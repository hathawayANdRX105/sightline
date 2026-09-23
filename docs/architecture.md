# Sightline 架构设计

> 状态: **草案 v0.1**（2026-09-22）
> 取代分散在 `todo/{agentation,ainotation,onlook}.md` 的借鉴视角，作为编码依据的唯一总设计。
> 三份 todo 文档保留为"为什么这么选"的溯源源料，不再作为单一事实源。

## 1. 一句话定位

**Sightline 是一个 Rust 单二进制的本地 sidecar，让任何 AI agent 通过 MCP 读到开发者对运行中网页的视觉标注反馈。** 框架无关、零运行时依赖、不绑定 dev server。

差异化三条（与 ref/ 下四个上游对照）:

| 维度 | 上游痛点 | Sightline |
|---|---|---|
| 接入路径 | ainotation 靠 Vite 中间件桥；dx/leptos/ferrite 都挂不上 | **sidecar 固定端口 + SDK 跨域自加载**，零 dev server 耦合 |
| 分发形态 | npx 46MB + 解析卡顿 + Node 24 运行时 | **Rust 单二进制**，~5MB，无运行时依赖 |
| 多宿主协调 | lockfile + 5 分钟 grant 租约 + 续租循环 | **localhost 一次性 token**，单宿主场景复杂度归零 |

## 2. 顶层组件

```
┌──────────────────────────────────────────────────────────────┐
│  Agent Host (Claude Desktop / Cursor / ferrite / …)          │
│                                                              │
│    MCP client  ◀──stdio──▶  sightline 二进制（同进程内）     │
└──────────────────────────────┬───────────────────────────────┘
                               │ 进程内 tokio runtime
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  sightline sidecar（单个 Rust 二进制）                       │
│                                                              │
│  ┌─────────────┐   ┌─────────────┐   ┌────────────────────┐  │
│  │ MCP server  │   │ HTTP server │   │ SDK asset server   │  │
│  │ (rmcp,      │   │ (axum,      │   │ (axum static,      │  │
│  │  stdio)     │   │  127.0.0.1  │   │  127.0.0.1:9420    │  │
│  │             │   │  :9420)     │   │  /sdk.js           │  │
│  └──────┬──────┘   └──────┬──────┘   └─────────┬──────────┘  │
│         │                 │                    │             │
│         └─────────┬───────┴────────────────────┘             │
│                   ▼                                          │
│         ┌──────────────────┐    ┌─────────────────────┐      │
│         │ Feedback Store   │    │ Session/Token mgr   │      │
│         │ (内存 + JSON     │    │ (一次性 token,      │      │
│         │  持久化)         │    │  Origin allowlist)  │      │
│         └──────────────────┘    └─────────────────────┘      │
└──────────────────────────────┬───────────────────────────────┘
                               │ HTTP + CORS（loopback only）
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  浏览器（任意 dev server 提供页面: dx / leptos / Vite / …）  │
│                                                              │
│  <script src="http://127.0.0.1:9420/sdk.js"></script>        │
│        │                                                     │
│        ▼                                                     │
│  Sightline SDK（零依赖，~30KB）                              │
│    · 点击元素 / 选中文本 → 生成验证过的 CSS selector         │
│    · POST /sessions/{id}/sync  →  sidecar                    │
│    · EventSource /sessions/{id}/events  →  agent 端可见      │
└──────────────────────────────────────────────────────────────┘
```

**三个分离进程间角色**:

1. **Agent host** — 通过 stdio 跟 sightline 二进制通讯；不知道有 HTTP。
2. **sightline 二进制** — 一个进程，一个 tokio runtime，同时跑 stdio MCP server + axum HTTP server。**监听唯一一个 TCP 端口 `127.0.0.1:9420`**。
3. **浏览器** — 加载一行 `<script>` 后，所有数据走 `http://127.0.0.1:9420`，跨域由 sidecar 显式 CORS 放行（loopback，零安全损失）。

## 3. 端口架构（决策 A）

