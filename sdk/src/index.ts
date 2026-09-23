/**
 * Sightline SDK — 浏览器侧标注采集器（零依赖）
 *
 * 接入方式（详见 docs/architecture.md §9b）:
 *   Tier 1: 浏览器控制台粘一行（任何框架都能用）:
 *     fetch("http://127.0.0.1:9420/sdk.js").then(r=>r.text()).then(eval)
 *   或 bookmarklet、devtools snippet、<script src> 自动加载。
 *   Tier 2（post-MVP）: 在 Cargo.toml 加 [dev-dependencies] sightline-dev。
 *
 * 使用（交互结构整体移植自 ainotation packages/sdk/src/ui/core）:
 *   await window.Sightline.start();
 *   // Alt+Shift+A（或点右下角 launcher）→ 展开工具栏并进入批注模式
 *   // 悬停元素显示青色虚线框；点击元素 / 选中文字 → 弹出评论编辑浮层
 *   // 浮层是真 DOM 组件（目标列表 + textarea + 取消/提交/删除），不用 window.prompt
 *   // 模式中按住 Alt = 事件穿透给页面（passthrough，同 ainotation）
 *   // 编辑器开着时：Shift+点击并入目标；普通外部点击收起并保留草稿；下次点击才重新选取
 *   // Esc：先收编辑浮层（保留草稿），再退出批注模式
 *   // 提交后锚点位置留 24px 编号 marker，点击可再次编辑 / 删除
 *   // 工具栏：复制 Markdown（四档详细度）/ 导出当前页面 JSON / 清空当前页面 /
 *   //         设置与会话信息（含输出详细度档位）/ 退出
 */

import type { FeedbackDocument, Annotation, TargetSnapshot } from "./types.generated";
import { bootstrap, syncFeedback } from "./transport";
import { selectorFor } from "./selector";
import { captureTarget, captureTextSelection } from "./capture";
import {
  mountShell,
  type ShellHandle,
  openEditor,
  type EditorHandle,
  type EditorTargetView,
  showOverlay,
  hideOverlay,
  destroyOverlay,
  mountMarkerLayer,
  type MarkerLayer,
  type MarkerView,
  showSettingsPanel,
  destroyUiStyle,
  shellMessage,
  destroyMessage,
} from "./ui";
import {
  feedbackMarkdown,
  OUTPUT_DETAIL_OPTIONS,
  isOutputDetail,
  type OutputDetail,
} from "./markdown";

export type { FeedbackDocument, Annotation, TargetSnapshot } from "./types.generated";

export interface StartOptions {
  /** Sidecar 端点。默认自动探测 http://127.0.0.1:9420。 */
  endpoint?: string;
}

interface SessionState {
  endpoint: string;
  sessionId: string;
  token: string;
  document: FeedbackDocument;
}

let session: SessionState | null = null;
let active = false;
/** picking 模式 ⇔ shell 展开（Alt+Shift+A 或 launcher 切换；Esc / X 退出） */
let picking = false;

let shell: ShellHandle | null = null;
let markerLayer: MarkerLayer | null = null;
let editor: EditorHandle | null = null;
/** 当前编辑器的目标列表（提交时整体 upsert；模式中继续点击会并入） */
let editorTargets: TargetSnapshot[] = [];
let editingId: string | null = null;
let settingsClose: (() => void) | null = null;
/** 复制输出详细度（ainotation OutputDetail 四档，默认 standard；Settings 可切） */
let outputDetail: OutputDetail = loadOutputDetail();
/** 编辑器草稿暂存：收起（外部点击 / Esc）时保留，重开恢复（同 ainotation draft） */
let draftStash = "";

let clickListener: ((e: MouseEvent) => void) | null = null;
let mousemoveListener: ((e: MouseEvent) => void) | null = null;
let selectionListener: ((e: MouseEvent) => void) | null = null;
let keydownListener: ((e: KeyboardEvent) => void) | null = null;
let viewportListener: (() => void) | null = null;

