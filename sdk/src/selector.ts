/**
 * CSS selector 生成器——验证过的、唯一的 selector。
 *
 * 策略（对齐 ainotation/packages/sdk/src/core/selector.ts，做了简化）:
 * 1. 优先级高的候选先试：
 *    #id (语义清晰) > [data-testid=...] > [aria-label=...] > .className > tag
 * 2. 验证标准：在根（document）里 `querySelectorAll(sel)` 必须返回且仅返回
 *    当前这一个 element——这是"验证过的 selector"的核心承诺。
 * 3. 如果单个元素候选失败，向上找一个语义化的祖先 anchor 再组合。
 * 4. 最后回退到 :nth-of-type 路径。
 *
 * 预算上限 256 次 querySelectorAll 调用（性能护栏）。
 */

/** 标识符是否"语义化"——排除 css-modules hash、状态类、纯数字 id 等。 */
export function descriptiveToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 100 &&
    !/^(?:css-|sc-|emotion-|makeStyles-|:r|radix-|headlessui-)/i.test(value) &&
    !/^(?:(?:is|has)[-_])?(?:active|selected|open|closed|disabled|enabled|hidden|visible|focus|focused|hover|loading|checked)$/i.test(
      value,
    ) &&
    !/[a-f0-9]{8,}|\d{4,}/i.test(value) &&
    /[a-z\p{L}]/iu.test(value)
  );
}

function attributeSelector(name: string, value: string): string {
  return `[${name}="${CSS.escape(value)}"]`;
}

/** 收集单个元素的所有候选 selector，按优先级排序。 */
function candidates(element: Element): string[] {
  const tag = CSS.escape(element.localName);
  const values: string[] = [];

  const id = element.getAttribute("id");
  if (id && descriptiveToken(id)) values.push(`#${CSS.escape(id)}`);

  for (const name of ["data-testid", "data-element", "name", "aria-label", "alt", "title"]) {
    const value = element.getAttribute(name);
    if (value && value.length <= 100 && !/[\r\n]/.test(value)) {
      values.push(`${name.startsWith("data-") ? "" : tag}${attributeSelector(name, value)}`);
    }
  }

  const classes = Array.from(element.classList).filter(descriptiveToken).slice(0, 5);
  for (const name of classes) values.push(`.${CSS.escape(name)}`);
  for (const name of classes) values.push(`${tag}.${CSS.escape(name)}`);
  for (let i = 0; i < classes.length; i++) {
    for (let j = i + 1; j < classes.length; j++) {
      values.push(`.${CSS.escape(classes[i]!)}.${CSS.escape(classes[j]!)}`);
    }
  }
  // 生成式 id 仍可用，但优先级靠后
  if (id && !descriptiveToken(id) && id.length <= 256) values.push(`#${CSS.escape(id)}`);
  values.push(tag);

  return [...new Set(values)].slice(0, 24);
}

/** 生成验证过的、唯一的 CSS selector。失败抛错。 */
export function selectorFor(element: Element, root: Document | ShadowRoot = document): string {
  let queries = 0;
  const unique = (selector: string): boolean => {
    if (selector.length > 4000) return false;
    try {
      const matches = root.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === element;
    } catch {
      return false;
    }
  };
  const attempt = (selector: string) => ++queries <= 256 && unique(selector);

  // Phase 1: 单元素候选
  const leaves = candidates(element);
  for (const selector of leaves) if (attempt(selector)) return selector;

  // Phase 2: 向上找祖先 anchor + 叶子组合
  let ancestor = element.parentElement;
  let best: { selector: string; cost: number } | undefined;
  for (
    let depth = 0;
    ancestor && depth < 8 && queries < 192;
    depth++, ancestor = ancestor.parentElement
  ) {
    const anchors = candidates(ancestor).slice(0, 6);
    for (const anchor of anchors) {
      for (const leaf of leaves.slice(0, 8)) {
        if (queries >= 192) break;
        const selector = `${anchor} ${leaf}`;
        if (attempt(selector)) {
          const cost =
            selector.length +
            (!/[.#[]/.test(anchor) ? 20 : 0) +
            (!/[.#[]/.test(leaf) ? 20 : 0);
          if (!best || cost < best.cost) best = { selector, cost };
        }
      }
    }
  }
  if (best) return best.selector;

  // Phase 3: nth-of-type 完整路径回退
  const parts: string[] = [];
  for (let current: Element | null = element; current; current = current.parentElement) {
    const parent = current.parentNode as Document | ShadowRoot | Element | null;
    if (!parent || !("children" in parent)) break;
    const siblings = Array.from(parent.children);
    const peers = siblings.filter(
      (sibling) =>
        sibling.localName === current!.localName &&
        sibling.namespaceURI === current!.namespaceURI,
    );
    parts.unshift(
      `${CSS.escape(current.localName)}${peers.length > 1 ? `:nth-of-type(${peers.indexOf(current) + 1})` : ""}`,
    );
    const selector = parts.join(" > ");
    if (attempt(selector)) return selector;
    const parentEl = current.parentElement;
    const parentId = parentEl?.getAttribute("id");
    if (parentId && descriptiveToken(parentId) && attempt(`#${CSS.escape(parentId)} > ${selector}`)) {
      return `#${CSS.escape(parentId)} > ${selector}`;
    }
  }

  // 最终验证一次（即便预算耗尽）
  const finalSelector = parts.join(" > ");
  if (!unique(finalSelector)) {
    throw new Error("Cannot create a unique target selector within the snapshot limits.");
  }
  return finalSelector;
}
