//! Sightline feedback document data contracts.
//!
//! 设计目标（见 `docs/architecture.md` §6）：
//! - 单一事实源：同一 struct 同时派生 `Serialize` / `Deserialize` /
//!   `JsonSchema`（喂 rmcp 给 MCP 入参用）和 `specta::Type`（喂
//!   specta-typescript 给前端 SDK）。
//! - MVP 子集：只保留 `FeedbackDocument / Annotation / TargetSnapshot /
//!   PageSnapshot` 四个聚合根；样式试调、UI 变体、截图、多轮对话、marker
//!   位置全部显式排除到 v2 之后。
//!
//! 字段命名一律 camelCase，跟浏览器侧 JS 习惯对齐（serde rename_all）。

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use schemars::{json_schema, JsonSchema, Schema, SchemaGenerator};
use serde::{Deserialize, Serialize};
use specta::Type;
use uuid::Uuid;

/// 反馈契约版本号。任何破坏性变更必须递增并在 MCP 工具的 `get_schema` 输出里暴露。
pub const FEEDBACK_SCHEMA_VERSION: u32 = 1;

/// 给 `uuid::Uuid` 提供 JSON Schema（schemars 1.x 不再原生支持 uuid；
/// 用 `#[schemars(schema_with = "uuid_schema")]` 在每个字段上引用本函数）。
pub fn uuid_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "format": "uuid" })
}

/// `Vec<Uuid>` 的 JSON Schema（同 uuid_schema，套一层 array）。
pub fn uuid_vec_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({
        "type": "array",
        "items": { "type": "string", "format": "uuid" }
    })
}

/// 视口矩形（CSS 像素，原点左上）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 页面捕获快照。一次标注动作附一份，反映点击/选区那一刻的页面状态。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageSnapshot {
    pub url: String,
    pub title: String,
    /// 用户代理字符串（可空，用于诊断 dioxus/leptos 等 framework 的 SSR 差异）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    /// 捕获时刻；由 SDK 填入，sidecar 不改写。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<DateTime<Utc>>,
    pub viewport: Viewport,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub device_pixel_ratio: f64,
    pub scroll_x: f64,
    pub scroll_y: f64,
}

/// DOM 上下文节点（用于 ancestors / nearbyElements）。
///
/// 故意比 ainotation 简化：不暴露 `shadowHost` 标志，不区分 shadow boundary，
/// 因为 MVP 的 selector 生成器只走 light DOM。Shadow DOM 排期到 v2。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct DomContextNode {
    pub tag_name: String,
    pub attributes: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct NearbyText {
    pub before: String,
    pub after: String,
}

/// 文本选区信息。当用户标注的是一段选中文本而非整个元素时填充。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextSelection {
    pub exact: String,
    pub prefix: String,
    pub suffix: String,
    pub truncated: bool,
    pub rects: Vec<Rect>,
}

/// 标注目标——一次标注可以指向多个 DOM 元素（Shift 多选）。
///
/// `selector` 是 SDK 端生成并已验证过的 CSS selector（按 testid → id →
/// class → 位置回退的策略）。sidecar 不重新生成或验证；它只是事实的搬运工。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
    #[schemars(schema_with = "uuid_schema")]
    pub id: Uuid,
    /// 验证过的 CSS selector，最长 4000 字符。
    pub selector: String,
    pub tag_name: String,
    /// 元素可见文本，截断到 500 字。
    pub text: String,
    pub attributes: HashMap<String, String>,
    pub rect: Rect,
    /// 关键 computed style（color、font-size、display 等 SDK 决定采集哪些）。
    pub styles: HashMap<String, String>,
    /// 祖先链，最多 32 层，超出截断且 `ancestry_truncated = true`。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ancestors: Option<Vec<DomContextNode>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ancestry_truncated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nearby_text: Option<NearbyText>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nearby_elements: Option<Vec<DomContextNode>>,
    /// 选区信息——仅当本次标注是文本选区时填充。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_selection: Option<TextSelection>,
}

/// 一条标注。MVP 只有 create + read；update / delete 排期。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct Annotation {
    #[schemars(schema_with = "uuid_schema")]
    pub id: Uuid,
    /// 用户文字反馈，1..=10000 字。
    pub comment: String,
    pub created_at: DateTime<Utc>,
    /// 标注触发时捕获的页面快照。
    pub page: PageSnapshot,
    /// 目标集合。MVP 限制 1..=20（对齐 ainotation）。
    pub targets: Vec<TargetSnapshot>,
}

