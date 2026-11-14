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
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePlan, evaluateFileCount, parseVersion, compareVersions } from "../scripts/check-build.mjs";
import { parseDeployUrl, verifyDeployedUrl, evaluateDeployProbe } from "../scripts/deploy-verdict.mjs";
import { classifyRedirect } from "../scripts/redirect-policy.mjs";
import { TLS_KEY, TLS_CERT } from "./fixtures/loopback-tls.mjs";

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
function runVerify(args, extraEnv = null) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/verify-deployment.mjs"), ...args], {
      encoding: "utf8",
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
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

// wrangler.jsonc：JSONC 注释 + JSON 键值语法（与 wrangler.toml 的 `key = "value"` 不同）
w("wrangler-json/wrangler.jsonc", `{\n  // JSONC 注释不影响字段解析\n  "name": "wrangler-json-fixture",\n  "compatibility_date": "2026-11-01",\n  "assets": {\n    "directory": "./public",\n    "not_found_handling": "404-page"\n  }\n}\n`);
w("wrangler-json/public/index.html", `<!doctype html><html><body>assets</body></html>\n`);

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

const wjson = detect(path.join(work, "wrangler-json"));
assert("wrangler.jsonc：读出 name / assets.directory / compatibility_date",
  wjson.cloudflare.wrangler?.name === "wrangler-json-fixture"
    && wjson.cloudflare.wrangler?.assetsDirectory === "./public"
    && wjson.cloudflare.wrangler?.compatibilityDate === "2026-11-01",
  JSON.stringify(wjson.cloudflare.wrangler));
assert("wrangler.jsonc：显式 assets.directory 作为输出目录（confirmed）并建议 Workers",
  wjson.project.outputDir === "./public"
    && wjson.evidence.outputDir.confidence === "confirmed"
    && /assets\.directory/.test(wjson.evidence.outputDir.source)
    && wjson.target.suggested === "workers"
    && !wjson.risks.some((r) => /输出目录未知/.test(r)),
  JSON.stringify({ outputDir: wjson.project.outputDir, evidence: wjson.evidence.outputDir, target: wjson.target, risks: wjson.risks }));

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
assert("产物：_headers 在产物根目录判通过", buildOk.json.checks.some((c) => c.id === "_headers" && c.status === "pass"));
assert("产物：没有 _redirects 明确跳过", buildOk.json.checks.some((c) => c.id === "_redirects" && c.status === "skip"));

// 资源存在性必须按部署后的真实文件名匹配：大小写不同（Windows 不敏感）与 .. 逃逸都要报出来。
const assetCaseDir = path.join(work, "asset-case");
w("asset-case/index.html", `<html><head><link rel="stylesheet" href="/Assets/App.css"><script src="../outside.html"></script><link rel="stylesheet" href="assets/app.css"></head></html>`);
w("asset-case/assets/app.css", `body{}`);
const buildCase = checkBuild(assetCaseDir, "static");
const caseAssets = buildCase.json.checks.find((c) => c.id === "assets");
assert("产物：资源引用大小写不一致判警告", caseAssets?.status === "warn" && caseAssets.broken?.includes("/Assets/App.css"), JSON.stringify(caseAssets));
assert("产物：.. 逃出产物目录的引用判坏", caseAssets?.broken?.includes("../outside.html") && !caseAssets.broken.includes("assets/app.css"), JSON.stringify(caseAssets));

// index.html 是目录时不能崩溃、拿不到 JSON；应输出结构化的 index 警告。
const weirdIndexDir = path.join(work, "weird-index");
fs.mkdirSync(path.join(weirdIndexDir, "index.html"), { recursive: true });
const buildWeird = checkBuild(weirdIndexDir, "static");
assert("产物：index.html 是目录时输出 JSON 不崩溃", buildWeird.json?.mode === "static" && buildWeird.json.checks.some((c) => c.id === "index" && c.status === "warn"), JSON.stringify(buildWeird.json?.checks?.find((c) => c.id === "index")));

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

// ---------------------------------------------------------------- 套餐 / 文件数上限
// 用纯函数测边界，不真造 20,001 个文件（本机写 2 万个小文件要 15s+，删也要 17s）。
// 语义变更：放宽条件按部署目标分流，旧用例保留场景但显式声明 --target pages。
const freePlan = resolvePlan("free");
assert("套餐：默认按 Free 20,000", freePlan.planInfo.limit === 20000 && freePlan.planInfo.effective === "free" && /默认 Free/.test(freePlan.limitReason));
const paidNoEvidence = resolvePlan("paid", { target: "pages", wranglerVersion: null, pagesMajor: "" });
assert("套餐：Pages Paid 无证据不放宽", paidNoEvidence.planInfo.limit === 20000 && paidNoEvidence.planInfo.missing.length === 2, JSON.stringify(paidNoEvidence.planInfo.missing));
const paidV3 = resolvePlan("paid", { target: "pages", wranglerVersion: "3.99.0", pagesMajor: "4" });
assert("套餐：Pages Wrangler v3 不放宽", paidV3.planInfo.effective === "free" && paidV3.planInfo.missing.some((s) => /Wrangler/.test(s)));
const paidNoEnv = resolvePlan("paid", { target: "pages", wranglerVersion: "4.34.0", pagesMajor: "" });
assert("套餐：Pages 缺 PAGES_WRANGLER_MAJOR_VERSION=4 不放宽", paidNoEnv.planInfo.effective === "free" && paidNoEnv.planInfo.missing.some((s) => /PAGES_WRANGLER/.test(s)));
const paidOk = resolvePlan("paid", { target: "pages", wranglerVersion: "4.34.0", pagesMajor: "4" });
assert("套餐：Pages Paid 条件齐全按 100,000", paidOk.planInfo.limit === 100000 && paidOk.planInfo.effective === "paid" && paidOk.planInfo.basis.length === 2 && paidOk.planInfo.target === "pages");
assert("套餐：Pages 只看 Wrangler 主版本，4.3.0 也够", resolvePlan("paid", { target: "pages", wranglerVersion: "^4.3.0", pagesMajor: "4" }).planInfo.effective === "paid");
assert("套餐：非法值返回 null", resolvePlan("enterprise") === null);
const overFree = evaluateFileCount(20001, freePlan.planInfo, freePlan.limitReason);
assert("文件数：20,001 在 Free 判失败并写明上限与原因", overFree.status === "fail" && /20,000/.test(overFree.detail) && /默认 Free/.test(overFree.reason), overFree.detail);
const underPaid = evaluateFileCount(20001, paidOk.planInfo, paidOk.limitReason);
assert("文件数：20,001 在证据齐全的 Paid 判通过", underPaid.status === "pass" && underPaid.limit === 100000);
const overPaid = evaluateFileCount(100001, paidOk.planInfo, paidOk.limitReason);
assert("文件数：100,001 在 Paid 也判失败", overPaid.status === "fail" && /100,000/.test(overPaid.detail));

// 版本号解析与完整比较（4.9.0 不能被字符串比较误判成比 4.34.0 新）
assert("版本：解析点分数字与范围前缀", JSON.stringify(parseVersion("^4.34.0")?.parts) === "[4,34,0]" && parseVersion("4.34")?.parts.join(".") === "4.34");
assert("版本：非法输入一律无法确认", ["4.x", "abc", "", "4.34.0-beta.1", "4.34.x"].every((v) => parseVersion(v) === null));
assert("版本：完整比较 4.9.0 < 4.34.0", compareVersions([4, 9, 0], [4, 34, 0]) === -1);
assert("版本：4.34 与 4.34.0 等价", compareVersions([4, 34], [4, 34, 0]) === 0);
assert("版本：5.0 满足 >= 4.34.0", compareVersions([5], [4, 34, 0]) === 1);

// Workers Static Assets：官方 4.34.0 门槛，不要求 Pages 环境变量
const wOk = resolvePlan("paid", { target: "workers", wranglerVersion: "4.34.0", pagesMajor: "" });
assert("套餐：Workers Paid + Wrangler 4.34.0 按 100,000", wOk.planInfo.limit === 100000 && wOk.planInfo.effective === "paid" && wOk.planInfo.target === "workers", JSON.stringify(wOk.planInfo));
assert("套餐：Workers 不强制 Pages 环境变量", wOk.planInfo.missing.length === 0 && !wOk.planInfo.requirement.includes("PAGES_WRANGLER"));
const wLow = resolvePlan("paid", { target: "workers", wranglerVersion: "4.33.0", pagesMajor: "4" });
assert("套餐：Workers Paid + Wrangler 4.33.0 不放宽", wLow.planInfo.effective === "free" && wLow.planInfo.limit === 20000 && wLow.planInfo.missing.some((s) => /4\.34\.0/.test(s)), JSON.stringify(wLow.planInfo));
assert("套餐：Workers 4.9.0 也低于 4.34.0", resolvePlan("paid", { target: "workers", wranglerVersion: "4.9.0" }).planInfo.effective === "free");
assert("套餐：Workers 只给主版本 4 不足以证明 >= 4.34.0", resolvePlan("paid", { target: "workers", wranglerMajor: 4 }).planInfo.effective === "free");
assert("套餐：Workers 5.0.0 满足门槛", resolvePlan("paid", { target: "workers", wranglerVersion: "5.0.0" }).planInfo.effective === "paid");
const wFree = resolvePlan("free", { target: "workers", wranglerVersion: "4.40.0", pagesMajor: "4" });
assert("套餐：Workers Free 仍按 20,000", wFree.planInfo.effective === "free" && wFree.planInfo.limit === 20000);
const unknownTarget = resolvePlan("paid", { wranglerVersion: "4.40.0", pagesMajor: "4" });
assert("套餐：部署目标未知时证据再全也不放宽", unknownTarget.planInfo.effective === "free" && unknownTarget.planInfo.target === null && unknownTarget.planInfo.missing.some((s) => /--target/.test(s)), JSON.stringify(unknownTarget.planInfo));
assert("套餐：非法版本号不放宽并写明原因", ["4.x", "4.34.0-beta.1", "abc"].every((v) => {
  const r = resolvePlan("paid", { target: "workers", wranglerVersion: v });
  return r.planInfo.effective === "free" && r.planInfo.missing.some((s) => /非法|未确认/.test(s));
}));

