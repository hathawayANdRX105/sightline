# ainotation → Sightline 借鉴与实现进度

> 参考: `ref/ainotation`（nightire/ainotation，beta，MIT，lit + Vite 插件 + 本地 MCP）
> 定位: 已在 ferrite 实测接入的方案——MCP 双向、样式试调、截图画图、grant 租约。
> Sightline 取其**反馈 schema 设计**与 **MCP 工具面**，弃其 lit 依赖与租约复杂度。
> 另见 `todo/onlook.md` 互补项、`ref/browser-tools-mcp`（相邻参考: 浏览器可观测数据喂 agent）。

## 能力拆解 → 实现状态

| 能力 | 上游做法 | Sightline 决策 | 状态 |
|---|---|---|---|
| 反馈 schema | document→annotations→targets: selector/ancestors/text/nearbyText/attributes/rect/styles | **核心借鉴**: serde 定义 → specta 导出 TS 类型（单一事实源） | ⬜ MVP |
| selector 质量 | 验证过的 CSS selector（testid→语义属性→祖先域→位置回退，256 候选上限） | 照抄策略（简化到 testid→id→class→位置） | ⬜ MVP |
| MCP 工具面 | 14 个工具（list/get/create/update/delete + variants） | 先只读 3 个: `sightline_list_feedback` / `sightline_get_feedback` / `sightline_get_image`（rmcp） | ⬜ MVP |
| 本地 service + grant 租约 | control API + 5 分钟租约 + 续租循环 | **简化**: localhost 一次性 token，无租约（我们不需要多宿主） | ✅ 设计确立 |
| 样式试调（原值/期望值 targetStyles） | 面板改 CSS，原值期望值随反馈保存 | 排期（差异化亮点） | ⬜ 排期 |
| 截图 + 页面画图 | 原生屏捕 + 画布标注 + 裁剪 | 排期（先用 DisplayMedia 最小路径） | ⬜ 排期 |
| Vite 插件自动注入 | dev-server 中间件桥 | **不抄**——我们 sidecar 直接伺服 SDK 文件，任何 dev server 通用 | ✅ 设计确立 |
| 刷新恢复草稿 | IndexedDB + 共享草稿 | 排期（IndexedDB 最小路径） | ⬜ |

## 明确不抄

- **lit 运行时**——零依赖原则冲突
- **grant 5 分钟租约 + 续租循环**——上游为多宿主设计的复杂度，我们 localhost 单宿主不需要
- **Vite 专用中间件桥**——dx/任意 server 通用的 sidecar 才是我们的差异化

## 进度记录

- 2026-09-20: 文档建立。schema/MCP 工具面/sidecar 伺服三项设计确立（来自 ferrite 实测接入的经验: dx 无法挂中间件桥、npx 启动 46MB、npx 解析阶段卡顿——均为 Sightline 用 Rust 单二进制解决的动机）。