**决策**: sidecar 固定监听 `127.0.0.1:9420`。所有客户端（浏览器、未来可能的 CLI）都连这个端口。

### 3.1 为什么固定而非随机

- ainotation 用随机端口 + `~/.ainotation/service/connection.json` 让 MCP 进程发现后台；这对"Vite 编译期注入 endpoint"是合理的，对"浏览器 SDK 自加载"是死路——SDK 还没下载到东西怎么读 connection.json？
- 固定端口的代价是"端口被占怎么办"：MVP 用启动失败即报错（提示用户用 `--port` 改端口），后期再加自动 fallback 到临近端口并把实际端口写进 SDK bundle。

### 3.2 为什么 loopback 而非 0.0.0.0

- 服务对象是开发者本机；没有任何理由让 LAN/公网可达。
- loopback-only 让 CORS 放行变得安全——Origin 一定是 `http://localhost:*` 或 `http://127.0.0.1:*`，简单 allowlist 即可。
- 这也是 ainotation 的硬规则（`http.ts:115` `server.listen(port, '127.0.0.1', ...)`），照抄。

### 3.3 SDK 自加载链路

```
1. 用户在任意 HTML 页面加: <script src="http://127.0.0.1:9420/sdk.js"></script>
2. 浏览器跨域请求 sdk.js → sidecar 静态资源服务返回 JS
3. sdk.js 内联引导阶段拉 /bootstrap（同源请求 → sidecar）:
   POST /bootstrap { origin: "http://localhost:8080" }
   ← 200 { sessionId, token, endpoint: "http://127.0.0.1:9420" }
4. 后续所有 SDK 请求带 Authorization: Bearer <token>
```

跨域要点:
- `sdk.js` 必须带 `Access-Control-Allow-Origin: *`（脚本跨域天然允许，无 token 泄漏）
- `/bootstrap` 严格校验 Origin（必须是 localhost/127.0.0.1 loopback），下发一次性 token
- 其他 API 端点都需要 Authorization + Origin 双校验

### 3.4 与 Vite 桥接方案的对比

| 维度 | Vite bridge (ainotation) | Sidecar 固定端口 (Sightline) |
|---|---|---|
| 浏览器同源 | ✅ | ❌（跨域，靠 CORS 放行） |
| 用户配置 | `vite.config.ts` 加 plugin | HTML 加一行 `<script>` |
| dx/leptos 可用 | ❌ | ✅ |
| 多 dev server 共存 | ❌（每 server 都要装 plugin） | ✅（一个 sidecar 服务所有页面） |
| token 下发 | 编译期注入 | 运行时 `/bootstrap` 同源下发 |

跨域是真实代价但小: 对 loopback，CORS 不增加攻击面；浏览器对简单 GET/POST + `application/json` 的 preflight 缓存 1 天，运行时开销可忽略。

## 4. MCP transport（决策 stdio）

**决策**: `sightline` 二进制启动后，rmcp server 通过 **stdio** 跟 agent host 通讯；不绑任何 MCP 端口。

### 4.1 为什么 stdio 而非 HTTP/SSE

- **零端口冲突**: agent host 直接 spawn `sightline` 作为子进程；不与本机其他 MCP server 抢端口。
- **零配置**: Claude Desktop 的配置就是 `{ "command": "sightline" }`，没有 URL/端口字段要填。
- **跟 HTTP sidecar 解耦**: 同一个二进制内部两个 transport（stdio 给 agent、HTTP 给浏览器），共享 tokio runtime 和 store；外部互不干扰。
- 这是 ainotation 的同样选择（`npx @ainotation/mcp connect` 走 stdio），照抄。

### 4.2 同进程双 transport 的 tokio 集成

```
#[tokio::main]
async fn main() {
    let store = Arc::new(FeedbackStore::new(...));

    // (1) HTTP sidecar — 服务浏览器
    let http_handle = tokio::spawn(run_http_server(store.clone()));

    // (2) MCP stdio server — 服务 agent host
    //     rmcp 的 serve_server_with_io(...) 直接吃 stdin/stdout
    let mcp_handle = tokio::spawn(run_mcp_stdio(store.clone()));

    tokio::select! {
        _ = http_handle => {},
        _ = mcp_handle => {},
    }
}
```