const cb = (args, dir = art, env = {}) => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", dir, ...args, "--json"], {
    encoding: "utf8", env: { ...process.env, PAGES_WRANGLER_MAJOR_VERSION: "", CF_DEPLOY_WRANGLER_VERSION: "", ...env },
  });
  return { code: r.status, json: JSON.parse(r.stdout || "{}") };
};
const cbDefault = cb([]);
assert("构建 CLI：默认 free 且上限写进结果", cbDefault.json.plan?.effective === "free" && cbDefault.json.plan?.limit === 20000 && cbDefault.json.summary?.fileLimit === 20000 && /20,000/.test(cbDefault.json.checks.find((c) => c.id === "file-count").detail));
const cbPaidNo = cb(["--plan", "paid"]);
assert("构建 CLI：声明 paid 但证据不足仍按 20,000", cbPaidNo.json.plan?.effective === "free" && cbPaidNo.json.checks.some((c) => c.id === "plan" && c.status === "warn") && cbPaidNo.json.checks.find((c) => c.id === "file-count").limit === 20000, JSON.stringify(cbPaidNo.json.plan));
const cbPaidOk = cb(["--plan", "paid", "--target", "pages", "--wrangler-version", "4.34.0", "--pages-wrangler-major", "4"]);
assert("构建 CLI：Pages 显式证据齐全按 100,000", cbPaidOk.json.plan?.effective === "paid" && cbPaidOk.json.plan?.limit === 100000 && cbPaidOk.json.checks.some((c) => c.id === "plan" && c.status === "pass"));
const cbBadPlan = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", art, "--plan", "enterprise"], { encoding: "utf8" });
assert("构建 CLI：非法套餐退出码 2", cbBadPlan.status === 2);
const cbBadTarget = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", art, "--target", "mongo"], { encoding: "utf8" });
assert("构建 CLI：非法部署目标退出码 2", cbBadTarget.status === 2);
w("wrangler4/package.json", JSON.stringify({ name: "wrangler4", devDependencies: { wrangler: "^4.3.0" } }));
w("wrangler4/dist/index.html", `<html><body>ok</body></html>`);
const cbAuto = cb(["--plan", "paid", "--target", "pages", "--pages-wrangler-major", "4"], path.join(work, "wrangler4", "dist"));
assert("构建 CLI：从项目 package.json 读到 Wrangler v4", cbAuto.json.plan?.effective === "paid" && cbAuto.json.plan?.basis.some((s) => /Wrangler 4/.test(s)), JSON.stringify(cbAuto.json.plan));
const cbEnv = cb(["--plan", "paid", "--target", "pages"], art, { PAGES_WRANGLER_MAJOR_VERSION: "4", CF_DEPLOY_WRANGLER_VERSION: "4.1.0" });
assert("构建 CLI：CI 环境变量也能作为证据", cbEnv.json.plan?.effective === "paid", JSON.stringify(cbEnv.json.plan));
const cbWorkersOk = cb(["--plan", "paid", "--target", "workers", "--wrangler-version", "4.34.0"]);
assert("构建 CLI：Workers 4.34.0 无需 Pages 变量即按 100,000", cbWorkersOk.json.plan?.effective === "paid" && cbWorkersOk.json.summary?.fileLimit === 100000 && cbWorkersOk.json.summary?.target === "workers", JSON.stringify(cbWorkersOk.json.plan));
const cbWorkersLow = cb(["--plan", "paid", "--target", "workers", "--wrangler-version", "4.33.0", "--pages-wrangler-major", "4"]);
assert("构建 CLI：Workers 4.33.0 即使给了 Pages 变量也不放宽", cbWorkersLow.json.plan?.effective === "free" && cbWorkersLow.json.checks.some((c) => c.id === "plan" && c.status === "warn"), JSON.stringify(cbWorkersLow.json.plan));
const cbWorkersFree = cb(["--plan", "free", "--target", "workers", "--wrangler-version", "4.40.0"]);
assert("构建 CLI：Workers Free 仍按 20,000", cbWorkersFree.json.plan?.effective === "free" && cbWorkersFree.json.summary?.fileLimit === 20000);
const cbBadVersion = cb(["--plan", "paid", "--target", "workers", "--wrangler-version", "4.x"]);
assert("构建 CLI：非法版本号不放宽", cbBadVersion.json.plan?.effective === "free" && cbBadVersion.json.plan?.missing.some((s) => /非法/.test(s)), JSON.stringify(cbBadVersion.json.plan));
const cbNoTarget = cb(["--plan", "paid", "--target", "pages", "--wrangler-version", "4.40.0"]);
assert("构建 CLI：Pages 缺环境变量不放宽", cbNoTarget.json.plan?.effective === "free");
const cbPagesSpec = cb(["--plan", "paid", "--target", "workers", "--pages-wrangler-major", "4"], path.join(work, "wrangler4", "dist"));
assert("构建 CLI：package.json 的 4.3.0 不满足 Workers 门槛", cbPagesSpec.json.plan?.effective === "free", JSON.stringify(cbPagesSpec.json.plan));

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
  // SPA 回退的状态分类：304 / 少见 3xx 不是「重定向式回退」，也不能判通过。
  if (p === "/deep304") { res.writeHead(304); res.end(); return; }
  if (p === "/deep300") { res.writeHead(300); res.end(); return; }
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

// canonical href 形态矩阵：缺 href / 空 href / 单引号 / 双引号 / 不带引号 / 无法解析。
// 每个页面都真实返回 HTML，测试执行验收脚本后断言 JSON 里的 canonical 检查。
let canonicalHrefBase = "";
const canonicalHrefCases = {
  "/missing-href/": "missing",
  "/empty-href/": "empty",
  "/single-quote/": "single",
  "/double-quote/": "double",
  "/unquoted/": "unquoted",
  "/bad-href/": "bad",
};
const canonicalHrefServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const kind = canonicalHrefCases[p];
  if (!kind) { res.writeHead(404, { "content-type": "text/html" }); res.end("nf"); return; }
  const self = `${canonicalHrefBase}${p}`;
  let tag;
  if (kind === "missing") tag = `<link rel="canonical">`;
  else if (kind === "empty") tag = `<link rel="canonical" href="">`;
  else if (kind === "single") tag = `<link rel='canonical' href='${self}'>`;
  else if (kind === "double") tag = `<link rel="canonical" href="${self}">`;
  else if (kind === "unquoted") tag = `<link rel="canonical" href=${self}>`;
  else tag = `<link rel="canonical" href="http://">`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>canonical href</title>${tag}</head><body>ok</body></html>`);
});

let backupTarget = "";
let crossTargetBase = "";
const backupServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  // /to-main/ 用于验证「备用站跳到主站」：Location 指向另一台本地服务器上的
  // /backup-landing，脚本若跟随就会在那台服务器的 hits 里留下记录。
  // /chain/<n>/<k>/ 连续 n 次同源 301 后返回 200，验证 --backup 与主站同一跳数规则。
  const chain = p.match(/^\/chain\/(\d+)\/(\d+)\/$/);
  if (chain) {
    const n = Number(chain[1]);
    const k = Number(chain[2]);
    if (k < n) { res.writeHead(301, { location: `/chain/${n}/${k + 1}/` }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html", server: "local-backup-chain" });
    res.end("<!doctype html><html><head><title>backup chain final</title></head><body>ok</body></html>");
    return;
  }
  // 304 / 少见 3xx：不是可验证的响应，不能写成「重定向未完成验证」。
  if (p === "/b304/") { res.writeHead(304); res.end(); return; }
  if (p === "/b300/") { res.writeHead(300); res.end(); return; }
  const loc = p === "/to-main/" ? `${crossTargetBase}/backup-landing` : `${backupTarget}/`;
  res.writeHead(301, { location: loc });
  res.end();
});

// SSR：首页有服务端渲染的真实文本，另有一个 JSON 接口和一个非 JSON 接口
const ssrServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/api/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"ok":true}`); return; }
  if (p === "/api/broken") { res.writeHead(200, { "content-type": "text/plain" }); res.end("not json"); return; }
  if (p === "/api/reordered") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{ "version": "1.0", "ok": true, "nested": { "b": [1, 2], "a": 1 } }`); return; }
  if (p === "/api/missing") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"version":"1.0"}`); return; }
  if (p === "/api/wrongtype") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"ok":"true"}`); return; }
  if (p === "/api/array") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"items":[{"id":1},{"id":2}],"ok":true}`); return; }
  if (p === "/api/badjson") { res.writeHead(200, { "content-type": "application/json" }); res.end(`{"ok":`); return; }
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  if (p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", server: "local-ssr" });
    res.end(`<!doctype html><html><head><title>Local SSR</title></head><body><main>${"服务端渲染的真实内容 ".repeat(30)}</main><script>console.log('client')</script></body></html>`);
    return;
  }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});

// CORS 矩阵：按路径返回不同的预检响应，覆盖允许/拒绝 Origin、缺方法、缺头、凭据错误。
// 同时记录非预检请求实际带上的凭据头，用于证明脚本没有「声明了凭据就真发 Cookie」。
const corsMatrixSeen = [];
const corsMatrixServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  const h = {
    "access-control-allow-origin": req.headers.origin || "",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
  if (p === "/deny") h["access-control-allow-origin"] = "https://other.example";
  if (p === "/missing-method") h["access-control-allow-methods"] = "GET,OPTIONS";
  if (p === "/no-method") delete h["access-control-allow-methods"];
  if (p === "/missing-header") h["access-control-allow-headers"] = "content-type";
  if (p === "/no-header") delete h["access-control-allow-headers"];
  if (p === "/no-cred") delete h["access-control-allow-credentials"];
  if (p === "/wildcard-cred") { h["access-control-allow-origin"] = "*"; delete h["access-control-allow-credentials"]; }
  if (p === "/no-acao") delete h["access-control-allow-origin"];
  // 简单请求（非预检）的凭据矩阵：ACAO=* + ACAC=true / 精确 ACAO 但缺 ACAC。
  if (p === "/simple-star-acac") { h["access-control-allow-origin"] = "*"; h["access-control-allow-credentials"] = "true"; }
  if (p === "/simple-exact-no-acac") { h["access-control-allow-origin"] = req.headers.origin || ""; delete h["access-control-allow-credentials"]; }
  // 通配符 / 凭据 / 方法大小写 / 安全列表方法矩阵
  if (p === "/wildcard-method") h["access-control-allow-methods"] = "*";
  if (p === "/wildcard-header") h["access-control-allow-headers"] = "*";
  if (p === "/explicit") {
    h["access-control-allow-methods"] = "GET,POST,OPTIONS,DELETE,PUT";
    h["access-control-allow-headers"] = "content-type,authorization,x-custom";
  }
  if (p === "/lower-method") h["access-control-allow-methods"] = "delete";
  if (p === "/case-normalize") h["access-control-allow-methods"] = "PUT";
  if (p === "/acao-wildcard") { h["access-control-allow-origin"] = "*"; delete h["access-control-allow-credentials"]; }
  if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }
  corsMatrixSeen.push({ path: p, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null });
  res.writeHead(200, { "content-type": "text/html", ...h });
  res.end(`<!doctype html><html><head><title>cors</title></head><body>ok</body></html>`);
});

// 资源重定向矩阵：同一台服务器按首页路径引用不同资源，另一台模拟跨主机目标。
let assetTargetBase = "";
const assetPages = {
  "/case/direct/": "/a/direct.css",
  "/case/301ok/": "/a/301.css",
  "/case/302bad/": "/a/302.css",
  "/case/cross/": "/a/cross.css",
  "/case/loop/": "/a/loop.css",
  "/case/404/": "/a/404.css",
  "/case/head405/": "/a/head405.css",
  "/case/noloc/": "/a/noloc.css",
  "/case/badproto/": "/a/badproto.css",
  "/case/304/": "/a/304.css",
  "/case/307ok/": "/a/307.css",
  "/case/308ok/": "/a/308.css",
  "/case/300/": "/a/300.css",
};
const assetRedirectServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/case/hostile/") {
    // 伪装成相对地址的跨源 URL（反斜杠会被 URL 解析成协议相对地址）+ 非 HTTP(S) 链接：
    // 脚本只能请求 /a/direct.css，绝不能请求跨源目标，也不能因 javascript: 链接判坏。
    const cross = new URL(crossTargetBase);
    const twoBackslashes = "\\\\";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>hostile</title><link rel="stylesheet" href="/a/direct.css"></head><body><a href="javascript:void(0)">j</a><img src="${twoBackslashes}${cross.host}/ssrf-probe"><a href="https:/[">bad</a></body></html>`);
    return;
  }
  if (assetPages[p]) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>assets</title><link rel="stylesheet" href="${assetPages[p]}"></head><body>ok</body></html>`);
    return;
  }
  if (p === "/a/direct.css" || p === "/a/final.css" || p === "/a/head405.css") {
    if (p === "/a/head405.css" && req.method === "HEAD") { res.writeHead(405, { "content-type": "text/css" }); res.end(""); return; }
    res.writeHead(200, { "content-type": "text/css" });
    res.end("body{}");
    return;
  }
  if (p === "/a/301.css") { res.writeHead(301, { location: "/a/final.css" }); res.end(); return; }
  if (p === "/a/302.css") { res.writeHead(302, { location: "/a/missing.css" }); res.end(); return; }
  if (p === "/a/307.css") { res.writeHead(307, { location: "/a/final.css" }); res.end(); return; }
  if (p === "/a/308.css") { res.writeHead(308, { location: "/a/final.css" }); res.end(); return; }
  if (p === "/a/304.css") { res.writeHead(304, { "content-type": "text/css" }); res.end(); return; }
  if (p === "/a/300.css") { res.writeHead(300, { "content-type": "text/css" }); res.end("body{}"); return; }
  if (p === "/a/cross.css") { res.writeHead(302, { location: `${assetTargetBase}/final.css` }); res.end(); return; }
  if (p === "/a/loop.css") { res.writeHead(301, { location: "/a/loop.css" }); res.end(); return; }
  if (p === "/a/noloc.css") { res.writeHead(308, {}); res.end(); return; }
  if (p === "/a/badproto.css") { res.writeHead(302, { location: "file:///etc/passwd" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});
const assetTargetServer = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/css" }); res.end("body{}");
});

