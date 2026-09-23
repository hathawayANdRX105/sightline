# Sightline SDK

浏览器侧 SDK，零依赖，原生 DOM API。

> 状态: **占位** — 构建链推后到 schema 落地后决定（见 `docs/architecture.md` §5）。

## 目标

- 一行接入: `<script src="http://127.0.0.1:9420/sdk.js"></script>`
- gzip 后 < 30KB
- 零运行时依赖（不用 lit、不用框架适配器、不用 vite）
- 能力（MVP）:
  - 点击元素 → 生成验证过的 CSS selector（testid → id → class → 位置回退）
  - 选中文本 → 生成 selector + 选区快照
  - POST `/sessions/{id}/sync` 推送到 sidecar
  - EventSource `/sessions/{id}/events` 订阅变更

## 类型单一事实源

SDK 的 TypeScript 类型由 `crates/sightline-schema` 的 specta 派生自动生成到
`sdk/src/types.generated.ts`（M0 阶段实证 specta-typescript 集成）。
**禁止手改生成文件**。

## 待决问题

1. 用 tsc / esbuild / 纯手写 JS？（架构文档 §10.4）
2. 怎么把生成的 sdk.js 嵌进 sidecar 二进制（include_str! vs 构建期拷贝）
