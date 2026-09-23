//! Sightline — 单 crate 包含全部模块。
//!
//! 模块拆分（保持单一 crate 的简单性，不再分 workspace）：
//! - [`schema`]: 数据契约，单一事实源
//! - [`store`]:  内存 + 后续持久化层
//! - [`http`]:   axum sidecar，固定端口 127.0.0.1:9420
//! - [`mcp`]:    rmcp stdio server，给 AI agent 用
//!
//! 二进制入口在 `src/main.rs`，调用 `sightline::http::run` 和
//! `sightline::mcp::run_stdio`，共享一个 tokio runtime 和一份 store。

pub mod schema;
pub mod store;
pub mod http;
pub mod mcp;

// 重导出常用入口，方便调用方少写一层路径。
pub use schema::FeedbackDocument;
pub use store::FeedbackStore;
