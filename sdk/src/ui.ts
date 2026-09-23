/**
 * Sightline UI 层 — 交互结构整体移植自 ainotation（ref/ainotation/packages/sdk/src/ui）:
 *   shell（launcher → 展开 pill toolbar）、hover 虚线 overlay、
 *   标注编辑 popover（目标列表 + selector 复制 + textarea + 取消/提交/删除）、
 *   编号 marker pin、会话信息浮层。
 *
 * 零依赖原生 DOM（不用 lit，不引 Shadow DOM）：
 *   - 所有根元素带 data-sightline-ui：index.ts 的 isSightlineUi() 靠它把自家 UI
 *     从页面事件里排除；所有 CSS 规则以它开头做样式隔离（特异性压过页面低级选择器）
 *   - 绝不用 window.prompt / alert / confirm——评论输入是真 DOM 组件
 */

const STYLE_ID = "sightline-ui-style";

// ─── 样式 ────────────────────────────────────────────────────────────────
// 全部规则以 [data-sightline-ui] 开头：既隔离页面样式，也保证特异性。
// 配色沿用 Sightline 青色品牌（对齐 demo 深色面板），结构对齐 ainotation。
const UI_CSS = [
  // 作用域变量 + 基础排版
  "[data-sightline-ui]{--sl-bg:#0f172a;--sl-panel:#1e293b;--sl-border:#334155;--sl-text:#f1f5f9;--sl-muted:#94a3b8;--sl-accent:#06b6d4;--sl-danger:#f87171;font:13px/1.5 system-ui,-apple-system,sans-serif;letter-spacing:0;color:var(--sl-text);color-scheme:dark;text-align:left;direction:ltr;}",
  "[data-sightline-ui],[data-sightline-ui] *{box-sizing:border-box;}",
  "[data-sightline-ui] button{font:inherit;appearance:none;-webkit-appearance:none;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:30px;padding:5px 9px;border:1px solid var(--sl-border);border-radius:6px;background:var(--sl-panel);color:var(--sl-text);cursor:pointer;line-height:1.2;}",
  "[data-sightline-ui] button:hover:not(:disabled){border-color:var(--sl-accent);}",
  "[data-sightline-ui] button:focus-visible{outline:2px solid var(--sl-accent);outline-offset:2px;}",
  "[data-sightline-ui] button:disabled{opacity:0.45;cursor:default;}",
  "[data-sightline-ui] [hidden]{display:none !important;}",
  "[data-sightline-ui] svg{display:block;}",
  // launcher：右下角固定（ainotation shell 位）
  "[data-sightline-ui].sl-launcher{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:44px;height:44px;padding:0;border-radius:12px;border:1px solid #1e293b;background:#0f172a;color:#06b6d4;box-shadow:0 6px 24px rgba(0,0,0,0.35);opacity:0.85;}",
  "[data-sightline-ui].sl-launcher:hover{opacity:1;border-color:#06b6d4;}",
  // toolbar：pill 形状，header 可拖拽（同 ainotation .toolbar/.header）
  "[data-sightline-ui].sl-toolbar{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:flex;border:1px solid var(--sl-border);border-radius:999px;background:var(--sl-panel);box-shadow:0 6px 24px rgba(0,0,0,0.35);}",
  "[data-sightline-ui] .sl-header{display:flex;align-items:center;gap:4px;padding:5px 6px 5px 10px;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;}",
  "[data-sightline-ui] .sl-header:active{cursor:grabbing;}",
  "[data-sightline-ui] .sl-brand{display:inline-flex;align-items:center;gap:6px;font-weight:650;font-size:13px;color:var(--sl-accent);padding-right:2px;white-space:nowrap;}",
  "[data-sightline-ui] .sl-sep{width:1px;align-self:stretch;margin:7px 3px;background:var(--sl-border);}",
  "[data-sightline-ui] .sl-icon{min-width:32px;padding:5px 6px;}",
  // hover 虚线 overlay：独立 fixed div，pointer-events:none，不污染页面
  "[data-sightline-ui].sl-overlay{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;border:1px dashed #06b6d4;transition:opacity 0.08s;opacity:0;}",
  // marker pin：24px 圆形编号（ainotation .marker 几何，青色品牌色）
  "[data-sightline-ui].sl-markers{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:2147483644;}",
  "[data-sightline-ui] .sl-marker{position:fixed;width:24px;height:24px;min-width:24px;min-height:24px;padding:0;border-radius:50%;background:#06b6d4;color:#062a33;border:1px solid rgba(255,255,255,0.55);font:700 12px/1 system-ui,sans-serif;transform:translate(-50%,-50%);pointer-events:auto;box-shadow:0 2px 8px rgba(0,0,0,0.4);}",
  // 编辑 popover：fixed 可拖拽浮层（ainotation .popover 几何）
  "[data-sightline-ui].sl-popover{position:fixed;z-index:2147483647;width:320px;max-width:calc(100vw - 16px);max-height:calc(100vh - 16px);overflow:auto;overscroll-behavior:contain;padding:12px;border:1px solid var(--sl-border);border-radius:8px;background:var(--sl-panel);box-shadow:0 4px 20px rgba(0,0,0,0.45);cursor:grab;display:flex;flex-direction:column;gap:8px;}",
  "[data-sightline-ui].sl-popover.dragging,[data-sightline-ui].sl-popover.dragging *{cursor:grabbing !important;user-select:none;}",
  "[data-sightline-ui] .sl-targets{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px;max-height:150px;overflow:auto;}",
  "[data-sightline-ui] .sl-target{border:1px solid var(--sl-border);border-radius:6px;background:var(--sl-bg);padding:6px 8px;display:flex;flex-direction:column;gap:4px;cursor:default;}",
  "[data-sightline-ui] .sl-target-desc{font-weight:600;font-size:12px;color:var(--sl-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  "[data-sightline-ui] .sl-locator{display:flex;gap:4px;align-items:center;}",
  "[data-sightline-ui] .sl-locator code{flex:1;min-width:0;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sl-accent);background:#0f172a;border:1px solid var(--sl-border);border-radius:4px;padding:3px 6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:text;}",
  "[data-sightline-ui] .sl-copy-sel{min-height:24px;padding:2px 6px;}",
  "[data-sightline-ui] .sl-quote{margin:0;padding:4px 8px;border-left:3px solid #06b6d4;background:#0f172a;color:var(--sl-muted);font-size:12px;border-radius:0 4px 4px 0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;}",
  "[data-sightline-ui] .sl-popover textarea{width:100%;min-height:64px;resize:vertical;padding:8px;border:1px solid var(--sl-border);border-radius:6px;background:#0f172a;color:var(--sl-text);font:13px/1.5 system-ui,sans-serif;cursor:text;}",
  "[data-sightline-ui] .sl-popover textarea:focus-visible{outline:2px solid #06b6d4;outline-offset:1px;}",
  "[data-sightline-ui] .sl-status{margin:0;padding:5px 8px;border-radius:5px;background:#3f1d1d;color:#fca5a5;font-size:12px;}",
  "[data-sightline-ui] .sl-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;}",
  "[data-sightline-ui] .sl-hint{font-size:11px;color:var(--sl-muted);margin:0;white-space:nowrap;}",
  "[data-sightline-ui] .sl-actions-right{display:flex;gap:6px;}",
  "[data-sightline-ui] .sl-primary{background:#06b6d4;border-color:#06b6d4;color:#062a33;font-weight:650;}",
  "[data-sightline-ui] .sl-primary:hover:not(:disabled){background:#22d3ee;border-color:#22d3ee;}",
  "[data-sightline-ui] .sl-danger{background:transparent;border-color:#7f1d1d;color:#f87171;}",
  "[data-sightline-ui] .sl-danger:hover:not(:disabled){border-color:#f87171;}",
  // 会话信息浮层
  "[data-sightline-ui].sl-settings{position:fixed;right:16px;bottom:76px;z-index:2147483647;width:300px;max-width:calc(100vw - 32px);padding:12px;border:1px solid var(--sl-border);border-radius:8px;background:var(--sl-panel);box-shadow:0 4px 20px rgba(0,0,0,0.45);display:flex;flex-direction:column;gap:8px;cursor:default;}",
  "[data-sightline-ui] .sl-settings-title{display:flex;align-items:center;justify-content:space-between;font-weight:650;color:#06b6d4;}",
  "[data-sightline-ui] .sl-kv{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 10px;font-size:12px;}",
  "[data-sightline-ui] .sl-kv dt{color:var(--sl-muted);white-space:nowrap;}",
  "[data-sightline-ui] .sl-kv dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--sl-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  // 输出详细度选择器（Settings 四档，同 ainotation OutputDetail）
  "[data-sightline-ui] .sl-field{display:flex;flex-direction:column;gap:4px;font-size:12px;}",
  "[data-sightline-ui] .sl-field-label{color:var(--sl-muted);}",
  "[data-sightline-ui] .sl-select{appearance:none;-webkit-appearance:none;padding:6px 8px;min-height:30px;border:1px solid var(--sl-border);border-radius:6px;background:#0f172a;color:var(--sl-text);font:12px/1.4 system-ui,-apple-system,sans-serif;cursor:pointer;}",
  "[data-sightline-ui] .sl-select:focus-visible{outline:2px solid #06b6d4;outline-offset:1px;}",
  // 动作反馈 toast（同 ainotation message()：复制/导出/清空要有可见回执）
  "[data-sightline-ui].sl-toast{position:fixed;top:16px;right:16px;z-index:2147483647;max-width:min(360px,calc(100vw - 32px));padding:9px 13px;border:1px solid var(--sl-border);border-radius:8px;background:var(--sl-panel);color:var(--sl-text);font-size:12.5px;box-shadow:0 4px 20px rgba(0,0,0,0.45);transition:opacity 0.22s;pointer-events:none;}",
  "[data-sightline-ui].sl-toast[data-kind='ok']{border-color:#06b6d4;color:#67e8f9;}",
  "[data-sightline-ui].sl-toast[data-kind='error']{border-color:#b91c1c;color:#fca5a5;}",
  "[data-sightline-ui].sl-toast[data-kind='info']{color:var(--sl-muted);}",
].join("\n");