// 主站重定向矩阵：全部是本地 HTTP 服务器。跨源目标（另一台本地服务器）会记录
// 收到的路径；按策略脚本不应请求它，测试据此证明「不跟随」而不是靠文案猜。
let rootRedirectBase = "";
const rootRedirectHits = [];
const crossTargetHits = [];
// 跳数边界矩阵：/chain/<case>/<step>/ 逐级 301；最后一跳按配置返回 200/404 或跨源 302。
// hops = 同源重定向次数，因此允许的最大请求数是 hops+1；第 hops+2 跳不应被请求。
const rootChains = {
  "five-ok": { hops: 5, final: 200 },
  "five-404": { hops: 5, final: 404 },
  "six": { hops: 6, final: 200 },
  "five-cross": { hops: 5, cross: true },
};
const rootRedirectServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  rootRedirectHits.push(p);
  const chain = p.match(/^\/chain\/([a-z0-9-]+)\/(\d+)\/$/);
  if (chain) {
    const cfg = rootChains[chain[1]];
    const step = Number(chain[2]);
    if (!cfg) { res.writeHead(404, { "content-type": "text/html" }); res.end("nf"); return; }
    if (step < cfg.hops) { res.writeHead(301, { location: `/chain/${chain[1]}/${step + 1}/` }); res.end(); return; }
    if (cfg.cross) { res.writeHead(302, { location: `${crossTargetBase}/chain-landing` }); res.end(); return; }
    if (cfg.final === 200) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html><head><title>chain final</title></head><body>final</body></html>");
    } else { res.writeHead(cfg.final, { "content-type": "text/html" }); res.end("nf"); }
    return;
  }
  if (p === "/final/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>final</title></head><body>final</body></html>`);
    return;
  }
  if (p === "/case/same301/") { res.writeHead(301, { location: "/final/" }); res.end(); return; }
  if (p === "/case/same302/") { res.writeHead(302, { location: "/gone/" }); res.end(); return; }
  // 3xx 状态分类矩阵：只有 301/302/303/307/308 需要跟随 Location。
  const statusCase = p.match(/^\/case\/r(301|302|303|307|308)\/$/);
  if (statusCase) { res.writeHead(Number(statusCase[1]), { location: "/final/" }); res.end(); return; }
  if (p === "/case/304/") { res.writeHead(304); res.end(); return; }
  if (p === "/case/300/") { res.writeHead(300); res.end(); return; }
  if (p === "/case/crosshost/") { res.writeHead(302, { location: `http://localhost:${new URL(crossTargetBase).port}/cross-landing` }); res.end(); return; }
  if (p === "/case/loopback/") { res.writeHead(302, { location: `${crossTargetBase}/loop-landing` }); res.end(); return; }
  if (p === "/case/proto-up/") { res.writeHead(302, { location: `https://127.0.0.1:${new URL(rootRedirectBase).port}/tls-landing` }); res.end(); return; }
  if (p === "/case/loop/") { res.writeHead(302, { location: "/case/loop/" }); res.end(); return; }
  if (p === "/case/badloc/") { res.writeHead(302, { location: "http://" }); res.end(); return; }
  if (p === "/case/badproto/") { res.writeHead(302, { location: "file:///etc/passwd" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});
const crossTargetServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  crossTargetHits.push(p);
  if (p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>cross target</title></head><body>cross target</body></html>`);
    return;
  }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});

// canonical 协议矩阵：真实的本地 HTTPS 服务器（内置自签名回环证书，见 fixtures/loopback-tls.mjs）。
// 让 --url 真的是 https://，从而能验证「http canonical 不算指向自身」；不访问外网、不需要 openssl。
let tlsCanonicalBase = "";
const tlsCanonicalCases = {
  "/": "self-https",
  "/http-canon/": "self-http",
  "/other-host/": "other-host",
  "/other-path/": "other-path",
  "/multi/": "multi",
};
const tlsCanonicalServer = https.createServer({ key: TLS_KEY, cert: TLS_CERT }, (req, res) => {
  const p = new URL(req.url, "https://127.0.0.1").pathname;
  const kind = tlsCanonicalCases[p];
  if (!kind) { res.writeHead(404, { "content-type": "text/html" }); res.end("nf"); return; }
  const self = `${tlsCanonicalBase}${p}`;
  let tags;
  if (kind === "self-https") tags = `<link rel="canonical" href="${self}">`;
  else if (kind === "self-http") tags = `<link rel="canonical" href="${self.replace(/^https:/, "http:")}">`;
  else if (kind === "other-host") tags = `<link rel="canonical" href="https://other.example.com${p}">`;
  else if (kind === "other-path") tags = `<link rel="canonical" href="${tlsCanonicalBase}/elsewhere/">`;
  else tags = `<link rel="canonical" href="${self}"><link rel="canonical" href="${self}">`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>tls canonical</title>${tags}</head><body>ok</body></html>`);
});

// /index.html 状态矩阵：301/302/303/307/308 收敛到目录根；304/300 不是有效重定向。
let indexStatusBase = "";
const indexStatusServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  // 跨源 / 非 HTTP(S) / 同源其他路径 / 缺 Location：都不能判「收敛到 /」。
  const special = {
    "/idxcross/index.html": { code: 302, location: "https://other.example/" },
    "/idxfile/index.html": { code: 302, location: "file:///etc/passwd" },
    "/idxelsewhere/index.html": { code: 302, location: "/somewhere/" },
    "/idxnoloc/index.html": { code: 301 },
  };
  if (special[p]) { res.writeHead(special[p].code, special[p].location ? { location: special[p].location } : {}); res.end(); return; }
  const specialRoot = p.match(/^\/(idxcross|idxfile|idxelsewhere|idxnoloc)\/$/);
  if (specialRoot) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>idx ${specialRoot[1]}</title><link rel="canonical" href="${indexStatusBase}/${specialRoot[1]}/"></head><body>ok</body></html>`);
    return;
  }
  const m = p.match(/^\/idx(300|301|302|303|304|307|308)\/(index\.html)?$/);
  if (!m) { res.writeHead(404, { "content-type": "text/html" }); res.end("nf"); return; }
  const code = Number(m[1]);
  if (m[2]) {
    if (code === 304 || code === 300) { res.writeHead(code); res.end(); return; }
    res.writeHead(code, { location: `/idx${code}/` }); res.end(); return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>idx ${code}</title><link rel="canonical" href="${indexStatusBase}/idx${code}/"></head><body>ok</body></html>`);
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
for (const srv of [staticServer, spaServer, corsServer, badCorsServer, dupCanonicalServer, canonicalHrefServer, backupServer, subServer, ssrServer, corsMatrixServer, assetRedirectServer, assetTargetServer, rootRedirectServer, indexStatusServer, crossTargetServer, tlsCanonicalServer]) await listen(srv);

staticBase = `http://127.0.0.1:${staticServer.address().port}`;
subBase = `http://127.0.0.1:${subServer.address().port}/repo`;
backupTarget = staticBase;
const spaUrl = `http://127.0.0.1:${spaServer.address().port}`;
const corsUrl = `http://127.0.0.1:${corsServer.address().port}`;
const badCorsUrl = `http://127.0.0.1:${badCorsServer.address().port}`;
const dupUrl = `http://127.0.0.1:${dupCanonicalServer.address().port}`;
canonicalHrefBase = `http://127.0.0.1:${canonicalHrefServer.address().port}`;
indexStatusBase = `http://127.0.0.1:${indexStatusServer.address().port}`;
const backupUrl = `http://127.0.0.1:${backupServer.address().port}/`;
const ssrUrl = `http://127.0.0.1:${ssrServer.address().port}`;
const corsMatrixUrl = `http://127.0.0.1:${corsMatrixServer.address().port}`;
const assetRedirectBase = `http://127.0.0.1:${assetRedirectServer.address().port}`;
assetTargetBase = `http://127.0.0.1:${assetTargetServer.address().port}`;
rootRedirectBase = `http://127.0.0.1:${rootRedirectServer.address().port}`;
crossTargetBase = `http://127.0.0.1:${crossTargetServer.address().port}`;
tlsCanonicalBase = `https://127.0.0.1:${tlsCanonicalServer.address().port}`;
// 子进程用 NODE_EXTRA_CA_CERTS 信任这份本地自签 CA，TLS 校验保持开启。
w("loopback-ca.pem", TLS_CERT);
const tlsVerifyEnv = { NODE_EXTRA_CA_CERTS: path.join(work, "loopback-ca.pem") };

const v1 = await runVerify(["--url", staticBase, "--mode", "static", "--json"]);
const v1j = JSON.parse(v1.out);
assert("验收：静态站正常路径通过", v1.code === 0 && v1j.summary.fail === 0, `失败=${v1j.summary.fail}`);
assert("验收：canonical + 404 + 资源", ["canonical", "404", "assets"].every((id) => v1j.checks.some((c) => c.id === id && c.status === "pass")));
assert("验收：HEAD 405 时用 GET 兜底", (() => {
  const assets = v1j.checks.find((c) => c.id === "assets");
  return assets.status === "pass" && assets.probed.some((p) => p.url === "/assets/app.css" && p.method === "GET" && p.fallback);
})(), "app.css 只支持 GET");
assert("验收：标题 / content-type / cache-control 检查落进 JSON", (() => {
  const byId = (id) => v1j.checks.find((c) => c.id === id);
  return byId("title")?.status === "pass" && byId("content-type")?.status === "pass" && byId("cache-control")?.status === "pass";
})(), JSON.stringify(["title", "content-type", "cache-control"].map((id) => v1j.checks.find((c) => c.id === id))));
assert("验收：安全头按数量给结论", (() => {
  const sec = v1j.checks.find((c) => c.id === "security-headers");
  return sec?.status === "warn" && /x-content-type-options/.test(sec.detail || "");
})(), JSON.stringify(v1j.checks.find((c) => c.id === "security-headers")));

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
assert("验收：SPA 回退检查暴露真实 HTTP 状态码", v3j.checks.find((c) => c.id === "spa-fallback")?.httpStatus === 200, JSON.stringify(v3j.checks.find((c) => c.id === "spa-fallback")));

// SPA 回退的 304 / 少见 3xx：既不是 200+shell，也不是重定向式回退，不能判通过。
const vSpa304 = await runVerify(["--url", spaUrl, "--mode", "spa", "--expect-404", "/deep304", "--json"]);
const sf304 = JSON.parse(vSpa304.out).checks.find((c) => c.id === "spa-fallback");
assert("SPA 回退：304 不判通过也不写成重定向", vSpa304.code === 1 && sf304?.status === "fail" && sf304.httpStatus === 304 && !/重定向式回退/.test(sf304.detail || ""), JSON.stringify(sf304));
const vSpa300 = await runVerify(["--url", spaUrl, "--mode", "spa", "--expect-404", "/deep300", "--json"]);
const sf300 = JSON.parse(vSpa300.out).checks.find((c) => c.id === "spa-fallback");
assert("SPA 回退：少见 3xx（300）不判通过", vSpa300.code === 1 && sf300?.status === "fail" && sf300.httpStatus === 300, JSON.stringify(sf300));