const log = (...args: unknown[]) => console.log("%c[sightline]", "color:#06b6d4", ...args);
const warn = (...args: unknown[]) => console.warn("%c[sightline]", "color:#f59e0b", ...args);

const OUTPUT_DETAIL_KEY = "sightline.outputDetail";

function loadOutputDetail(): OutputDetail {
  try {
    const v = localStorage.getItem(OUTPUT_DETAIL_KEY);
    if (isOutputDetail(v)) return v;
  } catch {
    // localStorage 不可用（隐私模式 / file://）→ 回退默认
  }
  return "standard";
}

function saveOutputDetail(detail: OutputDetail): void {
  try {
    localStorage.setItem(OUTPUT_DETAIL_KEY, detail);
  } catch {
    // 档位只影响复制；存不上就每次用默认，不打断
  }
}

/** 启动 SDK。会去 sidecar /bootstrap 一次性拿 token 和 session。 */
export async function start(opts: StartOptions = {}): Promise<FeedbackDocument> {
  if (session) {
    warn("already started; call stop() first");
    return session.document;
  }
  const endpoint = opts.endpoint ?? guessEndpoint();

  log("bootstrapping from", endpoint);
  const bs = await bootstrap(endpoint);
  session = {
    endpoint,
    sessionId: bs.sessionId,
    token: bs.token,
    document: bs.document,
  };
  log("session ready:", bs.sessionId, "— Alt+Shift+A 进入批注模式");

  attachPickers();
  return bs.document;
}

/** 停止 SDK；移除所有监听器和 UI。 */
export function stop(): void {
  detachPickers();
  session = null;
  active = false;
  log("stopped");
}

/**
 * 切换批注模式（shell 展开 ⇔ picking）。
 * 与启动快捷键 Alt+Shift+A、launcher 点击走同一条路径。
 */
export function setPicking(on: boolean): void {
  if (!session) {
    warn("setPicking ignored; call start() first");
    return;
  }
  if (picking === on) return;
  picking = on;
  shell?.setExpanded(on);
  document.body.style.cursor = on ? "crosshair" : "";
  if (on) {
    closeSettings();
  } else {
    hideOverlay();
    closeEditor();
    closeSettings();
  }
  log(on ? "批注模式开启 — 悬停预览，点击标注（Alt 穿透，Esc 退出）" : "批注模式关闭");
}

/** 显式提交一条标注（高级用法；通常用户直接点 UI 就行）。 */
export async function submitAnnotation(comment: string, elements: Element[]): Promise<FeedbackDocument> {
  if (!session) throw new Error("Sightline not started; call start() first");
  if (!elements.length) throw new Error("need at least one target element");

  const targets: TargetSnapshot[] = elements.map((el) => captureTarget(el));
  const annotation: Annotation = {
    id: cryptoRandomUuid(),
    comment,
    createdAt: new Date().toISOString(),
    page: capturePage(),
    targets,
  };

  const updated = await syncFeedback(session, {
    sessionId: session.sessionId,
    baseVersion: session.document.version,
    upsertAnnotations: [annotation],
    removeAnnotationIds: [],
  });
  session.document = updated;
  refreshMarkers();
  log("annotation submitted; document now at version", updated.version);
  return updated;
}

// ─── 内部实现 ────────────────────────────────────────────────────────────

