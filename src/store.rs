//! 内存 + JSON 文件持久化的反馈存储。
//!
//! 设计要点（见 `docs/architecture.md` §5、§7）：
//! - 多 reader / 单 writer：所有 mutate 走 `Mutex<Inner>`，读用快照 clone。
//! - `tokio::sync::Notify` 在写入后通知 SSE 订阅者（http 模块持有订阅）。
//! - MVP 单进程内存即可；JSON 持久化 deferred——先把 trait 立起来，文件落盘排期。
//!
//! MVP 不实现：图片 Blob 存储、IndexedDB 草稿恢复、多项目路由。

use std::collections::HashMap;
use std::sync::Arc;

use crate::schema::{Annotation, FeedbackDocument, SyncError, SyncRequest};
use thiserror::Error;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("session {0} not found")]
    SessionNotFound(Uuid),
    #[error(transparent)]
    Sync(#[from] SyncError),
}

/// 进程内存储。MVP：纯内存；持久化层后续插入（保持同一接口）。
#[derive(Debug, Default)]
pub struct FeedbackStore {
    inner: Mutex<Inner>,
    /// 写入通知器。HTTP SSE handler 通过 [`FeedbackStore::notifier`] 拿到
    /// `Arc<Notify>` 引用，在 `notify_waiters()` 后被唤醒。
    changed: Arc<Notify>,
}

#[derive(Debug, Default)]
struct Inner {
    sessions: HashMap<Uuid, FeedbackDocument>,
}

impl FeedbackStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// 拿到写入通知器。HTTP SSE handler 持有这个 `Arc<Notify>`，
    /// 在每次 `sync()` 后会被 `notify_waiters()` 唤醒。
    pub fn notifier(&self) -> Arc<Notify> {
        Arc::clone(&self.changed)
    }

    /// 创建（或返回已存在的）空 session。SDK `/bootstrap` 调用一次。
    pub async fn ensure_session(&self, session_id: Uuid) -> FeedbackDocument {
        let mut inner = self.inner.lock().await;
        let doc = inner
            .sessions
            .entry(session_id)
            .or_insert_with(|| FeedbackDocument::new(session_id));
        doc.clone()
    }

    pub async fn get(&self, session_id: Uuid) -> Result<FeedbackDocument, StoreError> {
        let inner = self.inner.lock().await;
        inner
            .sessions
            .get(&session_id)
            .cloned()
            .ok_or(StoreError::SessionNotFound(session_id))
    }

    pub async fn list(&self) -> Vec<FeedbackDocument> {
        let inner = self.inner.lock().await;
        inner.sessions.values().cloned().collect()
    }

    /// 应用一次 SDK 同步请求。校验 base_version，upsert 标注，bump version。
    pub async fn sync(&self, req: SyncRequest) -> Result<FeedbackDocument, StoreError> {
        let mut inner = self.inner.lock().await;
        let doc = inner
            .sessions
            .get_mut(&req.session_id)
            .ok_or(StoreError::Sync(SyncError::UnknownSession))?;
        if doc.version != req.base_version {
            return Err(StoreError::Sync(SyncError::StaleVersion {
                current: doc.version,
            }));
        }
        // 先删后插：同一 id 同时出现在两边时 upsert 生效（见 SyncRequest 文档）。
        if !req.remove_annotation_ids.is_empty() {
            doc.annotations
                .retain(|a| !req.remove_annotation_ids.contains(&a.id));
        }
        // 先删后插：同一 id 既在删除列表又在 upsert 列表时，以 upsert 为准。
        if !req.remove_annotation_ids.is_empty() {
            doc.annotations
                .retain(|a| !req.remove_annotation_ids.contains(&a.id));
        }
        for ann in req.upsert_annotations {
            upsert_annotation(&mut doc.annotations, ann);
        }
        doc.version += 1;
        doc.updated_at = chrono::Utc::now();
        let result = doc.clone();
        // 释放锁之后再发通知，避免订阅者回调阻塞写入。
        drop(inner);
        self.changed.notify_waiters();
        Ok(result)
    }
}