两个任务共享 `Arc<FeedbackStore>`，写入通过 `tokio::sync::Notify` 通知 SSE 订阅者。

## 5. 模块边界（Cargo workspace）

```
sightline/
├── Cargo.toml                    # workspace root
├── crates/
│   ├── sightline-schema/         # 数据契约（serde → specta → TS 单一事实源）
│   │   ├── Cargo.toml
│   │   └── src/lib.rs            # FeedbackDocument / Annotation / Target / Page
│   │
│   ├── sightline-store/          # 持久化层（内存 + JSON 文件，图片单独 Blob）
│   │   └── src/lib.rs            # FeedbackStore, SessionStore
│   │
│   ├── sightline-mcp/            # MCP server（rmcp + stdio transport）
│   │   └── src/lib.rs            # 3 个只读 tool: list / get / get_image
│   │
│   ├── sightline-http/           # HTTP sidecar（axum + 静态资源 + SSE）
│   │   └── src/lib.rs            # /bootstrap, /sessions/{id}/{sync,events}, /sdk.js
│   │
│   └── sightline-cli/            # 二进制入口（组装上述 + tokio::main）
│       └── src/main.rs
│
├── sdk/                          # TypeScript SDK（构建产物发布到 npm 或直接 sidecar 伺服）
│   ├── package.json
│   └── src/index.ts              # 零依赖，原生 DOM API；构建出 sdk.js
│
└── docs/
    ├── architecture.md           # 本文件
    └── protocol.md               # HTTP/MCP 协议规范（TODO）
```

### 关键约束

- **schema crate 是唯一事实源**。TS 类型由 `specta` + `specta-typescript` 在 build.rs 自动生成到 `sdk/src/types.generated.ts`，禁止手改。
- **SDK 零依赖**。不用 lit、不用 vite、不用任何运行时库；只用原生 DOM API（`querySelector`、`getBoundingClientRect`、`getComputedStyle`、`IntersectionObserver`、`Fetch`、`EventSource`）。最终 `sdk.js` gzip 后 < 30KB。
- **sidecar 二进制自包含 SDK**。`sdk.js` 通过 `include_str!("../sdk/dist/sdk.js")` 编译进二进制，HTTP `/sdk.js` 端点直接返回；用户不需要 npm install 任何东西。

## 6. 数据契约（v1，对齐 ainotation schema 简化版）

```
FeedbackDocument {
  session_id: Uuid,
  page: PageSnapshot,                // url, title, viewport
  annotations: Vec<Annotation>,
}

Annotation {
  id: Uuid,
  comment: String,                   // 用户文字反馈
  created_at: DateTime<Utc>,
  targets: Vec<TargetSnapshot>,      // 1..=20
}

TargetSnapshot {
  id: Uuid,
  selector: String,                  // 验证过的 CSS selector
  tag_name: String,
  text: String,                      // 截断 500 字
  attributes: HashMap<String, String>,
  rect: Rect,                        // x, y, width, height（视口坐标）
  styles: HashMap<String, String>,   // 关键 computed style
  ancestors: Vec<DomContextNode>,    // ≤ 32
  nearby_text: Option<NearbyText>,
  text_selection: Option<TextSelection>,
}

PageSnapshot {
  url: String,
  title: String,
  viewport: Viewport,                // width, height, dpr, scrollX, scrollY
}
```

**MVP 不实现**（来自 ainotation 但显式排除）:

- `styleChanges` / `targetStyles`（样式试调）
- `variants` / `variantCleanups`（UI 变体探索）
- `images`（截图标注）
- `replies`（多轮对话）
- `markerAnchor`（marker 位置）

这些都是 ainotation 的差异化亮点，但 Sightline MVP 只要标注反馈跑通。