const v4 = await runVerify(["--url", spaUrl, "--mode", "static", "--json"]);
const v4j = JSON.parse(v4.out);
assert("验收：把 SPA 当静态站会判 404 失败", v4.code === 1 && v4j.checks.some((c) => c.id === "404" && c.status === "fail"), "这正是原逻辑的冲突点");
assert("验收：404 检查暴露真实 HTTP 状态码", v4j.checks.find((c) => c.id === "404")?.httpStatus === 200, JSON.stringify(v4j.checks.find((c) => c.id === "404")));

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

// 命令行参数写错时应给出用法错误（退出码 2），而不是崩栈 / 静默跳过检查。
for (const [name, args] of [
  ["--api 的 URL 无法解析", ["--api", "http://["]],
  ["--expect-404 的 URL 无法解析", ["--expect-404", "http://["]],
  ["--assets-limit 不是正整数", ["--assets-limit", "abc"]],
  ["--timeout 不是正数", ["--timeout", "0"]],
  ["--backup 不是合法 URL", ["--backup", "http://["]],
]) {
  const r = await runVerify(["--url", staticBase, "--mode", "static", ...args, "--json"]);
  assert(`CLI：${name} 退出码 2 且不输出半截 JSON`, r.code === 2 && !r.out.trim() && /无法解析|正整数|正数|合法 URL/.test(r.err), `code=${r.code} out=${r.out.slice(0, 40)} err=${r.err.slice(0, 80)}`);
}

// ---------------------------------------------------------------- CORS 预检矩阵
const corsCase = async (p, extra = []) => {
  const r = await runVerify([
    "--url", staticBase, "--mode", "static", "--origin", "https://app.example.com",
    "--cors-url", `${corsMatrixUrl}${p}`, ...extra, "--json",
  ]);
  const j = JSON.parse(r.out);
  return { code: r.code, pre: j.checks.find((c) => c.id === "cors-preflight"), result: j };
};
const full = ["--cors-method", "POST", "--cors-headers", "content-type,authorization", "--cors-credentials"];
const cOk = await corsCase("/ok", full);
assert("预检：允许 Origin + 方法/头/凭据齐全判通过", cOk.pre?.status === "pass" && cOk.pre.notChecked.length === 0 && cOk.pre.checked.includes("Allow-Methods"), JSON.stringify(cOk.pre?.issues));
const cDeny = await corsCase("/deny", full);
assert("预检：拒绝 Origin 判失败", cDeny.pre?.status === "fail" && cDeny.pre.issues.some((s) => /不匹配/.test(s)), JSON.stringify(cDeny.pre?.issues));
// POST 是 CORS-safelisted method，按规范不应因「没列在 Allow-Methods」判失败；
// 这两条旧场景保留，但改用非安全方法 DELETE 才能真正测到「缺方法」。
const cMethod1 = await corsCase("/missing-method", ["--cors-method", "DELETE"]);
assert("预检：Allow-Methods 缺实际方法（DELETE）判失败", cMethod1.pre?.status === "fail" && cMethod1.pre.issues.some((s) => /不含实际请求方法/.test(s)), JSON.stringify(cMethod1.pre?.issues));
const cMethod2 = await corsCase("/no-method", ["--cors-method", "DELETE"]);
assert("预检：缺 Allow-Methods 头判失败", cMethod2.pre?.status === "fail" && cMethod2.pre.issues.some((s) => /缺少 Access-Control-Allow-Methods/.test(s)));
const cHeader1 = await corsCase("/missing-header", ["--cors-headers", "content-type,authorization"]);
assert("预检：Allow-Headers 缺实际请求头判失败", cHeader1.pre?.status === "fail" && cHeader1.pre.issues.some((s) => /不含实际请求头/.test(s)), JSON.stringify(cHeader1.pre?.issues));
const cHeader2 = await corsCase("/no-header", ["--cors-headers", "content-type,authorization"]);
assert("预检：缺 Allow-Headers 头判失败", cHeader2.pre?.status === "fail" && cHeader2.pre.issues.some((s) => /缺少 Access-Control-Allow-Headers/.test(s)));
const cCred1 = await corsCase("/no-cred", ["--cors-credentials"]);
assert("预检：带凭据但缺 ACAC 判失败", cCred1.pre?.status === "fail" && cCred1.pre.issues.some((s) => /Allow-Credentials/.test(s)));
const cCred2 = await corsCase("/wildcard-cred", ["--cors-credentials"]);
assert("预检：带凭据但 ACAO=* 判失败", cCred2.pre?.status === "fail" && cCred2.pre.issues.some((s) => /不能是 \*/.test(s)));
const cNoAcao = await corsCase("/no-acao");
assert("预检：204 但无 ACAO 不算通过", cNoAcao.pre?.status === "fail" && cNoAcao.pre?.httpStatus === 204, JSON.stringify(cNoAcao.pre?.issues));
const cDefault = await corsCase("/ok");
assert("预检：未提供的检查明确列入 notChecked", cDefault.pre?.status === "pass" && cDefault.pre.notChecked.length === 3 && /未执行/.test(cDefault.pre.detail), JSON.stringify(cDefault.pre?.notChecked));

// ---------------------------------------------------------------- CORS 通配符 / 凭据 / 安全列表方法（Fetch 规范）
const cWildMethod = await corsCase("/wildcard-method", ["--cors-method", "DELETE"]);
assert("预检：无凭据 + Allow-Methods:* 允许非安全方法", cWildMethod.pre?.status === "pass", JSON.stringify(cWildMethod.pre?.issues));
const cWildMethodCred = await corsCase("/wildcard-method", ["--cors-method", "DELETE", "--cors-credentials"]);
assert("预检：带凭据 + Allow-Methods:* 不得当通配通过", cWildMethodCred.pre?.status === "fail" && cWildMethodCred.pre.issues.some((s) => /字面方法名/.test(s)), JSON.stringify(cWildMethodCred.pre?.issues));
const cWildHeader = await corsCase("/wildcard-header", ["--cors-headers", "content-type"]);
assert("预检：无凭据 + Allow-Headers:* 覆盖普通请求头", cWildHeader.pre?.status === "pass", JSON.stringify(cWildHeader.pre?.issues));
const cWildHeaderAuth = await corsCase("/wildcard-header", ["--cors-headers", "authorization"]);
assert("预检：Allow-Headers:* 不覆盖 Authorization（non-wildcard header）", cWildHeaderAuth.pre?.status === "fail" && cWildHeaderAuth.pre.issues.some((s) => /non-wildcard/.test(s)), JSON.stringify(cWildHeaderAuth.pre?.issues));
const cWildHeaderCred = await corsCase("/wildcard-header", ["--cors-headers", "content-type", "--cors-credentials"]);
assert("预检：带凭据 + Allow-Headers:* 不作通配", cWildHeaderCred.pre?.status === "fail" && cWildHeaderCred.pre.issues.some((s) => /不作通配符/.test(s)), JSON.stringify(cWildHeaderCred.pre?.issues));
const cExplicitCred = await corsCase("/explicit", ["--cors-method", "DELETE", "--cors-headers", "authorization", "--cors-credentials"]);
assert("预检：带凭据 + 显式允许方法与请求头通过", cExplicitCred.pre?.status === "pass", JSON.stringify(cExplicitCred.pre?.issues));
const cSafePost = await corsCase("/no-method", ["--cors-method", "POST"]);
assert("预检：POST 是 CORS-safelisted，缺 Allow-Methods 仍通过", cSafePost.pre?.status === "pass", JSON.stringify(cSafePost.pre?.issues));
const cSafeGet = await corsCase("/no-method", ["--cors-method", "GET"]);
assert("预检：GET 是 CORS-safelisted，缺 Allow-Methods 仍通过", cSafeGet.pre?.status === "pass", JSON.stringify(cSafeGet.pre?.issues));
const cSafeHead = await corsCase("/missing-method", ["--cors-method", "HEAD"]);
assert("预检：HEAD 是 CORS-safelisted，Allow-Methods 只列 GET,OPTIONS 仍通过", cSafeHead.pre?.status === "pass", JSON.stringify(cSafeHead.pre?.issues));
const cCaseNorm = await corsCase("/case-normalize", ["--cors-method", "put"]);
assert("预检：已知方法 put 按规范规范化为 PUT 后匹配", cCaseNorm.pre?.status === "pass", JSON.stringify(cCaseNorm.pre?.issues));
const cCaseLower = await corsCase("/lower-method", ["--cors-method", "DELETE"]);
assert("预检：Allow-Methods 小写 delete 与 DELETE 不匹配", cCaseLower.pre?.status === "fail" && cCaseLower.pre.issues.some((s) => /不含实际请求方法 DELETE/.test(s)), JSON.stringify(cCaseLower.pre?.issues));
const cAcaoWild = await corsCase("/acao-wildcard", ["--cors-credentials"]);
assert("简单请求：带凭据 + ACAO=* 判失败", cAcaoWild.result.checks.some((c) => c.id === "cors" && c.status === "fail"), JSON.stringify(cAcaoWild.result.checks.find((c) => c.id === "cors")));
const cAcaoWildNoCred = await corsCase("/acao-wildcard");
assert("简单请求：无凭据 + ACAO=* 仍允许", cAcaoWildNoCred.result.checks.some((c) => c.id === "cors" && c.status === "pass"), JSON.stringify(cAcaoWildNoCred.result.checks.find((c) => c.id === "cors")));

// 简单请求的凭据模式由 --cors-credentials 声明，与响应里有没有 ACAC 无关。
const simpleCase = async (p, extra = []) => {
  const r = await runVerify([
    "--url", staticBase, "--mode", "static", "--origin", "https://app.example.com",
    "--cors-url", `${corsMatrixUrl}${p}`, ...extra, "--json",
  ]);
  return JSON.parse(r.out).checks.find((c) => c.id === "cors");
};
const sStarAcac = await simpleCase("/simple-star-acac");
assert("简单请求：无凭据 + ACAO=* + ACAC=true 仍允许", sStarAcac?.status === "pass" && sStarAcac.acac === "true" && sStarAcac.credentials === false, JSON.stringify(sStarAcac));
const sStarNoAcac = await simpleCase("/acao-wildcard");
assert("简单请求：无凭据 + ACAO=* + 无 ACAC 仍允许", sStarNoAcac?.status === "pass" && !sStarNoAcac.acac, JSON.stringify(sStarNoAcac));
const sCredStar = await simpleCase("/acao-wildcard", ["--cors-credentials"]);
assert("简单请求：有凭据 + ACAO=* 判失败且要求精确 Origin", sCredStar?.status === "fail" && /必须精确匹配 Origin/.test(sCredStar.detail), JSON.stringify(sCredStar));
const sCredOk = await simpleCase("/ok", ["--cors-credentials"]);
assert("简单请求：有凭据 + 精确 ACAO + ACAC=true 通过", sCredOk?.status === "pass" && sCredOk.acao === "https://app.example.com" && sCredOk.acac === "true", JSON.stringify(sCredOk));
const sCredNoAcac = await simpleCase("/simple-exact-no-acac", ["--cors-credentials"]);
assert("简单请求：有凭据 + 精确 ACAO + 缺 ACAC 判失败", sCredNoAcac?.status === "fail" && /Allow-Credentials/.test(sCredNoAcac.detail), JSON.stringify(sCredNoAcac));
assert("简单请求：--cors-credentials 是声明的预期模式，不是脚本真的发了 Cookie", sStarAcac?.credentialsDeclaredByUser === true && sStarAcac.credentialsMode === "declared-no-credentials" && sCredOk?.credentialsMode === "declared-with-credentials");
assert("简单请求：脚本实际没有发送 Cookie / Authorization",
  corsMatrixSeen.length > 0 && corsMatrixSeen.every((r) => !r.cookie && !r.authorization),
  JSON.stringify(corsMatrixSeen.slice(0, 3)));

