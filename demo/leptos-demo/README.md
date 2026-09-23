# Leptos × Sightline Demo

最小 Leptos CSR 应用，用来演示 Sightline 标注流程。

## 架构

- 单一 wasm-bindgen 工具链（无 trunk / cargo-leptos 依赖）
- Leptos 0.8 CSR
- demo 启动在 `http://localhost:8080`
- Sightline sidecar 在 `http://127.0.0.1:9420`

## 使用

### 1. 启动 Sightline sidecar

```sh
# 在项目根目录
cargo run --release -- --http-only
```

### 2. 构建 + 启动 demo

```sh
cd demo/leptos-demo
./serve.sh
```

`serve.sh` 会：
- 用 cargo 编译 wasm32-unknown-unknown 目标
- 用 wasm-bindgen-cli 把 wasm 转成 JS 模块
- 起 python http server 在 8080

### 3. 浏览器里跑

打开 `http://localhost:8080`，按 F12 进控制台，粘这一行加载 Sightline SDK：

```js
fetch("http://127.0.0.1:9420/sdk.js").then(r=>r.text()).then(eval)
// 然后启动:
await Sightline.start()
```

接下来：
- **Alt + Shift + A**（或点右下角 Sightline 图标）→ 展开工具栏、进入批注模式
- 悬停元素显示青色虚线框 → **点击**任意元素 / 选中一段文字 → 弹出评论编辑浮层 → 提交标注
- 编辑器开着时：**Shift + 点击**并入第二个目标；**普通外部点击**收起并保留草稿，下次点击恢复
- 模式中**按住 Alt = 穿透**给页面（正常交互）；**Esc** 依次收起编辑器（保留草稿）/ 退出模式
- **选中文本** → 弹出反馈框 → 提交标注
- 工具栏**复制** = Markdown 交接文本（Settings 里可切 Compact/Standard/Detailed/Everything 四档）；导出 / 清空只作用于当前页面

### 4. AI agent 端读

任何 MCP 客户端配 sightline 二进制作为 stdio MCP server 后，调：
- `sightline_list_feedback` → 看到当前 session
- `sightline_get_feedback(sessionId)` → 拿到带 selector / rect / styles 的完整反馈文档

## 为什么这个 demo 不用 trunk / cargo-leptos

 trunk 当前版本（0.21.x）依赖 libdeflate-sys，而 libdeflate 用了 GCC 14+ 才有的 `evex512` target attribute；本机 GCC 16 编译失败。绕开它直接用 wasm-bindgen-cli 反而更轻——少了一个工具依赖，构建脚本 `serve.sh` 完全透明可读。
