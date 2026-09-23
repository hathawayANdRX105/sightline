//! MCP server (rmcp, stdio transport) — 把反馈文档暴露给 AI agent。
//!
//! MVP 三个只读工具（见 `docs/architecture.md` §8 M4）：
//!   - `sightline_list_feedback`  列出所有 session
//!   - `sightline_get_feedback`   取一份文档（按 session UUID）
//!   - `sightline_get_image`      取 PNG 附件（MVP 占位，返回 NotImplemented）
//!
//! 设计要点：
//! - `sightline` 二进制内的 tokio runtime 把这个模块跑成一个 task，
//!   跟 `crate::http` 的 axum server 并行共存。
//! - server handler 持有 `Arc<FeedbackStore>`，所有工具读 store 即可，
//!   不需要再走 HTTP——避免自环请求。
//! - 工具入参用 `Parameters<T>` 包装的派生 `JsonSchema` struct，跟
//!   rmcp 官方 counter example 对齐。

use std::sync::Arc;

use rmcp::{
    ErrorData as RmcpError, ServerHandler, ServiceExt,
    handler::server::router::tool::ToolRouter,
    handler::server::wrapper::Parameters,
    model::{
        CallToolResult, ContentBlock, ErrorCode, Implementation, MetaObject,
        ProtocolVersion, ServerCapabilities, ServerConfig,
    },
    tool, tool_handler, tool_router,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::store::FeedbackStore;
use uuid::Uuid;

/// MCP server 入口。被 `src/main.rs` 调用。
pub async fn run_stdio(store: Arc<FeedbackStore>) -> anyhow::Result<()> {
    let server = SightlineServer::new(store);
    let service = server.serve(rmcp::transport::stdio()).await?;
    service.waiting().await?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetFeedbackParams {
    /// Session UUID（标准 8-4-4-4-12 hex 格式）。
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GetImageParams {
    pub session_id: String,
    pub image_id: String,
}

#[derive(Clone)]
struct SightlineServer {
    store: Arc<FeedbackStore>,
    #[allow(dead_code)]
    tool_router: ToolRouter<Self>,
}

#[tool_router]
impl SightlineServer {
    fn new(store: Arc<FeedbackStore>) -> Self {
        Self {
            store,
            tool_router: Self::tool_router(),
        }
    }

    #[tool(
        name = "sightline_list_feedback",
        description = "List all Sightline feedback sessions known to this sidecar."
    )]
    async fn list_feedback(&self) -> Result<CallToolResult, RmcpError> {
        let docs = self.store.list().await;
        let payload = serde_json::to_string_pretty(&docs)
            .map_err(|e| RmcpError::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(payload)]))
    }

    #[tool(
        name = "sightline_get_feedback",
        description = "Get one Sightline feedback document by session UUID."
    )]
    async fn get_feedback(
        &self,
        Parameters(params): Parameters<GetFeedbackParams>,
    ) -> Result<CallToolResult, RmcpError> {
        let sid = Uuid::parse_str(&params.session_id)
            .map_err(|e| RmcpError::invalid_params(e.to_string(), None))?;
        let doc = self
            .store
            .get(sid)
            .await
            .map_err(|e| RmcpError::internal_error(e.to_string(), None))?;
        let payload = serde_json::to_string_pretty(&doc)
            .map_err(|e| RmcpError::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![ContentBlock::text(payload)]))
    }

    #[tool(
        name = "sightline_get_image",
        description = "Read a PNG attachment from a feedback session by session + image id. \
                       MVP returns METHOD_NOT_FOUND; image support is scheduled post-MVP."
    )]
    async fn get_image(
        &self,
        Parameters(_params): Parameters<GetImageParams>,
    ) -> Result<CallToolResult, RmcpError> {
        Err(RmcpError::new(
            ErrorCode::METHOD_NOT_FOUND,
            "image attachments are not yet supported (post-MVP)",
            None,
        ))
    }
}

#[tool_handler]
impl ServerHandler for SightlineServer {
    fn get_info(&self) -> ServerConfig {
        // Implementation 是 non_exhaustive → 先 default 再填（别用 rmcp 的 from_build_env，
        // 那个拿到的是 rmcp 自己的包名，agent 端会显示成 "rmcp"）
        let mut server_info = Implementation::default();
        server_info.name = "sightline".to_string();
        server_info.title = Some("Sightline".to_string());
        server_info.version = env!("CARGO_PKG_VERSION").to_string();
        server_info.description = Some(
            "Local MCP sidecar exposing developer feedback about running web pages".to_string(),
        );
        ServerConfig::new(
            ServerCapabilities::builder().enable_tools().build(),
        )
        .with_server_info(server_info)
        .with_protocol_version(ProtocolVersion::V_2024_11_05)
        .with_instructions(
            "Sightline exposes developer feedback about running web pages. \
             Use sightline_list_feedback to discover sessions, then \
             sightline_get_feedback with a session UUID to read the full document \
             (page snapshot + annotations + target DOM snapshots)."
                .to_string(),
        )
    }
}

// 占位避免未使用警告（MetaObject 引入但 MVP 不用；保留以便后续 tool_handler 加 meta）。
#[allow(dead_code)]
fn _meta_marker() -> MetaObject {
    MetaObject::default()
}