const v7 = await runVerify(["--url", dupUrl, "--mode", "static", "--json"]);
const v7j = JSON.parse(v7.out);
assert("验收：重复 canonical 判失败", v7.code === 1 && v7j.checks.some((c) => c.id === "canonical" && c.status === "fail"));

// ---------------------------------------------------------------- canonical 协议矩阵（真实本地 HTTPS 站点）
const tlsCase = async (p) => {
  const r = await runVerify(["--url", `${tlsCanonicalBase}${p}`, "--mode", "static", "--json"], tlsVerifyEnv);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 断言里带上 stderr 便于定位 */ }
  return {
    code: r.code, err: r.err,
    root: j?.checks?.find((c) => c.id === "root"),
    canonical: j?.checks?.find((c) => c.id === "canonical"),
  };
};
const cSelf = await tlsCase("/");
assert("canonical：HTTPS 站点 + HTTPS 自身 canonical 判通过",
  cSelf.root?.status === "pass" && cSelf.root.httpStatus === 200
    && cSelf.canonical?.status === "pass" && cSelf.canonical.sameProtocol === true
    && cSelf.canonical.sameHost === true && cSelf.canonical.samePath === true,
  JSON.stringify({ root: cSelf.root, canonical: cSelf.canonical, err: cSelf.err }));
const cHttp = await tlsCase("/http-canon/");
assert("canonical：HTTPS 站点 + HTTP canonical 判警告并明确指出协议不一致",
  cHttp.canonical?.status === "warn" && cHttp.root?.status === "pass"
    && cHttp.canonical.sameProtocol === false && cHttp.canonical.sameHost === true
    && cHttp.canonical.samePath === true && /协议不一致/.test(cHttp.canonical.detail)
    && /http:/.test(cHttp.canonical.href) && /当前站点为 https:/.test(cHttp.canonical.detail),
  JSON.stringify({ canonical: cHttp.canonical, err: cHttp.err }));
const cHost = await tlsCase("/other-host/");
assert("canonical：不同主机维持原有警告",
  cHost.canonical?.status === "warn" && cHost.canonical.sameHost === false
    && /指向其他主机/.test(cHost.canonical.detail), JSON.stringify(cHost.canonical));
const cPath = await tlsCase("/other-path/");
assert("canonical：不同路径维持原有警告",
  cPath.canonical?.status === "warn" && cPath.canonical.samePath === false
    && /指向另一个路径/.test(cPath.canonical.detail), JSON.stringify(cPath.canonical));
const cMulti = await tlsCase("/multi/");
assert("canonical：多个标签维持原有失败判定",
  cMulti.canonical?.status === "fail" && cMulti.code === 1
    && /2 个 canonical 标签/.test(cMulti.canonical.detail), JSON.stringify(cMulti.canonical));

// ---------------------------------------------------------------- canonical href 形态矩阵（真实 HTTP）
const canonicalHrefCase = async (p) => {
  const r = await runVerify(["--url", `${canonicalHrefBase}${p}`, "--mode", "static", "--json"]);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 断言里带上 stderr */ }
  return { code: r.code, err: r.err, canonical: j?.checks?.find((c) => c.id === "canonical") };
};
const hrefMissing = await canonicalHrefCase("/missing-href/");
assert("canonical href：缺少 href 判失败，不当成指向自身",
  hrefMissing.code === 1 && hrefMissing.canonical?.status === "fail"
    && hrefMissing.canonical.hrefState === "missing" && hrefMissing.canonical.href === null
    && hrefMissing.canonical.sameHost === undefined && hrefMissing.canonical.samePath === undefined
    && /缺少 href/.test(hrefMissing.canonical.detail) && !/canonical 指向自身/.test(hrefMissing.canonical.detail),
  JSON.stringify({ canonical: hrefMissing.canonical, err: hrefMissing.err }));
const hrefEmpty = await canonicalHrefCase("/empty-href/");
assert("canonical href：空字符串判失败，不解析成当前站点",
  hrefEmpty.code === 1 && hrefEmpty.canonical?.status === "fail"
    && hrefEmpty.canonical.hrefState === "empty" && hrefEmpty.canonical.href === ""
    && hrefEmpty.canonical.sameHost === undefined && hrefEmpty.canonical.samePath === undefined
    && /为空字符串/.test(hrefEmpty.canonical.detail) && !/canonical 指向自身/.test(hrefEmpty.canonical.detail),
  JSON.stringify({ canonical: hrefEmpty.canonical, err: hrefEmpty.err }));
const hrefSingle = await canonicalHrefCase("/single-quote/");
assert("canonical href：单引号属性值按指向自身通过",
  hrefSingle.code === 0 && hrefSingle.canonical?.status === "pass"
    && hrefSingle.canonical.hrefState === "valid"
    && hrefSingle.canonical.sameProtocol === true && hrefSingle.canonical.sameHost === true
    && hrefSingle.canonical.samePath === true, JSON.stringify(hrefSingle.canonical));
const hrefDouble = await canonicalHrefCase("/double-quote/");
assert("canonical href：双引号属性值按指向自身通过",
  hrefDouble.code === 0 && hrefDouble.canonical?.status === "pass"
    && hrefDouble.canonical.hrefState === "valid"
    && hrefDouble.canonical.sameProtocol === true && hrefDouble.canonical.sameHost === true
    && hrefDouble.canonical.samePath === true, JSON.stringify(hrefDouble.canonical));
const hrefUnquoted = await canonicalHrefCase("/unquoted/");
assert("canonical href：不带引号的合法属性值按指向自身通过",
  hrefUnquoted.code === 0 && hrefUnquoted.canonical?.status === "pass"
    && hrefUnquoted.canonical.hrefState === "valid"
    && hrefUnquoted.canonical.sameProtocol === true && hrefUnquoted.canonical.sameHost === true
    && hrefUnquoted.canonical.samePath === true, JSON.stringify(hrefUnquoted.canonical));
const hrefBad = await canonicalHrefCase("/bad-href/");
assert("canonical href：无法解析判失败，不回退到当前站点",
  hrefBad.code === 1 && hrefBad.canonical?.status === "fail"
    && hrefBad.canonical.hrefState === "invalid" && hrefBad.canonical.href === "http://"
    && hrefBad.canonical.sameHost === undefined && hrefBad.canonical.samePath === undefined
    && /无法解析/.test(hrefBad.canonical.detail) && !/canonical 指向自身/.test(hrefBad.canonical.detail),
  JSON.stringify({ canonical: hrefBad.canonical, err: hrefBad.err }));

const v8 = await runVerify(["--url", staticBase, "--mode", "static", "--backup", backupUrl, "--json"]);
const v8j = JSON.parse(v8.out);
assert("验收：拒绝 301 备用站", v8.code === 1 && v8j.checks.some((c) => c.id === "backup" && c.status === "fail"), "备用站跳到主站");
const b304r = await runVerify(["--url", staticBase, "--mode", "static", "--backup", `${backupUrl}b304/`, "--json"]);
const b304 = JSON.parse(b304r.out).checks.find((c) => c.id === "backup");
assert("备用站：304 不写成重定向未完成验证", b304r.code === 1 && b304?.status === "fail"
  && b304.statusClass === "not-modified" && /不是可验证的响应/.test(b304.detail) && !/重定向未完成验证/.test(b304.detail),
JSON.stringify(b304));
const b300r = await runVerify(["--url", staticBase, "--mode", "static", "--backup", `${backupUrl}b300/`, "--json"]);
const b300 = JSON.parse(b300r.out).checks.find((c) => c.id === "backup");
assert("备用站：少见 3xx 同样不判通过", b300r.code === 1 && b300?.status === "fail"
  && b300.statusClass === "unexpected-3xx" && /不是可验证的响应/.test(b300.detail), JSON.stringify(b300));

// ---------------------------------------------------------------- 资源重定向矩阵
const assetCase = async (casePath) => {
  const r = await runVerify(["--url", `${assetRedirectBase}${casePath}`, "--mode", "static", "--assets-limit", "1", "--json"]);
  const j = JSON.parse(r.out);
  const assets = j.checks.find((c) => c.id === "assets");
  return { code: r.code, assets, probed: assets?.probed?.[0], result: j };
};
const aDirect = await assetCase("/case/direct/");
assert("资源：直接 200 判通过且无重定向", aDirect.assets?.status === "pass" && aDirect.probed?.chain?.length === 1 && aDirect.probed.finalStatus === 200, JSON.stringify(aDirect.probed));
const a301 = await assetCase("/case/301ok/");
assert("资源：301 同主机跟随到最终 200 判通过", a301.assets?.status === "pass" && a301.probed?.redirected === true && a301.probed.finalStatus === 200 && /\/a\/final\.css$/.test(a301.probed.finalUrl) && a301.assets.redirects?.length === 1, JSON.stringify(a301.probed));
const a302 = await assetCase("/case/302bad/");
assert("资源：302 后最终 404 判失败", a302.assets?.status === "fail" && a302.code === 1 && /最终状态 404/.test(a302.assets.broken[0].reason), JSON.stringify(a302.assets?.broken));
const aCross = await assetCase("/case/cross/");
assert("资源：跨主机重定向不默默当正常，记录最终地址与链", aCross.assets?.status === "warn" && aCross.probed?.crossHost === true && aCross.probed.finalUrl.startsWith(assetTargetBase) && aCross.probed.chain.length === 1 && aCross.assets.warnings?.length === 1, JSON.stringify(aCross.probed));
const aLoop = await assetCase("/case/loop/");
assert("资源：重定向循环有跳数上限且判失败", aLoop.assets?.status === "fail" && /超过 5 跳/.test(aLoop.assets.broken[0].reason) && aLoop.probed?.chain?.length === 6, JSON.stringify(aLoop.assets?.broken));
const a404 = await assetCase("/case/404/");
assert("资源：直接 404 判失败", a404.assets?.status === "fail" && /最终状态 404/.test(a404.assets.broken[0].reason), JSON.stringify(a404.assets?.broken));
const aHead405 = await assetCase("/case/head405/");
assert("资源：HEAD 405 改 GET 复核后仍判通过", aHead405.assets?.status === "pass" && aHead405.probed?.method === "GET" && aHead405.probed.fallback === true, JSON.stringify(aHead405.probed));
const aNoLoc = await assetCase("/case/noloc/");
assert("资源：3xx 缺 Location 判失败", aNoLoc.assets?.status === "fail" && /缺少 Location/.test(aNoLoc.assets.broken[0].reason), JSON.stringify(aNoLoc.assets?.broken));
const aBadProto = await assetCase("/case/badproto/");
assert("资源：非 HTTP/HTTPS 重定向目标判失败且不跟随", aBadProto.assets?.status === "fail" && /协议不受支持/.test(aBadProto.assets.broken[0].reason) && aBadProto.probed?.chain.length === 1, JSON.stringify(aBadProto.assets?.broken));
const crossHitsBefore = crossTargetHits.length;
const aHostile = await assetCase("/case/hostile/");
assert("资源：伪装成相对地址的跨源 URL 不会被请求（SSRF 防护）",
  aHostile.code === 0 && aHostile.assets?.status === "pass"
    && aHostile.probed?.url === "/a/direct.css"
    && aHostile.assets.ignored?.some((i) => /跨源/.test(i.reason))
    && !crossTargetHits.slice(crossHitsBefore).includes("/ssrf-probe"),
  JSON.stringify({ ignored: aHostile.assets?.ignored, hits: crossTargetHits.slice(crossHitsBefore) }));
