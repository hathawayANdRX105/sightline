#!/usr/bin/env bash
# 启动 leptos demo dev server。
#
# 工具链：cargo + wasm-bindgen-cli + python3 http.server（无 trunk / cargo-leptos 依赖）。
# 详见 README.md 的 "Why no trunk"。

set -euo pipefail
cd "$(dirname "$0")"

PKG_NAME="leptos_demo"
DIST="dist"
PORT="${1:-8080}"
WASM_PATH="target/wasm32-unknown-unknown/release/${PKG_NAME}.wasm"

if ! command -v wasm-bindgen >/dev/null 2>&1; then
    echo "❌ wasm-bindgen-cli 没装"
    echo "   cargo install wasm-bindgen-cli --locked"
    exit 1
fi

echo "📦 1/3 编译 wasm32-unknown-unknown ..."
cargo build --target wasm32-unknown-unknown --release

if [[ ! -f "$WASM_PATH" ]]; then
    echo "❌ 编译产物缺失: $WASM_PATH"
    exit 1
fi

echo "🔧 2/3 wasm-bindgen 转 JS 模块 ..."
rm -rf "$DIST"
mkdir -p "$DIST"
wasm-bindgen \
    --target web \
    --no-typescript \
    --out-dir "$DIST" \
    --out-name "$PKG_NAME" \
    "$WASM_PATH"

# 拷贝静态资源到 dist
cp index.html styles.css "$DIST"/

echo ""
echo "🚀 3/3 起 python http.server 在 :$PORT ..."
echo "    浏览器打开 http://localhost:$PORT/"
echo "    控制台粘一行加载 Sightline SDK:"
echo "      fetch(\"http://127.0.0.1:9420/sdk.js\").then(r=>r.text()).then(eval)"
echo "    然后:"
echo "      await Sightline.start()"
echo ""
cd "$DIST"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
