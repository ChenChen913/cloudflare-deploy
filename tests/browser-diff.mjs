#!/usr/bin/env node
/**
 * browser-diff.mjs — 可选的真实浏览器差分测试（不参与默认 run-tests）。
 *
 * 默认测试套件必须零安装可复现，所以不能依赖浏览器。这里提供一个**开发期**
 * 工具：用本机 Chrome / Edge 的真实 HTML5 解析器执行
 * tests/fixtures/html5-oracle.json 里的用例，把浏览器 DOM 事实与
 * scripts/html-scan.mjs 的输出逐项比较。
 *
 *   node tests/browser-diff.mjs            # 差分：浏览器 vs 本地 tokenizer
 *   node tests/browser-diff.mjs --record   # 重新录制 fixture（浏览器是唯一事实源）
 *
 * 依赖：本机安装 Chrome 或 Edge；Node.js >= 22（使用全局 WebSocket）。
 * 找不到浏览器时以退出码 2 跳过，不改变仓库。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseHtml, relTokens, getAttribute } from "../scripts/html-scan.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const fixturePath = path.join(here, "fixtures", "html5-oracle.json");
const XHTML = "http://www.w3.org/1999/xhtml";
const RECORD = process.argv.includes("--record");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (typeof WebSocket === "undefined") {
  console.error("需要 Node.js >= 22（全局 WebSocket）才能运行浏览器差分；默认测试不受影响。");
  process.exit(2);
}

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.EDGE_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
].filter(Boolean);

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const r = spawnSync(candidate, ["--version"], { encoding: "utf8", timeout: 15000, windowsHide: true });
      if (r.status === 0) return { exe: candidate, version: (r.stdout || r.stderr || "").trim() };
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/** 把 DOM facts 归一成与 tokenizer 可直接比较的形状。 */
function normalizeFacts(facts) {
  return {
    canonical: facts.canonical.filter((c) => c.ns === XHTML).map((c) => c.href),
    htmlTitles: facts.htmlTitles.map((t) => t.text),
    scripts: facts.scripts
      .filter((s) => s.ns === XHTML)
      .map((s) => (s.len === s.head.length
        ? { len: s.len, text: s.head }
        : { len: s.len, containsLink: s.containsLink })),
    htmlCounts: { img: facts.htmlNsCounts.img, base: facts.htmlNsCounts.base },
  };
}

/** 本地 tokenizer 的同一组事实。 */
function localFacts(html) {
  const parsed = parseHtml(html);
  return {
    canonical: parsed.elements
      .filter((el) => el.name === "link" && relTokens(el).includes("canonical"))
      .map((el) => getAttribute(el, "href").value),
    htmlTitles: parsed.elements.filter((el) => el.name === "title").map((el) => el.content),
    scripts: parsed.elements.filter((el) => el.name === "script").map((el) => (el.content.length <= 200
      ? { len: el.content.length, text: el.content }
      : { len: el.content.length, containsLink: el.content.includes("<link") })),
    htmlCounts: {
      img: parsed.elements.filter((el) => el.name === "img").length,
      base: parsed.elements.filter((el) => el.name === "base").length,
    },
  };
}

function factsExpression() {
  return `(() => {
    const X = ${JSON.stringify(XHTML)};
    const all = (sel) => [...document.querySelectorAll(sel)];
    const canon = all('link[rel~="canonical" i]').map((el) => ({ ns: el.namespaceURI, href: el.getAttribute('href') }));
    const titles = all('title').map((el) => ({ ns: el.namespaceURI, text: el.textContent }));
    const scripts = all('script').map((el) => ({ ns: el.namespaceURI, len: el.textContent.length, containsLink: el.textContent.includes('<link'), head: el.textContent.slice(0, 200) }));
    const htmlNsCounts = {};
    for (const t of ['base', 'link', 'img', 'script']) htmlNsCounts[t] = all(t).filter((el) => el.namespaceURI === X).length;
    return { canonical: canon, htmlTitles: titles.filter((t) => t.ns === X), scripts, htmlNsCounts };
  })()`;
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("WebSocket 连接失败")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id === undefined || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result || {});
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时（${timeoutMs}ms）：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      try { this.ws.send(JSON.stringify(message)); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
}