assert("资源：javascript: 等非 HTTP(S) 链接不会被当资源探测",
  aHostile.assets?.checked === 1 && aHostile.probed?.url === "/a/direct.css",
  JSON.stringify({ checked: aHostile.assets?.checked, probed: aHostile.probed }));

// ---------------------------------------------------------------- 资源 3xx 状态分类
const a304 = await assetCase("/case/304/");
assert("资源：304 不进入重定向链，也不判资源正常",
  a304.code === 1 && a304.assets?.status === "fail"
    && a304.probed?.redirected === false && a304.probed?.finalStatus === 304
    && a304.assets.redirects.length === 0 && a304.assets.broken[0]?.redirected === false
    && /304 Not Modified/.test(a304.assets.broken[0].reason)
    && !/缺少 Location/.test(a304.assets.broken[0].reason),
  JSON.stringify({ assets: a304.assets, probed: a304.probed }));
const a307 = await assetCase("/case/307ok/");
assert("资源：307 同主机跟随到最终 200 判通过",
  a307.assets?.status === "pass" && a307.probed?.redirected === true
    && a307.probed.finalStatus === 200 && /\/a\/final\.css$/.test(a307.probed.finalUrl)
    && a307.assets.redirects?.length === 1
    && a307.probed.chain.length === 2 && a307.probed.chain[0].status === 307
    && a307.probed.chain[0].statusClass === "redirect",
  JSON.stringify(a307.probed));
const a308 = await assetCase("/case/308ok/");
assert("资源：308 同主机跟随到最终 200 判通过",
  a308.assets?.status === "pass" && a308.probed?.redirected === true
    && a308.probed.finalStatus === 200 && /\/a\/final\.css$/.test(a308.probed.finalUrl)
    && a308.assets.redirects?.length === 1
    && a308.probed.chain.length === 2 && a308.probed.chain[0].status === 308
    && a308.probed.chain[0].statusClass === "redirect",
  JSON.stringify(a308.probed));
const a300 = await assetCase("/case/300/");
assert("资源：少见 3xx（300）只警告，不进 redirects 也不判正常",
  a300.assets?.status === "warn" && a300.code === 0
    && a300.probed?.redirected === false && a300.probed?.finalStatus === 300
    && a300.assets.redirects.length === 0 && a300.assets.warnings.length === 1
    && /不在需要跟随的重定向状态/.test(a300.assets.warnings[0].reason),
  JSON.stringify({ assets: a300.assets, probed: a300.probed }));

// ---------------------------------------------------------------- 资源重定向汇总一致性
assert("资源汇总：直接 200 不进 redirects", aDirect.assets.redirects.length === 0 && aDirect.probed.redirected === false, JSON.stringify(aDirect.assets.redirects));
assert("资源汇总：同主机 301 进 redirects，保留链与最终状态",
  a301.assets.redirects.length === 1 && a301.assets.redirects[0].crossHost === false
    && a301.assets.redirects[0].chain.length === 2 && a301.assets.redirects[0].finalStatus === 200
    && a301.probed.redirected === true, JSON.stringify(a301.assets.redirects));
assert("资源汇总：跨主机 302 同时进 redirects 与 warnings，probed 三处一致",
  aCross.assets.redirects.length === 1 && aCross.assets.redirects[0].crossHost === true
    && aCross.assets.redirects[0].url === aCross.probed.url
    && aCross.assets.redirects[0].finalUrl === aCross.probed.finalUrl
    && aCross.assets.redirects[0].finalStatus === aCross.probed.finalStatus
    && aCross.assets.warnings.length === 1 && aCross.assets.warnings[0].crossHost === true
    && aCross.assets.warnings[0].redirected === true && aCross.probed.redirected === true,
  JSON.stringify({ redirects: aCross.assets.redirects, warnings: aCross.assets.warnings, probed: aCross.probed }));
assert("资源汇总：重定向循环进失败记录，且仍记为发生过重定向",
  aLoop.assets.broken[0].redirected === true && aLoop.probed.redirected === true
    && aLoop.assets.redirects.length === 1 && aLoop.assets.redirects[0].level === "fail",
  JSON.stringify(aLoop.assets.redirects));
assert("资源汇总：缺 Location 进失败记录且不进 redirects",
  aNoLoc.assets.broken[0].redirected === false && aNoLoc.assets.redirects.length === 0,
  JSON.stringify(aNoLoc.assets.redirects));

// ---------------------------------------------------------------- /index.html 状态分类
const indexCase = async (code) => {
  const r = await runVerify(["--url", `${indexStatusBase}/idx${code}/`, "--mode", "static", "--json"]);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 断言里带上 stderr */ }
  return { code: r.code, idx: j?.checks?.find((c) => c.id === "index-redirect") };
};
const i304 = await indexCase(304);
assert("index.html：304 不算有效重定向，也不报缺少 Location",
  i304.idx?.status === "warn" && i304.idx.httpStatus === 304
    && i304.idx.statusClass === "not-modified" && i304.idx.redirect === false
    && /不是重定向/.test(i304.idx.detail) && !/缺少 Location/.test(i304.idx.detail),
  JSON.stringify(i304.idx));
const i300 = await indexCase(300);
assert("index.html：少见 3xx（300）不判通过",
  i300.idx?.status === "warn" && i300.idx.httpStatus === 300
    && i300.idx.statusClass === "unexpected-3xx" && i300.idx.redirect === false
    && /不能确认收敛/.test(i300.idx.detail), JSON.stringify(i300.idx));
for (const code of [301, 302, 303, 307, 308]) {
  const r = await indexCase(code);
  assert(`index.html：${code} 仍按有效重定向判通过`,
    r.code === 0 && r.idx?.status === "pass" && r.idx.httpStatus === code
      && r.idx.statusClass === "redirect" && r.idx.redirect === true
      && r.idx.redirectKind === "same-origin" && r.idx.convergesToRoot === true,
    JSON.stringify(r.idx));
}

// /index.html 的重定向目标不是站点根 / 不是同源 HTTP(S) 时，不能判「收敛到 /」。
const indexSpecial = async (name) => {
  const r = await runVerify(["--url", `${indexStatusBase}/${name}/`, "--mode", "static", "--json"]);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* 断言里带上 stderr */ }
  return { code: r.code, idx: j?.checks?.find((c) => c.id === "index-redirect"), err: r.err };
};
const iCross = await indexSpecial("idxcross");
assert("index.html：跨源重定向不判通过", iCross.idx?.status === "warn" && iCross.idx.redirect === false
  && iCross.idx.redirectKind === "cross-origin" && iCross.idx.convergesToRoot === false
  && /不是同源/.test(iCross.idx.detail), JSON.stringify(iCross.idx));
const iFile = await indexSpecial("idxfile");
assert("index.html：非 HTTP(S) 重定向不判通过", iFile.idx?.status === "warn"
  && iFile.idx.redirectKind === "unsupported-protocol" && iFile.idx.convergesToRoot === false, JSON.stringify(iFile.idx));
const iElsewhere = await indexSpecial("idxelsewhere");
assert("index.html：同源但目标不是站点根不判通过", iElsewhere.idx?.status === "warn"
  && iElsewhere.idx.redirectKind === "same-origin" && iElsewhere.idx.convergesToRoot === false
  && /不是站点根/.test(iElsewhere.idx.detail), JSON.stringify(iElsewhere.idx));
const iNoLoc = await indexSpecial("idxnoloc");
assert("index.html：301 缺 Location 只警告，不当成有效重定向", iNoLoc.idx?.status === "warn"
  && iNoLoc.idx.redirectKind === "invalid-location" && /缺失或无法解析/.test(iNoLoc.idx.detail), JSON.stringify(iNoLoc.idx));

// ---------------------------------------------------------------- 重定向策略（纯函数，不发请求）
assert("重定向策略：相对 Location 同源可跟随", classifyRedirect("http://127.0.0.1:8000/a", "/b", "http://127.0.0.1:8000").kind === "same-origin");
assert("重定向策略：HTTP → HTTPS 判跨源并标记协议变化", (() => {
  const c = classifyRedirect("http://127.0.0.1:8000/a", "https://127.0.0.1:8000/b", "http://127.0.0.1:8000");
  return c.kind === "cross-origin" && c.protocolChanged === true && c.next.startsWith("https://");
})());
assert("重定向策略：HTTPS → HTTP 判跨源并标记协议变化", (() => {
  const c = classifyRedirect("https://a.example/", "http://a.example/final", "https://a.example");
  return c.kind === "cross-origin" && c.protocolChanged === true && c.next.startsWith("http://");
})());
assert("重定向策略：端口变化也算跨源", classifyRedirect("http://a.example/", "http://a.example:8443/x", "http://a.example").kind === "cross-origin");
assert("重定向策略：跨主机／127.0.0.1 目标不跟随", classifyRedirect("http://a.example/", "http://127.0.0.1:9/x", "http://a.example").kind === "cross-origin");
assert("重定向策略：非 HTTP/HTTPS 协议直接拒绝", classifyRedirect("http://a.example/", "file:///etc/passwd", "http://a.example").kind === "unsupported-protocol");
assert("重定向策略：空 / 无法解析的 Location 分类正确",
  classifyRedirect("http://a.example/", null, "http://a.example").kind === "invalid-location"
    && classifyRedirect("http://a.example/", "http://", "http://a.example").kind === "invalid-location");
assert("重定向策略：始终约束到起始源，不能中途换源", classifyRedirect("http://a.example/x", "http://b.example/y", "http://a.example").kind === "cross-origin");

// ---------------------------------------------------------------- 主站重定向矩阵（本地 HTTP 服务器）
const rootCase = async (p) => {
  const r = await runVerify(["--url", `${rootRedirectBase}${p}`, "--mode", "static", "--json"]);
  return JSON.parse(r.out).checks.find((c) => c.id === "root");
};
const rSame301 = await rootCase("/case/same301/");
assert("主站：同源 301 → 200 判通过并写明最终验证成功",
  rSame301?.status === "pass" && rSame301.redirectOutcome === "same-origin-verified"
    && rSame301.verified === true && rSame301.hops.length === 2 && /同源重定向 1 跳后最终验证成功/.test(rSame301.detail),
  JSON.stringify(rSame301));
const rSame302 = await rootCase("/case/same302/");
assert("主站：同源 302 → 404 判失败且区分于跨源",
  rSame302?.status === "fail" && rSame302.redirectOutcome === "same-origin-final-failed"
    && rSame302.hops.length === 2 && rSame302.httpStatus === 404, JSON.stringify(rSame302));
const rCross = await rootCase("/case/crosshost/");
assert("主站：跨主机重定向只记录不跟随，目标未验证",
  rCross?.status === "warn" && rCross.redirectOutcome === "cross-origin-unverified"
    && rCross.verified === false && rCross.hops.length === 1 && rCross.redirectTarget.includes("localhost")
    && rCross.hops[0].location === rCross.redirectTarget && !crossTargetHits.includes("/cross-landing"),
  JSON.stringify(rCross));
assert("主站：跨主机目标返回 200 也不会让原站点判 pass",
  rCross?.status === "warn" && rCross.httpStatus === 302 && rCross.verified === false,
  JSON.stringify({ checkStatus: rCross?.status, httpStatus: rCross?.httpStatus }));
const rLoopback = await rootCase("/case/loopback/");
assert("主站：重定向到 127.0.0.1 不请求该目标",
  rLoopback?.status === "warn" && rLoopback.redirectOutcome === "cross-origin-unverified"
    && rLoopback.redirectTarget.includes("127.0.0.1") && !crossTargetHits.includes("/loop-landing"),
  JSON.stringify(rLoopback));
const rProtoUp = await rootCase("/case/proto-up/");
assert("主站：HTTP → HTTPS 判跨源并标记协议变化",
  rProtoUp?.status === "warn" && rProtoUp.redirectOutcome === "cross-origin-unverified"
    && rProtoUp.hops[0].protocolChanged === true && rProtoUp.redirectTarget.startsWith("https://")
    && !rootRedirectHits.includes("/tls-landing"), JSON.stringify(rProtoUp));