function attachPickers(): void {
  if (active) return;
  active = true;

  shell = mountShell({
    onToggle: () => setPicking(true),
    onClose: () => setPicking(false),
    onCopy: () => void copyFeedbackMarkdown(),
    onExport: () => exportDocumentJson(),
    onClear: () => void clearCurrentPageAnnotations(),
    onSettings: () => toggleSettings(),
  });
  markerLayer = mountMarkerLayer();
  refreshMarkers();

  // 点击 → 打开/并入编辑器。Alt 按住 = passthrough（事件给页面，同 ainotation）。
  clickListener = (e: MouseEvent) => {
    if (!picking || e.altKey) return;
    // 文本选区拖拽产生的 click：交给 selection 流程接管，不劫持
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount > 0) return;
    const target = e.target as Element | null;
    if (!target || isSightlineUi(target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (editor) {
      if (e.shiftKey) {
        // Shift+点击：目标并入打开中的编辑器（同 ainotation Shift 多选）
        handleMergePick(target);
      } else {
        // 普通外部点击：收起并保留草稿，下一次点击才重新选取（同 ainotation）
        closeEditor();
        log("编辑器收起，草稿已保留");
      }
      return;
    }
    handlePick(target, e.clientX, e.clientY);
  };
  document.addEventListener("click", clickListener, true);

  // 悬停 → 虚线 overlay（picking 且未按 Alt 时）
  mousemoveListener = (e: MouseEvent) => {
    if (!picking || e.altKey) {
      hideOverlay();
      return;
    }
    const target = e.target as Element | null;
    if (!target || isSightlineUi(target)) {
      hideOverlay();
      return;
    }
    showOverlay(target);
  };
  document.addEventListener("mousemove", mousemoveListener, true);

  // 选区：picking 中选中一段文字松开 → 打开编辑器（目标 = textSelection 快照）
  selectionListener = (e: MouseEvent) => {
    if (!picking || e.altKey) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const el = container.nodeType === Node.ELEMENT_NODE
      ? (container as Element)
      : container.parentElement;
    if (!el || isSightlineUi(el)) return;
    const text = sel.toString().trim();
    if (!text) return;
    openEditorFor([captureTextSelection(sel, el)], { x: e.clientX, y: e.clientY });
  };
  document.addEventListener("mouseup", selectionListener, true);

  // 快捷键：Alt+Shift+A 切换批注模式；Alt = 穿透；Esc 分级关闭
  keydownListener = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (e.altKey && e.shiftKey && (e.code === "KeyA" || e.key === "a" || e.key === "A")) {
      e.preventDefault();
      e.stopPropagation();
      setPicking(!picking);
      return;
    }
    // 按住 Alt 立刻收起 overlay（穿透中不显示拾取框）
    if (e.key === "Alt") hideOverlay();
    if (e.key === "Escape") {
      if (editor) {
        e.preventDefault();
        e.stopPropagation();
        closeEditor();
        return;
      }
      if (settingsClose) {
        e.preventDefault();
        e.stopPropagation();
        closeSettings();
        return;
      }
      if (picking) {
        e.preventDefault();
        e.stopPropagation();
        setPicking(false);
      }
    }
  };
  document.addEventListener("keydown", keydownListener, true);

  // 滚动/缩放 → overlay 失效收起，marker 按新 scroll 重定位
  viewportListener = () => {
    hideOverlay();
    refreshMarkers();
  };
  window.addEventListener("scroll", viewportListener, { capture: true, passive: true });
  window.addEventListener("resize", viewportListener);
}

function detachPickers(): void {
  if (clickListener) {
    document.removeEventListener("click", clickListener, true);
    clickListener = null;
  }
  if (mousemoveListener) {
    document.removeEventListener("mousemove", mousemoveListener, true);
    mousemoveListener = null;
  }
  if (selectionListener) {
    document.removeEventListener("mouseup", selectionListener, true);
    selectionListener = null;
  }
  if (keydownListener) {
    document.removeEventListener("keydown", keydownListener, true);
    keydownListener = null;
  }
  if (viewportListener) {
    window.removeEventListener("scroll", viewportListener, { capture: true });
    window.removeEventListener("resize", viewportListener);
    viewportListener = null;
  }
  closeEditor();
  closeSettings();
  shell?.destroy();
  shell = null;
  markerLayer?.destroy();
  markerLayer = null;
  destroyOverlay();
  destroyUiStyle();
  destroyMessage();
  draftStash = "";
  picking = false;
  document.body.style.cursor = "";
}

