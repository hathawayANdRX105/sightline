//! 构建前置检查：`sdk/dist/sdk.js` 必须先生成——`src/http.rs` 用
//! `include_str!` 把它嵌进二进制服务 `/sdk.js`。
//!
//! 构建顺序（CI 与本地一致）：
//!     cd sdk && npm ci && npm run build
//!     cargo build --release
fn main() {
    let sdk = std::path::Path::new("sdk/dist/sdk.js");
    if !sdk.exists() {
        panic!(
            "\n\n缺少 sdk/dist/sdk.js（HTTP /sdk.js 用 include_str! 嵌入它）。\n\
             先构建 SDK 再跑 cargo：\n    cd sdk && npm ci && npm run build\n"
        );
    }
    println!("cargo:rerun-if-changed=sdk/dist/sdk.js");
}