export function ensureUiStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = UI_CSS;
  (document.head || document.documentElement).appendChild(style);
}

export function destroyUiStyle(): void {
  document.getElementById(STYLE_ID)?.remove();
}

// ─── 图标（Lucide 风格内联 SVG，零依赖） ─────────────────────────────────
const ICONS: Record<string, string> = {
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  sliders: '<line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="9" cy="18" r="2"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
};

function svg(name: string, size: number): string {
  return (
    '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICONS[name] + "</svg>"
  );
}

function markUi(el: Element): void {
  el.setAttribute("data-sightline-ui", "1");
}

function iconBtn(name: string, label: string, title: string, extraClass?: string): HTMLButtonElement {
  const btn = document.createElement("button");
  markUi(btn);
  btn.type = "button";
  if (extraClass) btn.className = extraClass;
  btn.innerHTML = svg(name, 16);
  btn.setAttribute("aria-label", label);
  btn.title = title;
  return btn;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 复制文本到剪贴板：优先 async clipboard，降级 textarea+execCommand；失败静默（jsdom 无 clipboard）。 */
export function copyText(text: string): void {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      void navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // fall through
  }
  try {
    const ta = document.createElement("textarea");
    markUi(ta);
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-100px;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    if (typeof document.execCommand === "function") document.execCommand("copy");
    ta.remove();
  } catch {
    // 剪贴板不可用就算了——不打断用户
  }
}