## 7. 数据流（一次完整反馈）

```
[用户在 dx serve 跑的页面上]
   ↓ 点击一个按钮元素
[Sightline SDK]
   ↓ 生成 CSS selector（testid → id → class → 位置回退）
   ↓ 收集 target snapshot（rect, styles, ancestors, nearby text）
   ↓ POST http://127.0.0.1:9420/sessions/{sid}/sync
       Authorization: Bearer <token>
       Origin: http://localhost:8080
[sightline-http]
   ↓ 校验 token + Origin
   ↓ FeedbackStore.upsert(annotation)
   ↓ tokio::sync::Notify 通知订阅者
   ↓ 200 OK 返回最新 document
   ↓ 同时推 SSE event: changed 给所有订阅者
[sightline-mcp stdio]
   ↓ MCP client (Claude) 调 ainotation_get_feedback(sessionId)
   ↓ rmcp 把请求路由到 #[tool] handler
   ↓ handler 读 FeedbackStore.get(sessionId)
   ↓ 返回 JSON
[Claude]
   ↓ 看到 document，包含用户点击元素的 selector 和反馈
```

## 8. MVP 里程碑

| 阶段 | 交付物 | 验证 |
|---|---|---|
| **M0 — Schema** | `crates/sightline-schema` 完成 serde 定义 + specta 导出 TS | `cargo test`；`sdk/src/types.generated.ts` 生成 |
| **M1 — Store** | `crates/sightline-store` 内存 + JSON 持久化 | 单测覆盖 CRUD |
| **M2 — HTTP sidecar** | `crates/sightline-http` 启动 axum on 127.0.0.1:9420；`/bootstrap`、`/sessions/{id}/sync`、`/sessions/{id}/events`（SSE）、`/sdk.js` 静态 | curl 手测；CORS 头校验 |
| **M3 — SDK 最小可用** | `sdk/` 点击元素 + 选中文本 → 生成 selector → POST sync | 在一个 dx 测试页面里加载 sdk.js，点击按钮，能在 sidecar 日志看到 document |
| **M4 — MCP server** | 3 个只读 tool（`sightline_list_feedback` / `sightline_get_feedback` / `sightline_get_image`，参数 camelCase）+ stdio transport | `sdk/test/mcp.mjs`：tools/list + 经 MCP 读回 HTTP 写入的批注（16 项断言） |
| **M5 — 端到端 demo** | `crates/sightline-cli` 组装 + 简单 CLI；在一个真实 dx/leptos demo 里跑通"用户标注 → Claude 看到" | 录屏 demo |

**不在 MVP 内**：样式试调、截图、UI 变体、动画冻结、多项目路由、暗色主题、i18n、grant 租约、IndexedDB 草稿恢复、storybook playground、website。

## 9. 显式不做（与 todo 文档对齐）

- **不绑任何前端框架**（agentation 的 React 绑定、onlook 的 React/Next 专属都排除）
- **不做 Vite/webpack 插件**（ainotation 的 vite 插件是其接入路径的核心，对 Sightline 不是必需；后期可作为体验优化）
- **不做 grant 租约 + 多宿主协调**（ainotation 用 lockfile + 5 分钟租约是为多项目共用一个 service，Sightline 单 sidecar 单项目场景复杂度归零）
- **不做端口扫描**（ainotation 明确拒绝，照抄；端口固定，冲突就报错让用户改 `--port`）
- **不做浏览器扩展形态**（agentation 的 Chrome 扩展排除；script 注入更轻量）
- **MVP 不做可视化编辑**（onlook 的赛道，远期 rsx 映射才是 Sightline 的潜在独占方向）

## 9b. 浏览器接入策略——两层架构

**核心问题**：用户怎么把"标注 UI"装到他们的 dioxus/leptos 页面上？ainotation 用 Vite 中间件桥，但 dx/leptos 都没有中间件钩子。

**Sightline 给两层答案**，按"侵入度"递增排：

### Tier 1 — Devtools snippet / bookmarklet（MVP，零侵入）