// ─── 拾取 → 编辑器 ──────────────────────────────────────────────────────

function handlePick(el: Element, x: number, y: number): void {
  openEditorFor([captureTarget(el)], { x, y });
}

/** Shift+点击：向打开中的编辑器并入目标（多目标标注，同 ainotation target list）。 */
function handleMergePick(el: Element): void {
  if (!editor) return;
  const target = captureTarget(el);
  const dup = editorTargets.some(
    (t) => t.selector === target.selector && t.tagName === target.tagName,
  );
  if (dup) return;
  editorTargets.push(target);
  editor.setTargets(editorTargets.map(targetView));
  shellMessage(`已并入目标（共 ${editorTargets.length} 个）`, "info");
}

function openEditorFor(
  targets: TargetSnapshot[],
  anchor: { x: number; y: number },
  existing?: { id: string },
): void {
  closeEditor();
  if (!session) return;
  editorTargets = targets;
  editingId = existing?.id ?? null;
  const initial = existing
    ? (session.document.annotations.find((a) => a.id === existing.id)?.comment ?? "")
    : draftStash;
  editor = openEditor({
    anchor,
    targets: targets.map(targetView),
    initialComment: initial,
    editing: !!existing,
    onSave: (text) => void saveEditor(text),
    onCancel: () => closeEditor(),
    onDelete: existing ? () => void deleteAnnotation(existing.id) : undefined,
  });
}

function closeEditor(): void {
  if (!editor) return;
  // 任何收起都先暂存草稿（同 ainotation：外部点击收起保留 draft）
  draftStash = editor.getText();
  editor.close();
  editor = null;
  editorTargets = [];
  editingId = null;
}

function targetView(t: TargetSnapshot): EditorTargetView {
  const id = t.attributes["id"];
  const aria = t.attributes["aria-label"];
  const text = (t.text || "").replace(/\s+/g, " ").trim().slice(0, 40);
  let description = t.tagName + (id ? "#" + id : "");
  if (aria) description += " [" + aria + "]";
  if (text) description += " “" + text + (text.length >= 40 ? "…" : "") + "”";
  return { description, selector: t.selector, quote: t.textSelection?.exact };
}

async function saveEditor(text: string): Promise<void> {
  if (!session) return;
  try {
    let annotation: Annotation;
    if (editingId) {
      const prev = session.document.annotations.find((a) => a.id === editingId);
      if (!prev) throw new Error("annotation no longer exists");
      annotation = { ...prev, comment: text, targets: editorTargets, page: capturePage() };
    } else {
      annotation = {
        id: cryptoRandomUuid(),
        comment: text,
        createdAt: new Date().toISOString(),
        page: capturePage(),
        targets: editorTargets,
      };
    }
    const updated = await syncFeedback(session, {
      sessionId: session.sessionId,
      baseVersion: session.document.version,
      upsertAnnotations: [annotation],
      removeAnnotationIds: [],
    });
    session.document = updated;
    closeEditor();
    draftStash = "";
    refreshMarkers();
    log("标注已提交；文档版本", updated.version);
  } catch (err) {
    // 保留编辑器和草稿，只显示错误（同 ainotation .message 行为）
    warn("save failed:", err);
    editor?.setStatus("提交失败：" + (err instanceof Error ? err.message : String(err)));
  }
}

async function deleteAnnotation(id: string): Promise<void> {
  if (!session) return;
  try {
    const updated = await syncFeedback(session, {
      sessionId: session.sessionId,
      baseVersion: session.document.version,
      upsertAnnotations: [],
      removeAnnotationIds: [id],
    });
    session.document = updated;
    closeEditor();
    draftStash = "";
    refreshMarkers();
    log("标注已删除；文档版本", updated.version);
  } catch (err) {
    warn("delete failed:", err);
    editor?.setStatus("删除失败：" + (err instanceof Error ? err.message : String(err)));
  }
}