// ─── 动作反馈 toast ─────────────────────────────────────────────────────
let toastEl: HTMLDivElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 工具栏动作的可见回执（同 ainotation shell `message(msg('copied'))`）。
 * 顶部右侧浮层：ok/info 2.6s 淡出，error 5s；destroyMessage() 拆除。
 */
export function shellMessage(text: string, kind: "ok" | "error" | "info" = "info"): void {
  ensureUiStyle();
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (!toastEl) {
    toastEl = document.createElement("div");
    markUi(toastEl);
    toastEl.className = "sl-toast";
    document.body.appendChild(toastEl);
  }
  toastEl.dataset.kind = kind;
  toastEl.textContent = text;
  toastEl.style.opacity = "1";
  toastTimer = setTimeout(() => {
    if (toastEl) toastEl.style.opacity = "0";
  }, kind === "error" ? 5000 : 2600);
}

export function destroyMessage(): void {
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  toastEl?.remove();
  toastEl = null;
}

// ─── Shell（launcher + toolbar） ─────────────────────────────────────────
export interface ShellCallbacks {
  /** launcher 点击：展开（进入批注模式）。 */
  onToggle(): void;
  /** X 关闭：收起（退出批注模式）。 */
  onClose(): void;
  onCopy(): void;
  onExport(): void;
  onClear(): void;
  onSettings(): void;
}

export interface ShellHandle {
  setExpanded(v: boolean): void;
  setClearEnabled(v: boolean): void;
  destroy(): void;
}