const rLoop = await rootCase("/case/loop/");
assert("主站：重定向循环单独分类且不取得最终 200",
  rLoop?.status === "fail" && rLoop.redirectOutcome === "loop-or-limit" && rLoop.hops.length === 5
    && /循环或超过跳数/.test(rLoop.detail), JSON.stringify(rLoop));
const rBadLoc = await rootCase("/case/badloc/");
assert("主站：无法解析的 Location 单独分类并判失败",
  rBadLoc?.status === "fail" && rBadLoc.redirectOutcome === "invalid-location"
    && /Location/.test(rBadLoc.detail) && rBadLoc.redirectTarget === null, JSON.stringify(rBadLoc));
const rBadProto = await rootCase("/case/badproto/");
assert("主站：非 HTTP/HTTPS 目标直接拒绝且不请求",
  rBadProto?.status === "fail" && rBadProto.redirectOutcome === "unsupported-protocol"
    && /非 HTTP\/HTTPS/.test(rBadProto.detail), JSON.stringify(rBadProto));

// ---------------------------------------------------------------- 3xx 状态分类（304 与少见 3xx）
const rootCaseFull = async (p) => {
  const r = await runVerify(["--url", `${rootRedirectBase}${p}`, "--mode", "static", "--json"]);
  return { code: r.code, root: JSON.parse(r.out).checks.find((c) => c.id === "root") };
};
const r304 = await rootCaseFull("/case/304/");
assert("主站：304 不当作重定向，也不报缺少 Location",
  r304.root?.status === "fail" && r304.root.redirectOutcome === "not-modified"
    && r304.root.httpStatus === 304 && r304.root.statusClass === "not-modified"
    && r304.root.verified === false && r304.root.hops.length === 1
    && !/缺少 Location/.test(r304.root.detail) && !/同源重定向/.test(r304.root.detail),
  JSON.stringify(r304.root));
const r300 = await rootCaseFull("/case/300/");
assert("主站：少见 3xx（300）单独分类为警告，不判通过",
  r300.root?.status === "warn" && r300.root.redirectOutcome === "unexpected-3xx"
    && r300.root.httpStatus === 300 && r300.root.statusClass === "unexpected-3xx"
    && r300.root.verified === false && !/同源重定向/.test(r300.root.detail),
  JSON.stringify(r300.root));
for (const code of [301, 302, 303, 307, 308]) {
  const r = await rootCaseFull(`/case/r${code}/`);
  assert(`主站：${code} 仍按同源重定向跟随并验证最终 200`,
    r.code === 0 && r.root?.status === "pass" && r.root.redirectOutcome === "same-origin-verified"
      && r.root.verified === true && r.root.httpStatus === 200 && r.root.hops.length === 2
      && r.root.hops[0].status === code && r.root.hops[0].statusClass === "redirect",
    JSON.stringify(r.root));
}

// 备用站跳主站：只解析 Location 识别，不为识别而请求主站。
const vBackupMain = await runVerify([
  "--url", `${crossTargetBase}/`, "--mode", "static",
  "--backup", `http://127.0.0.1:${backupServer.address().port}/to-main/`, "--json",
]);
const bMain = JSON.parse(vBackupMain.out).checks.find((c) => c.id === "backup");
assert("备用站：识别跳主站但不请求主站",
  bMain?.status === "fail" && /跳转到主站/.test(bMain.detail) && bMain.hops.length === 1
    && bMain.redirectOutcome === "cross-origin" && !crossTargetHits.includes("/backup-landing"),
  JSON.stringify(bMain));
assert("重定向：跨源目标服务器全程未收到 landing 请求",
  !crossTargetHits.some((p) => /landing/.test(p)), crossTargetHits.join(","));

// ---------------------------------------------------------------- 主站 / 备用站跳数边界矩阵
const chainCase = async (caseName) => {
  const r = await runVerify(["--url", `${rootRedirectBase}/chain/${caseName}/0/`, "--mode", "static", "--json"]);
  const j = JSON.parse(r.out);
  // 只数链跳：404 探测（/chain/<case>/0/__cf_deploy_check_.../）和 /index.html 不算。
  const hopRe = new RegExp(`^/chain/${caseName}/\\d+/$`);
  return {
    code: r.code,
    root: j.checks.find((c) => c.id === "root"),
    hits: rootRedirectHits.filter((p) => hopRe.test(p)),
  };
};
const h5ok = await chainCase("five-ok");
assert("跳数：5 次同源重定向后最终 200 判通过，且确实请求了第 6 个地址",
  h5ok.root?.status === "pass" && h5ok.root.redirectOutcome === "same-origin-verified"
    && h5ok.root.httpStatus === 200 && h5ok.root.verified === true
    && h5ok.root.hops.length === 6 && h5ok.hits.length === 6
    && h5ok.hits.includes("/chain/five-ok/5/"),
  JSON.stringify({ root: h5ok.root, hits: h5ok.hits }));
const h5404 = await chainCase("five-404");
assert("跳数：5 次同源重定向后最终 404 判最终状态失败，而不是跳数超限",
  h5404.root?.status === "fail" && h5404.root.redirectOutcome === "same-origin-final-failed"
    && h5404.root.httpStatus === 404 && h5404.root.hops.length === 6
    && h5404.hits.includes("/chain/five-404/5/") && !/循环或超过跳数/.test(h5404.root.detail),
  JSON.stringify({ root: h5404.root, hits: h5404.hits }));
const h6 = await chainCase("six");
assert("跳数：第 6 次同源重定向判超出跳数，且不请求第 7 个地址",
  h6.root?.status === "fail" && h6.root.redirectOutcome === "loop-or-limit"
    && h6.root.limitHop?.status === 301 && h6.root.limitHop?.followed === false
    && h6.hits.length === 6 && !h6.hits.includes("/chain/six/6/"),
  JSON.stringify({ root: h6.root, hits: h6.hits }));
const hcross = await chainCase("five-cross");
assert("跳数：5 次同源重定向后跨源跳转仍不请求跨源目标",
  hcross.root?.status === "warn" && hcross.root.redirectOutcome === "cross-origin-unverified"
    && hcross.root.verified === false && !crossTargetHits.includes("/chain-landing"),
  JSON.stringify(hcross.root));
assert("跳数：原有循环用例仍判超限，且恰好请求 6 次（5 次跟随 + 第 6 次判超限）",
  rLoop?.status === "fail" && rLoop.redirectOutcome === "loop-or-limit"
    && rLoop.limitHop?.followed === false
    && rootRedirectHits.filter((p) => p === "/case/loop/").length === 6,
  JSON.stringify({ loop: rLoop, hits: rootRedirectHits.filter((p) => p === "/case/loop/").length }));

const backupChain = async (n) => {
  const r = await runVerify(["--url", staticBase, "--mode", "static", "--backup", `${backupUrl}chain/${n}/0/`, "--json"]);
  return JSON.parse(r.out).checks.find((c) => c.id === "backup");
};
const b5 = await backupChain(5);
assert("备用站：5 次同源重定向后最终 200 判通过（与主站同一跳数规则）",
  b5?.status === "pass" && b5.hops.length === 6 && b5.redirectOutcome === null,
  JSON.stringify(b5));
const b6 = await backupChain(6);
assert("备用站：6 次同源重定向同样判超出跳数",
  b6?.status === "fail" && b6.redirectOutcome === "loop-or-limit"
    && /重定向未完成验证/.test(b6.detail), JSON.stringify(b6));

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

// ---------------------------------------------------------------- --expect-json 结构化比较
const apiCheck = (j) => j.checks.find((c) => c.id === "api");
const vjOrder = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/reordered", "--expect-json", '{"ok":true,"nested":{"b":[1,2],"a":1}}', "--json"]);
const jOrder = apiCheck(JSON.parse(vjOrder.out));
assert("JSON 比较：字段顺序与空白不影响结果", jOrder.status === "pass" && jOrder.expectedFound === true && jOrder.jsonComparison?.match === true, JSON.stringify(jOrder.jsonComparison));
const vjMissing = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/missing", "--expect-json", '{"ok":true}', "--json"]);
const jMissing = apiCheck(JSON.parse(vjMissing.out));
assert("JSON 比较：字段缺失给出明确路径", jMissing.status === "fail" && /字段 \$\.ok 缺失/.test(jMissing.detail), jMissing.detail);
assert("验收：API 检查暴露真实 HTTP 状态码", jMissing.httpStatus === 200, JSON.stringify({ httpStatus: jMissing.httpStatus, status: jMissing.status }));
const vjType = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/wrongtype", "--expect-json", '{"ok":true}', "--json"]);
const jType = apiCheck(JSON.parse(vjType.out));
assert("JSON 比较：值类型不同判失败", jType.status === "fail" && /期望 true/.test(jType.detail), jType.detail);
const vjArray = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/array", "--expect-json", '{"items":[{"id":1},{"id":2}]}', "--json"]);
assert("JSON 比较：嵌套数组作为子集匹配", apiCheck(JSON.parse(vjArray.out)).status === "pass");
const vjArrayBad = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/array", "--expect-json", '{"items":[{"id":9}]}', "--json"]);
assert("JSON 比较：数组长度/元素不符判失败", apiCheck(JSON.parse(vjArrayBad.out)).status === "fail");
const vjBadExpect = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/health", "--expect-json", "not-json", "--json"]);
const jBadExpect = apiCheck(JSON.parse(vjBadExpect.out));
assert("JSON 比较：预期值不是合法 JSON 明确报错", jBadExpect.status === "fail" && /不是合法 JSON/.test(jBadExpect.expectedJsonError || ""), jBadExpect.detail);
const vjBadBody = await runVerify(["--url", ssrUrl, "--mode", "ssr", "--api", "/api/badjson", "--expect-json", '{"ok":true}', "--json"]);
const jBadBody = apiCheck(JSON.parse(vjBadBody.out));
assert("JSON 比较：响应体不是合法 JSON 明确报错", jBadBody.status === "fail" && /响应体不是合法 JSON/.test(jBadBody.detail), jBadBody.detail);

const vSsr200 = await runVerify(["--url", spaUrl, "--mode", "ssr", "--json"]);
const vSsr200J = JSON.parse(vSsr200.out);
assert("验收：ssr 下未知路径 200 只警告不判死", vSsr200J.checks.some((c) => c.id === "404" && c.status === "warn") && !vSsr200J.checks.some((c) => c.id === "404" && c.status === "fail"), JSON.stringify(vSsr200J.checks.find((c) => c.id === "404")));