```
用户在浏览器控制台粘一行（或保存为 bookmarklet）：
fetch("http://127.0.0.1:9420/sdk.js").then(r=>r.text()).then(eval)
```

- 任何框架、任何版本、任何页面（含生产环境调试）都能用
- 跟 agentation 的"复制粘贴"哲学一致——agent 无关、零依赖
- 缺点：每次页面刷新要重新粘（ bookmarklet 一次点击解决）
- **MVP 就走这条路**，因为标注只需 CSS selector，不需要框架感知

### Tier 2 — `sightline-dev` dev-dependency（post-MVP，dioxus/leptos 专用增强）

用户在自己的 `Cargo.toml` 里：

```toml
[dependencies]
dioxus = "0.6"          # 或 leptos = "0.7"

[dev-dependencies]
sightline-dev = "0.1"   # ← 关键：dev-deps 在 release build 里根本不编译
```

用户的 `main.rs`：

```rust
fn main() {
    #[cfg(debug_assertions)]
    sightline_dev::init();   // release build 里这一行直接消失

    dioxus::launch(app);
}
```

`sightline_dev::init()` 在 debug 模式下：

1. spawn 一个 tokio task 连 `ws://127.0.0.1:9420/ws`
2. 收到 sidecar 的"激活 SDK"指令时动态往 DOM 注入 `<script>`——用户 HTML 里没有任何 sightline 代码
3. **超出纯 JS SDK 的能力**：暴露 `dioxus::ScopeId` / `leptos::RuntimeId` 到 SDK，让 selector 生成可以拿到组件边界、props、hydration 状态——这是浏览器扩展永远做不到的框架感知能力

**为什么 `dev-dependencies` + `#[cfg(debug_assertions)]` 是 Rust 的标准答案**：

- `cargo build --release` 时 **dev-deps 完全不编译**，用户的 release 产物里没有任何 sightline 代码
- 二进制体积零增加、运行时零开销、零 release 编译时间
- 不需要类似 Vite plugin 的"build mode detection"——Cargo 本身就强制区分

### 为什么 MVP 不做 Tier 2

- Tier 2 的最大价值是"组件边界感知"——但 MVP 标注只需 CSS selector，组件树没意义
- 先用 Tier 1 证明反馈链路有价值，再投 Tier 2 的开发成本
- 跟 onlook 远期 rsx 映射的方向对齐：组件感知属于"远期差异化"，不是 MVP 入口

### 各框架对照表

| 框架 | MVP 推荐 | Post-MVP 增强 |
|---|---|---|
| Vite / webpack | Tier 1（devtools 粘贴） | 可考虑像 ainotation 那样出 plugin（编译期注入） |
| dioxus (`dx serve`) | Tier 1 | Tier 2 (`sightline-dev` dev-dep) |
| leptos (`cargo leptos`) | Tier 1 | Tier 2 (`sightline-dev` dev-dep) |
| ferrite / 其他 Rust 框架 | Tier 1 | Tier 2 |
| 生产环境紧急调试 | Tier 1 bookmarklet | — |
| 不想改代码的快速试用 | Tier 1 | — |



## 10. MCP 选型结论（rmcp v3.4.0，2026-09 调研）

**决策**: 用 `rmcp = "3.4"`（官方 MCP Rust SDK，Tier 1 维护级别）。Cargo features：

```toml
rmcp = { version = "3.4", features = ["server", "macros", "transport-io", "schemars"] }
```

### 10.1 关键事实（来自调研）

- **stable**: v3.0.0 于 2026-07-28 跟随 MCP spec 同日落地 stable；当前 3.4.0（2026-09-15）。Server conformance 30/30，Client 39/39。
- **stdio transport 原生支持**: `rmcp::transport::stdio()` 返回 `(stdin, stdout)` 包成的 transport，配 `ServiceExt::serve` 即用——正是我们要的。
- **跟 axum 共存**: rmcp 强依赖 tokio，所有 transport 都基于 tokio I/O。stdio MCP server 和 axum HTTP server 跑在**同一个 `#[tokio::main]` runtime 的并行 task**，零冲突、零额外 runtime。第 4.2 节的代码骨架思路成立。
- **工具定义用宏路径**: `#[tool_router] impl` + 方法标 `#[tool]` + `#[impl_tool_box]` / `tool_box!` 路由。下面给出实际 API 的最小骨架。