export function mountShell(cb: ShellCallbacks): ShellHandle {
  ensureUiStyle();

  const launcher = document.createElement("button");
  markUi(launcher);
  launcher.className = "sl-launcher";
  launcher.type = "button";
  launcher.setAttribute("aria-label", "打开 Sightline 工具栏");
  launcher.setAttribute("aria-keyshortcuts", "Alt+Shift+A");
  launcher.setAttribute("aria-expanded", "false");
  launcher.title = "Sightline：打开标注工具栏（Alt+Shift+A）";
  launcher.innerHTML = svg("target", 22);
  launcher.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    cb.onToggle();
  });

  const toolbar = document.createElement("section");
  markUi(toolbar);
  toolbar.className = "sl-toolbar";
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", "Sightline 工具栏");
  toolbar.hidden = true;

  const header = document.createElement("div");
  header.className = "sl-header";
  const brand = document.createElement("span");
  brand.className = "sl-brand";
  brand.innerHTML = svg("target", 15) + "Sightline";
  header.appendChild(brand);

  const mkShellBtn = (name: string, icon: string, label: string, title: string): HTMLButtonElement => {
    const b = iconBtn(icon, label, title, "sl-icon");
    b.dataset.sl = name;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (name === "copy") cb.onCopy();
      else if (name === "export") cb.onExport();
      else if (name === "clear") cb.onClear();
      else if (name === "settings") cb.onSettings();
      else if (name === "close") cb.onClose();
    });
    return b;
  };

  const copyBtn = mkShellBtn(
    "copy",
    "copy",
    "复制反馈 Markdown",
    "复制反馈 Markdown（整份文档 · Settings 调详细度）",
  );
  const exportBtn = mkShellBtn("export", "download", "导出当前页面 JSON", "导出当前页面 JSON");
  const clearBtn = mkShellBtn("clear", "trash", "清空当前页面标注", "清空当前页面标注");
  clearBtn.disabled = true;
  const settingsBtn = mkShellBtn("settings", "sliders", "设置与会话信息", "设置与会话信息");
  const sep = document.createElement("span");
  sep.className = "sl-sep";
  const closeBtn = mkShellBtn("close", "x", "退出标注模式", "退出标注模式（Esc）");

  header.append(copyBtn, exportBtn, clearBtn, settingsBtn, sep, closeBtn);
  toolbar.appendChild(header);

  // header 拖拽移动 toolbar（pointer events，非按钮区按下才拖）
  let drag: { id: number; dx: number; dy: number } | null = null;
  header.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    if (!t || t.closest("button")) return;
    const rect = toolbar.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    toolbar.style.left = rect.left + "px";
    toolbar.style.top = rect.top + "px";
    toolbar.style.right = "auto";
    toolbar.style.bottom = "auto";
    try {
      header.setPointerCapture(e.pointerId);
    } catch {
      // jsdom/老浏览器可能没有
    }
  });
  header.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    toolbar.style.left = clamp(e.clientX - drag.dx, 4, Math.max(4, window.innerWidth - 60)) + "px";
    toolbar.style.top = clamp(e.clientY - drag.dy, 4, Math.max(4, window.innerHeight - 40)) + "px";
  });
  const endDrag = (): void => {
    drag = null;
  };
  header.addEventListener("pointerup", endDrag);
  header.addEventListener("pointercancel", endDrag);

  document.body.append(launcher, toolbar);

  return {
    setExpanded(v: boolean): void {
      launcher.hidden = v;
      launcher.setAttribute("aria-expanded", String(v));
      toolbar.hidden = !v;
    },
    setClearEnabled(v: boolean): void {
      clearBtn.disabled = !v;
    },
    destroy(): void {
      launcher.remove();
      toolbar.remove();
    },
  };
}

// ─── Hover overlay ───────────────────────────────────────────────────────
let overlayEl: HTMLDivElement | null = null;

export function showOverlay(el: Element): void {
  ensureUiStyle();
  if (!overlayEl) {
    overlayEl = document.createElement("div");
    markUi(overlayEl);
    overlayEl.className = "sl-overlay";
    document.body.appendChild(overlayEl);
  }
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    overlayEl.style.opacity = "0";
    return;
  }
  overlayEl.style.left = rect.left + "px";
  overlayEl.style.top = rect.top + "px";
  overlayEl.style.width = rect.width + "px";
  overlayEl.style.height = rect.height + "px";
  overlayEl.style.opacity = "1";
}

export function hideOverlay(): void {
  if (overlayEl) overlayEl.style.opacity = "0";
}

export function destroyOverlay(): void {
  overlayEl?.remove();
  overlayEl = null;
}