for (const srv of [staticServer, spaServer, corsServer, badCorsServer, dupCanonicalServer, canonicalHrefServer, backupServer, subServer, ssrServer, corsMatrixServer, assetRedirectServer, assetTargetServer, rootRedirectServer, indexStatusServer, crossTargetServer, tlsCanonicalServer]) srv.close();

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
  'if (a[0] === "deploy") {',
  '  if (process.env.CF_FAKE_DEPLOY_FAIL) { console.error("fake deploy failed"); process.exit(1); }',
  '  if (process.env.CF_FAKE_DEPLOY_URL) { console.log("Published " + process.env.CF_FAKE_DEPLOY_URL); }',
  '  else { console.log("Deployed successfully (no URL in this output)"); }',
  '  process.exit(0);',
  "}",
  'if (a[0] === "delete") {',
  '  if (process.env.CF_FAKE_DELETE_FAIL) { console.error("fake delete failed"); process.exit(1); }',
  '  console.log("Successfully deleted");',
  "  process.exit(0);",
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
const runProbe = (extraEnv = {}, extraArgs = []) => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/probe.mjs"), "--json", "--timeout", "3000", ...extraArgs], {
    encoding: "utf8", cwd: probeDir, timeout: 40000,
    env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ...extraEnv },
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* 交给断言报告原始输出 */ }
  return { code: r.status, json: parsed, out: r.stdout, err: r.stderr };
};
const pOk = runProbe();
const pAuth = pOk.json?.checks?.find((c) => c.id === "auth");
assert("探针：whoami --json 调用失败时不误判未登录", pAuth?.status === "pass", pAuth ? JSON.stringify(pAuth) : `out=${pOk.out.slice(0, 200)} err=${pOk.err.slice(0, 200)}`);
assert("探针：从纯文本提取 Account ID", pOk.json?.checks?.some((c) => c.id === "account-id" && c.status === "pass" && c.accountId === "abcdef0123456789abcdef0123456789"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "account-id")));
assert("探针：wrangler 版本探测通过", pOk.json?.checks?.some((c) => c.id === "wrangler" && c.status === "pass"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "wrangler")));
assert("探针：OAuth 登录态如实跳过 Token 权限检查", pOk.json?.checks?.some((c) => c.id === "api-read" && c.status === "skip"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "api-read")));
const pNo = runProbe({ CF_FAKE_NOT_LOGGED: "1" });
assert("探针：文本明确未登录时判 blocked", pNo.json?.checks?.some((c) => c.id === "auth" && c.status === "fail") && pNo.json?.status === "blocked" && pNo.code === 2, `status=${pNo.json?.status} code=${pNo.code}`);

// ---------------------------------------------------------------- 部署探针判定（纯逻辑 + 本地假 wrangler 端到端）
assert("部署探针：能从输出解析 workers.dev URL", parseDeployUrl("Published https://cf-probe-abc.my-account.workers.dev (1.2s)") === "https://cf-probe-abc.my-account.workers.dev");
assert("部署探针：输出里没有 URL 返回 null", parseDeployUrl("Deployed successfully") === null);
const fetchOk = async () => ({ status: 200, text: async () => "ok" });
const fetch503 = async () => ({ status: 503, text: async () => "" });
const fetchWrongBody = async () => ({ status: 200, text: async () => "not ok" });
const fetchThrow = async () => { throw new Error("ECONNREFUSED"); };
const httpServed = await verifyDeployedUrl("https://x.workers.dev", fetchOk, { attempts: 2, delayMs: 0 });
assert("部署探针：200 + 内容匹配才算通过", httpServed.served === true && httpServed.attempts === 1);
const httpNotServed = await verifyDeployedUrl("https://x.workers.dev", fetch503, { attempts: 2, delayMs: 0 });
assert("部署探针：非 200 重试后仍不算通过", httpNotServed.served === false && httpNotServed.attempts === 2);
const httpWrongBody = await verifyDeployedUrl("https://x.workers.dev", fetchWrongBody, { attempts: 1, delayMs: 0 });
assert("部署探针：200 但内容不匹配不算通过", httpWrongBody.served === false && /内容不匹配/.test(httpWrongBody.reason));
const httpUnreachable = await verifyDeployedUrl("https://x.workers.dev", fetchThrow, { attempts: 1, delayMs: 0 });
assert("部署探针：URL 不可访问不算通过", httpUnreachable.served === false && /ECONNREFUSED/.test(httpUnreachable.reason));

const dFail = evaluateDeployProbe({ deployOk: false, deployErr: "error: auth", worker: "w1", cleanupOk: true });
assert("部署探针：部署命令失败判 fail", dFail.deploy.status === "fail" && dFail.deploy.verified === false);
const dNoUrl = evaluateDeployProbe({ deployOk: true, deployOut: "deployed", url: null, http: null, worker: "w1", cleanupOk: true });
assert("部署探针：成功但没 URL 绝不判 pass", dNoUrl.deploy.status !== "pass" && dNoUrl.deploy.verified === false, dNoUrl.deploy.status);
const dUnreachable = evaluateDeployProbe({ deployOk: true, url: "https://x.workers.dev", http: httpUnreachable, worker: "w1", cleanupOk: true });
assert("部署探针：URL 不可访问判 fail", dUnreachable.deploy.status === "fail" && dUnreachable.deploy.verified === false);
const dOk = evaluateDeployProbe({ deployOk: true, url: "https://x.workers.dev", http: httpServed, worker: "w1", cleanupOk: true });
assert("部署探针：拿到 URL 且 HTTP 通过才判 pass", dOk.deploy.status === "pass" && dOk.deploy.verified === true);
const dCleanupFail = evaluateDeployProbe({ deployOk: true, url: "https://x.workers.dev", http: httpServed, worker: "w1", cleanupOk: false });
assert("部署探针：清理失败单独记 warn，不影响 deploy", dCleanupFail.cleanup.status === "warn" && dCleanupFail.deploy.status === "pass");
const dCleanupSkipped = evaluateDeployProbe({ deployOk: false, deployErr: "error: auth", worker: "w1", cleanupSkipped: true });
assert("部署探针：部署失败时清理结论为 skip，不谎称删除失败", dCleanupSkipped.cleanup.status === "skip" && /无需清理/.test(dCleanupSkipped.cleanup.detail), JSON.stringify(dCleanupSkipped.cleanup));

const pDeployNoUrl = runProbe({ CF_FAKE_DELETE_FAIL: "1" }, ["--deploy"]);
const pDepCheck = pDeployNoUrl.json?.checks?.find((c) => c.id === "deploy");
const pCleanup = pDeployNoUrl.json?.checks?.find((c) => c.id === "deploy-cleanup");
assert("探针端到端：--deploy 成功但无 URL 不判 pass", pDepCheck?.status === "warn" && pDepCheck.verified === false, JSON.stringify(pDepCheck));
assert("探针端到端：清理失败单独记录", pCleanup?.status === "warn", JSON.stringify(pCleanup));
assert("探针端到端：nextSteps 提示未完成线上验证", pDeployNoUrl.json?.nextSteps?.some((s) => /没有完成线上验证/.test(s)), JSON.stringify(pDeployNoUrl.json?.nextSteps));
const pDeployFail = runProbe({ CF_FAKE_DEPLOY_FAIL: "1" }, ["--deploy"]);
assert("探针端到端：部署命令失败判 fail", pDeployFail.json?.checks?.find((c) => c.id === "deploy")?.status === "fail");
assert("探针端到端：部署失败时不声称清理失败", (() => {
  const c = pDeployFail.json?.checks?.find((x) => x.id === "deploy-cleanup");
  return c?.status === "skip" && /无需清理/.test(c.detail || "");
})(), JSON.stringify(pDeployFail.json?.checks?.find((c) => c.id === "deploy-cleanup")));

// ---------------------------------------------------------------- 预检退出码
const envRun = spawnSync(process.execPath, [path.join(root, "scripts/check-env.mjs"), "--json"], { encoding: "utf8", timeout: 40000 });
const envJ = JSON.parse(envRun.stdout);
// 从 checks[] 独立推导退出码，避免用脚本自己的 summary 证明自己（summary 恒真/恒假的回归也能被发现）。
const envFail = envJ.checks.filter((c) => c.status === "fail").map((c) => c.id);
const expectCanBuild = !envFail.includes("node") && !envFail.includes("git");
const expectCanDeploy = expectCanBuild
  && envJ.checks.find((c) => c.id === "wrangler")?.status === "pass"
  && envJ.checks.find((c) => c.id === "wrangler-auth")?.status === "pass";
const expectedCode = !expectCanBuild ? 2 : expectCanDeploy ? 0 : 1;
assert("预检：退出码与可构建/可部署结论一致",
  envRun.status === expectedCode && envJ.summary.canBuild === expectCanBuild && envJ.summary.canDeploy === expectCanDeploy,
  `code=${envRun.status} expected=${expectedCode} canBuild=${envJ.summary.canBuild}/${expectCanBuild} canDeploy=${envJ.summary.canDeploy}/${expectCanDeploy}`);
const envBuildOnly = spawnSync(process.execPath, [path.join(root, "scripts/check-env.mjs"), "--build-only", "--json"], { encoding: "utf8", timeout: 40000 });
assert("预检：--build-only 只按可构建判定", envBuildOnly.status === (expectCanBuild ? 0 : 2), `code=${envBuildOnly.status}`);

// 项目目录含空格时，Windows 下本地 .cmd 的绝对路径必须正确加引号才能执行。
const spaceDir = path.join(work, "cf env space");
const spaceBin = path.join(spaceDir, "node_modules", ".bin");
fs.mkdirSync(spaceBin, { recursive: true });
fs.writeFileSync(path.join(spaceBin, "fake-wrangler.mjs"), fakeWrangler);
if (process.platform === "win32") {
  fs.writeFileSync(path.join(spaceBin, "wrangler.cmd"), `@echo off\r\nnode "%~dp0fake-wrangler.mjs" %*\r\n`);
} else {
  fs.writeFileSync(path.join(spaceBin, "wrangler"), `#!/usr/bin/env node\n${fakeWrangler}`);
  fs.chmodSync(path.join(spaceBin, "wrangler"), 0o755);
}
const envSpace = spawnSync(process.execPath, [path.join(root, "scripts/check-env.mjs"), "--json"], {
  encoding: "utf8", cwd: spaceDir, timeout: 40000, env: { ...process.env },
});
let envSpaceJ = null;
try { envSpaceJ = JSON.parse(envSpace.stdout); } catch { /* 断言里带上原始输出 */ }
assert("预检：含空格的项目路径仍能执行本地 wrangler",
  envSpaceJ?.checks?.find((c) => c.id === "wrangler")?.status === "pass",
  envSpaceJ ? JSON.stringify(envSpaceJ.checks.find((c) => c.id === "wrangler")) : `out=${(envSpace.stdout || "").slice(0, 160)} err=${(envSpace.stderr || "").slice(0, 160)}`);
assert("预检：whoami 用实际解析到的本地 wrangler，而不是一律 npx",
  envSpaceJ?.checks?.find((c) => c.id === "wrangler-auth")?.status === "pass",
  JSON.stringify(envSpaceJ?.checks?.find((c) => c.id === "wrangler-auth")));

// ---------------------------------------------------------------- 技能结构
// check-skill 自身的回归：BOM / YAML 块标量 / fenced code 示例不能误报；
// 代码块之外的失效路径仍然必须报告。
const csOkDir = path.join(work, "checkskill-ok");
fs.mkdirSync(csOkDir, { recursive: true });
fs.writeFileSync(path.join(csOkDir, "SKILL.md"),
  "\uFEFF---\nname: checkskill-ok\ndescription: >-\n  这是一个用于验证 YAML 块标量 frontmatter 与 fenced code 示例的测试技能，\n  描述长度必须足够触发技能，并且不能把代码块里的示例路径当成真实引用。\n---\n\n# demo\n\n```md\n[example](missing-target.md)\nscripts/not-a-real.mjs\n```\n", "utf8");
const csOk = spawnSync(process.execPath, [path.join(here, "check-skill.mjs"), csOkDir], { encoding: "utf8" });
assert("结构自检：BOM / 块标量 / fenced code 示例不误报", csOk.status === 0, (csOk.stdout || csOk.stderr).trim().split("\n").at(-1));
const csBadDir = path.join(work, "checkskill-bad");
fs.mkdirSync(csBadDir, { recursive: true });
fs.writeFileSync(path.join(csBadDir, "SKILL.md"),
  "---\nname: checkskill-bad\ndescription: 第二个测试技能，用来确认 fenced code 之外的失效路径引用仍然会被结构检查报告出来。\n---\n\n见 references/not-real.md\n", "utf8");
const csBad = spawnSync(process.execPath, [path.join(here, "check-skill.mjs"), csBadDir], { encoding: "utf8" });
assert("结构自检：代码块之外的失效路径仍会报告", csBad.status === 1 && /not-real/.test(csBad.stdout || ""), (csBad.stdout || csBad.stderr).trim().split("\n").at(-1));

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