fn upsert_annotation(annotations: &mut Vec<Annotation>, incoming: Annotation) {
    if let Some(slot) = annotations.iter_mut().find(|a| a.id == incoming.id) {
        *slot = incoming;
    } else {
        annotations.push(incoming);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use crate::schema::{PageSnapshot, Rect, TargetSnapshot, Viewport};

    fn fixture_annotation(id: Uuid, comment: &str) -> Annotation {
        Annotation {
            id,
            comment: comment.into(),
            created_at: Utc::now(),
            page: PageSnapshot {
                url: "http://localhost:8080/".into(),
                title: "test".into(),
                user_agent: None,
                captured_at: None,
                viewport: Viewport {
                    width: 1280.0,
                    height: 720.0,
                    device_pixel_ratio: 1.0,
                    scroll_x: 0.0,
                    scroll_y: 0.0,
                },
            },
            targets: vec![TargetSnapshot {
                id: Uuid::new_v4(),
                selector: "#btn".into(),
                tag_name: "button".into(),
                text: "Click me".into(),
                attributes: Default::default(),
                rect: Rect { x: 0.0, y: 0.0, width: 10.0, height: 10.0 },
                styles: Default::default(),
                ancestors: None,
                ancestry_truncated: None,
                nearby_text: None,
                nearby_elements: None,
                text_selection: None,
            }],
        }
    }

    #[tokio::test]
    async fn sync_inserts_then_replaces_by_id() {
        let store = FeedbackStore::new();
        let sid = Uuid::new_v4();
        store.ensure_session(sid).await;

        let ann_id = Uuid::new_v4();
        let req = SyncRequest {
            session_id: sid,
            base_version: 0,
            upsert_annotations: vec![fixture_annotation(ann_id, "first")],
            remove_annotation_ids: vec![],
        };
        let doc = store.sync(req).await.unwrap();
        assert_eq!(doc.version, 1);
        assert_eq!(doc.annotations.len(), 1);
        assert_eq!(doc.annotations[0].comment, "first");

        let req2 = SyncRequest {
            session_id: sid,
            base_version: 1,
            upsert_annotations: vec![fixture_annotation(ann_id, "second")],
            remove_annotation_ids: vec![],
        };
        let doc2 = store.sync(req2).await.unwrap();
        assert_eq!(doc2.version, 2);
        assert_eq!(doc2.annotations.len(), 1);
        assert_eq!(doc2.annotations[0].comment, "second");
    }

    #[tokio::test]
    async fn sync_rejects_stale_base_version() {
        let store = FeedbackStore::new();
        let sid = Uuid::new_v4();
        store.ensure_session(sid).await;
        let req = SyncRequest {
            session_id: sid,
            base_version: 99,
            upsert_annotations: vec![],
            remove_annotation_ids: vec![],
        };
        let err = store.sync(req).await.unwrap_err();
        match err {
            StoreError::Sync(SyncError::StaleVersion { current }) => assert_eq!(current, 0),
            other => panic!("expected StaleVersion, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn notifier_fires_after_sync() {
        let store = FeedbackStore::new();
        let notify = store.notifier();
        let sid = Uuid::new_v4();
        store.ensure_session(sid).await;

        // 在另一个 task 里等待通知
        let notify_clone = Arc::clone(&notify);
        let waiter = tokio::spawn(async move {
            notify_clone.notified().await;
        });

        // 给 waiter 一点时间注册
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        let req = SyncRequest {
            session_id: sid,
            base_version: 0,
            upsert_annotations: vec![],
            remove_annotation_ids: vec![],
        };
        store.sync(req).await.unwrap();

        // notified() 应该已经被唤醒
        let _ = tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .expect("notifier should fire after sync");
    }

    #[tokio::test]
    async fn sync_removes_by_id_before_upsert() {
        let store = FeedbackStore::new();
        let sid = Uuid::new_v4();
        store.ensure_session(sid).await;

        let keep_id = Uuid::new_v4();
        let drop_id = Uuid::new_v4();
        let req = SyncRequest {
            session_id: sid,
            base_version: 0,
            upsert_annotations: vec![
                fixture_annotation(keep_id, "keep"),
                fixture_annotation(drop_id, "drop"),
            ],
            remove_annotation_ids: vec![],
        };
        store.sync(req).await.unwrap();

        // 删 drop_id，同时 upsert 同 id 的新内容 → upsert 生效（先删后插语义）
        let req2 = SyncRequest {
            session_id: sid,
            base_version: 1,
            upsert_annotations: vec![fixture_annotation(drop_id, "resurrect")],
            remove_annotation_ids: vec![drop_id],
        };
        let doc = store.sync(req2).await.unwrap();
        assert_eq!(doc.version, 2);
        assert_eq!(doc.annotations.len(), 2);
        let resurrected = doc
            .annotations
            .iter()
            .find(|a| a.id == drop_id)
            .expect("upsert after remove should win");
        assert_eq!(resurrected.comment, "resurrect");

        // 纯删除
        let req3 = SyncRequest {
            session_id: sid,
            base_version: 2,
            upsert_annotations: vec![],
            remove_annotation_ids: vec![drop_id],
        };
        let doc3 = store.sync(req3).await.unwrap();
        assert_eq!(doc3.version, 3);
        assert_eq!(doc3.annotations.len(), 1);
        assert_eq!(doc3.annotations[0].id, keep_id);

        // 删除不存在的 id 不报错（幂等）
        let req4 = SyncRequest {
            session_id: sid,
            base_version: 3,
            upsert_annotations: vec![],
            remove_annotation_ids: vec![Uuid::new_v4()],
        };
        let doc4 = store.sync(req4).await.unwrap();
        assert_eq!(doc4.version, 4);
        assert_eq!(doc4.annotations.len(), 1);
    }
}
