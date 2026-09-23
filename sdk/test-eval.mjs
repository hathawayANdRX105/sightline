import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';

// 1) 模拟浏览器环境
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost:8080/',
  runScripts: 'outside-only',
});
const { window } = dom;
global.window = window;
global.document = window.document;
Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true });
Object.defineProperty(global, 'crypto', { value: window.crypto, configurable: true });
global.CSS = window.CSS;
global.MouseEvent = window.MouseEvent;
global.Node = window.Node;

// 2) 读 SDK bundle
const code = readFileSync('dist/sdk.js', 'utf8');
console.log('SDK bundle size:', code.length);

// 3) 模拟 fetch().then(r=>r.text()).then(eval)
//    `.then(eval)` 在浏览器里是间接 eval（global scope）
const fakeResponse = { text: async () => code };
const fakeFetch = async () => fakeResponse;
global.fetch = fakeFetch;
window.fetch = fakeFetch;

// 模拟用户在控制台输入的两行
const userSnippet = `
fetch("http://127.0.0.1:9420/sdk.js").then(r=>r.text()).then(eval)
`;

// 间接 eval —— 跟 .then(eval) 一样
const indirectEval = eval;
indirectEval(userSnippet);

// 等待 promise resolve
setTimeout(() => {
  console.log('typeof window.Sightline:', typeof window.Sightline);
  console.log('typeof Sightline (global):', typeof Sightline);
  if (window.Sightline) {
    console.log('window.Sightline keys:', Object.keys(window.Sightline));
  }
}, 100);
