#!/usr/bin/env node
/**
 * run-tests.mjs — cloudflare-deploy 技能的本地可执行测试。
 *
 * 在 tests/.work 下创建合成项目，运行 detect-project.mjs 和 check-build.mjs，
 * 再启动两个本地 HTTP 服务器，真实执行 verify-deployment.mjs（HTTP 请求，不是 mock）。
 *
 * 这些是本地测试：不会部署到 Cloudflare，也不能证明账号级行为。
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const work = path.join(here, ".work");
const results = [];

function w(rel, content) {
  const p = path.join(work, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function json(rel, obj) { w(rel, JSON.stringify(obj, null, 2)); }
function assert(name, cond, detail = "") {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? "通过" : "失败"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function detect(dir) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/detect-project.mjs"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`识别失败 ${dir}：${r.stderr}`);
  return JSON.parse(r.stdout);
}
function checkBuild(dir) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", dir, "--json"], { encoding: "utf8" });
  return { code: r.status, json: JSON.parse(r.stdout) };
}
function runVerify(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/verify-deployment.mjs"), ...args], { encoding: "utf8" });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

if (fs.existsSync(work)) fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// ---------------------------------------------------------------- 测试项目
json("vite/package.json", {
  name: "vite-spa-fixture", private: true, scripts: { build: "vite build" },
  dependencies: { react: "^18.2.0" }, devDependencies: { vite: "^5.0.0" },
});
w("vite/vite.config.ts", `export default { base: "/repo/", build: { outDir: "dist" } };\n`);
w("vite/index.html", `<!doctype html><html><head><title>Vite</title></head><body><div id="root"></div><script type="module" src="/repo/src/main.jsx"></script></body></html>\n`);
w("vite/src/main.jsx", `console.log("vite");\n`);
w("vite/.github/workflows/pages.yml", `name: pages\non: push\njobs:\n  x:\n    steps:\n      - uses: actions/configure-pages@v5\n      - uses: actions/deploy-pages@v4\n`);

json("jekyll/package.json", { name: "jekyll-fixture" });
w("jekyll/_config.yml", `title: Fixture\nurl: https://www.example.com\n`);
w("jekyll/Gemfile", `source "https://rubygems.org"\ngem "jekyll"\n`);
w("jekyll/index.md", `---\nlayout: default\n---\n# Hi\n`);
w("jekyll/_layouts/default.html", `<html><body>{{ content }}</body></html>\n`);
w("jekyll/CNAME", `www.example.com\n`);
w("jekyll/.github/workflows/pages.yml", `name: pages\non: push\njobs:\n  x:\n    steps:\n      - uses: actions/deploy-pages@v4\n`);

json("supabase/package.json", {
  name: "supabase-fixture", scripts: { build: "vite build" },
  dependencies: { "@supabase/supabase-js": "^2.45.0", react: "^18.2.0" },
  devDependencies: { vite: "^5.0.0" },
});
w("supabase/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
w("supabase/src/lib/supabase.ts", `import { createClient } from "@supabase/supabase-js";\nexport const db = createClient(process.env.VITE_SUPABASE_URL!, process.env.VITE_SUPABASE_ANON_KEY!);\n`);
w("supabase/.env.example", `VITE_SUPABASE_URL=https://example.supabase.co\nVITE_SUPABASE_ANON_KEY=public-anon-key\n`);

json("hono/package.json", {
  name: "hono-d1", scripts: { deploy: "wrangler deploy" },
  dependencies: { hono: "^4.6.0" }, devDependencies: { wrangler: "^4.0.0" },
});
w("hono/wrangler.toml", `name = "hono-d1"\nmain = "src/index.ts"\ncompatibility_date = "2026-11-01"\n\n[assets]\ndirectory = "./public"\n\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "app"\ndatabase_id = "xxx"\n`);
w("hono/src/index.ts", `import { Hono } from "hono";\nconst app = new Hono();\napp.get("/api/items", (c) => c.json([]));\nexport default app;\n`);

json("heavy/package.json", {
  name: "heavy-api", scripts: { start: "node src/server.js" },
  dependencies: { express: "^4.19.0", sharp: "^0.33.0", puppeteer: "^23.0.0", "better-sqlite3": "^11.0.0" },
});
w("heavy/src/server.js", `const fs = require("fs");\nconst express = require("express");\nsetInterval(() => {}, 1000);\nexpress().listen(3000);\n`);

json("next/package.json", {
  name: "next-fixture", scripts: { build: "next build" },
  dependencies: { next: "^15.0.0", react: "^19.0.0" },
});
w("next/next.config.js", `module.exports = {};\n`);
w("next/pages/index.js", `export default function Home(){ return null; }\n`);

// ---------------------------------------------------------------- 识别
const vite = detect(path.join(work, "vite"));
assert("Vite：框架/类型", vite.project.framework === "vite" && vite.project.kind === "spa", `${vite.project.framework}/${vite.project.kind}`);
assert("Vite：输出目录 + base", vite.project.outputDir === "dist" && vite.project.basePath === "/repo/", `${vite.project.outputDir}, ${vite.project.basePath}`);
assert("Vite：识别 GitHub Pages", vite.githubPages.configured === true && vite.githubPages.workflows.length === 1);
assert("Vite：推荐 Pages", vite.recommendedTarget === "pages", vite.recommendedTarget);

const jekyll = detect(path.join(work, "jekyll"));
assert("Jekyll：框架/静态", jekyll.project.framework === "jekyll" && jekyll.project.kind === "static", `${jekyll.project.framework}/${jekyll.project.kind}`);
assert("Jekyll：_site + CNAME", jekyll.project.outputDir === "_site" && jekyll.githubPages.cname === "www.example.com", `${jekyll.project.outputDir}, ${jekyll.githubPages.cname}`);
assert("Jekyll：构建命令", /jekyll build/.test(jekyll.project.buildCommand || ""), jekyll.project.buildCommand);

const sb = detect(path.join(work, "supabase"));
assert("Supabase：SPA + 外部后端", sb.project.framework === "vite" && sb.project.kind === "spa");
assert("Supabase：环境变量键名", sb.runtime.envKeys.includes("VITE_SUPABASE_URL"), sb.runtime.envKeys.join(","));
assert("Supabase：不假设 Cloudflare 后端", sb.cloudflare.configured === false && sb.recommendedTarget === "pages", sb.recommendedTarget);

const hono = detect(path.join(work, "hono"));
assert("Hono：API + Workers", hono.project.framework === "hono" && hono.recommendedTarget === "workers", `${hono.project.framework}/${hono.recommendedTarget}`);
assert("Hono：D1 绑定 + 资源目录", hono.cloudflare.wrangler.bindings.d1 === true && hono.project.outputDir === "./public");

const heavy = detect(path.join(work, "heavy"));
assert("重依赖：标记为 assess", heavy.recommendedTarget === "assess", heavy.recommendedTarget);
assert("重依赖：原生依赖风险", heavy.risks.some((r) => /sharp|puppeteer/.test(r)), heavy.risks.join(" | "));
assert("重依赖：fs + 长驻进程风险", heavy.risks.some((r) => /node:fs/.test(r)) && heavy.risks.some((r) => /长驻/.test(r)));

const next = detect(path.join(work, "next"));
assert("Next：SSR -> Workers", next.project.framework === "nextjs" && next.project.kind === "ssr" && next.recommendedTarget === "workers", `${next.project.kind}/${next.recommendedTarget}`);
assert("Next：静态资源风险", next.risks.some((r) => /vinext|OpenNext/.test(r)));

// ---------------------------------------------------------------- 产物检查
const art = path.join(work, "artifact");
w("artifact/index.html", `<!doctype html><html><head><title>OK</title><link rel="canonical" href="https://example.com/"><link rel="stylesheet" href="/assets/app.css"></head><body><h1>Hello</h1><script src="/missing.js"></script></body></html>`);
w("artifact/404.html", `<html><body>404</body></html>`);
w("artifact/_headers", `/*\n  X-Frame-Options: SAMEORIGIN\n`);
w("artifact/assets/app.css", `body{color:#111}`);
const buildOk = checkBuild(art);
assert("产物：通过但有警告", buildOk.code === 0 && buildOk.json.summary.warnings >= 1, `警告=${buildOk.json.summary.warnings}`);
assert("产物：发现坏资源", buildOk.json.checks.some((c) => c.id === "assets" && c.status === "warn"));

const no404 = path.join(work, "no404");
w("no404/index.html", `<html><body>hi</body></html>`);
const buildWarn = checkBuild(no404);
assert("产物：缺 404 被标记", buildWarn.json.checks.some((c) => c.id === "404" && c.status === "warn"), "Pages 会当成 SPA");

// ---------------------------------------------------------------- 验收（真实 HTTP）
const mainServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/" || url.pathname === "") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "server": "local-main", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html><head><title>Local</title><link rel="canonical" href="http://127.0.0.1:${mainServer.address().port}/"><link rel="stylesheet" href="/assets/app.css"></head><body>ok</body></html>`);
    return;
  }
  if (url.pathname === "/assets/app.css") { res.writeHead(200, { "content-type": "text/css" }); res.end("body{}"); return; }
  if (url.pathname === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("not found");
});
const backupServer = http.createServer((req, res) => {
  res.writeHead(301, { location: `http://127.0.0.1:${mainServer.address().port}/` });
  res.end();
});

await new Promise((r) => mainServer.listen(0, "127.0.0.1", r));
await new Promise((r) => backupServer.listen(0, "127.0.0.1", r));
const mainUrl = `http://127.0.0.1:${mainServer.address().port}`;
const backupUrl = `http://127.0.0.1:${backupServer.address().port}/`;

const v1 = await runVerify(["--url", mainUrl, "--json"]);
const v1j = JSON.parse(v1.out);
assert("验收：正常路径通过", v1.code === 0 && v1j.summary.fail === 0, `失败=${v1j.summary.fail}`);
assert("验收：canonical + 404 + 资源", ["canonical", "404", "assets"].every((id) => v1j.checks.some((c) => c.id === id && c.status === "pass")));

const v2 = await runVerify(["--url", mainUrl, "--backup", backupUrl, "--json"]);
const v2j = JSON.parse(v2.out);
assert("验收：拒绝 301 备用站", v2.code === 1 && v2j.checks.some((c) => c.id === "backup" && c.status === "fail"), "备用站跳到主站");

mainServer.close();
backupServer.close();

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：");
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  process.exit(1);
}
