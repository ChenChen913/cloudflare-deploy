#!/usr/bin/env node
/**
 * run-tests.mjs — cloudflare-deploy 技能的本地可执行测试。
 *
 * 在 tests/.work 下创建合成项目，运行 detect-project.mjs 和 check-build.mjs，
 * 再启动多个本地 HTTP 服务器，真实执行 verify-deployment.mjs（真发请求，不是 mock）。
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
// 每次用独立目录：避免删除旧产物时被本机的安全删除钩子拦截（文件锁会导致整轮测试中断）。
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const work = path.join(here, ".work", runId);
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
function checkBuild(dir, mode = "static") {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", dir, "--mode", mode, "--json"], { encoding: "utf8" });
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

// monorepo：两个可部署子应用
w("mono/pnpm-workspace.yaml", `packages:\n  - "apps/*"\n`);
json("mono/apps/web/package.json", { name: "@mono/web", scripts: { build: "vite build" }, devDependencies: { vite: "^5.0.0" } });
w("mono/apps/web/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
json("mono/apps/api/package.json", { name: "@mono/api", scripts: { deploy: "wrangler deploy" }, dependencies: { hono: "^4.6.0" } });
w("mono/apps/api/src/index.ts", `import { Hono } from "hono";\nexport default new Hono();\n`);

// 多锁文件 + 无构建脚本的静态目录
json("lockfiles/package.json", { name: "lockfiles-fixture", dependencies: { react: "^18.0.0" }, devDependencies: { vite: "^5.0.0" } });
w("lockfiles/pnpm-lock.yaml", `lockfileVersion: "9.0"\n`);
w("lockfiles/package-lock.json", `{"lockfileVersion": 3}\n`);
w("lockfiles/index.html", `<!doctype html><html><body>hi</body></html>\n`);

// 动态 vite 配置：base/outDir 无法静态确认
json("dynamic/package.json", { name: "dynamic-fixture", scripts: { build: "vite build" }, devDependencies: { vite: "^5.0.0" } });
w("dynamic/vite.config.ts", `import { defineConfig, loadEnv } from "vite";\nexport default defineConfig(({ mode }) => ({ base: loadEnv(mode, ".", "").BASE || "/", build: { sourcemap: true } }));\n`);
w("dynamic/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);

// Pages Functions 形态：有 functions/，但没有 Wrangler 配置
json("pages-fn/package.json", { name: "pages-fn", scripts: { build: "vite build" }, devDependencies: { vite: "^5.0.0" } });
w("pages-fn/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
w("pages-fn/functions/api/hello.ts", `export const onRequest = () => new Response("ok");\n`);

// ORM / 驱动：识别脚本只标注「需要核对」，不下可行性结论
json("orm/package.json", {
  name: "orm-fixture", scripts: { build: "next build" },
  dependencies: { next: "^15.0.0", "@prisma/client": "^6.0.0", "drizzle-orm": "^0.36.0", "@neondatabase/serverless": "^0.10.0" },
});
w("orm/src/lib/db.ts", `import { neon } from "@neondatabase/serverless";\nimport { drizzle } from "drizzle-orm/neon-http";\nexport const db = drizzle(neon(process.env.DATABASE_URL!));\n`);

// 多个 HTML 入口
w("multi/site/index.html", `<!doctype html><html><body>site</body></html>\n`);
w("multi/docs/index.html", `<!doctype html><html><body>docs</body></html>\n`);

// ---------------------------------------------------------------- 识别
const vite = detect(path.join(work, "vite"));
assert("Vite：框架/类型", vite.project.framework === "vite" && vite.project.kind === "spa", `${vite.project.framework}/${vite.project.kind}`);
assert("Vite：输出目录 + base", vite.project.outputDir === "dist" && vite.project.basePath === "/repo/", `${vite.project.outputDir}, ${vite.project.basePath}`);
assert("Vite：识别 GitHub Pages", vite.githubPages.configured === true && vite.githubPages.workflows.length === 1);
assert("Vite：目标给候选而不是定论", vite.target.suggested === null && vite.target.candidates.join(",") === "pages,workers" && vite.recommendedTarget === "either", `${vite.target.suggested}/${vite.target.candidates}`);
assert("Vite：输出目录有证据等级", vite.evidence.outputDir.confidence === "confirmed" && vite.evidence.outputDir.source.includes("outDir"), `${vite.evidence.outputDir.confidence}`);

const jekyll = detect(path.join(work, "jekyll"));
assert("Jekyll：框架/静态", jekyll.project.framework === "jekyll" && jekyll.project.kind === "static", `${jekyll.project.framework}/${jekyll.project.kind}`);
assert("Jekyll：_site + CNAME", jekyll.project.outputDir === "_site" && jekyll.githubPages.cname === "www.example.com", `${jekyll.project.outputDir}, ${jekyll.githubPages.cname}`);
assert("Jekyll：构建命令", /jekyll build/.test(jekyll.project.buildCommand || ""), jekyll.project.buildCommand);
assert("Jekyll：目标待定", jekyll.target.suggested === null && jekyll.target.candidates.length === 2);

const sb = detect(path.join(work, "supabase"));
assert("Supabase：SPA + 外部后端", sb.project.framework === "vite" && sb.project.kind === "spa");
assert("Supabase：环境变量键名", sb.runtime.envKeys.includes("VITE_SUPABASE_URL"), sb.runtime.envKeys.join(","));
assert("Supabase：不假设 Cloudflare 后端", sb.cloudflare.configured === false && sb.target.suggested === null);

const hono = detect(path.join(work, "hono"));
assert("Hono：明确 Workers", hono.project.framework === "hono" && hono.target.suggested === "workers" && hono.target.confidence === "high", `${hono.project.framework}/${hono.target.suggested}`);
assert("Hono：D1 绑定 + 资源目录", hono.cloudflare.wrangler.bindings.d1 === true && hono.project.outputDir === "./public");
assert("Hono：依据写明 wrangler 配置", hono.target.basis.some((b) => /wrangler/.test(b)), hono.target.basis.join(" | "));

const heavy = detect(path.join(work, "heavy"));
assert("重依赖：标记为 assess", heavy.target.suggested === "assess" && heavy.recommendedTarget === "assess", heavy.recommendedTarget);
assert("重依赖：原生依赖风险", heavy.risks.some((r) => /sharp|puppeteer/.test(r)), heavy.risks.join(" | "));
assert("重依赖：fs + 长驻进程风险", heavy.risks.some((r) => /node:fs/.test(r)) && heavy.risks.some((r) => /长驻/.test(r)));

const next = detect(path.join(work, "next"));
assert("Next：SSR -> Workers", next.project.framework === "nextjs" && next.project.kind === "ssr" && next.target.suggested === "workers", `${next.project.kind}/${next.target.suggested}`);
assert("Next：静态资源风险", next.risks.some((r) => /vinext|OpenNext/.test(r)));

const orm = detect(path.join(work, "orm"));
assert("ORM：运行时依赖只标注待核对", orm.risks.some((r) => /运行时依赖需要核对/.test(r) && /prisma|drizzle/i.test(r)), orm.risks.join(" | "));
assert("ORM：Neon HTTP 交互式事务风险", orm.risks.some((r) => /交互式事务/.test(r)), orm.risks.join(" | "));
assert("ORM：不把待核对说成不可行", !orm.risks.some((r) => /无法部署|不支持部署/.test(r)));
assert("验收模式：Vite→spa / Jekyll→ssg / Next→ssr / ORM→ssr",
  vite.project.suggestedMode === "spa" && jekyll.project.suggestedMode === "ssg" && next.project.suggestedMode === "ssr" && orm.project.suggestedMode === "ssr",
  `${vite.project.suggestedMode}/${jekyll.project.suggestedMode}/${next.project.suggestedMode}/${orm.project.suggestedMode}`);
assert("重依赖：原生 SQLite 单独提示", heavy.risks.some((r) => /原生 SQLite/.test(r)), heavy.risks.join(" | "));

const mono = detect(path.join(work, "mono"));
assert("Monorepo：识别出两个子应用", mono.project.monorepo === true && mono.project.workspaces.length === 2, JSON.stringify(mono.project.workspaces));
assert("Monorepo：风险提示指明子包", mono.risks.some((r) => /monorepo/.test(r) && /apps\/web/.test(r)), mono.risks.join(" | "));

const locks = detect(path.join(work, "lockfiles"));
assert("多锁文件：列出全部", locks.project.lockfiles.length === 2, locks.project.lockfiles.join(","));
assert("多锁文件：包管理器降为推断", locks.project.packageManager === "pnpm" && locks.evidence.packageManager.confidence === "inferred", `${locks.project.packageManager}/${locks.evidence.packageManager.confidence}`);
assert("多锁文件：风险提示", locks.risks.some((r) => /锁文件/.test(r)));

const dyn = detect(path.join(work, "dynamic"));
assert("动态配置：base 标为未知", dyn.evidence.basePath.confidence === "unknown", dyn.evidence.basePath.confidence);
assert("动态配置：风险提示核对产物", dyn.risks.some((r) => /动态/.test(r)), dyn.risks.join(" | "));

const pfn = detect(path.join(work, "pages-fn"));
assert("Pages Functions：建议 Pages", pfn.target.suggested === "pages" && pfn.target.confidence === "medium", `${pfn.target.suggested}/${pfn.target.confidence}`);
assert("Pages Functions：识别 functions 目录", pfn.cloudflare.functionsDir === true);

const multi = detect(path.join(work, "multi"));
assert("多入口：列出 index.html", multi.project.htmlEntries.length === 2, multi.project.htmlEntries.join(","));
assert("多入口：要求确认站点根", multi.risks.some((r) => /个 index\.html/.test(r)), multi.risks.join(" | "));

// ---------------------------------------------------------------- 产物检查
const art = path.join(work, "artifact");
w("artifact/index.html", `<!doctype html><html><head><title>OK</title><link rel="canonical" href="https://example.com/"><link rel="stylesheet" href="/assets/app.css"></head><body><h1>Hello</h1><script src="/missing.js"></script></body></html>`);
w("artifact/404.html", `<html><body>404</body></html>`);
w("artifact/_headers", `/*\n  X-Frame-Options: SAMEORIGIN\n`);
w("artifact/assets/app.css", `body{color:#111}`);
const buildOk = checkBuild(art);
assert("产物：通过但有警告", buildOk.code === 0 && buildOk.json.summary.warnings >= 1, `警告=${buildOk.json.summary.warnings}`);
assert("产物：发现坏资源", buildOk.json.checks.some((c) => c.id === "assets" && c.status === "warn"));
assert("产物：报告实际检查的资源数", buildOk.json.summary.assetsChecked >= 2, `checked=${buildOk.json.summary.assetsChecked}`);

const no404 = path.join(work, "no404");
w("no404/index.html", `<html><body>hi</body></html>`);
const buildStatic = checkBuild(no404, "static");
assert("产物：static 模式缺 404 被警告", buildStatic.json.checks.some((c) => c.id === "404" && c.status === "warn"), "Pages 会当成 SPA");
const buildSpa = checkBuild(no404, "spa");
assert("产物：spa 模式不要求 404", buildSpa.json.checks.some((c) => c.id === "404" && c.status === "pass" && c.mode === "spa"), buildSpa.json.mode);
assert("产物：--spa 与 --mode spa 等价", (() => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", no404, "--spa", "--json"], { encoding: "utf8" });
  return JSON.parse(r.stdout).mode === "spa";
})());

const nested = path.join(work, "nested");
w("nested/index.html", `<!doctype html><html><body><link rel="stylesheet" href="/assets/css/site.css">ok</body></html>`);
w("nested/assets/css/site.css", `body{}`);
for (let i = 0; i < 60; i++) w(`nested/assets/js/chunk-${i}.js`, `export const n=${i};`);
const buildNested = checkBuild(nested, "static");
assert("嵌套产物：递归统计文件", buildNested.json.summary.files >= 61 && buildNested.code === 0, `files=${buildNested.json.summary.files}`);
assert("嵌套产物：资源路径能解析", buildNested.json.checks.some((c) => c.id === "assets" && c.status === "pass"));

const ssrBuild = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--mode", "ssr", "--json"], { encoding: "utf8" });
const ssrBuildJ = JSON.parse(ssrBuild.stdout);
assert("产物：ssr 不需要 --dir 且明确跳过", ssrBuild.status === 0 && ssrBuildJ.mode === "ssr" && ssrBuildJ.checks.some((c) => c.id === "mode-ssr" && c.status === "skip"), `exit=${ssrBuild.status}`);

// ---------------------------------------------------------------- 验收（真实 HTTP）
let staticBase = "";
const staticServer = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  if (p === "/" || p === "") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "server": "local-main", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html><head><title>Local Static</title><link rel="canonical" href="${staticBase}/"><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script></head><body>ok</body></html>`);
    return;
  }
  // 故意不支持 HEAD：验证 GET 兜底
  if (p === "/assets/app.css") {
    res.writeHead(req.method === "HEAD" ? 405 : 200, { "content-type": "text/css" });
    res.end(req.method === "HEAD" ? "" : "body{}");
    return;
  }
  if (p === "/assets/app.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(req.method === "HEAD" ? "" : "console.log(1)"); return; }
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("not found");
});

const spaServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  if (p === "/assets/main.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(req.method === "HEAD" ? "" : "console.log('spa')"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", server: "local-spa" });
  res.end(`<!doctype html><html><head><title>Local SPA</title></head><body><div id="root"></div><script type="module" src="/assets/main.js"></script></body></html>`);
});

const corsServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const origin = req.headers.origin || "";
  if (p === "/api/data") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,authorization",
        "access-control-allow-credentials": "true",
        vary: "Origin",
      });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" });
    res.end(`{"ok":true}`);
    return;
  }
  res.writeHead(404); res.end();
});

const badCorsServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/wrong") {
    res.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "https://other.example" });
    res.end("wrong origin");
    return;
  }
  if (p !== "/") { res.writeHead(404); res.end("nf"); return; }
  res.setHeader("access-control-allow-origin", ["https://a.example", "https://b.example"]);
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>bad cors</title></head><body>bad</body></html>`);
});

const dupCanonicalServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head><title>dup</title><link rel="canonical" href="https://a.example/"><link rel="canonical" href="https://b.example/"></head><body>dup</body></html>`);
});

let backupTarget = "";
const backupServer = http.createServer((req, res) => {
  res.writeHead(301, { location: `${backupTarget}/` });
  res.end();
});

// SSR：首页有服务端渲染的真实文本，另有一个 JSON 接口和一个非 JSON 接口
const ssrServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"ok":true}`); return; }
  if (p === "/api/broken") { res.writeHead(200, { "content-type": "text/plain" }); res.end("not json"); return; }
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  if (p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", server: "local-ssr" });
    res.end(`<!doctype html><html><head><title>Local SSR</title></head><body><main>${"服务端渲染的真实内容 ".repeat(30)}</main><script>console.log('client')</script></body></html>`);
    return;
  }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});

// 子路径站点：模拟 GitHub Pages project site / 多站点同域
const subSeen = [];
const subServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  subSeen.push(p);
  if (p === "/repo/" || p === "/repo" || p === "/repo/index.html") {
    if (p === "/repo/index.html") { res.writeHead(308, { location: "/repo/" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Sub</title><link rel="canonical" href="${subBase}/"><link rel="stylesheet" href="assets/app.css"></head><body>sub</body></html>`);
    return;
  }
  if (p === "/repo/assets/app.css") { res.writeHead(200, { "content-type": "text/css" }); res.end("body{}"); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});
let subBase = "";

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", r));
for (const srv of [staticServer, spaServer, corsServer, badCorsServer, dupCanonicalServer, backupServer, subServer, ssrServer]) await listen(srv);

staticBase = `http://127.0.0.1:${staticServer.address().port}`;
subBase = `http://127.0.0.1:${subServer.address().port}/repo`;
backupTarget = staticBase;
const spaUrl = `http://127.0.0.1:${spaServer.address().port}`;
const corsUrl = `http://127.0.0.1:${corsServer.address().port}`;
const badCorsUrl = `http://127.0.0.1:${badCorsServer.address().port}`;
const dupUrl = `http://127.0.0.1:${dupCanonicalServer.address().port}`;
const backupUrl = `http://127.0.0.1:${backupServer.address().port}/`;
const ssrUrl = `http://127.0.0.1:${ssrServer.address().port}`;

const v1 = await runVerify(["--url", staticBase, "--mode", "static", "--json"]);
const v1j = JSON.parse(v1.out);
assert("验收：静态站正常路径通过", v1.code === 0 && v1j.summary.fail === 0, `失败=${v1j.summary.fail}`);
assert("验收：canonical + 404 + 资源", ["canonical", "404", "assets"].every((id) => v1j.checks.some((c) => c.id === id && c.status === "pass")));
assert("验收：HEAD 405 时用 GET 兜底", (() => {
  const assets = v1j.checks.find((c) => c.id === "assets");
  return assets.status === "pass" && assets.probed.some((p) => p.url === "/assets/app.css" && p.method === "GET" && p.fallback);
})(), "app.css 只支持 GET");

const vSub = await runVerify(["--url", `${subBase}/`, "--mode", "static", "--json"]);
const vSubJ = JSON.parse(vSub.out);
assert("验收：子路径站点查对地址", vSub.code === 0 && vSubJ.checks.some((c) => c.id === "index-redirect" && c.status === "pass"), `exit=${vSub.code}`);
assert("验收：未知路径留在 /repo/ 下", subSeen.some((p) => p.startsWith("/repo/__cf_deploy_check")), subSeen.join(" "));
assert("验收：相对资源按站点根解析", vSubJ.checks.some((c) => c.id === "assets" && c.status === "pass"));

const vLimit = await runVerify(["--url", staticBase, "--mode", "static", "--assets-limit", "1", "--json"]);
const vLimitJ = JSON.parse(vLimit.out);
const limitAssets = vLimitJ.checks.find((c) => c.id === "assets");
assert("验收：资源上限写进报告", limitAssets.checked === 1 && limitAssets.total >= 2 && limitAssets.limited === true, `checked=${limitAssets.checked}/${limitAssets.total}`);

// 同一个静态站：static 判 404，spa 判回退 —— 两种模式给出不同但各自正确的结论
const v2 = await runVerify(["--url", staticBase, "--mode", "spa", "--json"]);
const v2j = JSON.parse(v2.out);
assert("验收：静态站按 SPA 模式判为“深链 404”警告", v2j.checks.some((c) => c.id === "spa-fallback" && c.status === "warn") && v2j.summary.fail === 0);

const v3 = await runVerify(["--url", spaUrl, "--mode", "spa", "--json"]);
const v3j = JSON.parse(v3.out);
assert("验收：SPA 深链回退通过", v3.code === 0 && v3j.checks.some((c) => c.id === "spa-fallback" && c.status === "pass"), "200 + app shell");

const v4 = await runVerify(["--url", spaUrl, "--mode", "static", "--json"]);
const v4j = JSON.parse(v4.out);
assert("验收：把 SPA 当静态站会判 404 失败", v4.code === 1 && v4j.checks.some((c) => c.id === "404" && c.status === "fail"), "这正是原逻辑的冲突点");

const v5 = await runVerify(["--url", staticBase, "--mode", "static", "--origin", "https://app.example.com", "--cors-url", `${corsUrl}/api/data`, "--json"]);
const v5j = JSON.parse(v5.out);
assert("验收：CORS 可指向独立子域 API", v5j.checks.some((c) => c.id === "cors" && c.status === "pass") && v5j.corsUrl === `${corsUrl}/api/data`, v5j.corsUrl);
assert("验收：预检通过", v5j.checks.some((c) => c.id === "cors-preflight" && c.status === "pass"));

const v6 = await runVerify(["--url", badCorsUrl, "--mode", "static", "--origin", "https://app.example.com", "--json"]);
const v6j = JSON.parse(v6.out);
assert("验收：重复 ACAO 判失败", v6.code === 1 && v6j.checks.some((c) => c.id === "cors" && c.status === "fail"), "两个 ACAO 值");

const v6b = await runVerify(["--url", badCorsUrl, "--mode", "static", "--origin", "https://app.example.com", "--cors-url", `${badCorsUrl}/wrong`, "--json"]);
const v6bJ = JSON.parse(v6b.out);
assert("验收：ACAO 与请求来源不匹配判失败", v6b.code === 1 && v6bJ.checks.some((c) => c.id === "cors" && c.status === "fail"), "浏览器会拒绝");

const v7 = await runVerify(["--url", dupUrl, "--mode", "static", "--json"]);
const v7j = JSON.parse(v7.out);
assert("验收：重复 canonical 判失败", v7.code === 1 && v7j.checks.some((c) => c.id === "canonical" && c.status === "fail"));

const v8 = await runVerify(["--url", staticBase, "--mode", "static", "--backup", backupUrl, "--json"]);
const v8j = JSON.parse(v8.out);
assert("验收：拒绝 301 备用站", v8.code === 1 && v8j.checks.some((c) => c.id === "backup" && c.status === "fail"), "备用站跳到主站");

// ---------------------------------------------------------------- SSR / API 验收
const vSsr = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/health", "--expect-json", '{"ok":true}', "--json"]);
const vSsrJ = JSON.parse(vSsr.out);
assert("验收：ssr 未知路径 404 通过", vSsrJ.checks.some((c) => c.id === "404" && c.status === "pass"), JSON.stringify(vSsrJ.checks.find((c) => c.id === "404")));
assert("验收：ssr 服务端渲染内容有文本", vSsrJ.checks.some((c) => c.id === "ssr-html" && c.status === "pass"), JSON.stringify(vSsrJ.checks.find((c) => c.id === "ssr-html")));
assert("验收：ssr 记录单次 TTFB", vSsrJ.checks.some((c) => c.id === "ttfb" && typeof c.ms === "number"), "单次采样，不是性能结论");
assert("验收：--api 状态 + JSON + 期望内容", vSsrJ.checks.some((c) => c.id === "api" && c.status === "pass" && c.path === "/api/health"), JSON.stringify(vSsrJ.checks.filter((c) => c.id === "api")));

const vApiBad = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/broken", "--json"]);
const vApiBadJ = JSON.parse(vApiBad.out);
assert("验收：--api 非 JSON 响应判失败", vApiBad.code === 1 && vApiBadJ.checks.some((c) => c.id === "api" && c.status === "fail"), JSON.stringify(vApiBadJ.checks.find((c) => c.id === "api")));

const vApiMiss = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/health", "--expect-json", '{"ok":false}', "--json"]);
const vApiMissJ = JSON.parse(vApiMiss.out);
assert("验收：--expect-json 不匹配判失败", vApiMiss.code === 1 && vApiMissJ.checks.some((c) => c.id === "api" && c.status === "fail"));

const vApiOrphan = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--expect-json", '{"ok":true}', "--json"]);
const vApiOrphanJ = JSON.parse(vApiOrphan.out);
assert("验收：--expect-json 缺 --api 报警告", vApiOrphanJ.checks.some((c) => c.id === "api" && c.status === "warn"));

const vSsr200 = await runVerify(["--url", spaUrl, "--mode", "ssr", "--json"]);
const vSsr200J = JSON.parse(vSsr200.out);
assert("验收：ssr 下未知路径 200 只警告不判死", vSsr200J.checks.some((c) => c.id === "404" && c.status === "warn") && !vSsr200J.checks.some((c) => c.id === "404" && c.status === "fail"), JSON.stringify(vSsr200J.checks.find((c) => c.id === "404")));

for (const srv of [staticServer, spaServer, corsServer, badCorsServer, dupCanonicalServer, backupServer, subServer, ssrServer]) srv.close();

// ---------------------------------------------------------------- 链路探针（本地假 wrangler，不接触真实账号）
const probeDir = path.join(work, "probe-cwd");
const probeBin = path.join(probeDir, "node_modules", ".bin");
fs.mkdirSync(probeBin, { recursive: true });
const fakeWrangler = [
  "const a = process.argv.slice(2);",
  'if (a.includes("--version")) { console.log("4.0.0-fake"); process.exit(0); }',
  'if (a[0] === "whoami" && a.includes("--json")) { console.error("Unknown argument: json"); process.exit(1); }',
  'if (a[0] === "whoami") {',
  '  if (process.env.CF_FAKE_NOT_LOGGED) { console.log("You are not logged in. Please run npx wrangler login."); process.exit(0); }',
  '  console.log("You are logged in with an OAuth Token, associated with the email probe@example.com!");',
  '  console.log("| Account Name | Account ID |");',
  '  console.log("| probe | abcdef0123456789abcdef0123456789 |");',
  '  process.exit(0);',
  "}",
  "process.exit(1);",
].join("\n");
fs.writeFileSync(path.join(probeBin, "fake-wrangler.mjs"), fakeWrangler);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(probeBin, "wrangler.cmd"), `@echo off\r\nnode "%~dp0fake-wrangler.mjs" %*\r\n`);
} else {
  fs.writeFileSync(path.join(probeBin, "wrangler"), `#!/usr/bin/env node\n${fakeWrangler}`);
  fs.chmodSync(path.join(probeBin, "wrangler"), 0o755);
}
const runProbe = (extraEnv = {}) => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/probe.mjs"), "--json", "--timeout", "3000"], {
    encoding: "utf8", cwd: probeDir, timeout: 40000,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ...extraEnv },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 交给断言报告原始输出 */ }
  return { code: r.status, json: parsed, out: r.stdout, err: r.stderr };
};
const pOk = runProbe();
const pAuth = pOk.json?.checks?.find((c) => c.id === "auth");
assert("探针：whoami --json 不被支持时不误判未登录", pAuth?.status === "pass", pAuth ? JSON.stringify(pAuth) : `out=${pOk.out.slice(0, 200)} err=${pOk.err.slice(0, 200)}`);
assert("探针：从纯文本提取 Account ID", pOk.json?.checks?.some((c) => c.id === "account-id" && c.status === "pass" && c.accountId === "abcdef0123456789abcdef0123456789"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "account-id")));
assert("探针：wrangler 版本探测通过", pOk.json?.checks?.some((c) => c.id === "wrangler" && c.status === "pass"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "wrangler")));
assert("探针：OAuth 登录态如实跳过 Token 权限检查", pOk.json?.checks?.some((c) => c.id === "api-read" && c.status === "skip"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "api-read")));
const pNo = runProbe({ CF_FAKE_NOT_LOGGED: "1" });
assert("探针：文本明确未登录时判 blocked", pNo.json?.checks?.some((c) => c.id === "auth" && c.status === "fail") && pNo.json?.status === "blocked" && pNo.code === 2, `status=${pNo.json?.status} code=${pNo.code}`);