async function runBrowser(browser, cases) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-deploy-browser-diff-"));
  const profile = path.join(tempDir, "profile");
  const urls = {};
  for (const testCase of cases) {
    const file = path.join(tempDir, `${testCase.id}.html`);
    const wrap = typeof testCase.wrappedDoctype === "boolean" ? testCase.wrappedDoctype : !ownsDoctype(testCase.id);
    fs.writeFileSync(file, `${wrap ? "<!doctype html>\n" : ""}${testCase.html}`, "utf8");
    urls[testCase.id] = `file:///${file.replace(/\\/g, "/")}`;
  }
  let child = null;
  let cdp = null;
  try {
    child = spawn(browser.exe, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--no-default-browser-check",
      "--disable-extensions", "--disable-background-networking", "--disable-sync", "--metrics-recording-only",
      "--window-size=1280,800", `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank",
    ], { stdio: "ignore", windowsHide: true });

    let port = null;
    for (let i = 0; i < 200 && port == null; i++) {
      try {
        const content = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/);
        if (content[0]) port = Number(content[0]);
      } catch { await sleep(100); }
    }
    if (!port) throw new Error("浏览器 DevTools 端口未就绪");
    let version = null;
    for (let i = 0; i < 100; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (res.ok) { version = await res.json(); break; }
      } catch { /* retry */ }
      await sleep(100);
    }
    if (!version) throw new Error("无法读取浏览器版本");
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.connect();
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    const results = [];
    for (const testCase of cases) {
      await cdp.send("Page.navigate", { url: urls[testCase.id] }, sessionId);
      for (let i = 0; i < 120; i++) {
        const ready = await cdp.send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true }, sessionId);
        if (ready.result && ready.result.value === "complete") break;
        await sleep(50);
      }
      const evaluated = await cdp.send("Runtime.evaluate", { expression: factsExpression(), returnByValue: true }, sessionId);
      results.push({ id: testCase.id, html: testCase.html, facts: evaluated.result ? evaluated.result.value : null });
    }
    return { version, results };
  } finally {
    // 无论成功/异常都关闭 WebSocket、杀掉浏览器进程树、清理临时目录。
    try { if (cdp && cdp.ws) cdp.ws.close(); } catch { /* ignore */ }
    if (child && child.pid) {
      if (process.platform === "win32") {
        try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { /* ignore */ }
      }
      try { child.kill(); } catch { /* ignore */ }
    }
    try { fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 2 }); } catch (error) {
      console.error(`警告：临时目录清理失败（可手动删除）：${tempDir}：${error.message}`);
    }
  }
}

function ownsDoctype(id) {
  // 与记录 fixture 时相同：B/D 系列内容自带 DOCTYPE，不能再用 <!doctype html> 包裹。
  return id.startsWith("B") || id.startsWith("D");
}

async function main() {
  if (!fs.existsSync(fixturePath)) {
    console.error(`缺少 fixture：${fixturePath}`);
    process.exit(2);
  }
  const browser = findBrowser();
  if (!browser) {
    console.error("未找到 Chrome / Edge；跳过浏览器差分。默认测试不受影响。");
    process.exit(2);
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
  console.log(`浏览器：${browser.exe} (${browser.version})`);
  console.log(`fixture：${fixture.cases.length} 个用例（${fixture._browser || "未知版本"} 录制）`);
  const { version, results } = await runBrowser(browser, fixture.cases);

  if (RECORD) {
    const cases = results.map((record) => {
      const prior = fixture.cases.find((c) => c.id === record.id);
      const facts = normalizeFacts(record.facts);
      return {
        id: record.id,
        html: record.html,
        wrappedDoctype: typeof prior?.wrappedDoctype === "boolean" ? prior.wrappedDoctype : !ownsDoctype(record.id),
        expect: facts,
      };
    });
    const next = {
      _schema: 1,
      _provenance: `Recorded from a real Chromium HTML5 parser (${version.Browser || "Chrome/Edge"} headless via CDP Runtime.evaluate; facts filtered by namespaceURI === ${XHTML}). Regenerate with: node tests/browser-diff.mjs --record (requires Chrome/Edge and Node 22+); run-tests.mjs only reads this JSON, so the default test suite stays browser-free.`,
      _doctypePrefixRule: "Per-case wrappedDoctype: true means the recorder prepends <!doctype html>; false means the case HTML already contains its own DOCTYPE (so quirks-mode behavior is preserved).",
      _browser: version.Browser,
      _edgeBrowser: fixture._edgeBrowser || null,
      _recordedAt: new Date().toISOString(),
      cases,
    };
    fs.writeFileSync(fixturePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    console.log(`已重新录制 ${cases.length} 个用例 -> ${path.relative(root, fixturePath)}`);
    return;
  }

  let mismatches = 0;
  for (const record of results) {
    const expected = fixture.cases.find((c) => c.id === record.id)?.expect;
    if (!expected) { mismatches++; console.log(`MISMATCH ${record.id}: fixture 缺少该用例`); continue; }
    const browserFacts = normalizeFacts(record.facts);
    const parserFacts = localFacts(record.html);
    const diffs = [];
    for (const key of ["canonical", "htmlTitles", "scripts", "htmlCounts"]) {
      if (JSON.stringify(browserFacts[key]) !== JSON.stringify(expected[key])) {
        diffs.push(`fixture 过期: ${key} expected=${JSON.stringify(expected[key])} browser=${JSON.stringify(browserFacts[key])}`);
      }
      if (JSON.stringify(parserFacts[key]) !== JSON.stringify(browserFacts[key])) {
        diffs.push(`解析器不一致: ${key} browser=${JSON.stringify(browserFacts[key])} parser=${JSON.stringify(parserFacts[key])}`);
      }
    }
    if (diffs.length) {
      mismatches++;
      console.log(`MISMATCH ${record.id}`);
      for (const diff of diffs) console.log(`  ${diff}`);
      console.log(`  html: ${record.html}`);
    }
  }
  console.log(`差分结果：${results.length - mismatches}/${results.length} 一致`);
  process.exit(mismatches ? 1 : 0);
}

const globalTimeout = setTimeout(() => {
  console.error("浏览器差分超时（180s），已中止；请检查浏览器/网络或手动清理临时 profile。");
  process.exit(3);
}, 180000);
globalTimeout.unref?.();

main().catch((error) => {
  clearTimeout(globalTimeout);
  console.error(`浏览器差分失败：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
