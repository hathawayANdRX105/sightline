//! HTTP sidecar — 固定端口 `127.0.0.1:9420`，浏览器 SDK 的唯一接入点。
//!
//! 设计要点（见 `docs/architecture.md` §3）：
//! - 单一固定端口（决策 A），SDK 自加载链路：
//!     GET  /sdk.js                    静态资源（MVP 占位；SDK 构建链推后）
//!     POST /bootstrap                 loopback Origin 校验 → 下发 token + sessionId
//!     POST /sessions/{id}/sync        upsert 标注（需 Authorization: Bearer <token>）
//!     GET  /sessions/{id}/events      SSE 推送变更
//! - loopback-only：bind 到 127.0.0.1，CORS allowlist 限制 Origin 为
//!   http://localhost:* / http://127.0.0.1:*。
//! - 一次性 token：`/bootstrap` 下发，sidecar 用 `SessionTokens` 表
//!   按 session_id 索引 token；后续请求 Authorization: Bearer 校验。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::{
    Router,
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum::extract::Request;
use axum::middleware::{self, Next};
use tower_http::cors::{AllowOrigin, CorsLayer};
use uuid::Uuid;

use crate::schema::{FeedbackDocument, SyncRequest};
use crate::store::FeedbackStore;

pub const DEFAULT_PORT: u16 = 9420;

/// 记录某 session 的 token。session_id → 32 字节 hex token。
/// MVP 单进程内存即可；进程重启即失效（这是设计意图）。
type SessionTokens = tokio::sync::Mutex<HashMap<Uuid, String>>;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<FeedbackStore>,
    pub tokens: Arc<SessionTokens>,
}

pub async fn run(store: Arc<FeedbackStore>, port: u16) -> anyhow::Result<()> {
    run_with_state(
        AppState {
            store,
            tokens: Arc::default(),
        },
        SocketAddr::from(([127, 0, 0, 1], port)),
    )
    .await
}

pub async fn run_with_state(state: AppState, addr: SocketAddr) -> anyhow::Result<()> {
    // MVP：mirror request origin（loopback bind 已经把攻击面降到零）。
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::mirror_request())
        .allow_methods([
            axum::http::Method::GET,
            axum::http::Method::POST,
            axum::http::Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
        ]);

    let app = Router::new()
        .route("/sdk.js", get(sdk_js))
        .route("/bootstrap", post(bootstrap))
        .route(
            "/sessions/{id}/sync",
            post(sync_session).route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer_token,
            )),
        )
        .route("/sessions/{id}/events", get(events_session))
        .layer(cors)
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "sightline-http listening");
    axum::serve(listener, app).await?;
    Ok(())
}

/// 静态 SDK 文件。编译期通过 `include_str!` 把 sdk/dist/sdk.js 嵌进二进制，
/// 避免运行时依赖文件系统。`cargo build` 时该文件必须存在——build.rs 负责
/// 在缺失时给出清晰的错误提示（TODO 加 build.rs）。
async fn sdk_js() -> Response {
    static SDK_JS: &str = include_str!("../sdk/dist/sdk.js");
    (
        StatusCode::OK,
        [
            ("content-type", "application/javascript; charset=utf-8"),
            // 跨域加载脚本需要 CORS *；不带任何凭据，无安全损失。
            ("access-control-allow-origin", "*"),
            ("cache-control", "no-store"),
        ],
        SDK_JS,
    )
        .into_response()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapResponse {
    session_id: Uuid,
    token: String,
    endpoint: String,
    /// 顺便下发当前文档（首次 bootstrap 是空文档），SDK 不需要再单独 GET。
    /// 缺这个字段会让 SDK 在 start() 之后访问 `bs.document.version` 报错。
    document: FeedbackDocument,
}

/// SDK 引导：校验 loopback Origin → 创建（或复用）session → 下发 token。
///
/// 安全模型：
/// - bind 已经限制为 127.0.0.1，所以只有本机浏览器能到这里
/// - 再校验 Origin 头必须是 http://localhost:* 或 http://127.0.0.1:*
///   （这阻止了恶意网页从 file:// 或外网 IP 发起的 CSRF 风格请求）
/// - token 是 32 字节随机 hex，进程内绑定到 session_id
async fn bootstrap(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !is_loopback_origin(origin) {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(serde_json::json!({
                "error": "Origin not allowed",
                "hint": "Sightline only accepts http://localhost:* or http://127.0.0.1:* origins"
            })),
        )
            .into_response();
    }

    let session_id = Uuid::new_v4();
    let token = generate_token();
    state
        .tokens
        .lock()
        .await
        .insert(session_id, token.clone());

    // 在 store 里也确保 session 存在，方便后续 sync 直接命中。
    let document = state.store.ensure_session(session_id).await;

    tracing::info!(%session_id, %origin, "session bootstrapped");

    let resp = BootstrapResponse {
        session_id,
        token,
        endpoint: format!("http://127.0.0.1:{DEFAULT_PORT}"),
        document,
    };
    (StatusCode::OK, axum::Json(resp)).into_response()
}