async function clearCurrentPageAnnotations(): Promise<void> {
  if (!session) return;
  // 同 ainotation：清除只作用于当前页面（复制才汇总整份文档）
  const ids = session.document.annotations
    .filter((a) => a.page.url === location.href)
    .map((a) => a.id);
  if (!ids.length) {
    shellMessage("当前页面没有可清空的标注", "info");
    log("当前页面没有可清空的标注");
    return;
  }
  try {
    const updated = await syncFeedback(session, {
      sessionId: session.sessionId,
      baseVersion: session.document.version,
      upsertAnnotations: [],
      removeAnnotationIds: ids,
    });
    session.document = updated;
    refreshMarkers();
    shellMessage(`已清空当前页面 ${ids.length} 条标注`, "ok");
    log("已清空当前页面", ids.length, "条标注；文档版本", updated.version);
  } catch (err) {
    warn("clear failed:", err);
    shellMessage("清空失败：" + (err instanceof Error ? err.message : String(err)), "error");
  }
}

// ─── Marker 渲染 ─────────────────────────────────────────────────────────

function refreshMarkers(): void {
  if (!markerLayer) return;
  const doc = session?.document;
  if (!doc) {
    markerLayer.render([], () => undefined);
    return;
  }
  const views: MarkerView[] = [];
  doc.annotations.forEach((a, i) => {
    const rect = a.targets[0]?.rect;
    if (!rect) return;
    // rect 是页面坐标；marker 是 fixed → 屏幕坐标 = 页面坐标 - 当前 scroll
    views.push({
      id: a.id,
      number: i + 1,
      x: rect.x + rect.width / 2 - window.scrollX,
      y: rect.y + rect.height / 2 - window.scrollY,
      title: "编辑标注 #" + (i + 1) + "：" + a.comment.slice(0, 40),
    });
  });
  markerLayer.render(views, (id) => editAnnotation(id));
  // 清空按钮只对“当前页面”有标注时可用（同 ainotation 清除=当前页面）
  shell?.setClearEnabled(doc.annotations.some((a) => a.page.url === location.href));
}

function editAnnotation(id: string): void {
  if (!session) return;
  const ann = session.document.annotations.find((a) => a.id === id);
  if (!ann) return;
  const rect = ann.targets[0]?.rect;
  const anchor = rect
    ? {
        x: rect.x + rect.width / 2 - window.scrollX,
        y: rect.y + rect.height / 2 - window.scrollY,
      }
    : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  openEditorFor(ann.targets, anchor, { id });
}

// ─── 工具栏动作 ──────────────────────────────────────────────────────────

/**
 * 复制反馈（ainotation copyProjectFeedback 语义）：
 * 载荷是 Markdown 交接文本（feedbackMarkdown，按 page.url 分组），不是裸 JSON；
 * 汇总整份文档所有页面，档位由 Settings 的 OutputDetail 决定；
 * 成功 / 失败都给可见回执（toast），剪贴板写入失败先降级 execCommand 再报错。
 */
async function copyFeedbackMarkdown(): Promise<void> {
  if (!session) return;
  const doc = session.document;
  if (!doc.annotations.length) {
    shellMessage("没有可复制的标注", "info");
    return;
  }
  const text = feedbackMarkdown(doc, outputDetail);
  try {
    await writeClipboard(text);
    shellMessage(
      `已复制 ${doc.annotations.length} 条标注 · Markdown · ${detailLabel(outputDetail)}`,
      "ok",
    );
    log("反馈 Markdown 已复制（", doc.annotations.length, "条，detail =", outputDetail, "）");
  } catch (err) {
    warn("copy failed:", err);
    shellMessage("复制失败：剪贴板不可用，请改用「导出 JSON」", "error");
  }
}

function detailLabel(detail: OutputDetail): string {
  for (const [value, label] of OUTPUT_DETAIL_OPTIONS) {
    if (value === detail) return label;
  }
  return detail;
}