// ─── 编辑 popover（评论输入组件——替代 window.prompt） ─────────────────────
export interface EditorTargetView {
  description: string;
  selector: string;
  /** textSelection 目标的原文引用。 */
  quote?: string;
}

export interface EditorOptions {
  anchor: { x: number; y: number };
  targets: EditorTargetView[];
  initialComment?: string;
  /** 编辑已有标注（显示删除按钮）。 */
  editing: boolean;
  onSave(text: string): void;
  onCancel(): void;
  onDelete?(): void;
}

export interface EditorHandle {
  close(): void;
  setTargets(views: EditorTargetView[]): void;
  setStatus(msg: string): void;
  /** 当前草稿文本（收起时由 index.ts 暂存，重开恢复——同 ainotation draft）。 */
  getText(): string;
}

export function openEditor(opts: EditorOptions): EditorHandle {
  ensureUiStyle();

  const root = document.createElement("section");
  markUi(root);
  root.className = "sl-popover";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Sightline 标注编辑");

  const list = document.createElement("ul");
  list.className = "sl-targets";

  const textarea = document.createElement("textarea");
  textarea.rows = 3;
  textarea.maxLength = 10000;
  textarea.placeholder = "描述问题或建议…";
  textarea.value = opts.initialComment ?? "";
  textarea.setAttribute("aria-label", "反馈评论");

  const status = document.createElement("p");
  status.className = "sl-status";
  status.hidden = true;

  const actions = document.createElement("div");
  actions.className = "sl-actions";
  const hint = document.createElement("span");
  hint.className = "sl-hint";
  hint.textContent = "Cmd/Ctrl+Enter 提交 · Esc 收起（保留草稿）";
  const right = document.createElement("div");
  right.className = "sl-actions-right";

  const cancelBtn = iconBtn("x", "收起并保留草稿", "收起并保留草稿（Esc）");
  cancelBtn.dataset.sl = "cancel";
  const saveBtn = iconBtn("check", "提交", "提交（Cmd/Ctrl+Enter）");
  saveBtn.dataset.sl = "save";
  saveBtn.classList.add("sl-primary");
  right.appendChild(cancelBtn);
  if (opts.editing && opts.onDelete) {
    const delBtn = iconBtn("trash", "删除此标注", "删除此标注");
    delBtn.dataset.sl = "delete";
    delBtn.classList.add("sl-danger");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      opts.onDelete?.();
    });
    right.appendChild(delBtn);
  }
  right.appendChild(saveBtn);
  actions.append(hint, right);
  root.append(list, textarea, status, actions);

  const renderTargets = (views: EditorTargetView[]): void => {
    list.textContent = "";
    for (const v of views) {
      const li = document.createElement("li");
      li.className = "sl-target";
      const desc = document.createElement("div");
      desc.className = "sl-target-desc";
      desc.title = v.description;
      desc.textContent = v.description;
      const locator = document.createElement("div");
      locator.className = "sl-locator";
      const code = document.createElement("code");
      code.textContent = v.selector;
      const copySel = iconBtn("copy", "复制 selector", "复制 selector", "sl-copy-sel");
      copySel.addEventListener("click", (e) => {
        e.stopPropagation();
        copyText(v.selector);
      });
      locator.append(code, copySel);
      li.append(desc, locator);
      if (v.quote) {
        const q = document.createElement("q");
        q.className = "sl-quote";
        q.textContent = v.quote;
        li.append(q);
      }
      list.append(li);
    }
  };
  renderTargets(opts.targets);

  const setStatus = (msg: string): void => {
    status.textContent = msg;
    status.hidden = !msg;
  };

  const updateSaveState = (): void => {
    saveBtn.disabled = textarea.value.trim().length === 0;
  };
  textarea.addEventListener("input", () => {
    setStatus("");
    updateSaveState();
  });
  updateSaveState();

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    root.remove();
  };

  const save = (): void => {
    const text = textarea.value.trim();
    if (!text) {
      setStatus("评论不能为空");
      return;
    }
    opts.onSave(text);
  };
  saveBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    save();
  });
  cancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onCancel();
  });
  textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      save();
    }
  });

  // popover 拖拽：非交互区按下可拖（同 ainotation .popover cursor:grab）
  let drag: { id: number; dx: number; dy: number } | null = null;
  root.addEventListener("pointerdown", (e) => {
    const t = e.target as Element | null;
    if (!t || t.closest("button, textarea, code, select, option, label, input, a")) return;
    const rect = root.getBoundingClientRect();
    drag = { id: e.pointerId, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    root.classList.add("dragging");
    try {
      root.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  });
  root.addEventListener("pointermove", (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    root.style.left = clamp(e.clientX - drag.dx, 4, Math.max(4, window.innerWidth - 40)) + "px";
    root.style.top = clamp(e.clientY - drag.dy, 4, Math.max(4, window.innerHeight - 40)) + "px";
  });
  const endDrag = (): void => {
    drag = null;
    root.classList.remove("dragging");
  };
  root.addEventListener("pointerup", endDrag);
  root.addEventListener("pointercancel", endDrag);

  document.body.appendChild(root);

  // 定位：锚点右下，clamp 到视口内（同 ainotation popover 定位策略）
  const w = root.offsetWidth;
  const h = root.offsetHeight;
  root.style.left = clamp(opts.anchor.x + 12, 8, Math.max(8, window.innerWidth - w - 8)) + "px";
  root.style.top = clamp(opts.anchor.y + 12, 8, Math.max(8, window.innerHeight - h - 8)) + "px";

  textarea.focus({ preventScroll: true });

  return { close, setTargets: renderTargets, setStatus, getText: () => textarea.value };
}

// ─── Marker pin 层 ───────────────────────────────────────────────────────
export interface MarkerView {
  id: string;
  number: number;
  /** 屏幕坐标（页面坐标已减去当前 scroll）。 */
  x: number;
  y: number;
  title: string;
}

export interface MarkerLayer {
  render(views: MarkerView[], onEdit: (id: string) => void): void;
  destroy(): void;
}

export function mountMarkerLayer(): MarkerLayer {
  ensureUiStyle();
  const layer = document.createElement("div");
  markUi(layer);
  layer.className = "sl-markers";
  layer.setAttribute("aria-label", "Sightline 标注标记");
  document.body.appendChild(layer);
  return {
    render(views, onEdit): void {
      layer.textContent = "";
      for (const v of views) {
        const btn = document.createElement("button");
        markUi(btn);
        btn.className = "sl-marker";
        btn.type = "button";
        btn.textContent = String(v.number);
        btn.title = v.title;
        btn.setAttribute("aria-label", v.title);
        btn.style.left = v.x + "px";
        btn.style.top = v.y + "px";
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit(v.id);
        });
        layer.appendChild(btn);
      }
    },
    destroy(): void {
      layer.remove();
    },
  };
}

