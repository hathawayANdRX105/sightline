/**
 * 端到端验证 SDK 完整标注 UX（jsdom + 真实 bundle）。
 *
 * 这个测试存在的根本原因：SDK 出过两类没被本地测试拦住的 bug——
 *   1. esbuild minify 把 \n 压成字面 newline → Firefox 跨域 eval 拒掉 bundle；
 *   2. 修饰键属性名写错（alt vs altKey）→ handler 永远早返回。
 * 后又出过两类用户在真浏览器里才发现的问题：
 *   3. 评论输入用 window.prompt（非 UI 组件，违背 ainotation 移植目标）；
 *   4. 快捷键用错（应为 ainotation 的 Alt+Shift+A）。
 * 所以此测试把交互结构整体锁住：
 *   Alt+Shift+A 进模式 → 虚线 hover → Alt 穿透 → 点击弹 popover（非 prompt）→
 *   外部点击收起草稿 → 下次点击恢复草稿 → Shift 并入多目标 → 保存出 marker →
 *   点 marker 编辑 → 删除 → Esc 分级 → 清空 → 复制（Markdown 四档 + toast 回执）→
 *   导出 / 会话信息 / 档位选择 → 关闭 → stop 清场。
 * window.prompt/alert/confirm 被替换成"调用即抛错"，谁用谁挂。
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "fs";
import { strict as assert } from "assert";

const SDK = readFileSync(new URL("../dist/sdk.js", import.meta.url), "utf8");

// ─── 模拟 sidecar 的最小响应器（upsert-by-id + removeAnnotationIds） ────
function makeFakeServer() {
  let version = 0;
  const annotations = [];
  const calls = { bootstrap: 0, sync: 0, syncBodies: [] };
  return {
    calls,
    annotations,
    async handle(path, opts) {
      if (path === "/bootstrap") {
        calls.bootstrap++;
        return {
          sessionId: "test-session-id",
          token: "test-token",
          endpoint: "http://127.0.0.1:9420",
          document: {
            schemaVersion: 1,
            sessionId: "test-session-id",
            version: 0,
            annotations: [],
            updatedAt: "2026-01-01T00:00:00Z",
          },
        };
      }
      const m = path.match(/^\/sessions\/[^/]+\/sync$/);
      if (m) {
        calls.sync++;
        const body = JSON.parse(opts.body);
        calls.syncBodies.push(body);
        // 先删后插（同 Rust store 语义）
        for (const id of body.removeAnnotationIds ?? []) {
          const idx = annotations.findIndex((a) => a.id === id);
          if (idx >= 0) annotations.splice(idx, 1);
        }
        for (const a of body.upsertAnnotations ?? []) {
          const idx = annotations.findIndex((x) => x.id === a.id);
          if (idx >= 0) annotations[idx] = a;
          else annotations.push(a);
        }
        version++;
        return {
          schemaVersion: 1,
          sessionId: "test-session-id",
          version,
          annotations: annotations.slice(),
          updatedAt: new Date().toISOString(),
        };
      }
      throw new Error(`unhandled path ${path}`);
    },
  };
}

async function main() {
  const server = makeFakeServer();

  const vc = new VirtualConsole();
  const logs = [];
  vc.on("log", (...args) => logs.push(args.join(" ")));
  vc.on("error", (...args) => logs.push("ERR " + args.join(" ")));
  vc.on("warn", (...args) => logs.push("WARN " + args.join(" ")));

  const dom = new JSDOM(
    `<!DOCTYPE html><html><body>
       <button data-testid="target">Click me</button>
       <p id="para">Some paragraph text for a second target</p>
     </body></html>`,
    { url: "http://localhost:8080/", runScripts: "outside-only", virtualConsole: vc },
  );
  const { window } = dom;
  const doc = window.document;

  // fetch → fake server
  window.fetch = async (url, opts = {}) => {
    const u = new URL(url, "http://127.0.0.1:9420");
    const json = await server.handle(u.pathname + u.search, opts);
    return {
      ok: true,
      status: 200,
      json: async () => json,
      text: async () => JSON.stringify(json),
    };
  };

  // 评论输入绝不能走原生弹窗——谁调谁炸
  window.prompt = () => {
    throw new Error("window.prompt 不允许被调用（评论输入必须是 UI 组件）");
  };
  window.alert = () => {
    throw new Error("window.alert 不允许被调用");
  };
  window.confirm = () => {
    throw new Error("window.confirm 不允许被调用");
  };

  // 注入 SDK（模拟 <script src="...sdk.js">）
  const vm = await import("vm");
  const ctx = dom.getInternalVMContext();
  ctx.Sightline = undefined;
  vm.runInContext(SDK, ctx);

  const target = doc.querySelector('[data-testid="target"]');
  const para = doc.querySelector("#para");
  const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
  const overlay = () => doc.querySelector(".sl-overlay");
  const popover = () => doc.querySelector(".sl-popover");
  const markers = () => doc.querySelectorAll(".sl-marker");
  const toolbar = () => doc.querySelector(".sl-toolbar");
  const launcher = () => doc.querySelector(".sl-launcher");
  const dispatchKey = (init) =>
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  const dispatchMove = (el, init = {}) =>
    el.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, cancelable: true, ...init }));
  const dispatchClick = (el, init = {}) =>
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
  const typeInto = (textarea, value) => {
    textarea.value = value;
    textarea.dispatchEvent(new window.Event("input", { bubbles: true }));
  };

  // ─── 1. window.Sightline 已定义 ──────────────────────────────────────
  assert.equal(typeof window.Sightline, "object", "window.Sightline 应该是个 object");
  for (const k of ["start", "stop", "submitAnnotation", "selectorFor", "setPicking"]) {
    assert.equal(typeof window.Sightline[k], "function", `Sightline.${k} 应该是 function`);
  }
  console.log("✓ 1. window.Sightline =", Object.keys(window.Sightline).sort().join(","));

  // ─── 2. start() → bootstrap + shell 挂载（collapsed）──────────────────
  const document0 = await window.Sightline.start();
  assert.equal(server.calls.bootstrap, 1, "bootstrap 应该被调一次");
  assert.equal(document0.sessionId, "test-session-id");
  assert.ok(launcher(), "launcher 应该存在");
  assert.equal(toolbar().hidden, true, "初始 toolbar 应该收起");
  assert.equal(launcher().hidden, false, "初始 launcher 应该可见");
  const styleTag = doc.getElementById("sightline-ui-style");
  assert.ok(styleTag, "样式表应该挂载");
  assert.match(styleTag.textContent, /1px dashed #06b6d4/, "overlay 虚线样式应在样式表里");
  assert.match(styleTag.textContent, /sl-marker/, "marker 样式应在样式表里");
  // 模式未开启时 mousemove 不该创建 overlay
  dispatchMove(target);
  assert.equal(overlay(), null, "模式外 mousemove 不创建 overlay");
  console.log("✓ 2. start → bootstrap×1，shell collapsed，样式表挂载");

  // ─── 3. Alt+Shift+A 进入批注模式 → toolbar 展开 + hover 虚线 ──────────
  // jsdom 无布局，stub 真实 rect（零尺寸不显示 overlay）
  const rect = { x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 70, width: 100, height: 50, toJSON: () => ({}) };
  target.getBoundingClientRect = () => rect;
  para.getBoundingClientRect = () => ({ ...rect, x: 200, left: 200, right: 400 });

  dispatchKey({ key: "A", code: "KeyA", altKey: true, shiftKey: true });
  assert.equal(toolbar().hidden, false, "Alt+Shift+A 应该展开 toolbar");
  assert.equal(launcher().hidden, true, "展开后 launcher 隐藏（ainotation shell 行为）");
  assert.equal(doc.body.style.cursor, "crosshair", "批注模式下光标为十字");

  dispatchMove(target);
  const ov = overlay();
  assert.ok(ov, "模式内 mousemove 应该创建 overlay");
  assert.equal(ov.style.opacity, "1", "overlay 可见");
  assert.equal(ov.style.left, "10px");
  assert.equal(ov.style.width, "100px");
  assert.equal(ov.style.height, "50px");
  console.log("✓ 3. Alt+Shift+A 展开 toolbar，hover 显示虚线 overlay（100×50）");

  // ─── 4. Alt 按住 = 穿透（点击不开编辑器、overlay 收起）────────────────
  dispatchMove(target, { altKey: true });
  assert.equal(overlay().style.opacity, "0", "按住 Alt overlay 收起（passthrough）");
  dispatchClick(target, { altKey: true });
  assert.equal(popover(), null, "Alt+click 穿透给页面，不弹编辑器");
  assert.equal(server.calls.sync, 0, "Alt+click 不触发 sync");
  dispatchMove(target); // 恢复
  assert.equal(overlay().style.opacity, "1", "松开 Alt 恢复 overlay");
  console.log("✓ 4. Alt = passthrough（不拾取、overlay 收起）");

  // ─── 5. 点击 → 编辑 popover（真 UI，非 prompt）+ 外部点击收起 + Shift 并入 ──
  dispatchClick(target);
  assert.ok(popover(), "点击应该弹出编辑 popover（非 window.prompt）");
  assert.ok(popover().querySelector("textarea"), "popover 里应该有 textarea");
  assert.equal(popover().querySelector("textarea").value, "", "新标注草稿初始为空");
  assert.equal(popover().querySelector(".sl-primary").disabled, true, "空草稿时提交禁用");
  assert.equal(popover().querySelectorAll(".sl-target").length, 1, "目标列表 1 项");

  // 普通外部点击 = 收起并保留草稿（同 ainotation），下一次点击才重新选取
  typeInto(popover().querySelector("textarea"), "draft to keep");
  dispatchClick(para);
  assert.equal(popover(), null, "编辑器开着时普通外部点击 → 收起");
  assert.equal(server.calls.sync, 0, "收起不触发 sync");
  dispatchClick(target);
  assert.ok(popover(), "下一次点击才重新选取");
  assert.equal(popover().querySelector("textarea").value, "draft to keep", "重开恢复保留的草稿");
  assert.equal(popover().querySelectorAll(".sl-target").length, 1, "重新选取 = 1 个目标");

  // Shift+点击 → 第二个目标并入（同 ainotation Shift 多选）
  dispatchClick(para, { shiftKey: true });
  assert.equal(popover().querySelectorAll(".sl-target").length, 2, "Shift+点击 → 目标列表 2 项");
  assert.match(popover().querySelectorAll(".sl-target code")[1].textContent, /para/, "第二个目标 selector 指向 #para");
  console.log("✓ 5. 点击 → popover / 外部点击收起草稿并恢复 / Shift 并入多目标");

  // ─── 6. 输入评论 → 提交 → sync + marker ──────────────────────────────
  const textarea = popover().querySelector("textarea");
  typeInto(textarea, "test comment");
  assert.equal(popover().querySelector(".sl-primary").disabled, false, "有内容后提交可用");
  popover().querySelector(".sl-primary").click();
  await tick();

  assert.equal(server.calls.sync, 1, "提交触发一次 sync");
  assert.deepEqual(server.calls.syncBodies[0].removeAnnotationIds, [], "新建标注不带删除");
  assert.equal(server.annotations.length, 1, "服务端应有 1 条标注");
  const ann = server.annotations[0];
  assert.equal(ann.comment, "test comment");
  assert.equal(ann.targets.length, 2, "提交的标注含 2 个目标");
  assert.equal(ann.targets[0].tagName, "button");
  assert.match(ann.targets[0].selector, /target/, "selector 应针对 testid 目标");
  assert.equal(popover(), null, "提交后 popover 关闭");

  assert.equal(markers().length, 1, "提交后应有 1 个 marker pin");
  assert.equal(markers()[0].textContent, "1", "marker 编号为 1");
  assert.equal(markers()[0].style.left, "60px", "marker 锚在 targets[0] 中心（页面坐标 60）");
  assert.equal(markers()[0].style.top, "45px");
  console.log("✓ 6. 提交 → sync#1（2 目标）→ marker #1 @ (60,45)");

  // ─── 7. 点 marker → 编辑已有标注 ─────────────────────────────────────
  markers()[0].click();
  assert.ok(popover(), "点 marker 应重开 popover");
  assert.equal(popover().querySelector("textarea").value, "test comment", "编辑器回填原评论");
  assert.ok(popover().querySelector('[data-sl="delete"]'), "编辑模式显示删除按钮");
  assert.equal(popover().querySelectorAll(".sl-target").length, 2, "编辑器回填原目标列表");

  // ─── 8. Cmd+Enter 提交编辑 → upsert 同 id 替换 ───────────────────────
  typeInto(popover().querySelector("textarea"), "v2 comment");
  popover().querySelector("textarea").dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }),
  );
  await tick();
  assert.equal(server.calls.sync, 2, "编辑提交触发 sync#2");
  assert.equal(server.annotations.length, 1, "编辑是替换不是追加");
  assert.equal(server.annotations[0].comment, "v2 comment");
  assert.equal(server.annotations[0].id, ann.id, "同 id 替换");
  assert.equal(markers().length, 1, "marker 数量不变");
  console.log("✓ 7-8. marker → 编辑回填 → Cmd+Enter 替换（sync#2）");

  // ─── 8b. 复制 = Markdown 交接文本（ainotation copyProjectFeedback）+ toast ──
  let clipboardText = null;
  Object.defineProperty(window.navigator, "clipboard", {
    value: { writeText: async (t) => { clipboardText = t; } },
    configurable: true,
  });
  toolbar().querySelector('[data-sl="copy"]').click();
  await tick();
  assert.ok(clipboardText, "复制应该写入剪贴板");
  assert.match(clipboardText, /^# Page feedback$/m, "载荷是 Markdown（# Page feedback 组头）");
  assert.match(clipboardText, /^## 1\. Annotation \(/m, "standard 档有 ## Annotation 分节");
  assert.match(clipboardText, /v2 comment/, "Markdown 含评论原文");
  assert.match(clipboardText, /^### Target 1$/m, "Markdown 含目标块");
  assert.match(clipboardText, /^Selector: /m, "目标块含 Selector 行（agent 可定位）");
  assert.match(clipboardText, /^Page: http:\/\/localhost:8080\//m, "按页面 URL 分组");
  let toast = doc.querySelector(".sl-toast");
  assert.ok(toast, "复制后应有 toast 回执");
  assert.equal(toast.dataset.kind, "ok", "成功回执 kind=ok");
  assert.match(toast.textContent, /已复制 1 条标注/, "toast 含条数");
  assert.match(toast.textContent, /Standard/, "toast 含当前档位");

  // Settings 切 Compact 档 → 复制走紧凑单行；档位持久化
  toolbar().querySelector('[data-sl="settings"]').click();
  let settingsEl = doc.querySelector(".sl-settings");
  assert.ok(settingsEl, "Settings 打开");
  const detailSelect = settingsEl.querySelector('[data-sl="output-detail"]');
  assert.ok(detailSelect, "Settings 含复制输出详细度选择器");
  assert.equal(detailSelect.value, "standard", "默认 Standard 档");
  detailSelect.value = "compact";
  detailSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(window.localStorage.getItem("sightline.outputDetail"), "compact", "档位持久化 localStorage");
  settingsEl.querySelector('[data-sl="settings-close"]').click();
  clipboardText = null;
  toolbar().querySelector('[data-sl="copy"]').click();
  await tick();
  assert.match(clipboardText, /^\d+\. "button"/m, "compact 档 = 紧凑单行");
  assert.ok(!clipboardText.includes("### Target 1"), "compact 档不含 ### 分层");

  // 恢复 Standard 档，避免影响后续
  toolbar().querySelector('[data-sl="settings"]').click();
  settingsEl = doc.querySelector(".sl-settings");
  const detailSelectBack = settingsEl.querySelector('[data-sl="output-detail"]');
  detailSelectBack.value = "standard";
  detailSelectBack.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(window.localStorage.getItem("sightline.outputDetail"), "standard", "恢复 Standard 档");
  settingsEl.querySelector('[data-sl="settings-close"]').click();
  console.log("✓ 8b. 复制=Markdown（standard/compact 两档）+ ok toast + 档位持久化");

  // ─── 9. 删除按钮 → removeAnnotationIds ───────────────────────────────
  markers()[0].click();
  popover().querySelector('[data-sl="delete"]').click();
  await tick();
  assert.equal(server.calls.sync, 3, "删除触发 sync#3");
  assert.deepEqual(server.calls.syncBodies[2].removeAnnotationIds, [ann.id], "删除走 removeAnnotationIds");
  assert.equal(server.annotations.length, 0, "服务端标注已删");
  assert.equal(markers().length, 0, "marker 已清");
  assert.equal(popover(), null, "删除后 popover 关闭");

  // ─── 10. Esc 分级关闭：先收编辑器（保留草稿），下次点击重开 ────────────
  dispatchClick(target);
  assert.ok(popover(), "点击又打开编辑器");
  dispatchKey({ key: "Escape" });
  assert.equal(popover(), null, "Esc 先收编辑器");
  assert.equal(server.calls.sync, 3, "收起不触发 sync");
  assert.equal(toolbar().hidden, false, "编辑器开着时 Esc 不退出模式");
  dispatchClick(target);
  assert.ok(popover(), "Esc 收起后下一次点击重新选取");
  dispatchKey({ key: "Escape" });
  assert.equal(popover(), null, "再按 Esc 收起，进入下一步");
  assert.equal(server.calls.sync, 3, "两次收起都不触发 sync");

  // ─── 11. 新建一条 → 工具栏清空 ───────────────────────────────────────
  dispatchClick(target);
  typeInto(popover().querySelector("textarea"), "to clear");
  popover().querySelector(".sl-primary").click();
  await tick();
  assert.equal(server.calls.sync, 4, "sync#4");
  const clearTargetId = server.calls.syncBodies[3].upsertAnnotations[0].id;
  assert.equal(markers().length, 1, "清空前有 1 个 marker");
  const clearBtn = toolbar().querySelector('[data-sl="clear"]');
  assert.equal(clearBtn.disabled, false, "有标注时清空按钮可用");
  clearBtn.click();
  await tick();
  assert.equal(server.calls.sync, 5, "清空触发 sync#5");
  assert.deepEqual(server.calls.syncBodies[4].removeAnnotationIds, [clearTargetId], "清空按 id 批量删除");
  assert.equal(server.annotations.length, 0, "服务端已清空");
  assert.equal(markers().length, 0, "marker 已清空");
  assert.equal(clearBtn.disabled, true, "清空后按钮禁用");
  console.log("✓ 9-11. 删除 / Esc 分级关闭 / 清空（removeAnnotationIds 批量）");

  // ─── 12. 0 标注时复制/导出给 info 回执，不写剪贴板、不抛错 ─────────────
  clipboardText = null;
  toolbar().querySelector('[data-sl="copy"]').click();
  await tick();
  assert.equal(clipboardText, null, "0 标注时复制不写剪贴板");
  assert.equal(doc.querySelector(".sl-toast").dataset.kind, "info", "0 标注复制 → info 回执");
  toolbar().querySelector('[data-sl="export"]').click();
  await tick();
  console.log("✓ 12. 0 标注时复制/导出 → info 回执且不抛错（剪贴板 / createObjectURL 缺失有降级）");

  // ─── 13. 会话信息浮层开关 ────────────────────────────────────────────
  toolbar().querySelector('[data-sl="settings"]').click();
  const settings = doc.querySelector(".sl-settings");
  assert.ok(settings, "会话信息浮层应该出现");
  assert.match(settings.textContent, /test-session-id/, "浮层展示 sessionId");
  settings.querySelector('[data-sl="settings-close"]').click();
  assert.equal(doc.querySelector(".sl-settings"), null, "会话信息浮层可关闭");
  console.log("✓ 13. 会话信息浮层开 / 关");

  // ─── 14. 关闭按钮 → 退出模式 ─────────────────────────────────────────
  toolbar().querySelector('[data-sl="close"]').click();
  assert.equal(toolbar().hidden, true, "关闭后 toolbar 收起");
  assert.equal(launcher().hidden, false, "关闭后 launcher 回来");
  assert.equal(doc.body.style.cursor, "", "光标恢复");
  dispatchMove(target);
  assert.equal(overlay().style.opacity, "0", "模式外 hover 不显示 overlay");
  // 模式外点击不弹编辑器
  dispatchClick(target);
  assert.equal(popover(), null, "模式外点击不开编辑器");
  console.log("✓ 14. 关闭按钮退出模式（toolbar 收起、hover/点击失效）");

  // ─── 15. 再次 Alt+Shift+A 重进 + Esc 退出 ────────────────────────────
  dispatchKey({ key: "A", code: "KeyA", altKey: true, shiftKey: true });
  assert.equal(toolbar().hidden, false, "Alt+Shift+A 重进模式");
  dispatchKey({ key: "Escape" });
  assert.equal(toolbar().hidden, true, "Esc 退出模式");
  console.log("✓ 15. Alt+Shift+A / Esc 双向切换");

  // ─── 16. stop() 清场 ─────────────────────────────────────────────────
  window.Sightline.stop();
  assert.equal(doc.querySelector(".sl-launcher"), null, "launcher 已移除");
  assert.equal(doc.querySelector(".sl-toolbar"), null, "toolbar 已移除");
  assert.equal(doc.querySelector(".sl-markers"), null, "marker 层已移除");
  assert.equal(doc.querySelector(".sl-overlay"), null, "overlay 已移除");
  assert.equal(doc.getElementById("sightline-ui-style"), null, "样式表已移除");
  assert.equal(doc.querySelector(".sl-toast"), null, "toast 已移除");
  assert.equal(doc.body.style.cursor, "", "光标已恢复");
  console.log("✓ 16. stop() 清场（launcher/toolbar/markers/overlay/style/toast 全部移除）");

  console.log("\n🎉 所有端到端断言通过");
  console.log("   bootstrap:", server.calls.bootstrap, "| sync:", server.calls.sync, "| annotations:", server.annotations.length);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