// ---------------------------------------------------------------- 预检退出码
const envRun = spawnSync(process.execPath, [path.join(root, "scripts/check-env.mjs"), "--json"], { encoding: "utf8", timeout: 40000 });
const envJ = JSON.parse(envRun.stdout);
const expectedCode = !envJ.summary.canBuild ? 2 : envJ.summary.canDeploy ? 0 : 1;
assert("预检：退出码与可构建/可部署结论一致", envRun.status === expectedCode, `code=${envRun.status} canBuild=${envJ.summary.canBuild} canDeploy=${envJ.summary.canDeploy}`);
const envBuildOnly = spawnSync(process.execPath, [path.join(root, "scripts/check-env.mjs"), "--build-only", "--json"], { encoding: "utf8", timeout: 40000 });
assert("预检：--build-only 只按可构建判定", envBuildOnly.status === (envJ.summary.canBuild ? 0 : 2), `code=${envBuildOnly.status}`);

// ---------------------------------------------------------------- 技能结构
const skillCheck = spawnSync(process.execPath, [path.join(here, "check-skill.mjs")], { encoding: "utf8" });
assert("结构检查：frontmatter / 路径 / 无绝对路径", skillCheck.status === 0, (skillCheck.stdout || skillCheck.stderr).trim().split("\n").at(-1));

// ---------------------------------------------------------------- 汇总
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：");
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  process.exit(1);
}