/// 顶层反馈文档。一个 session 一份；一次标注动作产生一个新版本。
///
/// 设计要点：version 字段单调递增，sidecar 用它做乐观并发控制
/// （SDK POST 时带期望的 base version，sidecar 拒绝 stale 写入）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackDocument {
    pub schema_version: u32,
    #[schemars(schema_with = "uuid_schema")]
    pub session_id: Uuid,
    pub version: u64,
    pub annotations: Vec<Annotation>,
    /// 文档最后更新时刻。
    pub updated_at: DateTime<Utc>,
}

impl FeedbackDocument {
    /// 创建一个空文档（用于 SDK 首次 `/bootstrap` 时初始化 session）。
    pub fn new(session_id: Uuid) -> Self {
        Self {
            schema_version: FEEDBACK_SCHEMA_VERSION,
            session_id,
            version: 0,
            annotations: Vec::new(),
            updated_at: Utc::now(),
        }
    }
}

/// SDK → sidecar 的同步请求。`base_version` 用于乐观并发；sidecar 拒绝
/// stale 写入并返回 `SyncError::StaleVersion` 让 SDK 重拉。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    #[schemars(schema_with = "uuid_schema")]
    pub session_id: Uuid,
    /// SDK 当前持有的文档版本；sidecar 校验 `store.version == base_version`。
    pub base_version: u64,
    /// 要 upsert 的标注。按 `id` 匹配；不存在则追加，存在则替换。
    pub upsert_annotations: Vec<Annotation>,
    /// 要删除的标注 id（工具栏"清空"和编辑器"删除"用）。
    /// 应用顺序：先删除后 upsert——同一 id 同时出现在两边时 upsert 生效。
    /// `#[serde(default)]` 保证旧 SDK 不带此字段也能反序列化。
    #[serde(default)]
    #[schemars(schema_with = "uuid_vec_schema")]
    pub remove_annotation_ids: Vec<Uuid>,
}

/// 同步错误。通过 `Result<_, SyncError>` 序列化返回；不依赖 HTTP 状态码承载语义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, Type)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum SyncError {
    /// SDK 的 base_version 落后于 sidecar 当前版本。
    StaleVersion { current: u64 },
    /// session 不存在或已过期。
    UnknownSession,
    /// schema 版本不兼容。
    UnsupportedSchemaVersion { client: u32, server: u32 },
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StaleVersion { current } => {
                write!(f, "stale base version; server is at {current}")
            }
            Self::UnknownSession => write!(f, "unknown session"),
            Self::UnsupportedSchemaVersion { client, server } => {
                write!(f, "schema mismatch: client={client}, server={server}")
            }
        }
    }
}

impl std::error::Error for SyncError {}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON roundtrip 必须保留 camelCase 命名，不能出现 snake_case 泄漏。
    #[test]
    fn feedback_document_roundtrip_camel_case() {
        let doc = FeedbackDocument::new(Uuid::new_v4());
        let json = serde_json::to_string(&doc).unwrap();
        assert!(json.contains("sessionId"));
        assert!(json.contains("schemaVersion"));
        assert!(!json.contains("session_id"));
        assert!(!json.contains("schema_version"));
        let back: FeedbackDocument = serde_json::from_str(&json).unwrap();
        assert_eq!(doc, back);
    }

    #[test]
    fn rect_roundtrip_normal_values() {
        let r = Rect { x: 1.5, y: 2.5, width: 100.0, height: 50.0 };
        let json = serde_json::to_string(&r).unwrap();
        let back: Rect = serde_json::from_str(&json).unwrap();
        assert_eq!(r, back);
    }

    /// 旧 SDK 省略 `removeAnnotationIds` 也要能反序列化（serde default 向后兼容）。
    #[test]
    fn sync_request_omitted_remove_ids_defaults_empty() {
        let sid = Uuid::new_v4();
        let legacy = format!(
            r#"{{"sessionId":"{sid}","baseVersion":0,"upsertAnnotations":[]}}"#
        );
        let req: SyncRequest = serde_json::from_str(&legacy).unwrap();
        assert!(req.remove_annotation_ids.is_empty());

        // 新客户端写出的字段名必须是 camelCase
        let req2 = SyncRequest {
            session_id: sid,
            base_version: 0,
            upsert_annotations: vec![],
            remove_annotation_ids: vec![Uuid::new_v4()],
        };
        let json = serde_json::to_string(&req2).unwrap();
        assert!(json.contains("removeAnnotationIds"));
        assert!(!json.contains("remove_annotation_ids"));
        let back: SyncRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req2, back);
    }
}
