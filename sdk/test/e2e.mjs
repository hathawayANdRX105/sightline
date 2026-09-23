/**
 * End-to-end: 起 sidecar，模拟 SDK 真行为跑一遍标注流程。
 * 不开浏览器，用 fetch（Node 22+ 自带）+ 真实 HTTP。
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_BIN = path.resolve(__dirname, "../../target/release/sightline");

const PORT = 9422;
const sidecar = spawn(SIDECAR_BIN, ["--http-only", "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
});
sidecar.stdout.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));
sidecar.stderr.on("data", (d) => process.stderr.write(`[sidecar] ${d}`));

const cleanup = () => { try { sidecar.kill("SIGTERM"); } catch {} };
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));

try {
  await delay(800);
  const base = `http://127.0.0.1:${PORT}`;

  // ─── 1. 拉 sdk.js 验证嵌入的真 SDK ──────────────────────────────
  const sdkRes = await fetch(`${base}/sdk.js`);
  const sdkText = await sdkRes.text();
  if (!sdkText.startsWith('"use strict"') && !sdkText.includes("Sightline")) {
    throw new Error(`sdk.js 看起来不对: ${sdkText.slice(0, 80)}`);
  }
  console.log(`PASS sdk.js: ${sdkText.length} bytes, 真实 SDK 已嵌入`);

  // ─── 2. bootstrap ───────────────────────────────────────────────
  const bsRes = await fetch(`${base}/bootstrap`, {
    method: "POST",
    headers: { "Origin": "http://localhost:8080", "Content-Type": "application/json" },
    body: "{}",
  });
  if (!bsRes.ok) throw new Error(`bootstrap ${bsRes.status}`);
  const bs = await bsRes.json();
  const { sessionId, token } = bs;
  console.log(`PASS bootstrap: sessionId=${sessionId.slice(0, 8)}…, token=${token.slice(0, 8)}…`);

  // ─── 3. 模拟 SDK 提交一条标注 ──────────────────────────────────
  // 这个 payload 跟 sdk/src/capture.ts 的真实输出格式完全一致
  const annotation = {
    id: crypto.randomUUID(),
    comment: "this button looks broken",
    createdAt: new Date().toISOString(),
    page: {
      url: "http://localhost:8080/",
      title: "demo",
      userAgent: "Mozilla/5.0 (test)",
      capturedAt: new Date().toISOString(),
      viewport: {
        width: 1280, height: 720,
        devicePixelRatio: 1, scrollX: 0, scrollY: 0,
      },
    },
    targets: [{
      id: crypto.randomUUID(),
      selector: "#submit-btn",
      tagName: "button",
      text: "Submit",
      attributes: { "id": "submit-btn", "type": "submit" },
      rect: { x: 100, y: 200, width: 80, height: 32 },
      styles: {
        "color": "rgb(255, 255, 255)",
        "background-color": "rgb(37, 99, 235)",
        "display": "inline-block",
      },
      ancestors: [
        { tagName: "main", attributes: {}, text: "…" },
        { tagName: "body", attributes: {}, text: undefined },
      ],
      nearbyText: { before: "Please submit the form", after: "" },
    }],
  };

  const authHeaders = {
    "Authorization": `Bearer ${token}`,
    "Origin": "http://localhost:8080",
    "Content-Type": "application/json",
  };

  const sync1 = await fetch(`${base}/sessions/${sessionId}/sync`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      sessionId, baseVersion: 0, upsertAnnotations: [annotation],
    }),
  });
  if (!sync1.ok) throw new Error(`sync1 ${sync1.status}: ${await sync1.text()}`);
  const doc1 = await sync1.json();
  if (doc1.version !== 1) throw new Error(`expected version 1, got ${doc1.version}`);
  if (doc1.annotations.length !== 1) throw new Error(`expected 1 annotation`);
  if (doc1.annotations[0].comment !== "this button looks broken") throw new Error("comment mismatch");
  if (doc1.annotations[0].targets[0].selector !== "#submit-btn") throw new Error("selector mismatch");
  if (doc1.annotations[0].targets[0].styles["background-color"] !== "rgb(37, 99, 235)") throw new Error("style mismatch");
  console.log(`PASS sync #1: version=${doc1.version}, annotation.id=${doc1.annotations[0].id.slice(0, 8)}…`);

  // ─── 4. 第二条标注——验证 baseVersion 推进 ───────────────────────
  const ann2 = { ...annotation, id: crypto.randomUUID(), comment: "second issue" };
  const sync2 = await fetch(`${base}/sessions/${sessionId}/sync`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ sessionId, baseVersion: 1, upsertAnnotations: [ann2] }),
  });
  const doc2 = await sync2.json();
  if (doc2.version !== 2 || doc2.annotations.length !== 2) {
    throw new Error(`expected 2 annotations at v2, got v=${doc2.version} n=${doc2.annotations.length}`);
  }
  console.log(`PASS sync #2: version=${doc2.version}, ${doc2.annotations.length} annotations`);

  // ─── 5. 用错误 token 应该 401 ──────────────────────────────────
  const badAuth = await fetch(`${base}/sessions/${sessionId}/sync`, {
    method: "POST",
    headers: { ...authHeaders, "Authorization": "Bearer wrong-token" },
    body: JSON.stringify({ sessionId, baseVersion: 2, upsertAnnotations: [] }),
  });
  if (badAuth.status !== 401) throw new Error(`expected 401 with bad token, got ${badAuth.status}`);
  console.log(`PASS bad token rejected: 401`);

  // ─── 6. 验证 SSE events 在新 sync 后会被推送 ───────────────────
  // 打开 SSE 连接，然后触发一次 sync，应该在事件流里看到 changed
  const eventsUrl = `${base}/sessions/${sessionId}/events`;
  const eventPromise = new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const to = setTimeout(() => { ctrl.abort(); reject(new Error("SSE timeout")); }, 3000);
    (async () => {
      const res = await fetch(eventsUrl, { signal: ctrl.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.includes("event: changed")) {
          clearTimeout(to);
          ctrl.abort();
          resolve("changed");
          return;
        }
      }
    })().catch(() => {});
  });

  await delay(200); // 让 SSE 连接先建立
  await fetch(`${base}/sessions/${sessionId}/sync`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ sessionId, baseVersion: 2, upsertAnnotations: [] }),
  });

  const saw = await eventPromise;
  if (saw !== "changed") throw new Error(`SSE 未推 changed`);
  console.log(`PASS SSE event: 收到 'changed'`);

  // ─── 7. removeAnnotationIds：按 id 删除（工具栏清空 / 编辑器删除用） ──
  // 注意：前面所有 sync 都**没带** removeAnnotationIds 字段——顺带验证
  // 旧 SDK 省略字段的向后兼容（serde default）。
  const rmRes = await fetch(`${base}/sessions/${sessionId}/sync`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      sessionId, baseVersion: 3, upsertAnnotations: [],
      removeAnnotationIds: [annotation.id],
    }),
  });
  if (!rmRes.ok) throw new Error(`remove sync ${rmRes.status}: ${await rmRes.text()}`);
  const doc4 = await rmRes.json();
  if (doc4.version !== 4) throw new Error(`expected version 4 after remove, got ${doc4.version}`);
  if (doc4.annotations.length !== 1) throw new Error(`expected 1 annotation after remove, got ${doc4.annotations.length}`);
  if (doc4.annotations[0].id !== ann2.id) throw new Error("remove 删错了标注（应保留 ann2）");
  console.log(`PASS remove: version=4, 保留 ${doc4.annotations[0].id.slice(0, 8)}…, 删除 ${annotation.id.slice(0, 8)}…`);

  console.log(`\n🎉 所有 E2E 测试通过`);
  process.exit(0);
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
}
