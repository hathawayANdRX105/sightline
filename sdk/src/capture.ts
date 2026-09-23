/**
 * DOM 快照采集——把 Element 转成 TargetSnapshot。
 *
 * 采集的字段跟 Rust schema `TargetSnapshot` 完全对齐（单一事实源在
 * src/schema.rs；本文件的 TS 类型由 specta 在后续步骤自动生成）。
 *
 * MVP 只采 light DOM（不开 shadow boundary）；祖先链最多 32 层。
 */

import type { TargetSnapshot, DomContextNode, Rect } from "./types.generated";
import { selectorFor } from "./selector";

/** 当前 SDK 关注的 computed style 关键字段。 */
const STYLES_TO_CAPTURE = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "font-family",
  "display",
  "visibility",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "cursor",
] as const;

export function captureTarget(el: Element): TargetSnapshot {
  const selector = selectorFor(el);
  const rect = getElementRect(el);
  const styles = captureStyles(el);
  const attributes = captureAttributes(el);
  const text = truncate(el.textContent?.trim() ?? "", 500);
  const ancestors = captureAncestors(el);
  const nearbyText = captureNearbyText(el);

  return {
    id: cryptoRandomUuid(),
    selector,
    tagName: el.localName,
    text,
    attributes,
    rect,
    styles,
    ancestors: ancestors.length ? ancestors : undefined,
    ancestryTruncated: ancestors.length >= 32 ? true : undefined,
    nearbyText,
    nearbyElements: undefined, // MVP 跳过；以 nearbyText 兜底
    textSelection: undefined,
  };
}

export function captureTextSelection(sel: Selection, containerEl: Element): TargetSnapshot {
  const base = captureTarget(containerEl);
  const text = sel.toString();
  const range = sel.getRangeAt(0);
  const textRects = Array.from(range.getClientRects()).map(clientRectToRect);
  return {
    ...base,
    text: truncate(text, 500),
    textSelection: {
      exact: truncate(text, 1000),
      prefix: truncate(textBeforeSelection(containerEl, sel), 64),
      suffix: truncate(textAfterSelection(containerEl, sel), 64),
      truncated: text.length > 1000,
      rects: textRects.slice(0, 32),
    },
  };
}

// ─── 内部 ────────────────────────────────────────────────────────────

function getElementRect(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return {
    x: r.x + window.scrollX,
    y: r.y + window.scrollY,
    width: r.width,
    height: r.height,
  };
}

function clientRectToRect(cr: DOMRect): Rect {
  return {
    x: cr.x + window.scrollX,
    y: cr.y + window.scrollY,
    width: cr.width,
    height: cr.height,
  };
}

function captureStyles(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const cs = getComputedStyle(el);
  for (const name of STYLES_TO_CAPTURE) {
    const v = cs.getPropertyValue(name);
    if (v) out[name] = truncate(v, 1000);
  }
  return out;
}

function captureAttributes(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const attr of Array.from(el.attributes)) {
    if (attr.name.length <= 100 && attr.value.length <= 1000) {
      out[attr.name] = attr.value;
    }
  }
  return out;
}

function captureAncestors(el: Element): DomContextNode[] {
  const out: DomContextNode[] = [];
  let cur: Element | null = el.parentElement;
  let depth = 0;
  while (cur && depth < 32) {
    out.push({
      tagName: cur.localName,
      attributes: captureAttributes(cur),
      text: truncate(cur.textContent?.trim() ?? "", 160) || undefined,
    });
    cur = cur.parentElement;
    depth++;
  }
  return out;
}

function captureNearbyText(el: Element): { before: string; after: string } | undefined {
  const parent = el.parentElement;
  if (!parent) return undefined;
  // 取父元素的纯文本前后片段（粗糙但够用）
  const full = parent.textContent?.trim() ?? "";
  const own = el.textContent?.trim() ?? "";
  if (!full || !own) return undefined;
  const idx = full.indexOf(own);
  if (idx < 0) return undefined;
  const before = truncate(full.slice(0, idx).trim(), 160);
  const after = truncate(full.slice(idx + own.length).trim(), 160);
  if (!before && !after) return undefined;
  return { before, after };
}

function textBeforeSelection(container: Element, sel: Selection): string {
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(container);
  pre.setEnd(range.startContainer, range.startOffset);
  return pre.toString();
}

function textAfterSelection(container: Element, sel: Selection): string {
  const range = sel.getRangeAt(0);
  const post = range.cloneRange();
  post.selectNodeContents(container);
  post.setStart(range.endContainer, range.endOffset);
  return post.toString();
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function cryptoRandomUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