// ─── 设置 + 会话信息浮层 ─────────────────────────────────────────────────
export interface SettingsOptions {
  entries: Array<[string, string]>;
  /** 当前复制输出详细度（OutputDetail 四档）。 */
  detail: string;
  /** 可选档位 [value, label]（ainotation: Compact/Standard/Detailed/Everything）。 */
  detailOptions: ReadonlyArray<readonly [string, string]>;
  onDetailChange(value: string): void;
  onClose(): void;
}

export function showSettingsPanel(opts: SettingsOptions): () => void {
  ensureUiStyle();
  const panel = document.createElement("aside");
  markUi(panel);
  panel.className = "sl-settings";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Sightline 设置与会话信息");

  const title = document.createElement("div");
  title.className = "sl-settings-title";
  const name = document.createElement("span");
  name.textContent = "设置 · 会话信息";
  const closeBtn = iconBtn("x", "关闭", "关闭");
  closeBtn.dataset.sl = "settings-close";
  title.append(name, closeBtn);

  const dl = document.createElement("dl");
  dl.className = "sl-kv";
  for (const [k, v] of opts.entries) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dd.title = v;
    dl.append(dt, dd);
  }

  // 复制输出详细度：四档只影响 Markdown 复制，不裁剪导出 / MCP 数据
  const field = document.createElement("label");
  field.className = "sl-field";
  const cap = document.createElement("span");
  cap.className = "sl-field-label";
  cap.textContent = "复制输出详细度（Markdown）";
  const select = document.createElement("select");
  select.className = "sl-select";
  select.dataset.sl = "output-detail";
  select.setAttribute("aria-label", "复制输出详细度");
  for (const [value, label] of opts.detailOptions) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    if (value === opts.detail) o.selected = true;
    select.appendChild(o);
  }
  select.addEventListener("change", (e) => {
    e.stopPropagation();
    opts.onDetailChange(select.value);
  });
  field.append(cap, select);

  panel.append(title, dl, field);
  document.body.appendChild(panel);

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    panel.remove();
    opts.onClose();
  };
  closeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    close();
  });
  return close;
}