### 10.2 替换第 4.2 节的代码骨架

```rust
use rmcp::{model::*, schemars, tool, tool_router,
           ServerHandler, ServiceExt, transport::stdio, ErrorData};
use std::sync::Arc;
use sightline_store::FeedbackStore;

#[derive(Clone)]
struct SightlineServer {
    store: Arc<FeedbackStore>,
    router: ToolRouter<Self>,
}

#[tool_router]
impl SightlineServer {
    fn new(store: Arc<FeedbackStore>) -> Self {
        Self { store, router: SightlineServer::tool_router() }
    }

    #[tool(name = "sightline_list_feedback", description = "List all feedback sessions for the current project.")]
    async fn list_feedback(&self) -> Result<CallToolResult, ErrorData> {
        let docs = self.store.list().await.map_err(|e| ErrorData::new(
            ErrorCode::INTERNAL_ERROR, e.to_string(), None))?;
        Ok(RawContent::text(serde_json::to_string_pretty(&docs).unwrap()).into())
    }

    #[tool(name = "sightline_get_feedback", description = "Get one feedback document by session id.")]
    async fn get_feedback(&self,
        #[tool(param)] session_id: String,
    ) -> Result<CallToolResult, ErrorData> { /* … */ }

    #[tool(name = "sightline_get_image", description = "Read a PNG attachment by session + image id.")]
    async fn get_image(&self,
        #[tool(param)] session_id: String,
        #[tool(param)] image_id: String,
    ) -> Result<CallToolResult, ErrorData> { /* … */ }
}

#[impl_tool_box(SightlineServer)]
impl ServerHandler for SightlineServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            server_info: Implementation {
                name: "sightline".into(),
                version: env!("CARGO_PKG_VERSION").into(),
            },
            ..Default::default()
        }
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let store = Arc::new(FeedbackStore::open(...)?);

    // HTTP sidecar (axum) — 服务浏览器
    let http_handle = tokio::spawn(sightline_http::run(store.clone()));

    // MCP server (stdio) — 服务 agent host
    let mcp_handle = tokio::spawn(async {
        SightlineServer::new(store.clone())
            .serve(stdio())
            .await
            .map(|s| s.waiting().await)
    });

    tokio::select! {
        res = http_handle => { res??; }
        res = mcp_handle  => { res??; }
    }
    Ok(())
}
```

### 10.3 schema 单一事实源的折中

rmcp 用 **schemars** 给 MCP 入参派生 JSON Schema（这是 MCP 协议要求的入参 schema 载体）。我们想要前端 TS 也是单一事实源。**两者并不冲突**——同一 struct 双 derive：

```rust
#[derive(serde::Serialize, serde::Deserialize, schemars::JsonSchema, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GetFeedbackParams {
    pub session_id: String,
}
```

- `JsonSchema` 给 rmcp 用（MCP `tools/call` 入参校验）
- `specta::Type` 给 SDK 用（build.rs 生成 `sdk/src/types.generated.ts`）

第 5 节"schema crate 是唯一事实源"原则成立——只是事实源派生两个不同的产物，不是两套 schema。

### 10.4 待验证（移到 M0/M1 阶段实证）

- specta-typescript 输出是否够干净用作前端 SDK 的唯一类型源？需在 M0 试一次。
- 单二进制 release 大小目标 < 10MB：axum + tokio + rmcp + serde + schemars + specta 通常 5–8MB，M0 后实测。
- rmcp 宏跟 workspace 的 `sightline-schema` 类型协作是否顺畅（宏需要 `JsonSchema` 派生在 schema crate 里）。
```
