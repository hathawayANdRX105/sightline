/**
 * Node-side smoke test: 验证 SDK 的 selector 生成逻辑在 JSDOM 里能跑。
 * 不测网络层（transport 用 fetch，需要单独测）。
 */
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!DOCTYPE html>
<body>
  <main>
    <header id="site-header">
      <h1>Title</h1>
    </header>
    <section class="card">
      <button id="primary-btn" data-testid="submit" class="btn primary">Submit</button>
      <button class="btn secondary">Cancel</button>
      <p>Some paragraph with <em>italic</em> text.</p>
    </section>
  </main>
</body>`, { url: "http://localhost:8080/" });

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.CSS = dom.window.CSS;

const { selectorFor, descriptiveToken } = await import("../src/selector.ts");

const cases = [
  ["#primary-btn (by id)", () => document.getElementById("primary-btn")],
  ["h1 (by tag)", () => document.querySelector("h1")],
  ["em (deep child)", () => document.querySelector("em")],
  ["secondary button (by class)", () => document.querySelector(".secondary")],
];

let pass = 0, fail = 0;
for (const [name, getEl] of cases) {
  const el = getEl();
  if (!el) { console.log(`FAIL ${name}: element not found`); fail++; continue; }
  try {
    const sel = selectorFor(el);
    // 验证 selector 唯一匹配回这个 element
    const matched = document.querySelectorAll(sel);
    if (matched.length === 1 && matched[0] === el) {
      console.log(`PASS ${name}: ${sel}`);
      pass++;
    } else {
      console.log(`FAIL ${name}: selector "${sel}" matched ${matched.length} nodes`);
      fail++;
    }
  } catch (e) {
    console.log(`FAIL ${name}: ${(e).message}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
