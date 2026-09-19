# onlook → Sightline 借鉴与实现进度

> 参考: `ref/onlook`（onlook-dev/onlook，26.8k★，TypeScript，"The Cursor for Designers"）
> ref 形态说明: 仓库较大且链路不稳，以 **main 分支 tarball** 解包（无 .git），更新用同法重拉。
> 定位: 可视化编辑运行中的 React 应用 + AI 同步代码——比"标注反馈"更进一步（直接改 UI）。
> React/Next 专属。Sightline 取其**框架 adapter 架构思想**与远期 rsx 方向，MVP 不碰编辑器。

## 能力拆解 → 实现状态

| 能力 | 上游做法 | Sightline 决策 | 状态 |
|---|---|---|---|
| 可视化编辑运行中应用 | WebView 注入编辑层，直接改样式/布局/文本 | **远期**: 属编辑器赛道，MVP 只做标注反馈 | ⬜ 排期 |
| AI 同步代码 | 编辑映射回组件代码（React AST） | 远期——Sightline 的对应物是 **rsx 映射** | ⬜ 排期 |
| 框架 adapter | 项目内抽象"框架插件"以支持多框架 | **架构思想照抄**: sidecar 与 SDK 的接口设计预留 adapter 位 | ✅ 设计确立 |
| Figma 导入 | 设计稿→代码 | 不抄（生态位不同） | ⬜ 不抄 |
| 数据库/托管集成 | Supabase 深度绑定 | 不抄（我们要零外部依赖） | ⬜ 不抄 |

## 明确不抄

- **React/Next 绑定**（他们的核心卖点恰是我们的边界外）
- **Supabase 托管依赖**（零外部依赖原则）
- MVP 阶段不做任何可视化编辑

## 进度记录

- 2026-09-20: 文档建立。框架 adapter 思想采纳；rsx 映射确立为远期差异化方向（Dioxus 生态无人服务，Sightline 若做即独占）。

## 互补参考: browser-tools-mcp

> `ref/browser-tools-mcp`（AgentDeskAI，7.3k★）——浏览器可观测数据（console/network/DOM/截图）经 MCP 喂 agent。
> 无标注交互，与 Sightline 互补（调试 vs 视觉反馈）。借鉴点: **MCP 工具的粒度设计**（每个数据源一个工具、
> setup 校验工具先行），在 rmcp 实现时参考其工具切分。
