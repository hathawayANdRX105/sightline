/**
 * feedbackMarkdown — 复制按钮的载荷，移植自 ainotation
 * `packages/schema/src/index.ts feedbackMarkdown`（caller: core/handoff.ts copyProjectFeedback）。
 *
 * 语义（同 ainotation AGENTS.md）:
 *   - 复制的是 Markdown 交接文本，不是裸 JSON；
 *   - 汇总整份文档所有页面的标注，按 page.url 分组、组间用 `---` 分隔；
 *   - 四档 OutputDetail（Compact/Standard/Detailed/Everything，默认 Standard），
 *     档位只影响复制输出，不裁剪持久化/JSON 导出/MCP 数据。
 *
 * 与原版差异（MVP 排除项）：无 styleChanges/variants/images/status/replies/marker，
 * 其余字段与层级结构逐行对齐。
 */

import type { FeedbackDocument, Annotation, TargetSnapshot } from "./types.generated";

export type OutputDetail = "compact" | "standard" | "detailed" | "forensic";

/** Settings 里的四档选项（label 即 ainotation 的 Settings 命名）。 */
export const OUTPUT_DETAIL_OPTIONS: ReadonlyArray<readonly [OutputDetail, string]> = [
  ["compact", "Compact 精简"],
  ["standard", "Standard 标准"],
  ["detailed", "Detailed 详细"],
  ["forensic", "Everything 全量"],
];

export function isOutputDetail(v: unknown): v is OutputDetail {
  return v === "compact" || v === "standard" || v === "detailed" || v === "forensic";
}

function quote(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function compactTarget(target: TargetSnapshot): string {
  const text = target.textSelection?.exact;
  const selected = text
    ? ` — selected ${JSON.stringify(text.slice(0, 30))}${text.length > 30 ? "…" : ""}`
    : "";
  return `${JSON.stringify(target.tagName)} (${JSON.stringify(target.selector)})${selected}`;
}

function domPath(target: TargetSnapshot): string {
  return [...(target.ancestors ?? []), target]
    .map((node) => {
      const identifier = node.attributes.id
        ? `#${node.attributes.id}`
        : node.attributes.class
          ? `.${node.attributes.class.split(/\s+/).filter(Boolean).join(".")}`
          : "";
      return `${node.tagName}${identifier}`;
    })
    .join(" > ");
}

function renderTarget(target: TargetSnapshot, index: number, detail: OutputDetail): string {
  const detailed = detail === "detailed" || detail === "forensic";
  const forensic = detail === "forensic";
  return [
    `### Target ${index + 1}`,
    `Selector: ${JSON.stringify(target.selector)}`,
    `Element: ${JSON.stringify(target.tagName)}`,
    ...(target.textSelection
      ? [
          `Selected text: ${JSON.stringify(target.textSelection.exact)}${target.textSelection.truncated ? " (truncated)" : ""}`,
        ]
      : []),
    ...(detailed
      ? [
          `Classes: ${JSON.stringify(target.attributes.class || "")}`,
          `Bounds (viewport px): ${JSON.stringify(target.rect)}`,
          ...(target.textSelection
            ? [
                `Selection context: ${JSON.stringify({
                  prefix: target.textSelection.prefix,
                  suffix: target.textSelection.suffix,
                })}`,
              ]
            : [
                `Text: ${JSON.stringify(target.text)}`,
                ...(target.nearbyText ? [`Nearby text: ${JSON.stringify(target.nearbyText)}`] : []),
              ]),
        ]
      : []),
    ...(forensic
      ? [
          ...(target.ancestors
            ? [
                `DOM path${target.ancestryTruncated ? " (truncated)" : ""}: ${JSON.stringify(domPath(target))}`,
              ]
            : []),
          `Attributes: ${JSON.stringify(target.attributes)}`,
          `Styles at annotation: ${JSON.stringify(target.styles)}`,
          ...(target.nearbyElements
            ? [
                `Nearby elements (${target.nearbyElements.length} siblings): ${JSON.stringify(target.nearbyElements)}`,
              ]
            : []),
          ...(target.textSelection
            ? [`Selection bounds (viewport px): ${JSON.stringify(target.textSelection.rects)}`]
            : []),
        ]
      : []),
  ].join("\n");
}

function renderAnnotation(annotation: Annotation, index: number, detail: OutputDetail): string {
  if (detail === "compact") {
    return [
      `${index + 1}. ${annotation.targets.map(compactTarget).join("; ")}`,
      quote(annotation.comment),
    ].join("\n");
  }
  const forensic = detail === "forensic";
  return [
    `## ${index + 1}. Annotation (${annotation.id})`,
    `Page: ${annotation.page.url}`,
    ...(forensic
      ? [
          `Page title: ${JSON.stringify(annotation.page.title)}`,
          ...(annotation.page.userAgent
            ? [`User Agent: ${JSON.stringify(annotation.page.userAgent)}`]
            : []),
          ...(annotation.page.capturedAt ? [`Captured at: ${annotation.page.capturedAt}`] : []),
        ]
      : []),
    `Viewport: ${annotation.page.viewport.width} x ${annotation.page.viewport.height}; DPR ${annotation.page.viewport.devicePixelRatio}; scroll ${annotation.page.viewport.scrollX}, ${annotation.page.viewport.scrollY}`,
    quote(annotation.comment),
    ...annotation.targets.map((target, ti) => renderTarget(target, ti, detail)),
  ].join("\n\n");
}

/**
 * 把整份反馈文档渲染成 Markdown：
 * 按 page.url 分组（首现顺序），组头 `# Page feedback` + `Page:`，
 * forensic 档补 `Session:`；组间以 `---` 分隔（同 copyProjectFeedback）。
 */
export function feedbackMarkdown(document: FeedbackDocument, detail: OutputDetail): string {
  const order: string[] = [];
  const byUrl = new Map<string, Annotation[]>();
  for (const a of document.annotations) {
    const url = a.page.url;
    if (!byUrl.has(url)) {
      byUrl.set(url, []);
      order.push(url);
    }
    byUrl.get(url)!.push(a);
  }
  return order
    .map((url) =>
      [
        `# Page feedback`,
        `Page: ${url}`,
        ...(detail === "forensic" ? [`Session: ${document.sessionId}`] : []),
        ...byUrl.get(url)!.map((a, i) => renderAnnotation(a, i, detail)),
      ].join("\n\n"),
    )
    .join("\n\n---\n\n");
}
