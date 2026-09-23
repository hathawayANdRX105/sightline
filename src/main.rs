//! sightline — 单二进制入口。
//!
//! 一个进程、一个 tokio runtime，同时跑：
//!   1. HTTP sidecar（axum on 127.0.0.1:9420）— 服务浏览器 SDK
//!   2. MCP server（rmcp over stdio）— 服务 AI agent host
//!
//! 详见 `docs/architecture.md` §4.2 的双 transport 协议。

use std::sync::Arc;

use clap::Parser;
use sightline::http::DEFAULT_PORT;
use sightline::store::FeedbackStore;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "sightline",
    version,
    about = "Local MCP sidecar that exposes developer feedback about running web pages to AI agents."
)]
struct Cli {
    /// HTTP sidecar 端口。默认 9420；冲突时用此参数改端口。
    #[arg(long, env = "SIGHTLINE_PORT", default_value_t = DEFAULT_PORT)]
    port: u16,

    /// 只跑 HTTP sidecar，跳过 MCP stdio（调试用）。
    #[arg(long, default_value_t = false)]
    http_only: bool,

    /// 只跑 MCP stdio，跳过 HTTP（调试用）。
    #[arg(long, default_value_t = false)]
    mcp_only: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| {
            EnvFilter::new("sightline=info,tower_http=info,rmcp=info")
        }))
        .with_writer(std::io::stderr) // 不要污染 stdout（stdio 给 MCP）
        .init();

    let cli = Cli::parse();
    let store = FeedbackStore::new();

    let mut handles: Vec<tokio::task::JoinHandle<anyhow::Result<()>>> = Vec::new();

    if !cli.mcp_only {
        let store_http = Arc::clone(&store);
        let port = cli.port;
        handles.push(tokio::spawn(async move {
            sightline::http::run(store_http, port).await
        }));
    }

    if !cli.http_only {
        let store_mcp = Arc::clone(&store);
        handles.push(tokio::spawn(async move {
            sightline::mcp::run_stdio(store_mcp).await
        }));
    }

    if handles.is_empty() {
        tracing::error!("both --http-only and --mcp-only given; nothing to run");
        std::process::exit(2);
    }

    // 任一 task 结束（成功或失败）都让进程退出。
    let (first_result, _, _) = futures::future::select_all(handles).await;
    match first_result {
        Ok(Ok(())) => {
            tracing::info!("sightline task completed; shutting down");
            Ok(())
        }
        Ok(Err(e)) => {
            tracing::error!(error = %e, "sightline task failed");
            Err(e)
        }
        Err(join_err) => {
            tracing::error!(error = %join_err, "sightline task panicked");
            Err(anyhow::anyhow!(join_err))
        }
    }
}
