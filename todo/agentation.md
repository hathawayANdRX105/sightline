# agentation → Sightline 借鉴与实现进度

> 参考: `ref/agentation`（benjitaylor/agentation，4.7k★，TypeScript，PolyForm Shield）
> 定位: agent-agnostic 的页面标注工具——点击元素/选文本/拖区域 → 结构化 markdown → 复制给任何 agent。
> 上游硬限制: React 18+ 绑定、许可非 MIT。Sightline 取其**零依赖哲学**与交互设计，弃其框架绑定。

## 能力拆解 → 实现状态

| 能力 | 上游做法 | Sightline 决策 | 状态 |
|---|---|---|---|
| 零依赖 SDK | 纯 CSS 动画、无运行时库 | **照抄哲学**: 页内 SDK 不引任何运行时库 | ✅ 原则确立 |
| 点击元素标注 | 自动 selector 识别 | TS 实现 + 生成验证过的 CSS selector | ⬜ MVP |
| 文本选区标注 | 选中文本即标注 | 同左 | ⬜ MVP |
| 多选（拖选多元素） | 拖选 | 排期（MVP 后） | ⬜ |
| 区域选择（含空白区） | 拖框任意区域 | 排期 | ⬜ |
| **动画冻结** | 冻结 CSS/JS/视频动画以截取状态 | **照抄**——截瞬态 UI 的杀手锏 | ⬜ 排期 |
| 结构化输出 | markdown: selector + 位置 + 上下文 | 我们的 markdown 兜底格式对齐此思路 | ⬜ MVP |
| agent 无关兜底 | 复制即用，不强制 MCP | **照抄**: MCP 之外永远保留复制兜底 | ✅ 原则确立 |
| 暗色/亮色跟随 | 跟随系统 | 排期 | ⬜ |

## 明确不抄

- **React 18+ 绑定**——Sightline 的立身之本就是框架无关（Dioxus/任意框架）
- **PolyForm Shield 许可**——Sightline 用 MIT
- Chrome 扩展形态（我们走 script 注入）

## 进度记录

- 2026-09-20: 文档建立，能力拆解完成，零依赖/复制兜底两条原则确立。