/** 剪贴板写入：async clipboard → textarea+execCommand 降级 → 都失败抛错（UI 显示错误回执）。 */
async function writeClipboard(text: string): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch (err) {
    warn("async clipboard failed, fallback to execCommand:", err);
  }
  const ta = document.createElement("textarea");
  markUiElement(ta);
  ta.value = text;
  ta.style.cssText = "position:fixed;top:-100px;opacity:0;";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    ta.remove();
  }
  if (!ok) throw new Error("clipboard unavailable");
}

function exportDocumentJson(): void {
  if (!session) return;
  const doc = session.document;
  // 同 ainotation：JSON 导出只作用于当前页面（复制才汇总全部页面）
  const pageAnnotations = doc.annotations.filter((a) => a.page.url === location.href);
  if (!pageAnnotations.length) {
    shellMessage("当前页面没有可导出的标注", "info");
    return;
  }
  try {
    const payload: FeedbackDocument = { ...doc, annotations: pageAnnotations };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    markUiElement(a);
    a.href = url;
    a.download = "sightline-feedback-" + session.sessionId.slice(0, 8) + ".json";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    shellMessage(`已导出当前页面 ${pageAnnotations.length} 条标注（JSON）`, "ok");
    log("已导出当前页面反馈 JSON（", pageAnnotations.length, "条）");
  } catch (err) {
    warn("export failed:", err);
    shellMessage("导出失败：" + (err instanceof Error ? err.message : String(err)), "error");
  }
}

function toggleSettings(): void {
  if (settingsClose) {
    closeSettings();
    return;
  }
  if (!session) return;
  const doc = session.document;
  settingsClose = showSettingsPanel({
    entries: [
      ["Sidecar", session.endpoint],
      ["Session", session.sessionId.slice(0, 18) + "…"],
      ["文档版本", String(doc.version)],
      ["标注数", String(doc.annotations.length)],
      ["Schema", String(doc.schemaVersion)],
    ],
    detail: outputDetail,
    detailOptions: OUTPUT_DETAIL_OPTIONS,
    onDetailChange: (value) => {
      if (!isOutputDetail(value)) return;
      outputDetail = value;
      saveOutputDetail(value);
      log("复制输出详细度 =", detailLabel(value));
    },
    onClose: () => {
      settingsClose = null;
    },
  });
}

function closeSettings(): void {
  const close = settingsClose;
  settingsClose = null;
  close?.();
}

// ─── 工具 ────────────────────────────────────────────────────────────────

function markUiElement(el: Element): void {
  el.setAttribute("data-sightline-ui", "1");
}

function capturePage(): Annotation["page"] {
  return {
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    capturedAt: new Date().toISOString(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
  };
}

function isSightlineUi(el: Element | null): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (cur.hasAttribute && cur.hasAttribute("data-sightline-ui")) return true;
    cur = cur.parentElement;
  }
  return false;
}

function guessEndpoint(): string {
  // 默认固定端口（架构文档 §3.1）；SDK 自加载链路依赖这个端口稳定。
  return "http://127.0.0.1:9420";
}

/** 用 crypto.randomUUID（浏览器原生，所有现代浏览器都有）。 */
function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // Fallback（极老浏览器）
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// 把核心 API 挂到 window，方便从控制台调用。
declare global {
  interface Window {
    Sightline?: {
      start: typeof start;
      stop: typeof stop;
      submitAnnotation: typeof submitAnnotation;
      selectorFor: typeof selectorFor;
      setPicking: typeof setPicking;
    };
  }
}

if (typeof window !== "undefined") {
  window.Sightline = { start, stop, submitAnnotation, selectorFor, setPicking };
}

// 重新导出内部模块用于单元测试
export { selectorFor } from "./selector";
export { captureTarget, captureTextSelection } from "./capture";
export { bootstrap, syncFeedback } from "./transport";
