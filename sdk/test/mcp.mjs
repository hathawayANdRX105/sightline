/**
 * MCP e2e：验证 AI agent 能通过 stdio MCP 读到浏览器经 HTTP 写入的批注。
 *
 * 链路（单进程共享 FeedbackStore —— 架构文档 §4.2 双 transport）：
 *   spawn sightline（默认双模式：HTTP sidecar + MCP stdio，同一个 store）
 *     → HTTP /bootstrap + /sync 写一条标注（模拟浏览器 SDK）
 *     → stdio JSON-RPC（行分隔）: initialize → notifications/initialized
 *        → tools/list → sightline_list_feedback → sightline_get_feedback
 *     → 断言 agent 读回的文档 == 写入的批注（含 selector / page 上下文）
 *
 * 运行：node sdk/test/mcp.mjs   （需先 cargo build --release）
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_BIN = path.resolve(__dirname, "../../target/release/sightline");

const PORT = 9431;
const BASE = `http://127.0.0.1:${PORT}`;
const COMMENT = "MCP e2e：agent 应能读到这条批注";

let checks = 0;
let failures = 0;
function ok(cond, msg) {
  checks++;
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures++;
    console.error(`  ✗ ${msg}`);
  }
}

/** 行分隔 JSON-RPC 客户端（MCP stdio 传输）。 */
function attachRpc(child) {
  const pending = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        console.error("[mcp stdout 非 JSON 行]", line.slice(0, 200));
        continue;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  let nextId = 1;
  const request = (method, params, timeoutMs = 5000) => {
    const id = nextId++;
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`RPC 超时: ${method}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return p;
  };
  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  return { request, notify };
}

// stdin/stdout = MCP 协议；stderr = tracing 日志（main.rs 显式分流）
const sidecar = spawn(SIDECAR_BIN, ["--port", String(PORT)], {
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
sidecar.stderr.on("data", (d) => {
  stderr += d;
});
const cleanup = () => {
  try {
    sidecar.kill("SIGTERM");
  } catch {
    // 已退出
  }
};
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

try {
  const rpc = attachRpc(sidecar);

  // ─── 1. 等 HTTP sidecar 就绪（与 MCP 同进程） ────────────────────────
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try {
      const r = await fetch(`${BASE}/sdk.js`);
      ready = r.ok;
    } catch {
      // 还没起来
    }
    if (!ready) await delay(50);
  }
  ok(ready, `HTTP sidecar 就绪 @ ${PORT}（与 MCP stdio 同进程同 store）`);
  if (!ready) throw new Error("sidecar 未启动，stderr:\n" + stderr);

  // ─── 2. 浏览器 SDK 链路写入一条批注（bootstrap + sync） ───────────────
  const bsRes = await fetch(`${BASE}/bootstrap`, {
    method: "POST",
    headers: { "Origin": "http://localhost:8080", "Content-Type": "application/json" },
    body: "{}",
  });
  if (!bsRes.ok) throw new Error(`bootstrap ${bsRes.status}`);
  const { sessionId, token } = await bsRes.json();
  ok(Boolean(sessionId && token), `HTTP bootstrap: session=${String(sessionId).slice(0, 8)}…`);

  const annotation = {
    id: crypto.randomUUID(),
    comment: COMMENT,
    createdAt: new Date().toISOString(),
    page: {
      url: "http://localhost:8080/",
      title: "demo",
      userAgent: "Mozilla/5.0 (test)",
      capturedAt: new Date().toISOString(),
      viewport: { width: 1280, height: 720, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
    },
    targets: [
      {
        id: crypto.randomUUID(),
        selector: "main > button.cta",
        tagName: "button",
        text: "提交",
        attributes: { class: "cta" },
        rect: { x: 100, y: 200, width: 80, height: 32 },
        styles: { color: "rgb(255, 255, 255)" },
        ancestors: [{ tagName: "main", attributes: {}, text: "…" }],
      },
    ],
  };
  const syncRes = await fetch(`${BASE}/sessions/${sessionId}/sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "http://localhost:8080",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sessionId, baseVersion: 0, upsertAnnotations: [annotation] }),
  });
  if (!syncRes.ok) throw new Error(`sync ${syncRes.status}: ${await syncRes.text()}`);
  const doc0 = await syncRes.json();
  ok(doc0.version === 1 && doc0.annotations.length === 1, "HTTP sync 写入 1 条批注（v1）");

  // ─── 3. MCP initialize ──────────────────────────────────────────────
  console.log("\nMCP 协议链路：");
  const init = await rpc.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "sightline-mcp-e2e", version: "0.0.0" },
  });
  ok(
    init.result?.serverInfo?.name === "sightline",
    `initialize → serverInfo.name=${init.result?.serverInfo?.name}（应用名而非 rmcp）`,
  );
  rpc.notify("notifications/initialized", {});
  ok(
    String(init.result?.instructions ?? "").includes("sightline_list_feedback"),
    "instructions 指引 sightline_list_feedback 发现 session",
  );

  // ─── 4. tools/list ──────────────────────────────────────────────────
  const toolsRes = await rpc.request("tools/list", {});
  const tools = toolsRes.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  ok(names.includes("sightline_list_feedback"), `tools/list 含 sightline_list_feedback（${names.join(", ")}）`);
  ok(names.includes("sightline_get_feedback"), "tools/list 含 sightline_get_feedback");
  ok(names.includes("sightline_get_image"), "tools/list 含 sightline_get_image（post-MVP 占位）");

  const getTool = tools.find((t) => t.name === "sightline_get_feedback");
  const props = getTool?.inputSchema?.properties ?? {};
  const sessionProp = "sessionId" in props ? "sessionId" : "session_id";
  ok(sessionProp === "sessionId", `get_feedback 参数名 = ${sessionProp}（camelCase 约定）`);

  // ─── 5. sightline_list_feedback ─────────────────────────────────────
  const listRes = await rpc.request("tools/call", {
    name: "sightline_list_feedback",
    arguments: {},
  });
  const listJson = JSON.parse(listRes.result.content[0].text);
  ok(
    Array.isArray(listJson) && listJson.some((d) => d.sessionId === sessionId),
    `list 读回 ${Array.isArray(listJson) ? listJson.length : "?"} 个 session，含本 session`,
  );

  // ─── 6. sightline_get_feedback 读回批注本体 ─────────────────────────
  const getRes = await rpc.request("tools/call", {
    name: "sightline_get_feedback",
    arguments: { [sessionProp]: sessionId },
  });
  const got = JSON.parse(getRes.result.content[0].text);
  ok(got.sessionId === sessionId, "get 读回的文档 sessionId 匹配");
  const ann = got.annotations?.[0];
  ok(ann?.comment === COMMENT, "agent 读到批注评论原文");
  ok(ann?.targets?.[0]?.selector === "main > button.cta", "批注含 selector（agent 可定位元素）");
  ok(ann?.page?.url === "http://localhost:8080/", "批注含页面 URL 上下文");
  ok(got.version === 1, "文档版本一致（v1）");

  // ─── 7. 负例：非法 sessionId → 错误回执（不崩） ─────────────────────
  const bad = await rpc.request("tools/call", {
    name: "sightline_get_feedback",
    arguments: { [sessionProp]: "not-a-uuid" },
  });
  ok(
    Boolean(bad.error) || bad.result?.isError === true,
    "非法 sessionId → 协议错误 / isError（进程不崩）",
  );

  console.log(
    `\n${failures ? "FAIL" : "🎉 MCP E2E 通过"}: ${checks - failures}/${checks} 项断言`,
  );
  process.exit(failures ? 1 : 0);
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  console.error(e.stack);
  console.error("--- sidecar stderr ---\n" + stderr);
  process.exit(1);
}