/// 中间件：校验 `Authorization: Bearer <token>` 并把 session_id 注入 request extensions。
///
/// 路径参数 `:id` 已经在路径里，所以这里解析它并匹配 tokens 表。
async fn require_bearer_token(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let session_id = match extract_session_id(&request) {
        Some(id) => id,
        None => return (StatusCode::BAD_REQUEST, "missing session id in path").into_response(),
    };

    let provided = request
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(parse_bearer);
    let expected = state.tokens.lock().await.get(&session_id).cloned();

    let ok = match (provided, expected) {
        (Some(p), Some(e)) => constant_time_eq(p.as_bytes(), e.as_bytes()),
        _ => false,
    };
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            axum::Json(serde_json::json!({"error": "invalid or missing bearer token"})),
        )
            .into_response();
    }

    request.extensions_mut().insert(SessionIdExt(session_id));
    next.run(request).await
}

#[derive(Clone, Copy)]
struct SessionIdExt(Uuid);

fn extract_session_id(req: &Request) -> Option<Uuid> {
    // 路径形如 /sessions/{uuid}/sync；这里简单 split。
    let path = req.uri().path();
    let segs: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    if segs.len() >= 3 && segs[0] == "sessions" {
        return Uuid::parse_str(segs[1]).ok();
    }
    None
}

fn parse_bearer(hv: &HeaderValue) -> Option<String> {
    let s = hv.to_str().ok()?;
    let t = s.strip_prefix("Bearer ")?;
    Some(t.trim().to_string())
}

/// 简化的常量时间比较（保护 token 不被时序攻击；32 字节长度足以应对）。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn generate_token() -> String {
    // 用 uuid v4 当 token 来源——足够随机且不引第三方 crate。
    // 32 字节 hex = uuid 拼两次，避开依赖 rand。
    let a = Uuid::new_v4().simple().to_string();
    let b = Uuid::new_v4().simple().to_string();
    format!("{a}{b}")
}

fn is_loopback_origin(origin: &str) -> bool {
    if origin.is_empty() {
        return false;
    }
    let Ok(url) = origin.parse::<axum::http::Uri>() else {
        return false;
    };
    let scheme = url.scheme_str();
    let host = url.host();
    (scheme == Some("http") || scheme == Some("https"))
        && matches!(host, Some("localhost") | Some("127.0.0.1") | Some("::1"))
}

/// 接收 SDK 同步请求并应用到 store。
async fn sync_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    axum::Json(req): axum::Json<SyncRequest>,
) -> Response {
    if req.session_id != session_id {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(serde_json::json!({"error": "path/payload session_id mismatch"})),
        )
            .into_response();
    }
    match state.store.sync(req).await {
        Ok(doc) => (StatusCode::OK, axum::Json(doc)).into_response(),
        Err(e) => (
            StatusCode::CONFLICT, // 409 = base_version 冲突；其他错误也走这里（MVP）
            axum::Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response(),
    }
}

/// SSE：推送 session 变更事件。订阅 store.notifier()，每次 sync 后被唤醒。
async fn events_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
) -> Response {
    use axum::response::sse::{Event, KeepAlive, Sse};
    use futures::stream::{self, StreamExt};

    let notifier = state.store.notifier();

    // 无限流：每次 notifier 触发就 emit 一个 `changed` 事件。
    let events = stream::unfold(notifier, move |notify| {
        let sid = session_id;
        async move {
            notify.notified().await;
            // SSE data 字段不能含裸换行；用单行 JSON。
            let payload = serde_json::json!({ "sessionId": sid }).to_string();
            let ev = Event::default()
                .event("changed")
                .data(payload);
            Some((ev, notify))
        }
    })
    .map(Ok::<_, std::convert::Infallible>);

    Sse::new(events)
        .keep_alive(
            KeepAlive::new()
                .interval(std::time::Duration::from_secs(15)),
        )
        .into_response()
}
