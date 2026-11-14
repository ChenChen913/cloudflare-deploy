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
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePlan, evaluateFileCount, parseVersion, compareVersions } from "../scripts/check-build.mjs";
import { parseDeployUrl, verifyDeployedUrl, evaluateDeployProbe } from "../scripts/deploy-verdict.mjs";
import { classifyRedirect } from "../scripts/redirect-policy.mjs";
import { parseHtml, getAttribute, relTokens, effectiveBaseUrl, decodeCharacterReferences, resourceReferences, parseSrcset, scanScriptData } from "../scripts/html-scan.mjs";
import { classifyWranglerWhoami, extractAccountId } from "../scripts/wrangler-auth.mjs";
import { isTransientNetworkError, parseRetries, collectNetworkErrorCodes } from "../scripts/net-retry.mjs";
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
function assert(name, cond, detail = "", layer = "core") {
  results.push({ name, ok: Boolean(cond), detail, layer });
  console.log(`${cond ? "通过" : "失败"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function detect(dir) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/detect-project.mjs"), dir], { encoding: "utf8", timeout: 30000 });
  if (r.status !== 0) throw new Error(`识别失败 ${dir}：${r.stderr || r.error || r.status}`);
  return JSON.parse(r.stdout);
}

// 网络重试只对连接类瞬时错误生效；HTTP 响应、超时、证书错误不得重试。
assert("网络重试：只分类连接类瞬时错误（含 cause/AggregateError）",
  isTransientNetworkError({ cause: { code: "UND_ERR_SOCKET" } })
    && isTransientNetworkError({ cause: { errors: [{ code: "ECONNRESET" }] } })
    && isTransientNetworkError({ cause: { cause: { code: "ETIMEDOUT" } } })
    && !isTransientNetworkError({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } })
    && !isTransientNetworkError({ cause: { code: "ENOTFOUND" } })
    && !isTransientNetworkError({ cause: { code: "EAI_AGAIN" } })
    && !isTransientNetworkError(new Error("aborted"), true)
    && collectNetworkErrorCodes({ cause: { errors: [{ code: "ECONNRESET" }, { code: "EPIPE" }] } }).includes("EPIPE"),
  JSON.stringify({
    socket: isTransientNetworkError({ cause: { code: "UND_ERR_SOCKET" } }),
    cert: isTransientNetworkError({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } }),
    dns: isTransientNetworkError({ cause: { code: "EAI_AGAIN" } }),
    timeout: isTransientNetworkError(new Error("aborted"), true),
  }), "unit");
assert("网络重试：--retries 只接受 0..3 的整数",
  parseRetries("0") === 0 && parseRetries("3") === 3
    && ["4", "-1", "1.5", "abc", ""].every((v) => parseRetries(v) === null),
  JSON.stringify(["0", "3", "4", "-1", "1.5", "abc", ""].map((v) => [v, parseRetries(v)])), "unit");
function checkBuild(dir, mode = "static") {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", dir, "--mode", mode, "--json"], { encoding: "utf8", timeout: 30000 });
  return { code: r.status, json: JSON.parse(r.stdout) };
}
function runVerify(args, extraEnv = null) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, "scripts/verify-deployment.mjs"), ...args], {
      ...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
    });
    let out = "";
    let err = "";
    // 子进程挂起时不能让整轮测试卡死：超时后 kill 并按失败返回。
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    }, 60000);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, out, err: `${err}\nspawn error: ${e.message}` }); });
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

// HashRouter 与 history 路由的验收模式不同：前者未知路径 404 正常（static），
// 后者必须有 SPA fallback（spa）。识别错误会导致验收结论相反。
json("router-hash/package.json", {
  name: "router-hash-fixture", scripts: { build: "vite build" },
  dependencies: { react: "^19.0.0", "react-router": "^7.0.0" }, devDependencies: { vite: "^6.0.0" },
});
w("router-hash/index.html", `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`);
w("router-hash/src/main.tsx", `import { HashRouter, Routes, Route } from "react-router";\nexport function App(){ return <HashRouter><Routes><Route path="/" element={<div>hash</div>} /></Routes></HashRouter>; }\n`);
json("router-history/package.json", {
  name: "router-history-fixture", scripts: { build: "vite build" },
  dependencies: { react: "^19.0.0", "react-router": "^7.0.0" }, devDependencies: { vite: "^6.0.0" },
});
w("router-history/index.html", `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`);
w("router-history/src/main.tsx", `import { BrowserRouter } from "react-router";\nexport function App(){ return <BrowserRouter><div>history</div></BrowserRouter>; }\n`);

// 路由识别不能只看 kind=spa：Vue CLI/Angular/webpack 等项目的 HTML 可能在
// public/ 或 src/，会被识别成 static/static-html；但仍需按 router 依赖判断模式。
json("router-history-tool/package.json", {
  name: "router-history-tool", scripts: { build: "vue-cli-service build" },
  dependencies: { "vue-router": "^4.4.0" },
});
w("router-history-tool/public/index.html", `<!doctype html><html><body><div id="app"></div><script type="module" src="/src/main.js"></script></body></html>\n`);
w("router-history-tool/src/main.js", `import { createRouter, createWebHistory } from "vue-router";\nexport const router = createRouter({ history: createWebHistory(), routes: [] });\n`);
json("router-vue3-hash/package.json", {
  name: "router-vue3-hash", scripts: { build: "vue-cli-service build" },
  dependencies: { "vue-router": "^3.6.5" },
});
w("router-vue3-hash/index.html", `<!doctype html><html><body><div id="app"></div></body></html>\n`);
w("router-vue3-hash/src/main.js", `import VueRouter from "vue-router";\nexport const router = new VueRouter({ routes: [] });\n`);
json("router-deep-hash/package.json", {
  name: "router-deep-hash", scripts: { build: "vite build" },
  dependencies: { react: "^19.0.0", "react-router": "^7.0.0" }, devDependencies: { vite: "^6.0.0" },
});
w("router-deep-hash/index.html", `<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`);
w("router-deep-hash/src/pages/admin/nested/route.tsx", `import { HashRouter } from "react-router";\nexport const Router = () => <HashRouter><div>deep</div></HashRouter>;\n`);
json("router-string-only/package.json", {
  name: "router-string-only", scripts: { build: "vite build" },
  dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^6.0.0" },
});
w("router-string-only/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
w("router-string-only/src/main.tsx", `const label = "HashRouter is only a string"; export default label;\n`);
json("router-mixed/package.json", {
  name: "router-mixed", scripts: { build: "vite build" },
  dependencies: { react: "^19.0.0", "react-router": "^7.0.0" }, devDependencies: { vite: "^6.0.0" },
});
w("router-mixed/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
w("router-mixed/src/main.tsx", `import { HashRouter } from "react-router";\nconst docs = "use BrowserRouter for history";\nexport const App = () => <HashRouter><div>{docs}</div></HashRouter>;\n`);
json("router-vue3-history/package.json", {
  name: "router-vue3-history", scripts: { build: "vue-cli-service build" },
  dependencies: { "vue-router": "^3.6.5" },
});
w("router-vue3-history/index.html", `<!doctype html><html><body><div id="app"></div></body></html>\n`);
w("router-vue3-history/src/main.js", `import VueRouter from "vue-router";\nexport const router = new VueRouter({ mode: "history", routes: [] });\n`);
json("router-bundle-leak/package.json", {
  name: "router-bundle-leak", scripts: { build: "vite build" },
  dependencies: { react: "^19.0.0", "react-router": "^7.0.0" }, devDependencies: { vite: "^6.0.0" },
});
w("router-bundle-leak/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
w("router-bundle-leak/src/main.tsx", `import { HashRouter } from "react-router";\nexport const App = () => <HashRouter><div>real</div></HashRouter>;\n`);
w("router-bundle-leak/dist-web/assets/app-old.js", `import { BrowserRouter } from "react-router";\nsetInterval(() => {}, 1000);\nconsole.log("old bundle only");\n`);

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
w("supabase/.env.example", `VITE_SUPABASE_URL=https://example.supabase.co\nVITE_SUPABASE_ANON_KEY=public-anon-key\nexport VITE_EXPORTED_FLAG=1\nlower_case_key=2\n`);

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

// 注释/字符串噪声：注释掉的配置值不能生效（与 HTML 伪标签同一根因：没区分代码与注释）。
json("noisy-vite/package.json", { name: "noisy-vite", scripts: { build: "vite build" }, devDependencies: { vite: "^5.0.0" } });
w("noisy-vite/index.html", `<!doctype html><html><body><div id="root"></div></body></html>\n`);
w("noisy-vite/vite.config.ts", `// base: "/legacy/", outDir: "dist-legacy"\n/* outDir: "dist-block" */\nexport default { base: "/real/", build: { outDir: "dist-real" } };\n`);
w("noisy-vite/.github/workflows/pages.yml", `name: pages\non: push\njobs:\n  x:\n    steps:\n      # - uses: actions/configure-pages@v5\n      - run: |\n          echo "actions/deploy-pages and wrangler are only text here"\n      - run: echo hi\n`);
json("noisy-next/package.json", { name: "noisy-next", scripts: { build: "next build" }, dependencies: { next: "^15.0.0", react: "^19.0.0" } });
w("noisy-next/next.config.js", `// output: "export"\nmodule.exports = {};\n`);
json("noisy-wrangler/package.json", { name: "noisy-wrangler" });
w("noisy-wrangler/wrangler.jsonc", `{\n  // "name": "fake", "directory": "./fake", "main": "src/fake.js"\n  "name": "real-wrangler",\n  "compatibility_date": "2026-11-01",\n  "assets": { "directory": "./public" }\n}\n`);
w("noisy-wrangler/public/index.html", `<!doctype html><html><body>ok</body></html>\n`);
w("noisy-toml/wrangler.toml", `# name = "old-site"\n# main = "src/index.js"\ndescription = """\nmain = "src/fake.ts"\n[assets]\ndirectory = "./legacy"\n"""\nname = "real-toml"\ncompatibility_date = "2026-11-01"\n\n[assets]\ndirectory = "./public"\n`);
w("noisy-toml/public/index.html", `<!doctype html><html><body>ok</body></html>\n`);
json("start-flags/package.json", { name: "start-flags", scripts: { start: "node -r dotenv/config --inspect src/index.js" } });
json("nuxt-static/package.json", { name: "nuxt-static", scripts: { build: "nuxt build" }, dependencies: { nuxt: "^3.13.0" } });
w("nuxt-static/nuxt.config.ts", `// ssr: true\nexport default defineNuxtConfig({ ssr: false });\n`);
json("nuxt-generate/package.json", { name: "nuxt-generate", scripts: { build: "nuxt generate" }, dependencies: { nuxt: "^3.13.0" } });
w("nuxt-generate/nuxt.config.ts", `export default defineNuxtConfig({});\n`);
json("nuxt-route-csr/package.json", { name: "nuxt-route-csr", scripts: { build: "nuxt build" }, dependencies: { nuxt: "^3.13.0" } });
w("nuxt-route-csr/nuxt.config.ts", `export default defineNuxtConfig({ routeRules: { "/admin/**": { ssr: false } } });\n`);
w("public-only/public/index.html", `<!doctype html><html><body>public only</body></html>\n`);

// ---------------------------------------------------------------- 识别
const vite = detect(path.join(work, "vite"));
assert("Vite：框架/类型", vite.project.framework === "vite" && vite.project.kind === "spa", `${vite.project.framework}/${vite.project.kind}`);
assert("Vite：输出目录 + base", vite.project.outputDir === "dist" && vite.project.basePath === "/repo/", `${vite.project.outputDir}, ${vite.project.basePath}`);
assert("Vite：识别 GitHub Pages", vite.githubPages.configured === true && vite.githubPages.workflows.length === 1);
assert("Vite：目标给候选而不是定论", vite.target.suggested === null && vite.target.candidates.join(",") === "pages,workers" && vite.recommendedTarget === "either", `${vite.target.suggested}/${vite.target.candidates}`);
assert("Vite：输出目录有证据等级", vite.evidence.outputDir.confidence === "confirmed" && vite.evidence.outputDir.source.includes("outDir"), `${vite.evidence.outputDir.confidence}`);

const routerHash = detect(path.join(work, "router-hash"));
const routerHistory = detect(path.join(work, "router-history"));
assert("Vite+HashRouter：识别 hash 路由并用 static 验收",
  routerHash.project.spaRouting === "hash" && routerHash.project.suggestedMode === "static"
    && routerHash.risks.some((r) => /HashRouter/.test(r)),
  JSON.stringify({ routing: routerHash.project.spaRouting, mode: routerHash.project.suggestedMode, risks: routerHash.risks }));
assert("Vite+BrowserRouter：识别 history 路由并用 spa 验收",
  routerHistory.project.spaRouting === "history" && routerHistory.project.suggestedMode === "spa"
    && routerHistory.risks.some((r) => /history 路由/.test(r)),
  JSON.stringify({ routing: routerHistory.project.spaRouting, mode: routerHistory.project.suggestedMode, risks: routerHistory.risks }));

const routerHistoryTool = detect(path.join(work, "router-history-tool"));
const routerVue3Hash = detect(path.join(work, "router-vue3-hash"));
const routerDeepHash = detect(path.join(work, "router-deep-hash"));
const routerStringOnly = detect(path.join(work, "router-string-only"));
const routerMixed = detect(path.join(work, "router-mixed"));
const routerVue3History = detect(path.join(work, "router-vue3-history"));
const routerBundleLeak = detect(path.join(work, "router-bundle-leak"));
assert("路由识别不依赖 kind=spa：Vue/webpack 风格 history 项目仍建议 spa",
  (routerHistoryTool.project.kind === "static" || routerHistoryTool.project.kind === "unknown")
    && routerHistoryTool.project.spaRouting === "history" && routerHistoryTool.project.suggestedMode === "spa",
  JSON.stringify({ kind: routerHistoryTool.project.kind, routing: routerHistoryTool.project.spaRouting, mode: routerHistoryTool.project.suggestedMode }));
assert("Vue Router 3 默认 hash：无显式 history 时按 hash/static 建议",
  routerVue3Hash.project.spaRouting === "hash" && routerVue3Hash.project.suggestedMode === "static",
  JSON.stringify({ routing: routerVue3Hash.project.spaRouting, mode: routerVue3Hash.project.suggestedMode }));
assert("路由识别覆盖深层源码，且字符串字面量不误报",
  routerDeepHash.project.spaRouting === "hash" && routerDeepHash.project.suggestedMode === "static"
    && routerStringOnly.project.spaRouting === "unknown" && routerStringOnly.project.suggestedMode === "spa",
  JSON.stringify({ deep: routerDeepHash.project.spaRouting, string: routerStringOnly.project.spaRouting, mode: routerStringOnly.project.suggestedMode }));
assert("mixed 字符串噪声不改变真实 HashRouter 判定",
  routerMixed.project.spaRouting === "hash" && routerMixed.project.suggestedMode === "static",
  JSON.stringify({ routing: routerMixed.project.spaRouting, mode: routerMixed.project.suggestedMode, risks: routerMixed.risks }));
assert("Vue Router 3 显式 mode:history 不被默认 hash 覆盖",
  routerVue3History.project.spaRouting === "history" && routerVue3History.project.suggestedMode === "spa",
  JSON.stringify({ routing: routerVue3History.project.spaRouting, mode: routerVue3History.project.suggestedMode }));
assert("构建产物目录不参与源码路由/长驻进程扫描",
  routerBundleLeak.project.spaRouting === "hash" && routerBundleLeak.project.suggestedMode === "static"
    && !routerBundleLeak.risks.some((r) => /长驻/.test(r)),
  JSON.stringify({ routing: routerBundleLeak.project.spaRouting, mode: routerBundleLeak.project.suggestedMode, risks: routerBundleLeak.risks }));

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

// 注释 / 字符串噪声：配置字段只认真实值。
const noisyVite = detect(path.join(work, "noisy-vite"));
assert("配置噪声：Vite 注释/块标量里的 base/outDir/Pages action 不生效",
  noisyVite.project.basePath === "/real/" && noisyVite.project.outputDir === "dist-real"
    && noisyVite.githubPages.configured === false
    && !noisyVite.githubPages.workflows.some((w) => w.pages || w.cloudflare),
  JSON.stringify({ basePath: noisyVite.project.basePath, outputDir: noisyVite.project.outputDir, ghPages: noisyVite.githubPages.configured, workflows: noisyVite.githubPages.workflows }), "adversarial");
const noisyNext = detect(path.join(work, "noisy-next"));
assert("配置噪声：Next 注释掉的 output:export 不改变 SSR 判定", noisyNext.project.kind === "ssr", `${noisyNext.project.kind}`, "adversarial");
const noisyWrangler = detect(path.join(work, "noisy-wrangler"));
assert("配置噪声：wrangler.jsonc 注释字段不生效、结构化字段生效",
  noisyWrangler.cloudflare.wrangler?.name === "real-wrangler"
    && noisyWrangler.cloudflare.wrangler?.assetsDirectory === "./public"
    && noisyWrangler.cloudflare.wrangler?.hasMain === false
    && noisyWrangler.project.outputDir === "./public",
  JSON.stringify(noisyWrangler.cloudflare.wrangler), "adversarial");
const noisyToml = detect(path.join(work, "noisy-toml"));
assert("配置噪声：wrangler.toml 注释/多行字符串里的 name/main/directory 不生效",
  noisyToml.cloudflare.wrangler?.name === "real-toml" && noisyToml.cloudflare.wrangler?.hasMain === false
    && noisyToml.cloudflare.wrangler?.assetsDirectory === "./public",
  JSON.stringify(noisyToml.cloudflare.wrangler), "adversarial");
const startFlags = detect(path.join(work, "start-flags"));
assert("启动脚本：跳过 -r/--inspect 等参数取真实入口", startFlags.project.serverEntry === "src/index.js", startFlags.project.serverEntry, "boundary");
const nuxtStatic = detect(path.join(work, "nuxt-static"));
assert("Nuxt ssr:false 判定为静态站（注释里的 ssr:true 不生效）", nuxtStatic.project.framework === "nuxt" && nuxtStatic.project.kind === "static", `${nuxtStatic.project.framework}/${nuxtStatic.project.kind}`, "adversarial");
const nuxtGenerate = detect(path.join(work, "nuxt-generate"));
assert("Nuxt generate 判定为静态产物", nuxtGenerate.project.kind === "static", nuxtGenerate.project.kind, "boundary");
const nuxtRouteCsr = detect(path.join(work, "nuxt-route-csr"));
assert("Nuxt routeRules 里的 ssr:false 不影响整站 SSR 判定", nuxtRouteCsr.project.kind === "ssr", nuxtRouteCsr.project.kind, "adversarial");
const publicOnly = detect(path.join(work, "public-only"));
assert("静态站：只有 public/index.html 也能识别", publicOnly.project.framework === "static-html" && publicOnly.project.outputDir === "public", JSON.stringify({ f: publicOnly.project.framework, out: publicOnly.project.outputDir }), "boundary");
assert("环境变量键名：支持 export 前缀与小写键",
  sb.runtime.envKeys.includes("VITE_EXPORTED_FLAG") && sb.runtime.envKeys.includes("lower_case_key"),
  sb.runtime.envKeys.join(","), "boundary");

// ---------------------------------------------------------------- 产物检查
const art = path.join(work, "artifact");
w("artifact/index.html", `<!doctype html><html><head><title>OK</title><link rel="canonical" href="https://example.com/"><link rel="stylesheet" href="/assets/app.css"></head><body><h1>Hello</h1><script src="/missing.js"></script></body></html>`);
w("artifact/404.html", `<html><body>404</body></html>`);
w("artifact/_headers", `/*\n  X-Frame-Options: SAMEORIGIN\n`);
w("artifact/assets/app.css", `body{color:#111}`);
const buildOk = checkBuild(art);
assert("产物：通过但有警告", buildOk.code === 0 && buildOk.json.summary.warnings >= 1, `警告=${buildOk.json.summary.warnings}`);
assert("产物：发现坏资源", buildOk.json.checks.some((c) => c.id === "assets" && c.status === "warn"));
assert("产物：报告实际检查的资源数", buildOk.json.summary.assetsChecked === 2, `checked=${buildOk.json.summary.assetsChecked}`);
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

// 与 verify-deployment 共用 tokenizer：注释 / script / textarea 里的伪资源引用不参与检查。
const fakeRefsDir = path.join(work, "fake-refs");
w("fake-refs/index.html", `<html><head><title>fake refs</title><script>var s='<img src="/not-real.js">';</script><!-- <img src="/fake.png"> --><textarea><img src="/ta.png"></textarea><link rel="stylesheet" href="real.css"></head></html>`);
w("fake-refs/real.css", `body{}`);
const buildFakeRefs = checkBuild(fakeRefsDir, "static");
const fakeRefsAssets = buildFakeRefs.json.checks.find((c) => c.id === "assets");
assert("产物：注释 / script / textarea 里的伪资源引用不参与检查",
  buildFakeRefs.code === 0 && fakeRefsAssets?.status === "pass" && fakeRefsAssets.checked === 1 && (fakeRefsAssets.broken?.length ?? 0) === 0,
  JSON.stringify(fakeRefsAssets), "adversarial");

// 资源引用边界：目录式 URL、导航/canonical 排除、%2F 保护、srcset、无引号、前后空白。
const refsEdgeDir = path.join(work, "refs-edge");
w("refs-edge/index.html", `<html><head><title>edge</title>`
  + `<a href="/login">nav</a>`
  + `<link rel="canonical" href="/canonical-page">`
  + `<link rel="stylesheet" href="about/">`
  + `<link rel="stylesheet" href="docs">`
  + `<img src=" assets/img.png ">`
  + `<img src="/img/photo%2Fbad.png">`
  + `<img src="/img/a.png" srcset="/img/a.png 1x, /img/b.png 2x">`
  + `<script src=/js/app.js></script>`
  + `</head></html>`);
w("refs-edge/assets/img.png", "x");
w("refs-edge/img/a.png", "x");
w("refs-edge/img/b.png", "x");
w("refs-edge/js/app.js", "x");
w("refs-edge/about/index.html", "<html></html>");
w("refs-edge/docs/index.html", "<html></html>");
const buildEdge = checkBuild(refsEdgeDir, "static");
const edgeAssets = buildEdge.json.checks.find((c) => c.id === "assets");
assert("产物资源：目录式 URL/无引号/srcset/前后空白正确解析，导航与 canonical 不算资源",
  edgeAssets?.status === "warn" && edgeAssets.checked === 7 && edgeAssets.broken?.length === 1
    && edgeAssets.broken[0] === "/img/photo%2Fbad.png"
    && !edgeAssets.broken.includes("/login") && !edgeAssets.broken.includes("/canonical-page"),
  JSON.stringify(edgeAssets), "adversarial");

// 超过 40 个引用时必须说明只检查前 40 个，不能让人误以为全查了。
const refsManyDir = path.join(work, "refs-many");
let manyHtml = "<html><body>";
for (let i = 0; i < 45; i++) manyHtml += `<img src="/missing-${i}.png">`;
manyHtml += "</body></html>";
w("refs-many/index.html", manyHtml);
const buildMany = checkBuild(refsManyDir, "static");
const manyAssets = buildMany.json.checks.find((c) => c.id === "assets");
assert("产物资源：超过上限时写明只检查前 40/共 45",
  manyAssets?.checked === 40 && manyAssets.total === 45 && manyAssets.limited === true && /共 45 个/.test(manyAssets.detail || ""),
  JSON.stringify(manyAssets), "boundary");

// 主模块守卫：通过 symlink/junction 安装技能时也必须真正执行，而不是静默 exit 0。
// 链接指向 work 内的技能副本（不能指向仓库根，否则测试目录递归/备份会沿链接膨胀）。
const installedSkill = path.join(work, "installed-skill");
fs.mkdirSync(path.join(installedSkill, "scripts"), { recursive: true });
for (const f of fs.readdirSync(path.join(root, "scripts"))) {
  if (f.endsWith(".mjs")) fs.copyFileSync(path.join(root, "scripts", f), path.join(installedSkill, "scripts", f));
}
const skillLink = path.join(work, "skill-link");
fs.symlinkSync(installedSkill, skillLink, process.platform === "win32" ? "junction" : "dir");
const linkedRun = spawnSync(process.execPath, [path.join(skillLink, "scripts", "check-build.mjs"), "--dir", art, "--json"], { encoding: "utf8" });
let linkedJson = null;
try { linkedJson = JSON.parse(linkedRun.stdout); } catch { /* 断言里带上输出 */ }
assert("主模块守卫：通过 symlink/junction 安装时仍执行检查并输出 JSON",
  linkedRun.status === 0 && linkedJson?.summary?.files > 0,
  `status=${linkedRun.status} out=${(linkedRun.stdout || "").slice(0, 100)} err=${(linkedRun.stderr || "").slice(0, 160)}`, "boundary");

// check-build 与 verify 对齐：<base href> 决定产物内相对资源路径。
w("refs-base/index.html", `<html><head><base href="assets/"><link rel="stylesheet" href="app.css"></head><body>x</body></html>`);
w("refs-base/assets/app.css", `body{}`);
const buildBase = checkBuild(path.join(work, "refs-base"), "static");
const baseAssets = buildBase.json.checks.find((c) => c.id === "assets");
assert("产物资源：<base href> 决定相对资源路径（与 verify 一致）",
  baseAssets?.status === "pass" && baseAssets.checked === 1,
  JSON.stringify(baseAssets), "combination");

// 顶层文件名大小写必须与部署后一致（Windows 不区分，CDN 区分）。
w("case-top/Index.HTML", `<html><body>x</body></html>`);
w("case-top/404.HTML", `<html><body>nf</body></html>`);
w("case-top/_Headers", `/*\n  X-Test: 1\n`);
const buildCaseTop = checkBuild(path.join(work, "case-top"), "static");
const caseIndex = buildCaseTop.json.checks.find((c) => c.id === "index");
const case404 = buildCaseTop.json.checks.find((c) => c.id === "404");
const caseHeaders = buildCaseTop.json.checks.find((c) => c.id === "_headers");
assert("产物：顶层 index/404/_headers 大小写不一致时不判存在",
  caseIndex?.status === "warn" && /大小写/.test(caseIndex.detail || "")
    && case404?.status === "warn" && caseHeaders?.status === "skip",
  JSON.stringify({ index: caseIndex, notFound: case404, headers: caseHeaders }), "adversarial");

// 产物里的 symlink/junction 要跟随并计入（否则 20,000 上限会 fail-open）。
w("link-assets/app.css", `body{}`);
w("link-build/index.html", `<html><head><link rel="stylesheet" href="assets/app.css"></head><body>x</body></html>`);
fs.symlinkSync(path.join(work, "link-assets"), path.join(work, "link-build", "assets"), process.platform === "win32" ? "junction" : "dir");
const buildLink = checkBuild(path.join(work, "link-build"), "static");
const linkAssets = buildLink.json.checks.find((c) => c.id === "assets");
assert("产物：symlink/junction 目录被递归统计且资源可解析",
  buildLink.json.summary.files === 2 && linkAssets?.status === "pass" && linkAssets.checked === 1,
  JSON.stringify({ files: buildLink.json.summary.files, assets: linkAssets }), "boundary");

// 跨源 <base href> 下的相对引用是外链：产物里没有也不该判坏（与 verify 一致）。
w("refs-cross-base/index.html", `<html><head><base href="https://cdn.example.com/lib/"><script src="jquery.js"></script></head><body>x</body></html>`);
const buildCrossBase = checkBuild(path.join(work, "refs-cross-base"), "static");
const crossBaseAssets = buildCrossBase.json.checks.find((c) => c.id === "assets");
assert("产物资源：跨源 <base href> 下的相对引用按外链跳过",
  crossBaseAssets?.status === "pass" && crossBaseAssets.checked === 0,
  JSON.stringify(crossBaseAssets), "adversarial");

// srcset 的 URL 可以含逗号；只有「逗号 + 空白」才是候选分隔。
w("refs-srcset/index.html", `<html><head><title>ss</title></head><body><img srcset="/img/a,b.png 1x, /img/c.png 2x"></body></html>`);
w("refs-srcset/img/a,b.png", "x");
w("refs-srcset/img/c.png", "x");
const buildSrcset = checkBuild(path.join(work, "refs-srcset"), "static");
const srcsetAssets = buildSrcset.json.checks.find((c) => c.id === "assets");
assert("产物资源：srcset 含逗号的 URL 不被拆坏",
  srcsetAssets?.status === "pass" && srcsetAssets.checked === 2,
  JSON.stringify(srcsetAssets), "adversarial");

const no404 = path.join(work, "no404");
w("no404/index.html", `<html><body>hi</body></html>`);
const buildStatic = checkBuild(no404, "static");
assert("产物：static 模式缺 404 被警告", buildStatic.json.checks.some((c) => c.id === "404" && c.status === "warn"), "Pages 会当成 SPA");
const buildSpa = checkBuild(no404, "spa");
assert("产物：spa 模式不要求 404", buildSpa.json.checks.some((c) => c.id === "404" && c.status === "pass" && c.mode === "spa"), buildSpa.json.mode);
assert("产物：--spa 与 --mode spa 行为完全等价", (() => {
  const a = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", no404, "--spa", "--json"], { encoding: "utf8" });
  const b = spawnSync(process.execPath, [path.join(root, "scripts/check-build.mjs"), "--dir", no404, "--mode", "spa", "--json"], { encoding: "utf8" });
  try {
    const ja = JSON.parse(a.stdout);
    const jb = JSON.parse(b.stdout);
    return a.status === b.status && JSON.stringify(ja.checks) === JSON.stringify(jb.checks);
  } catch { return false; }
})());

const nested = path.join(work, "nested");
w("nested/index.html", `<!doctype html><html><body><link rel="stylesheet" href="/assets/css/site.css">ok</body></html>`);
w("nested/assets/css/site.css", `body{}`);
for (let i = 0; i < 60; i++) w(`nested/assets/js/chunk-${i}.js`, `export const n=${i};`);
const buildNested = checkBuild(nested, "static");
assert("嵌套产物：递归统计文件", buildNested.json.summary.files === 62 && buildNested.code === 0, `files=${buildNested.json.summary.files}`);
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
  if (p === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "server": "local-main", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html><head><title>Local Static</title><link rel="canonical" href="${staticBase}/"><link rel="stylesheet" href="/assets/app.css"><script src="/assets/app.js"></script></head><body>ok</body></html>`);
    return;
  }
  // 元数据对抗页：注释 / script 里的伪 <title>、<meta> 不能参与识别。
  if (p === "/meta/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head>`
      + `<!-- <title>Fake Comment Title</title><meta name="robots" content="noindex"> -->`
      + `<script>document.write('<title>Fake Script Title</title><meta name="robots" content="noindex">')</script>`
      + `<title>Real Title</title><meta name="robots" content="index,follow">`
      + `</head><body>ok</body></html>`);
    return;
  }
  // 500 错误页：即使带 title/canonical/资源，也不能作为首页内容证据。
  if (p === "/broken/") {
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Error Page</title><link rel="canonical" href="/fake/"><script src="/fake.js"></script></head><body>error</body></html>`);
    return;
  }
  // 两个安全头 → security-headers 应为 pass（不是 pen 分支）。
  if (p === "/secure/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "strict-transport-security": "max-age=31536000", "x-content-type-options": "nosniff" });
    res.end(`<!doctype html><html><head><title>secure</title></head><body>ok</body></html>`);
    return;
  }
  // 故意不支持 HEAD：验证 GET 兜底
  if (p === "/assets/app.css") {
    res.writeHead(req.method === "HEAD" ? 405 : 200, { "content-type": "text/css" });
    res.end(req.method === "HEAD" ? "" : "body{}");
    return;
  }
  if (p === "/assets/app.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end(req.method === "HEAD" ? "" : "console.log(1)"); return; }
  if (p === "/rel.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end("console.log(2)"); return; }
  // 无尾斜杠的页面 URL：浏览器把 app.js 解析成 /app.js，脚本不能补成 /subpage.html/app.js。
  if (p === "/subpage.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>subpage</title><script src="rel.js"></script></head><body>ok</body></html>`);
    return;
  }
  // <noscript> 在脚本启用时是 RAWTEXT：里面的伪 base/canonical 不生效。
  if (p === "/noscript-assets/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>noscript assets</title><noscript><base href="https://evil.example/"><link rel="canonical" href="https://evil.example/"></noscript><link rel="stylesheet" href="/assets/app.css"></head><body>ok</body></html>`);
    return;
  }
  // srcset 候选分隔：逗号后无空格也要拆成两个资源。
  if (p === "/srcset/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>srcset</title></head><body><img srcset="/assets/app.css 1x,/assets/app.js 2x"></body></html>`);
    return;
  }
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("not found");
});

const spaServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  // SPA 回退的状态分类：304 / 少见 3xx 不是「重定向式回退」，也不能判通过。
  if (p === "/deep304") { res.writeHead(304); res.end(); return; }
  if (p === "/deep300") { res.writeHead(300); res.end(); return; }
  // 未知路径 200 但不含 app shell 标记：必须 warn，不能因为「有内容」就 pass。
  if (p === "/bare/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>bare</title></head><body>plain page without shell</body></html>`);
    return;
  }
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
// 另加 rel 识别矩阵：只认真正的 <link> 标签上的真正 rel token（忽略注释 / data-rel / 相似词）。
// 每个页面都真实返回 HTML，测试执行验收脚本后断言 JSON 里的 canonical 检查。
let canonicalHrefBase = "";
const canonicalHrefCases = {
  "/missing-href/": "missing",
  "/empty-href/": "empty",
  "/single-quote/": "single",
  "/double-quote/": "double",
  "/unquoted/": "unquoted",
  "/bad-href/": "bad",
  "/rel-double/": "rel-double",
  "/rel-single/": "rel-single",
  "/rel-unquoted/": "rel-unquoted",
  "/href-first/": "href-first",
  "/rel-multi-token/": "rel-multi-token",
  "/real-plus-comment/": "real-plus-comment",
  "/data-rel/": "data-rel",
  "/aria-rel/": "aria-rel",
  "/rel-canonicalized/": "rel-canonicalized",
  "/comment-only/": "comment-only",
  "/in-script/": "in-script",
  // HTML 上下文隔离矩阵：注释 / RAWTEXT / RCDATA / template / 属性值里的伪标签
  "/in-comment/": "in-comment",
  "/in-script-raw/": "in-script-raw",
  "/in-style/": "in-style",
  "/in-textarea/": "in-textarea",
  "/in-title/": "in-title",
  "/in-iframe/": "in-iframe",
  "/in-xmp/": "in-xmp",
  "/in-noembed/": "in-noembed",
  "/in-noframes/": "in-noframes",
  "/in-plaintext/": "in-plaintext",
  "/in-template/": "in-template",
  "/attr-value/": "attr-value",
  "/incomplete/": "incomplete",
  "/title-fake-text/": "title-fake-text",
  "/in-noscript/": "in-noscript",
  "/in-svg/": "in-svg",
  "/svg-cdata/": "svg-cdata",
  "/svg-title/": "svg-title",
  "/in-endtag-quote/": "in-endtag-quote",
  "/in-script-double/": "in-script-double",
  "/script-double-real/": "script-double-real",
  "/in-doctype-public/": "in-doctype-public",
  "/in-doctype-system/": "in-doctype-system",
  "/doctype-abrupt-real/": "doctype-abrupt-real",
  "/svg-nested-close/": "svg-nested-close",
  "/svg-fo-nested/": "svg-fo-nested",
  "/svg-breakout/": "svg-breakout",
  "/svg-title-link/": "svg-title-link",
  "/math-mtext-link/": "math-mtext-link",
  // URL 解析矩阵：相对 canonical / <base href>
  "/relative-canonical/": "relative-canonical",
  "/base-tag-canonical/": "base-tag-canonical",
  "/real-plus-fakes/": "real-plus-fakes",
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
  else if (kind === "rel-double") tag = `<link rel="canonical" href="${self}">`;
  else if (kind === "rel-single") tag = `<link rel='canonical' href='${self}'>`;
  else if (kind === "rel-unquoted") tag = `<link rel=canonical href="${self}">`;
  else if (kind === "href-first") tag = `<link href="${self}" rel="canonical">`;
  else if (kind === "rel-multi-token") tag = `<link rel="alternate canonical" href="${self}">`;
  else if (kind === "real-plus-comment") tag = `<link rel="canonical" href="${self}"><!-- <link rel="canonical" href="${self}"> -->`;
  else if (kind === "data-rel") tag = `<link data-rel="canonical" href="${self}">`;
  else if (kind === "aria-rel") tag = `<link aria-rel="canonical" href="${self}">`;
  else if (kind === "rel-canonicalized") tag = `<link rel="canonicalized" href="${self}">`;
  else if (kind === "comment-only") tag = `<!-- <link rel="canonical" href="${self}"> -->`;
  else if (kind === "in-script") tag = `<script>document.write('<link rel="canonical" href="${self}">')</script>`;
  else if (kind === "in-comment") tag = `<!-- <link rel="canonical" href="${self}"> -->`;
  else if (kind === "in-script-raw") tag = `<script>var s = '<link rel="canonical" href="${self}">';</script>`;
  else if (kind === "in-style") tag = `<style>/* <link rel="canonical" href="${self}"> */</style>`;
  else if (kind === "in-textarea") tag = `<textarea><link rel="canonical" href="${self}"></textarea>`;
  else if (kind === "in-title") tag = `<title>fake <link rel="canonical" href="${self}"></title>`;
  else if (kind === "in-iframe") tag = `<iframe><link rel="canonical" href="${self}"></iframe>`;
  else if (kind === "in-xmp") tag = `<xmp><link rel="canonical" href="${self}"></xmp>`;
  else if (kind === "in-noembed") tag = `<noembed><link rel="canonical" href="${self}"></noembed>`;
  else if (kind === "in-noframes") tag = `<noframes><link rel="canonical" href="${self}"></noframes>`;
  else if (kind === "in-plaintext") tag = `<plaintext><link rel="canonical" href="${self}">`;
  else if (kind === "in-template") tag = `<template><link rel="canonical" href="${self}"></template>`;
  else if (kind === "attr-value") tag = `<div data-html="<link rel='canonical' href='${self}'>"></div>`;
  else if (kind === "incomplete") tag = `<link rel="canonical" href="${self}"`;
  else if (kind === "title-fake-text") tag = `<title>Page <link rel="canonical" href="${self}"> title</title>`;
  else if (kind === "in-noscript") tag = `<noscript><link rel="canonical" href="${self}"></noscript>`;
  else if (kind === "in-svg") tag = `<svg><link rel="canonical" href="https://evil.example/"></svg>`;
  else if (kind === "svg-cdata") tag = `<svg><![CDATA[> <link rel="canonical" href="https://evil.example/"> ]]></svg><link rel="canonical" href="${self}">`;
  else if (kind === "svg-title") tag = `<svg><title>SVG-ONLY</title></svg>`;
  else if (kind === "in-endtag-quote") tag = `</a "><link rel="canonical" href="${self}">`;
  else if (kind === "in-script-double") tag = `<script><!--<script></script><link rel='canonical' href='${self}fake'>--></script>`;
  else if (kind === "script-double-real") tag = `<script><!--<script></script>--></script><link rel="canonical" href="${self}">`;
  else if (kind === "in-doctype-public") tag = `<!DOCTYPE html PUBLIC "<link rel='canonical' href='${self}fake'>">`;
  else if (kind === "in-doctype-system") tag = `<!DOCTYPE html SYSTEM "<link rel='canonical' href='${self}fake'>">`;
  else if (kind === "doctype-abrupt-real") tag = `<!DOCTYPE html PUBLIC "x>fake"><link rel="canonical" href="${self}">`;
  else if (kind === "svg-nested-close") tag = `<svg><svg><link rel='canonical' href='${self}fake'></svg></svg><link rel="canonical" href="${self}">`;
  else if (kind === "svg-fo-nested") tag = `<svg><foreignObject><svg><foreignObject></foreignObject></svg></foreignObject></svg><link rel="canonical" href="${self}">`;
  else if (kind === "svg-breakout") tag = `<svg><img src="/assets/app.css"><link rel="canonical" href="${self}"></svg>`;
  else if (kind === "svg-title-link") tag = `<svg><title><link rel='canonical' href='${self}'></title></svg>`;
  else if (kind === "math-mtext-link") tag = `<math><mtext><link rel='canonical' href='${self}'></mtext></math>`;
  else if (kind === "relative-canonical") tag = `<link rel="canonical" href="./">`;
  else if (kind === "base-tag-canonical") tag = `<base href="${canonicalHrefBase}/"><link rel="canonical" href="base-tag-canonical/">`;
  else if (kind === "real-plus-fakes") {
    tag = `<link rel="canonical" href="${self}">`
      + `<!-- <link rel="canonical" href="${self}"> -->`
      + `<script>var s='<link rel="canonical" href="${self}">'</script>`
      + `<textarea><link rel="canonical" href="${self}"></textarea>`;
  }
  else tag = `<link rel="canonical" href="http://">`;
  // 不完整标签必须真的在 EOF 处截断（不能再拼上 </head>，否则浏览器会把它当完整标签）。
  if (kind === "incomplete") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>canonical href</title><link rel="canonical" href="${self}"`);
    return;
  }
  // title-fake-text 不能带外层真 title，否则测不到 title 内容里的伪标签文本。
  if (kind === "title-fake-text") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head>${tag}</head><body>ok</body></html>`);
    return;
  }
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
  // RAWTEXT 内容不能算作可见文本，也不能被当成标签。
  if (p === "/heavy/index.html") { res.writeHead(308, { location: "/heavy/" }); res.end(); return; }
  if (p === "/heavy/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>Heavy Script</title>`
      + `<script>${"x".repeat(4000)}; var fake = '<link rel="canonical" href="/fake">';</script>`
      + `<style>${"y".repeat(3000)}</style>`
      + `</head><body><main>short</main></body></html>`);
    return;
  }
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
  // CORS 错误响应 / 重定向 / 严格预检服务器（用于证明不会被误判为通过）
  if (p === "/simple-500") {
    if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }
    res.writeHead(500, h); res.end("err"); return;
  }
  if (p === "/simple-301") {
    if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }
    res.writeHead(301, { location: "/simple-star-acac" }); res.end(); return;
  }
  if (p === "/preflight-strict") {
    if (req.method === "OPTIONS") {
      const asked = String(req.headers["access-control-request-headers"] || "");
      if (/authorization/i.test(asked)) { res.writeHead(403, { "access-control-allow-origin": req.headers.origin || "" }); res.end(); return; }
      res.writeHead(204, { "access-control-allow-origin": req.headers.origin || "", "access-control-allow-headers": "content-type" }); res.end(); return;
    }
    res.writeHead(200, { "content-type": "text/html", ...h }); res.end("ok"); return;
  }
  if (p === "/preflight-403") {
    // 无断言时 OPTIONS 恒 403：不能判 fail，也不能判 pass，只能 warn 并说明无法判断。
    if (req.method === "OPTIONS") { res.writeHead(403, { "access-control-allow-origin": req.headers.origin || "" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html", ...h }); res.end("ok"); return;
  }
  if (req.method === "OPTIONS") { res.writeHead(204, h); res.end(); return; }
  corsMatrixSeen.push({ path: p, cookie: req.headers.cookie || null, authorization: req.headers.authorization || null });
  res.writeHead(200, { "content-type": "text/html", ...h });
  res.end(`<!doctype html><html><head><title>cors</title></head><body>ok</body></html>`);
});

// 资源重定向矩阵：同一台服务器按首页路径引用不同资源，另一台模拟跨主机目标。
let assetTargetBase = "";
const assetHits = [];
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
  assetHits.push(p);
  if (p === "/case/hostile-html/") {
    // 注释 / RAWTEXT / RCDATA / 属性值里的伪资源引用不能触发请求；
    // 反斜杠伪装的跨源 URL 仍按跨源处理，不发请求。
    const cross = new URL(crossTargetBase);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>hostile html</title>`
      + `<link rel="stylesheet" href="/a/direct.css">`
      + `<!-- <img src="/fake-comment.png"> -->`
      + `<script>var s = '<img src="/fake-script.png">';</script>`
      + `<style>/* <img src="/fake-style.png"> */</style>`
      + `<textarea><img src="/fake-textarea.png"></textarea>`
      + `<title><img src="/fake-title.png"></title>`
      + `<iframe><img src="/fake-iframe.png"></iframe>`
      + `<xmp><img src="/fake-xmp.png"></xmp>`
      + `<div data-src="/fake-attr.png"></div>`
      + `</head><body><img src="\\\\${cross.host}/ssrf-probe"></body></html>`);
    return;
  }
  if (p === "/case/base-tag/") {
    // 相对资源按 <base href> 解析（HTML 语义），而不是按站点根。
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>base tag</title><base href="/assets/"><link rel="stylesheet" href="base.css"></head><body>ok</body></html>`);
    return;
  }
  if (p === "/case/base-cross/") {
    // 跨源 <base href> 会让相对资源变成跨源：只记录、不请求。
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>base cross</title><base href="${crossTargetBase}/"><link rel="stylesheet" href="evil.css"></head><body>ok</body></html>`);
    return;
  }
  if (p === "/assets/base.css") { res.writeHead(200, { "content-type": "text/css" }); res.end("body{}"); return; }
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
    // 最终页面同时声明 canonical、相对资源与（带 Origin 时）CORS 头：
    // 用于验证根重定向后 canonical/资源/CORS 默认目标都按最终 URL 解析。
    const headers = { "content-type": "text/html; charset=utf-8" };
    if (req.headers.origin) headers["access-control-allow-origin"] = req.headers.origin;
    res.writeHead(200, headers);
    res.end(`<!doctype html><html><head><title>final</title><link rel="canonical" href="/final/"><link rel="stylesheet" href="final.css"></head><body>final</body></html>`);
    return;
  }
  if (p === "/final/final.css") { res.writeHead(200, { "content-type": "text/css" }); res.end("body{}"); return; }
  // /index.html 探测网络失败：脚本必须输出 index-redirect 警告而不是静默跳过。
  if (p === "/idxerr/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>idxerr</title></head><body>ok</body></html>`);
    return;
  }
  if (p === "/idxerr/index.html") { try { req.socket.destroy(); } catch { /* ignore */ } return; }
  if (p === "/case/same301/") { res.writeHead(301, { location: "/final/" }); res.end(); return; }
  // 同源重定向到「无尾斜杠」的最终路径：相对资源必须按文档 URL 解析为 /app.js。
  if (p === "/case/noSlash/") { res.writeHead(302, { location: "/noslash" }); res.end(); return; }
  if (p === "/noslash") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><head><title>noslash</title><script src="app.js"></script></head><body>ok</body></html>`);
    return;
  }
  if (p === "/app.js") { res.writeHead(200, { "content-type": "application/javascript" }); res.end("console.log(3)"); return; }
  if (p === "/noslash/app.js") { res.writeHead(404, { "content-type": "text/html" }); res.end("nf"); return; }
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
  if (p === "/case/userinfo/") {
    // 带 userinfo 的 Location：fetch 会拒绝，不能当成可跟随的同源重定向。
    res.writeHead(302, { location: `http://user:pass@127.0.0.1:${new URL(rootRedirectBase).port}/final/` });
    res.end();
    return;
  }
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
    "/idx500/index.html": { code: 500 },
  };
  if (special[p]) { res.writeHead(special[p].code, special[p].location ? { location: special[p].location } : {}); res.end(); return; }
  const specialRoot = p.match(/^\/(idxcross|idxfile|idxelsewhere|idxnoloc|idx500)\/$/);
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

// 瞬时故障服务器：用真实 socket 行为验证 verify-deployment 的重试边界。
let flakyMode = "ok";
let flakyRootHits = 0;
let flakyBase = "";
const flakyServer = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/") {
    if (req.method !== "HEAD") flakyRootHits++;
    if (flakyMode === "reset-first" || flakyMode === "always-reset") {
      if (flakyMode === "always-reset" || flakyRootHits === 1) { req.socket.destroy(); return; }
    }
    if (flakyMode === "503") { res.writeHead(503, { "content-type": "text/plain" }); res.end("service unavailable"); return; }
    const send = () => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate", "x-content-type-options": "nosniff" });
      res.end(`<!doctype html><html><head><title>Flaky</title><link rel="canonical" href="${flakyBase}/"></head><body>ok</body></html>`);
    };
    if (flakyMode === "slow") { setTimeout(send, 300); return; }
    send();
    return;
  }
  if (p === "/index.html") { res.writeHead(308, { location: "/" }); res.end(); return; }
  res.writeHead(404, { "content-type": "text/html" }); res.end("nf");
});
flakyServer.on("clientError", (_e, socket) => { try { socket.destroy(); } catch { /* 已关闭 */ } });

const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", r));
for (const srv of [staticServer, spaServer, corsServer, badCorsServer, dupCanonicalServer, canonicalHrefServer, backupServer, subServer, ssrServer, corsMatrixServer, assetRedirectServer, assetTargetServer, rootRedirectServer, indexStatusServer, crossTargetServer, flakyServer, tlsCanonicalServer]) await listen(srv);

staticBase = `http://127.0.0.1:${staticServer.address().port}`;
subBase = `http://127.0.0.1:${subServer.address().port}/repo`;
backupTarget = staticBase;
flakyBase = `http://127.0.0.1:${flakyServer.address().port}`;
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
assert("验收 SEO：存在 canonical 时不误报 seo warn", !v1j.checks.some((c) => c.id === "seo"),
  JSON.stringify(v1j.checks.filter((c) => c.id === "seo")), "adversarial");

// 瞬时网络错误重试：只重试连接类错误，不重试 HTTP 响应/超时。
{
  flakyMode = "reset-first"; flakyRootHits = 0;
  const r = await runVerify(["--url", flakyBase, "--mode", "static", "--retries", "1", "--timeout", "3000", "--json"]);
  const j = JSON.parse(r.out);
  const root = j.checks.find((c) => c.id === "root");
  assert("验收重试：首次连接重置后第二次成功（attempts=2）",
    r.code === 0 && root?.status === "pass" && root.attempts === 2 && flakyRootHits === 2,
    JSON.stringify({ code: r.code, root, hits: flakyRootHits }), "adversarial");
}
{
  flakyMode = "always-reset"; flakyRootHits = 0;
  const r = await runVerify(["--url", flakyBase, "--mode", "static", "--retries", "2", "--timeout", "3000", "--json"]);
  const j = JSON.parse(r.out);
  const root = j.checks.find((c) => c.id === "root");
  assert("验收重试：重试耗尽仍失败时报告 attempts/errorKind，且不伪造 HTTP 状态",
    r.code === 1 && root?.status === "fail" && root.attempts === 3 && root.errorKind === "network"
      && root.httpStatus === null && /已重试 2 次/.test(root.detail || ""),
    JSON.stringify({ code: r.code, root }), "adversarial");
}
{
  flakyMode = "503"; flakyRootHits = 0;
  const r = await runVerify(["--url", flakyBase, "--mode", "static", "--retries", "3", "--timeout", "3000", "--json"]);
  const j = JSON.parse(r.out);
  const root = j.checks.find((c) => c.id === "root");
  assert("验收重试：HTTP 503 不重试（服务器只收到 1 次 GET）",
    r.code === 1 && root?.status === "fail" && root.httpStatus === 503 && flakyRootHits === 1
      && !/已重试/.test(root.detail || ""),
    JSON.stringify({ code: r.code, root, hits: flakyRootHits }), "adversarial");
}
{
  flakyMode = "slow"; flakyRootHits = 0;
  const startedAt = Date.now();
  const r = await runVerify(["--url", flakyBase, "--mode", "static", "--retries", "3", "--timeout", "100", "--json"]);
  const j = JSON.parse(r.out);
  const root = j.checks.find((c) => c.id === "root");
  assert("验收重试：单次超时不重试且不放大等待",
    r.code === 1 && root?.status === "fail" && root.errorKind === "timeout" && flakyRootHits === 1
      && Date.now() - startedAt < 5000,
    JSON.stringify({ code: r.code, root, hits: flakyRootHits, ms: Date.now() - startedAt }), "adversarial");
}
{
  flakyMode = "reset-first"; flakyRootHits = 0;
  const r = await runVerify(["--url", flakyBase, "--mode", "static", "--retries", "0", "--timeout", "3000", "--json"]);
  const j = JSON.parse(r.out);
  const root = j.checks.find((c) => c.id === "root");
  assert("验收重试：--retries 0 关闭重试（只请求 1 次）",
    r.code === 1 && root?.status === "fail" && root.attempts === 1 && flakyRootHits === 1,
    JSON.stringify({ code: r.code, root, hits: flakyRootHits }), "boundary");
}
{
  flakyMode = "ok"; flakyRootHits = 0;
  const r = await runVerify(["--url", flakyBase, "--mode", "static", "--retries", "1", "--json"]);
  const j = JSON.parse(r.out);
  assert("验收重试：无故障请求不触发重试，且 retry 配置写入 JSON",
    r.code === 0 && j.checks.find((c) => c.id === "root")?.attempts === 1
      && j.retry?.maxRetries === 1 && j.retry?.mode === "transient-network-only",
    JSON.stringify({ code: r.code, retry: j.retry, root: j.checks.find((c) => c.id === "root") }), "boundary");
}
{
  const r = await runVerify(["--url", staticBase, "--mode", "static", "--retries=2", "--json"]);
  const j = JSON.parse(r.out);
  assert("验收重试：支持 --retries=N 等号形式，且不误触发重试",
    r.code === 0 && j.retry?.maxRetries === 2 && j.checks.find((c) => c.id === "root")?.attempts === 1,
    JSON.stringify({ code: r.code, retry: j.retry, root: j.checks.find((c) => c.id === "root") }), "boundary");
}
{
  // 无 canonical/meta 的 SPA：SEO 是策略提醒，不应改变退出码。
  const r = await runVerify(["--url", spaUrl, "--mode", "spa", "--json"]);
  const j = JSON.parse(r.out);
  const seo = j.checks.find((c) => c.id === "seo");
  assert("验收 SEO：canonical/meta 都缺少时给出 warn，但不改退出码",
    r.code === 0 && seo?.status === "warn" && /canonical|索引策略/.test(seo.detail || ""),
    JSON.stringify({ code: r.code, seo, canonical: j.checks.find((c) => c.id === "canonical") }), "adversarial");
}
assert("验收：安全头按数量给结论", (() => {
  const sec = v1j.checks.find((c) => c.id === "security-headers");
  return sec?.status === "warn" && /x-content-type-options/.test(sec.detail || "");
})(), JSON.stringify(v1j.checks.find((c) => c.id === "security-headers")));

// 元数据对抗：注释 / script 里的伪 <title> / <meta name=robots> 不能参与识别。
const vMeta = await runVerify(["--url", `${staticBase}/meta/`, "--mode", "static", "--json"]);
const vMetaJ = JSON.parse(vMeta.out);
const vMetaTitle = vMetaJ.checks.find((c) => c.id === "title");
const vMetaRobots = vMetaJ.checks.find((c) => c.id === "meta-robots");
assert("HTML 元数据：真实 <title> 优先于注释/script 里的伪 title",
  vMetaTitle?.status === "pass" && /Real Title/.test(vMetaTitle.detail || "") && !/Fake/.test(vMetaTitle.detail || ""),
  JSON.stringify(vMetaTitle), "adversarial");
assert("HTML 元数据：真实 meta[name=robots] 优先于注释/script 里的伪 meta",
  vMetaRobots?.status === "pass" && /index,follow/.test(vMetaRobots.detail || "") && !/noindex/.test(vMetaRobots.detail || ""),
  JSON.stringify(vMetaRobots), "adversarial");

// 非 200 首页的错误页不能作为内容证据；两个安全头应判 pass。
const vBroken = await runVerify(["--url", `${staticBase}/broken/`, "--mode", "static", "--json"]);
const vBrokenJ = JSON.parse(vBroken.out);
assert("首页 500：错误页的 title/canonical 不进入检查结论",
  vBroken.code === 1 && vBrokenJ.checks.find((c) => c.id === "root")?.status === "fail"
    && !vBrokenJ.checks.some((c) => c.id === "title") && !vBrokenJ.checks.some((c) => c.id === "canonical")
    && vBrokenJ.checks.some((c) => c.id === "html" && c.status === "warn"),
  JSON.stringify(vBrokenJ.checks.map((c) => c.id)), "adversarial");
const vSecure = await runVerify(["--url", `${staticBase}/secure/`, "--mode", "static", "--json"]);
const secureHeaders = JSON.parse(vSecure.out).checks.find((c) => c.id === "security-headers");
assert("安全头：两个常见安全头判 pass", secureHeaders?.status === "pass" && /strict-transport-security/.test(secureHeaders.detail || ""), JSON.stringify(secureHeaders), "boundary");

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
// 未知路径 200 但首页/目标页都没有 app shell 标记：不能因为「有内容」判 pass。
const vSpaBare = await runVerify(["--url", spaUrl, "--mode", "spa", "--expect-404", "/bare/", "--json"]);
const sfBare = JSON.parse(vSpaBare.out).checks.find((c) => c.id === "spa-fallback");
assert("SPA 回退：200 但没有 app shell 标记只警告（fail-closed）",
  sfBare?.status === "warn" && sfBare.idFound === false && sfBare.homeTokens > 0,
  JSON.stringify(sfBare), "adversarial");

const v4 = await runVerify(["--url", spaUrl, "--mode", "static", "--json"]);
const v4j = JSON.parse(v4.out);
assert("验收：把 SPA 当静态站会判 404 失败", v4.code === 1 && v4j.checks.some((c) => c.id === "404" && c.status === "fail"), "这正是原逻辑的冲突点");
assert("验收：404 检查暴露真实 HTTP 状态码", v4j.checks.find((c) => c.id === "404")?.httpStatus === 200, JSON.stringify(v4j.checks.find((c) => c.id === "404")));

const v5 = await runVerify(["--url", staticBase, "--mode", "static", "--origin", "https://app.example.com", "--cors-url", `${corsUrl}/api/data`, "--cors-method", "POST", "--cors-headers", "content-type,authorization", "--json"]);
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
  ["--retries 不是 0..3 的整数", ["--retries", "99"]],
  ["--retries 不是整数", ["--retries", "1.5"]],
  ["--backup 不是合法 URL", ["--backup", "http://["]],
  ["--origin 不是合法 origin", ["--origin", "a b"]],
  ["CORS 参数缺少 --origin", ["--cors-method", "POST"]],
]) {
  const r = await runVerify(["--url", staticBase, "--mode", "static", ...args, "--json"]);
  assert(`CLI：${name} 退出码 2 且不输出半截 JSON`, r.code === 2 && !r.out.trim() && /无法解析|正整数|正数|合法 URL|--origin|需要同时提供|--retries|0\.\.3/.test(r.err), `code=${r.code} out=${r.out.slice(0, 40)} err=${r.err.slice(0, 80)}`);
}

// 其余 CLI / 模式边界：非法模式、非法 --url、--cors-url、带 query 的 --url、ssg 模式。
const badMode = await runVerify(["--url", staticBase, "--mode", "bogus", "--json"]);
assert("CLI：非法 --mode 退出码 2", badMode.code === 2 && /未知模式/.test(badMode.err), `code=${badMode.code} err=${badMode.err.slice(0, 60)}`, "boundary");
const badUrl = spawnSync(process.execPath, [path.join(root, "scripts/verify-deployment.mjs"), "--url", "not-a-url", "--mode", "static", "--json"], { encoding: "utf8" });
assert("CLI：非法 --url 退出码 2", badUrl.status === 2 && /不是合法 URL/.test(badUrl.stderr || ""), `code=${badUrl.status}`, "boundary");
const badCorsUrlArg = await runVerify(["--url", staticBase, "--mode", "static", "--origin", "https://a.example", "--cors-url", "http://[", "--json"]);
assert("CLI：非法 --cors-url 退出码 2", badCorsUrlArg.code === 2 && /cors-url/.test(badCorsUrlArg.err), `code=${badCorsUrlArg.code}`, "boundary");
const vQuery = await runVerify(["--url", `${staticBase}/?utm=1`, "--mode", "static", "--json"]);
const vQueryJ = JSON.parse(vQuery.out);
assert("CLI：--url 带 query 时站点根仍保留路径",
  vQuery.code === 0 && vQueryJ.checks.find((c) => c.id === "root")?.status === "pass"
    && vQueryJ.checks.find((c) => c.id === "404")?.status === "pass",
  JSON.stringify({ root: vQueryJ.checks.find((c) => c.id === "root")?.status, notFound: vQueryJ.checks.find((c) => c.id === "404")?.status }), "boundary");
const vSsg = await runVerify(["--url", staticBase, "--mode", "ssg", "--json"]);
assert("模式：ssg 与 static 的 404 判定一致（真实执行）",
  vSsg.code === 0 && JSON.parse(vSsg.out).checks.some((c) => c.id === "404" && c.status === "pass"),
  `code=${vSsg.code}`, "boundary");
const buildSsg = checkBuild(art, "ssg");
assert("构建 CLI：ssg 模式可执行且 404 判定同 static", buildSsg.code === 0 && buildSsg.json.checks.some((c) => c.id === "404" && c.status === "pass"), `code=${buildSsg.code}`, "boundary");
const cbBadMode = spawnSync(process.execPath, [path.join(root, "scripts", "check-build.mjs"), "--dir", art, "--mode", "bogus"], { encoding: "utf8" });
assert("构建 CLI：非法 --mode 退出码 2", cbBadMode.status === 2 && /未知模式/.test(cbBadMode.stderr || ""), `code=${cbBadMode.status}`, "boundary");
const cbNoDirArg = spawnSync(process.execPath, [path.join(root, "scripts", "check-build.mjs"), "--mode", "static"], { encoding: "utf8" });
assert("构建 CLI：缺 --dir 退出码 2", cbNoDirArg.status === 2 && /用法/.test(cbNoDirArg.stderr || ""), `code=${cbNoDirArg.status}`, "boundary");
const cbMissingDir = spawnSync(process.execPath, [path.join(root, "scripts", "check-build.mjs"), "--dir", path.join(work, "does-not-exist"), "--mode", "static", "--json"], { encoding: "utf8" });
let cbMissingJson = null;
try { cbMissingJson = JSON.parse(cbMissingDir.stdout); } catch { /* 断言里带上输出 */ }
assert("构建 CLI：目录不存在时退出码 1 且输出结构化 JSON",
  cbMissingDir.status === 1 && cbMissingJson?.checks?.some((c) => c.id === "exists" && c.status === "fail"),
  `code=${cbMissingDir.status} out=${(cbMissingDir.stdout || "").slice(0, 80)}`, "boundary");

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
assert("预检：未提供实际方法/请求头时不判通过、检查项列入 notChecked",
  cDefault.pre?.status === "warn" && cDefault.pre.notChecked.length === 3 && /未执行/.test(cDefault.pre.detail) && cDefault.pre.asserted === false,
  JSON.stringify(cDefault.pre), "adversarial");
const cPfStrictDefault = await corsCase("/preflight-strict");
assert("预检：未提供实际请求头时不会因默认探针把 403 当失败",
  cPfStrictDefault.pre?.status === "warn" && cPfStrictDefault.pre.issues?.length === 0 && cPfStrictDefault.pre.httpStatus === 204,
  JSON.stringify(cPfStrictDefault.pre), "adversarial");
const cPfStrictAuth = await corsCase("/preflight-strict", ["--cors-headers", "authorization"]);
assert("预检：显式声明 authorization 后服务器 403 判失败",
  cPfStrictAuth.pre?.status === "fail" && /OPTIONS 返回 403/.test(cPfStrictAuth.pre.detail || ""),
  JSON.stringify(cPfStrictAuth.pre), "adversarial");
const cWildRange = await corsCase("/wildcard-header", ["--cors-headers", "range"]);
assert("预检：Range 可被 Allow-Headers:* 覆盖（只有 Authorization 是 non-wildcard）",
  cWildRange.pre?.status === "pass", JSON.stringify(cWildRange.pre?.issues), "boundary");
const cCredOnly = await corsCase("/ok", ["--cors-credentials"]);
assert("预检：只声明凭据、没有方法/请求头断言时最多 warn，不判 pass",
  cCredOnly.pre?.status === "warn" && cCredOnly.pre.notChecked?.length === 2 && cCredOnly.pre.checked?.includes("Allow-Credentials"),
  JSON.stringify(cCredOnly.pre), "adversarial");
const cPf403 = await corsCase("/preflight-403");
assert("预检：无断言时 OPTIONS 恒 403 只 warn（不能据此判 fail）",
  cPf403.pre?.status === "warn" && cPf403.pre.httpStatus === 403 && cPf403.pre.issues?.length === 0,
  JSON.stringify(cPf403.pre), "adversarial");

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

// CORS 错误响应 / 重定向：即使带 ACAO 也不能判通过。
const sCors500 = await simpleCase("/simple-500");
assert("简单请求：500 错误响应即使带 ACAO 也判失败",
  sCors500?.status === "fail" && sCors500.httpStatus === 500 && /不是 2xx/.test(sCors500.detail || ""),
  JSON.stringify(sCors500), "adversarial");
const sCors301 = await simpleCase("/simple-301");
assert("简单请求：3xx 重定向不判通过、最终响应未验证",
  sCors301?.status === "fail" && sCors301.httpStatus === 301 && /重定向/.test(sCors301.detail || ""),
  JSON.stringify(sCors301), "adversarial");

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
  return {
    code: r.code, err: r.err,
    canonical: j?.checks?.find((c) => c.id === "canonical"),
    title: j?.checks?.find((c) => c.id === "title"),
    metaRobots: j?.checks?.find((c) => c.id === "meta-robots"),
  };
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

// ---------------------------------------------------------------- canonical rel 识别矩阵
// 只认真正的 <link> 标签 + 真正的 rel 属性 + 按 HTML 空白分隔的 canonical token。
const canonicalRelPass = ["/rel-double/", "/rel-single/", "/rel-unquoted/", "/href-first/", "/rel-multi-token/", "/real-plus-comment/", "/in-endtag-quote/", "/script-double-real/", "/svg-nested-close/", "/svg-fo-nested/", "/svg-title-link/", "/math-mtext-link/", "/doctype-abrupt-real/"];
for (const p of canonicalRelPass) {
  const r = await canonicalHrefCase(p);
  assert(`canonical rel：${p} 正常识别为指向自身`,
    r.code === 0 && r.canonical?.status === "pass" && r.canonical.hrefState === "valid"
      && r.canonical.sameProtocol === true && r.canonical.sameHost === true && r.canonical.samePath === true,
    JSON.stringify({ canonical: r.canonical, err: r.err }));
}
const canonicalRelSkip = ["/data-rel/", "/aria-rel/", "/rel-canonicalized/", "/comment-only/", "/in-script/"];
for (const p of canonicalRelSkip) {
  const r = await canonicalHrefCase(p);
  assert(`canonical rel：${p} 不被误识别为 canonical`,
    r.code === 0 && r.canonical?.status === "skip" && /没有 canonical/.test(r.canonical.detail || ""),
    JSON.stringify({ canonical: r.canonical, err: r.err }));
}

// ---------------------------------------------------------------- canonical 上下文隔离矩阵（对抗层）
// 伪 <link rel=canonical> 出现在注释 / RAWTEXT（script/style/xmp/iframe/noembed/noframes）/
// RCDATA（textarea/title）/ plaintext / template / 属性值 / 不完整标签里，都不能被识别。
const canonicalContextSkip = [
  "/in-comment/", "/in-script-raw/", "/in-style/", "/in-textarea/", "/in-title/",
  "/in-iframe/", "/in-xmp/", "/in-noembed/", "/in-noframes/", "/in-plaintext/",
  "/in-template/", "/attr-value/", "/incomplete/", "/in-noscript/", "/in-svg/",
  "/in-script-double/", "/in-doctype-public/", "/in-doctype-system/",
];
for (const p of canonicalContextSkip) {
  const r = await canonicalHrefCase(p);
  assert(`canonical 上下文：${p} 的伪标签不被识别`,
    r.code === 0 && r.canonical?.status === "skip" && /没有 canonical/.test(r.canonical?.detail || ""),
    JSON.stringify({ canonical: r.canonical, err: r.err }), "adversarial");
}
const iTitleFake = await canonicalHrefCase("/title-fake-text/");
assert("canonical 上下文：title 里的标签文本不产生 canonical，也不破坏 title 检查",
  iTitleFake.canonical?.status === "skip" && iTitleFake.title?.status === "pass" && /<link/.test(iTitleFake.title?.detail || ""),
  JSON.stringify({ canonical: iTitleFake.canonical, title: iTitleFake.title }), "adversarial");
const iSvgCdata = await canonicalHrefCase("/svg-cdata/");
assert("canonical 上下文：SVG CDATA 里的伪标签不计入，真实 canonical 通过",
  iSvgCdata.code === 0 && iSvgCdata.canonical?.status === "pass",
  JSON.stringify(iSvgCdata.canonical), "adversarial");
const iSvgTitle = await canonicalHrefCase("/svg-title/");
assert("canonical 上下文：SVG title 不成为文档 title",
  iSvgTitle.title?.status === "pass" && !/SVG-ONLY/.test(iSvgTitle.title?.detail || ""),
  JSON.stringify(iSvgTitle.title), "adversarial");
// SVG 的 HTML integration point（title/desc/foreignObject）与 MathML 文本集成点里的
// <link> 在浏览器里是 HTML 元素；不能因为“在 svg 里”就一律忽略。
const iSvgBreakout = await canonicalHrefCase("/svg-breakout/");
assert("SVG：breakout 开始标签（img）退回 HTML 后 canonical 仍按 HTML 识别",
  iSvgBreakout.canonical?.status === "pass",
  JSON.stringify({ canonical: iSvgBreakout.canonical, assets: iSvgBreakout.assets }), "adversarial");

// ---------------------------------------------------------------- canonical URL 解析（组合层）
// 相对 canonical 按最终页面 URL 解析；<base href> 按 HTML 语义改变解析基准。
const canonicalUrlPass = ["/relative-canonical/", "/base-tag-canonical/"];
for (const p of canonicalUrlPass) {
  const r = await canonicalHrefCase(p);
  assert(`canonical URL：${p} 按页面 URL / base 解析为指向自身`,
    r.code === 0 && r.canonical?.status === "pass" && r.canonical.sameProtocol === true
      && r.canonical.sameHost === true && r.canonical.samePath === true,
    JSON.stringify({ canonical: r.canonical, err: r.err }), "boundary");
}
const iRealPlusFakes = await canonicalHrefCase("/real-plus-fakes/");
assert("canonical 组合：一个真实标签 + 注释/script/textarea 伪标签只算 1 个",
  iRealPlusFakes.code === 0 && iRealPlusFakes.canonical?.status === "pass"
    && (iRealPlusFakes.canonical.count === undefined) && !/多个|发现 2/.test(iRealPlusFakes.canonical?.detail || ""),
  JSON.stringify(iRealPlusFakes.canonical), "combination");

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
const assetCase = async (casePath, limit = 1) => {
  const r = await runVerify(["--url", `${assetRedirectBase}${casePath}`, "--mode", "static", "--assets-limit", String(limit), "--json"]);
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
assert("资源：跨主机重定向不跟随，记录未请求目标而不伪造 finalUrl",
  aCross.assets?.status === "warn" && aCross.probed?.crossHost === true
    && aCross.probed.chain.length === 1
    && aCross.probed.finalUrl === `${assetRedirectBase}/a/cross.css`
    && aCross.probed.redirectTarget === `${assetTargetBase}/final.css`
    && aCross.assets.warnings?.length === 1,
  JSON.stringify(aCross.probed), "boundary");
const aLoop = await assetCase("/case/loop/");
assert("资源：重定向循环有跳数上限且判失败，未跟随目标有标记", aLoop.assets?.status === "fail" && /超过 5 跳/.test(aLoop.assets.broken[0].reason) && aLoop.probed?.chain?.length === 6 && aLoop.probed.limitReached === true && aLoop.probed.redirectTarget !== null, JSON.stringify(aLoop.probed), "adversarial");
const a404 = await assetCase("/case/404/");
assert("资源：直接 404 判失败", a404.assets?.status === "fail" && /最终状态 404/.test(a404.assets.broken[0].reason), JSON.stringify(a404.assets?.broken));
const aHead405 = await assetCase("/case/head405/");
assert("资源：HEAD 405 改 GET 复核后仍判通过", aHead405.assets?.status === "pass" && aHead405.probed?.method === "GET" && aHead405.probed.fallback === true, JSON.stringify(aHead405.probed));
const aNoLoc = await assetCase("/case/noloc/");
assert("资源：3xx 缺 Location 判失败", aNoLoc.assets?.status === "fail" && /缺少 Location/.test(aNoLoc.assets.broken[0].reason), JSON.stringify(aNoLoc.assets?.broken));
const aBadProto = await assetCase("/case/badproto/");
assert("资源：非 HTTP/HTTPS 重定向目标判失败且不跟随", aBadProto.assets?.status === "fail" && /协议不受支持/.test(aBadProto.assets.broken[0].reason) && aBadProto.probed?.chain.length === 1, JSON.stringify(aBadProto.assets?.broken));
const crossHitsBefore = crossTargetHits.length;
// limit 10：如果跨源过滤失效，反斜杠伪装引用会变成第 2 个待探测资源，checked 变 2、测试失败。
const aHostile = await assetCase("/case/hostile/", 10);
assert("资源：伪装成相对地址的跨源 URL 不会被请求（SSRF 防护）",
  aHostile.code === 0 && aHostile.assets?.status === "pass"
    && aHostile.probed?.url === "/a/direct.css"
    && aHostile.assets.ignored?.some((i) => /跨源/.test(i.reason))
    && !crossTargetHits.slice(crossHitsBefore).includes("/ssrf-probe"),
  JSON.stringify({ ignored: aHostile.assets?.ignored, hits: crossTargetHits.slice(crossHitsBefore) }));
assert("资源：javascript: 等非 HTTP(S) 链接不会被当资源探测",
  aHostile.assets?.checked === 1 && aHostile.probed?.url === "/a/direct.css",
  JSON.stringify({ checked: aHostile.assets?.checked, probed: aHostile.probed }));

// 注释 / RAWTEXT / RCDATA / 属性值里的伪资源引用、跨源 <base href>：都不能触发请求。
const assetHitsBefore = assetHits.length;
const aHostileHtml = await assetCase("/case/hostile-html/", 10);
const hostileHits = assetHits.slice(assetHitsBefore);
assert("资源：注释/RAWTEXT/RCDATA/属性值里的伪资源不被请求",
  aHostileHtml.code === 0 && aHostileHtml.assets?.status === "pass"
    && aHostileHtml.assets?.checked === 1
    && aHostileHtml.probed?.url === "/a/direct.css"
    && hostileHits.filter((h) => /fake-/.test(h)).length === 0,
  JSON.stringify({ assets: aHostileHtml.assets, probed: aHostileHtml.probed, hits: hostileHits }), "adversarial");
const aBaseTag = await assetCase("/case/base-tag/");
assert("资源：<base href> 决定相对资源解析基准",
  aBaseTag.assets?.status === "pass" && /\/assets\/base\.css$/.test(aBaseTag.probed?.finalUrl || ""),
  JSON.stringify(aBaseTag.probed), "adversarial");
const crossBeforeBase = crossTargetHits.length;
const aBaseCross = await assetCase("/case/base-cross/");
assert("资源：跨源 <base href> 下的相对引用按跨源处理、不请求",
  aBaseCross.code === 0 && aBaseCross.assets?.status === "pass"
    && aBaseCross.assets.ignored?.some((i) => /跨源/.test(i.reason))
    && !crossTargetHits.slice(crossBeforeBase).includes("/evil.css"),
  JSON.stringify({ ignored: aBaseCross.assets?.ignored, hits: crossTargetHits.slice(crossBeforeBase) }), "adversarial");

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
const i500 = await indexSpecial("idx500");
assert("index.html：5xx 判失败而不是静默警告", i500.code === 1 && i500.idx?.status === "fail" && i500.idx.httpStatus === 500, JSON.stringify(i500.idx), "adversarial");
// /index.html 网络失败不能静默跳过：JSON 里必须有 index-redirect 条目说明未检查。
const iNetErr = await runVerify(["--url", `${rootRedirectBase}/idxerr/`, "--mode", "static", "--json"]);
const iNetErrJ = JSON.parse(iNetErr.out);
const iNetErrCheck = iNetErrJ.checks.find((c) => c.id === "index-redirect");
assert("index.html：请求失败时仍输出 warn，不静默跳过",
  iNetErrCheck?.status === "warn" && iNetErrCheck.httpStatus === null && /失败|无法确认/.test(iNetErrCheck.detail || ""),
  JSON.stringify(iNetErrCheck), "adversarial");

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
assert("主站：跨主机重定向不请求目标，不能据目标响应判 pass",
  rCross?.status === "warn" && rCross.httpStatus === 302 && rCross.verified === false
    && !crossTargetHits.includes("/cross-landing"),
  JSON.stringify({ checkStatus: rCross?.status, httpStatus: rCross?.httpStatus }), "adversarial");
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

// 根路径经过同源重定向后，canonical / 相对资源必须按「最终页面 URL」解析。
// 夹具：/case/same301/ -> /final/，/final/ 声明 canonical="/final/" 并引用相对 final.css。
const vRedirectFinal = await runVerify(["--url", `${rootRedirectBase}/case/same301/`, "--mode", "static", "--json"]);
const vRedirectFinalJ = JSON.parse(vRedirectFinal.out);
const rfCanon = vRedirectFinalJ.checks.find((c) => c.id === "canonical");
const rfAssets = vRedirectFinalJ.checks.find((c) => c.id === "assets");
assert("重定向：canonical 按最终 URL 判定为指向自身",
  vRedirectFinal.code === 0 && rfCanon?.status === "pass" && rfCanon.samePath === true && rfCanon.sameHost === true,
  JSON.stringify(rfCanon), "combination");
assert("重定向：相对资源按最终页面 URL 解析",
  rfAssets?.status === "pass" && rfAssets.probed?.some((p) => /\/final\/final\.css$/.test(p.finalUrl || "")),
  JSON.stringify(rfAssets?.probed), "combination");
// Location 带 userinfo：fetch 会拒绝，必须单独分类为 invalid-location，而不是网络错误。
const rUserinfo = await rootCaseFull("/case/userinfo/");
assert("重定向：Location 含 userinfo 分类为 invalid-location 且不请求目标",
  rUserinfo.root?.status === "fail" && rUserinfo.root.redirectOutcome === "invalid-location"
    && /userinfo/.test(rUserinfo.root.detail || ""), JSON.stringify(rUserinfo.root), "adversarial");
// 根路径同源重定向后，未显式给 --cors-url 时 CORS 默认目标必须是最终站点根。
const rFinalCors = await runVerify(["--url", `${rootRedirectBase}/case/same301/`, "--mode", "static", "--origin", "https://app.example.com", "--json"]);
const rFinalCorsJ = JSON.parse(rFinalCors.out);
const rFinalCorsCheck = rFinalCorsJ.checks.find((c) => c.id === "cors");
assert("CORS：根重定向后默认目标按最终站点根（不是原始 --url）",
  /\/final\/$/.test(rFinalCorsJ.corsUrl || "") && rFinalCorsCheck?.status === "pass" && rFinalCorsCheck.httpStatus === 200,
  JSON.stringify({ corsUrl: rFinalCorsJ.corsUrl, check: rFinalCorsCheck }), "combination");
// 同源重定向到无尾斜杠路径：相对资源按文档 URL 解析，而不是强制补成 /noslash/app.js。
const rNoSlash = await runVerify(["--url", `${rootRedirectBase}/case/noSlash/`, "--mode", "static", "--json"]);
const rNoSlashJ = JSON.parse(rNoSlash.out);
const noSlashAssets = rNoSlashJ.checks.find((c) => c.id === "assets");
assert("资源：最终页面无尾斜杠时相对 URL 按文档 URL 解析",
  noSlashAssets?.status === "pass" && noSlashAssets.checked === 1
    && /\/app\.js$/.test(noSlashAssets.probed?.[0]?.finalUrl || "")
    && !/\/noslash\//.test(noSlashAssets.probed?.[0]?.finalUrl || ""),
  JSON.stringify(noSlashAssets), "adversarial");
// --url 直接指向 .html 文件：相对资源按 /subpage.html 文档 URL 解析成 /rel.js。
const rSubpage = await runVerify(["--url", `${staticBase}/subpage.html`, "--mode", "static", "--json"]);
let rSubpageJ = null;
try { rSubpageJ = JSON.parse(rSubpage.out); } catch { assert("资源：subpage 探针输出合法 JSON", false, `code=${rSubpage.code} err=${(rSubpage.err || "").slice(0, 400)} out=${(rSubpage.out || "").slice(0, 200)}`); }
const subpageAssets = rSubpageJ?.checks.find((c) => c.id === "assets");
assert("资源：--url 指向 .html 时相对资源仍按文档 URL 解析",
  subpageAssets?.status === "pass" && subpageAssets.probed?.[0]?.finalUrl === `${staticBase}/rel.js`,
  JSON.stringify(subpageAssets), "adversarial");
// noscript（脚本启用时是 RAWTEXT）里的伪 base/canonical 不能影响资源与 canonical。
const rNoscriptAssets = await runVerify(["--url", `${staticBase}/noscript-assets/`, "--mode", "static", "--json"]);
let rNoscriptAssetsJ = null;
try { rNoscriptAssetsJ = JSON.parse(rNoscriptAssets.out); } catch { assert("noscript：探针输出合法 JSON", false, `code=${rNoscriptAssets.code} err=${(rNoscriptAssets.err || "").slice(0, 400)}`); }
const noscriptAssets = rNoscriptAssetsJ?.checks.find((c) => c.id === "assets");
const noscriptCanonical = rNoscriptAssetsJ?.checks.find((c) => c.id === "canonical");
assert("noscript：伪 base/canonical 不生效，资源仍按站点根解析",
  noscriptAssets?.status === "pass" && noscriptAssets.checked === 1
    && noscriptAssets.probed?.[0]?.finalUrl === `${staticBase}/assets/app.css`
    && noscriptCanonical?.status === "skip",
  JSON.stringify({ assets: noscriptAssets, canonical: noscriptCanonical }), "adversarial");
// srcset：逗号后无空格也必须拆成两个候选资源并都探测。
const rSrcset = await runVerify(["--url", `${staticBase}/srcset/`, "--mode", "static", "--json"]);
const rSrcsetJ = JSON.parse(rSrcset.out);
const rSrcsetAssets = rSrcsetJ.checks.find((c) => c.id === "assets");
assert("srcset：逗号后无空格的候选都进入资源检查",
  rSrcset.code === 0 && rSrcsetAssets?.status === "pass" && rSrcsetAssets.checked === 2
    && rSrcsetAssets.probed?.some((p) => p.url === "/assets/app.css")
    && rSrcsetAssets.probed?.some((p) => p.url === "/assets/app.js"),
  JSON.stringify(rSrcsetAssets), "adversarial");
// 备用站与主站同源不构成独立入口。
const rBackupSame = await runVerify(["--url", staticBase, "--mode", "static", "--backup", `${staticBase}/`, "--json"]);
const rBackupSameCheck = JSON.parse(rBackupSame.out).checks.find((c) => c.id === "backup");
assert("备用站：与主站同源判 fail（不是独立备用入口）",
  rBackupSame.code === 1 && rBackupSameCheck?.status === "fail" && /同源/.test(rBackupSameCheck.detail || ""),
  JSON.stringify(rBackupSameCheck), "adversarial");

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

// RAWTEXT 内容既不能产生标签，也不能算作服务端渲染的可见文本。
const vSsrHeavy = await runVerify(["--url", `${ssrUrl}/heavy/`, "--mode", "ssr", "--json"]);
const vSsrHeavyJ = JSON.parse(vSsrHeavy.out);
const heavyCanon = vSsrHeavyJ.checks.find((c) => c.id === "canonical");
const heavyHtml = vSsrHeavyJ.checks.find((c) => c.id === "ssr-html");
assert("HTML 上下文：script 里的伪 canonical 不进 canonical 检查", heavyCanon?.status === "skip", JSON.stringify(heavyCanon), "adversarial");
assert("SSR：script/style 内容不计入可见文本", heavyHtml?.status === "warn" && heavyHtml.textLength < 200, JSON.stringify(heavyHtml), "adversarial");
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

for (const srv of [staticServer, spaServer, corsServer, badCorsServer, dupCanonicalServer, canonicalHrefServer, backupServer, subServer, ssrServer, corsMatrixServer, assetRedirectServer, assetTargetServer, rootRedirectServer, indexStatusServer, crossTargetServer, flakyServer, tlsCanonicalServer]) srv.close();

// ---------------------------------------------------------------- 链路探针（本地假 wrangler，不接触真实账号）
const probeDir = path.join(work, "probe-cwd");
const probeBin = path.join(probeDir, "node_modules", ".bin");
fs.mkdirSync(probeBin, { recursive: true });
const fakeWrangler = [
  'import fs from "node:fs";',
  'if (process.env.PROBE_CALL_LOG) { try { fs.appendFileSync(process.env.PROBE_CALL_LOG, process.argv.slice(2).join(" ") + "\\n"); } catch { /* 测试辅助，失败不影响探针 */ } }',
  "const a = process.argv.slice(2);",
  'if (a.includes("--version")) { console.log("4.0.0-fake"); process.exit(0); }',
  'if (a[0] === "whoami" && a.includes("--json")) { console.error("Unknown argument: json"); process.exit(1); }',
  'if (a[0] === "whoami") {',
  '  if (process.env.CF_FAKE_WHOAMI_EMPTY) { process.exit(0); }',
  '  if (process.env.CF_FAKE_WHOAMI_FALSE) { console.log("{\\"loggedIn\\":false}"); process.exit(0); }',
  '  if (process.env.CF_FAKE_WHOAMI_ERROR) { console.error("wrangler crashed"); process.exit(1); }',
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
const spawnProbe = (args, extraEnv = {}) => spawnSync(process.execPath, [path.join(root, "scripts/probe.mjs"), ...args], {
  encoding: "utf8", cwd: probeDir, timeout: 40000,
  env: { ...process.env, CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "", ...extraEnv },
});
const pDefaultTimeout = spawnProbe(["--json"]);
let pDefaultTimeoutJson = null;
try { pDefaultTimeoutJson = JSON.parse(pDefaultTimeout.stdout); } catch { /* 断言里报告原始输出 */ }
assert("探针 CLI：不传 --timeout 时使用默认 15000 并正常执行",
  pDefaultTimeout.status !== null && pDefaultTimeoutJson !== null
    && Array.isArray(pDefaultTimeoutJson.checks) && !/用法错误/.test(pDefaultTimeout.stderr || ""),
  `code=${pDefaultTimeout.status} out=${(pDefaultTimeout.stdout || "").slice(0, 100)} err=${(pDefaultTimeout.stderr || "").slice(0, 100)}`, "boundary");

const pOk = runProbe();
assert("探针 CLI：合法 --timeout 正整数保持原有行为",
  pOk.json !== null && Array.isArray(pOk.json.checks) && !/用法错误/.test(pOk.err || ""),
  `code=${pOk.code} out=${(pOk.out || "").slice(0, 100)} err=${(pOk.err || "").slice(0, 100)}`, "boundary");

// --timeout 必须是有限正整数且不超过 Node.js 定时器上限；非法参数必须在任何网络/
// wrangler/部署调用之前以退出码 2 结束，而不是包装成网络失败。fake wrangler 的
// PROBE_CALL_LOG 证明这些进程没有再走到 wrangler/部署阶段（校验代码在 fetch 之前）。
{
  const callLog = path.join(probeDir, "invalid-timeout-calls.log");
  fs.rmSync(callLog, { force: true });
  const invalidTimeoutCases = [
    ["非数字 abc", ["--timeout", "abc"]],
    ["负数 -1", ["--timeout", "-1"]],
    ["零 0", ["--timeout", "0"]],
    ["小数 1.5", ["--timeout", "1.5"]],
    ["超出定时器上限", ["--timeout", "2147483648"]],
    ["缺少值", ["--timeout"]],
    ["空字符串", ["--timeout", ""]],
  ];
  let invalidBad = 0;
  let invalidDetail = null;
  for (const [name, args] of invalidTimeoutCases) {
    const startedAt = Date.now();
    const r = spawnProbe(["--json", "--deploy", ...args], { PROBE_CALL_LOG: callLog });
    const elapsed = Date.now() - startedAt;
    const ok = r.status === 2 && !String(r.stdout || "").trim()
      && /用法错误/.test(r.stderr || "") && /--timeout/.test(r.stderr || "")
      && !/无法访问|api\.cloudflare\.com|网络连接失败/.test(r.stderr || "")
      && elapsed < 2000;
    if (!ok) {
      invalidBad++;
      if (!invalidDetail) invalidDetail = { name, code: r.status, elapsed, out: String(r.stdout || "").slice(0, 80), err: String(r.stderr || "").slice(0, 160) };
    }
  }
  const callLogText = fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8").trim() : "";
  assert("探针 CLI：非法 --timeout 全部退出码 2 且不进入网络/部署阶段",
    invalidBad === 0 && callLogText === "",
    JSON.stringify({ invalidBad, invalidDetail, wranglerCalls: callLogText.slice(0, 200) }), "adversarial");
}
const pAuth = pOk.json?.checks?.find((c) => c.id === "auth");
assert("探针：whoami --json 调用失败时不误判未登录", pAuth?.status === "pass", pAuth ? JSON.stringify(pAuth) : `out=${pOk.out.slice(0, 200)} err=${pOk.err.slice(0, 200)}`);
assert("探针：从纯文本提取 Account ID", pOk.json?.checks?.some((c) => c.id === "account-id" && c.status === "pass" && c.accountId === "abcdef0123456789abcdef0123456789"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "account-id")));
assert("探针：wrangler 版本探测通过", pOk.json?.checks?.some((c) => c.id === "wrangler" && c.status === "pass"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "wrangler")));
assert("探针：OAuth 登录态如实跳过 Token 权限检查", pOk.json?.checks?.some((c) => c.id === "api-read" && c.status === "skip"), JSON.stringify(pOk.json?.checks?.find((c) => c.id === "api-read")));
const pNo = runProbe({ CF_FAKE_NOT_LOGGED: "1" });
assert("探针：文本明确未登录时判 blocked", pNo.json?.checks?.some((c) => c.id === "auth" && c.status === "fail") && pNo.json?.status === "blocked" && pNo.code === 2, `status=${pNo.json?.status} code=${pNo.code}`);
const pEmpty = runProbe({ CF_FAKE_WHOAMI_EMPTY: "1" });
assert("探针：whoami 退出码 0 但空输出不得判已登录（fail-closed）",
  pEmpty.json?.checks?.find((c) => c.id === "auth")?.status === "fail" && pEmpty.json?.status === "blocked" && pEmpty.code === 2,
  JSON.stringify({ auth: pEmpty.json?.checks?.find((c) => c.id === "auth"), status: pEmpty.json?.status, code: pEmpty.code }), "adversarial");
const pFalse = runProbe({ CF_FAKE_WHOAMI_FALSE: "1" });
assert("探针：whoami 输出 loggedIn:false 判 blocked",
  pFalse.json?.checks?.find((c) => c.id === "auth")?.status === "fail" && pFalse.code === 2,
  JSON.stringify(pFalse.json?.checks?.find((c) => c.id === "auth")), "adversarial");
const pErr = runProbe({ CF_FAKE_WHOAMI_ERROR: "1" });
assert("探针：whoami 执行失败与未登录分开报告",
  pErr.json?.checks?.find((c) => c.id === "auth")?.status === "fail" && /执行失败/.test(pErr.json?.checks?.find((c) => c.id === "auth")?.detail || ""),
  JSON.stringify(pErr.json?.checks?.find((c) => c.id === "auth")), "boundary");

// 登录判定纯函数：未知/本地化输出不能当成已登录；多账号不替用户选。
const authCases = [
  [{ ok: true, stdout: "已登录", stderr: "" }, "unknown", "本地化但无正向证据"],
  [{ ok: true, stdout: "You are logged in with an OAuth Token, associated with probe@example.com!", stderr: "" }, "logged-in", "英文登录 + 邮箱"],
  [{ ok: true, stdout: "You are logged in with an OAuth Token.\nWarning: no account selected", stderr: "" }, "logged-in", "已登录但未选账号"],
  [{ ok: true, stdout: "You are not logged in. Please run npx wrangler login.", stderr: "" }, "logged-out", "明确未登录"],
  [{ ok: true, stdout: "", stderr: "" }, "unknown", "空输出"],
  [{ ok: false, stdout: "", stderr: "boom", error: "ENOENT" }, "error", "执行失败"],
  [{ ok: false, stdout: "You are not logged in.", stderr: "" }, "logged-out", "非零退出 + 未登录"],
];
for (const [input, expected, label] of authCases) {
  const got = classifyWranglerWhoami(input);
  assert(`登录判定：${label} 判 ${expected}`, got.state === expected, JSON.stringify(got), "unit");
}
const multiAccount = "| Account Name | Account ID |\n| a | aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa |\n| b | bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb |";
assert("登录判定：多账号 whoami 不替用户选 Account ID", extractAccountId(multiAccount) === null, JSON.stringify(extractAccountId(multiAccount)), "unit");

// ---------------------------------------------------------------- 部署探针判定（纯逻辑 + 本地假 wrangler 端到端）
assert("部署探针：能从输出解析 workers.dev URL", parseDeployUrl("Published https://cf-probe-abc.my-account.workers.dev (1.2s)") === "https://cf-probe-abc.my-account.workers.dev");
assert("部署探针：输出里没有 URL 返回 null", parseDeployUrl("Deployed successfully") === null);
const fetchOk = async () => ({ status: 200, text: async () => "ok" });
const fetch503 = async () => ({ status: 503, text: async () => "" });
const fetch302 = async () => ({ status: 302, text: async () => "" });
const fetchWrongBody = async () => ({ status: 200, text: async () => "not ok" });
const fetchThrow = async () => { throw new Error("ECONNREFUSED"); };
const httpServed = await verifyDeployedUrl("https://x.workers.dev", fetchOk, { attempts: 2, delayMs: 0 });
assert("部署探针：200 + 内容匹配才算通过", httpServed.served === true && httpServed.attempts === 1);
const httpRedirect = await verifyDeployedUrl("https://x.workers.dev", fetch302, { attempts: 1, delayMs: 0 });
assert("部署探针：跳转响应不算线上验证通过", httpRedirect.served === false && /重定向未跟随/.test(httpRedirect.reason), JSON.stringify(httpRedirect), "adversarial");
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
assert("部署探针：部署失败时清理结论为 skip，并提示可能残留",
  dCleanupSkipped.cleanup.status === "skip" && /未确认成功/.test(dCleanupSkipped.cleanup.detail) && /手动删除/.test(dCleanupSkipped.cleanup.detail),
  JSON.stringify(dCleanupSkipped.cleanup));

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
  return c?.status === "skip" && /未确认成功/.test(c.detail || "");
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

// 登录判定 fail-closed：退出码 0 但输出不可信时不得 canDeploy=true。
const envAuthMode = (mode) => {
  const r = spawnSync(process.execPath, [path.join(root, "scripts/check-env.mjs"), "--json"], {
    encoding: "utf8", cwd: spaceDir, timeout: 40000, env: { ...process.env, [mode]: "1" },
  });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 断言里带上原始输出 */ }
  return { code: r.status, json: j, out: r.stdout, err: r.stderr };
};
const envFalse = envAuthMode("CF_FAKE_WHOAMI_FALSE");
const envFalseAuth = envFalse.json?.checks?.find((c) => c.id === "wrangler-auth");
assert("预检：whoami 输出 loggedIn:false 判 warn 且不可部署",
  envFalseAuth?.status === "warn" && envFalseAuth.authState === "logged-out"
    && envFalse.json?.summary?.canDeploy === false && envFalse.code !== 0,
  JSON.stringify({ auth: envFalseAuth, summary: envFalse.json?.summary, code: envFalse.code }), "adversarial");
const envEmpty = envAuthMode("CF_FAKE_WHOAMI_EMPTY");
const envEmptyAuth = envEmpty.json?.checks?.find((c) => c.id === "wrangler-auth");
assert("预检：whoami 退出码 0 但空输出判 warn（unknown）且不可部署",
  envEmptyAuth?.status === "warn" && envEmptyAuth.authState === "unknown"
    && /没有可验证的登录证据/.test(envEmptyAuth.detail || "")
    && envEmpty.json?.summary?.canDeploy === false,
  JSON.stringify({ auth: envEmptyAuth, summary: envEmpty.json?.summary }), "adversarial");

// ================================================================ HTML tokenizer（单元 / 对抗层）
// 解析可靠性集中在 scripts/html-scan.mjs。这一层直接测 tokenizer 的上下文边界和
// 畸形输入；上面的真实 HTTP 用例再验证这些输入经过 verify-deployment 后的业务结论。
const canonElements = (htmlText) => parseHtml(htmlText).elements.filter((el) => el.name === "link" && relTokens(el).includes("canonical"));
const canonCount = (htmlText) => canonElements(htmlText).length;

const tokenizerCases = [
  [`<link rel="canonical" href="/a">`, 1, "双引号属性"],
  [`<link rel='canonical' href='/a'>`, 1, "单引号属性"],
  [`<link rel=canonical href=/a>`, 1, "无引号属性"],
  [`<link href="/a" rel="canonical">`, 1, "属性顺序（href 在前）"],
  [`<LINK REL="Canonical" HREF="/A">`, 1, "标签名/属性名/rel 大小写"],
  [`<link data-rel="canonical" href="/a">`, 0, "data-rel"],
  [`<link aria-rel="canonical" href="/a">`, 0, "aria-rel"],
  [`<link rel="canonicalized" href="/a">`, 0, "canonicalized"],
  [`<link rel="alternate canonical" href="/a">`, 1, "rel 多 token"],
  [`<link rel="canonicalized canonical" href="/a">`, 1, "相似 token + 真 token"],
  [`<link rel="canonicalized" rel="canonical" href="/a">`, 0, "重复 rel 属性第一个生效"],
  [`<link rel="canonical" rel="canonicalized" href="/a">`, 1, "重复 rel 属性第一个生效 2"],
  [`<!-- <link rel="canonical" href="/a"> -->`, 0, "HTML 注释"],
  [`<!--><link rel="canonical" href="/a">`, 1, "abrupt 空注释"],
  [`<!---><link rel="canonical" href="/a">`, 1, "短注释结束后真实标签"],
  [`<script>x</script foo="><link rel='canonical' href='/fake'>"><link rel='canonical' href='/a'>`, 1, "结束标签引号里的 > 不提前结束"],
  [`<!-- <link rel="canonical" href="/a"> --><link rel="canonical" href="/a">`, 1, "注释 + 真实标签"],
  [`<script>var s = '<link rel="canonical" href="/a">';</script>`, 0, "script RAWTEXT"],
  [`<script>if (a < b) { }</script><link rel="canonical" href="/a">`, 1, "script 里的 < 不开始标签"],
  [`<style>/* <link rel="canonical" href="/a"> */</style>`, 0, "style RAWTEXT"],
  [`<textarea><link rel="canonical" href="/a"></textarea>`, 0, "textarea RCDATA"],
  [`<title><link rel="canonical" href="/a"></title>`, 0, "title RCDATA"],
  [`<iframe><link rel="canonical" href="/a"></iframe>`, 0, "iframe RAWTEXT"],
  [`<xmp><link rel="canonical" href="/a"></xmp>`, 0, "xmp RAWTEXT"],
  [`<noembed><link rel="canonical" href="/a"></noembed>`, 0, "noembed RAWTEXT"],
  [`<noframes><link rel="canonical" href="/a"></noframes>`, 0, "noframes RAWTEXT"],
  [`<plaintext><link rel="canonical" href="/a">`, 0, "plaintext"],
  [`<template><link rel="canonical" href="/a"></template>`, 0, "template 惰性内容"],
  [`<template></template><link rel="canonical" href="/a">`, 1, "template 之后的真实标签"],
  [`<div data-html="<link rel='canonical' href='/a'>"></div>`, 0, "属性值里的伪标签"],
  [`<link rel="canonical" href="/a" data-x=">">`, 1, "属性值里的 >"],
  [`<link rel="canonical"`, 0, "不完整标签（EOF）"],
  [`<link rel="canonical" href="/a"`, 0, "属性中途 EOF"],
  [`<link rel="canonical"href="/a">`, 1, "属性之间无空格"],
  [`<link rel="canonical" href=/a/>`, 1, "无引号值以 /> 结尾"],
  [`<link rel="canonical" href=/a />`, 1, "自闭合标签"],
  [`<!DOCTYPE html><link rel="canonical" href="/a">`, 1, "DOCTYPE 不干扰"],
  [`</ link><link rel="canonical" href="/a">`, 1, "畸形结束标签"],
  [`<> <link rel="canonical" href="/a">`, 1, "空尖括号"],
  [`<link rel="canonical" href="/a">`.replace(">", " >"), 1, "结束尖括号前有空格"],
  [`<noscript><link rel="canonical" href="/a"></noscript>`, 0, "noscript（脚本启用时是 RAWTEXT）"],
  [`<svg><link rel="canonical" href="https://evil/"></svg><link rel="canonical" href="/a">`, 1, "SVG 外域里的 link 不是 HTML 元素"],
  [`<svg><![CDATA[> <link rel="canonical" href="https://evil/"> ]]></svg><link rel="canonical" href="/a">`, 1, "SVG CDATA 里的伪标签"],
  [`<math><link rel="canonical" href="https://evil/"></math><link rel="canonical" href="/a">`, 1, "MathML 外域里的 link"],
  [`<svg><foreignObject><link rel="canonical" href="/in-object"></foreignObject></svg>`, 1, "foreignObject 内部恢复 HTML"],
  [`</a "><link rel="canonical" href="/a">`, 1, "结束标签里游离引号不吞后续标签"],
  [`</a '><link rel="canonical" href="/a">`, 1, "结束标签里游离单引号"],
  [`<link =rel="canonical" href="/a">`, 0, "属性名以 = 开头不等于 rel"],
  [`<svg><title>SVG-ONLY</title></svg><title>HTML-TITLE</title>`, 0, "文档 title 只认 HTML 命名空间"],
];
for (const [htmlText, expected, label] of tokenizerCases) {
  assert(`HTML tokenizer：${label}`, canonCount(htmlText) === expected, `expected=${expected} actual=${canonCount(htmlText)}`, "unit");
}

// 属性/实体/URL 解析细节
const entityEl = canonElements(`<link rel="canonical" href="/q?a=1&amp;b=2">`)[0];
assert("HTML tokenizer：属性值里的字符引用被解码", getAttribute(entityEl, "href").value === "/q?a=1&b=2", JSON.stringify(getAttribute(entityEl, "href")), "unit");
assert("HTML tokenizer：数字/十六进制字符引用解码", decodeCharacterReferences("&#47; &#x2f; &#38;") === "/ / &", decodeCharacterReferences("&#47; &#x2f; &#38;"), "unit");
assert("HTML tokenizer：未知命名实体保持原样", decodeCharacterReferences("&unknown;") === "&unknown;", decodeCharacterReferences("&unknown;"), "unit");
assert("HTML tokenizer：命名实体大小写敏感（&Amp; 不解码）", decodeCharacterReferences("&Amp; &amp;") === "&Amp; &", decodeCharacterReferences("&Amp; &amp;"), "unit");
assert("HTML tokenizer：数字引用允许缺分号（文本上下文）", decodeCharacterReferences("&#47 &#x2f") === "/ /", decodeCharacterReferences("&#47 &#x2f"), "unit");
assert("HTML tokenizer：属性值里缺分号且后接字母/=时不解码", decodeCharacterReferences("&#47x", true) === "&#47x" && decodeCharacterReferences("&#47", true) === "/", JSON.stringify([decodeCharacterReferences("&#47x", true), decodeCharacterReferences("&#47", true)]), "unit");
assert("HTML tokenizer：C1 控制字符按 windows-1252 映射", decodeCharacterReferences("&#128;") === "\u20ac", JSON.stringify(decodeCharacterReferences("&#128;")), "unit");
const nulEl = canonElements(`<link rel="canonical" href="/a\u0000b">`)[0];
assert("HTML tokenizer：输入 NUL 替换为 U+FFFD", getAttribute(nulEl, "href").value === "/a\uFFFDb", JSON.stringify(getAttribute(nulEl, "href")), "unit");
const dupAttrEl = canonElements(`<link rel="canonical" href="/first" href="/second">`)[0];
assert("HTML tokenizer：重复属性保留第一个", getAttribute(dupAttrEl, "href").value === "/first", JSON.stringify(getAttribute(dupAttrEl, "href")), "unit");
const titleEl2 = parseHtml(`<title>A &amp; B</title>`).elements.find((el) => el.name === "title");
assert("HTML tokenizer：RCDATA title 内容可读取并解码", titleEl2?.content === "A & B", JSON.stringify(titleEl2?.content), "unit");

// <base href>：第一个生效；template 里的不算；无法解析回退 documentUrl
const baseHtml = `<template><base href="/evil/"></template><base href="/root/"><base href="/ignored/"><link rel="canonical" href="x">`;
const baseElements = parseHtml(baseHtml).elements;
assert("HTML tokenizer：<base href> 第一个生效且跳过 template 内容",
  effectiveBaseUrl(baseElements, "https://example.com/dir/page") === "https://example.com/root/",
  effectiveBaseUrl(baseElements, "https://example.com/dir/page"), "unit");
assert("HTML tokenizer：非法 <base href> 回退到文档 URL",
  effectiveBaseUrl(parseHtml(`<base href="http://"><link rel="canonical" href="/a">`).elements, "https://example.com/dir/page") === "https://example.com/dir/page",
  effectiveBaseUrl(parseHtml(`<base href="http://">`).elements, "https://example.com/dir/page"), "unit");

// 可见文本：注释 / RAWTEXT / title 排除，textarea 与普通文本保留，实体解码
const textSample = parseHtml(`<title>T&amp;T</title><!-- hidden --><script>SHOULD_NOT_APPEAR</script><style>CSS</style><textarea>TA</textarea><p>Hello &amp; bye</p>`).text;
assert("HTML tokenizer：可见文本排除注释/RAWTEXT/title、保留 textarea 与普通文本",
  /Hello & bye/.test(textSample) && /TA/.test(textSample) && !/T&T/.test(textSample)
    && !/SHOULD_NOT_APPEAR/.test(textSample) && !/CSS/.test(textSample),
  JSON.stringify(textSample), "unit");
assert("HTML tokenizer：xmp 内容计入可见文本（浏览器会渲染）",
  /XMP-VISIBLE/.test(parseHtml(`<xmp>XMP-VISIBLE</xmp>`).text) && !/SCRIPT-HIDDEN/.test(parseHtml(`<script>SCRIPT-HIDDEN</script>`).text),
  JSON.stringify(parseHtml(`<xmp>XMP-VISIBLE</xmp>`).text), "unit");
assert("HTML tokenizer：SVG title 不计入文档 title",
  parseHtml(`<svg><title>SVG-ONLY</title></svg><title>HTML-TITLE</title>`).elements.find((el) => el.name === "title")?.content === "HTML-TITLE",
  JSON.stringify(parseHtml(`<svg><title>SVG-ONLY</title></svg><title>HTML-TITLE</title>`).elements.filter((el) => el.name === "title")), "adversarial");

// 资源属性规则：与 check-build 共用的单一权威。
const refElements = parseHtml(`<a href="/nav">x</a><link rel="canonical" href="/canonical">`
  + `<link rel="stylesheet" href="/s.css"><link rel="preload" as="style" href="/pre.css">`
  + `<img src="/i.png" srcset="/img/a,b.png 1x, /i3.png 2x">`
  + `<video poster="/p.jpg"></video><object data="/o.bin"></object><base href="/assets/">`
  + `<link rel="alternate canonical" href="/multi-canonical">`).elements;
const refValues = resourceReferences(refElements).map((r) => r.value);
assert("HTML 资源引用：只取子资源属性，排除导航/canonical/base",
  refValues.includes("/s.css") && refValues.includes("/i.png") && refValues.includes("/img/a,b.png")
    && refValues.includes("/i3.png") && refValues.includes("/p.jpg") && refValues.includes("/o.bin")
    && refValues.includes("/pre.css") && !refValues.includes("/multi-canonical")
    && !refValues.includes("/nav") && !refValues.includes("/canonical") && !refValues.includes("/assets/"),
  refValues.join(","), "unit");

// ---------------------------------------------------------------- HTML5 状态机专项（第二轮）
// 期望值来自真实 Chromium 解析器（tests/fixtures/html5-oracle.json，Chrome/Edge 交叉验证），
// 不是本实现自己算出来的。fixtures 由 tests/browser-diff.mjs --record 生成。
const canonHrefs = (htmlText) => canonElements(htmlText).map((el) => getAttribute(el, "href").value);
const scriptContent = (htmlText) => parseHtml(htmlText).elements.find((el) => el.name === "script")?.content ?? null;

// 1) script data：escaped / double-escaped / `-->` 回 data / EOF。
const scriptDataCases = [
  ["double-escaped 里的 </script> 不关闭", `<script><!--<script></script>--></script><link rel="canonical" href="/after"><link rel="canonical" href="/fake">`, ["/after", "/fake"], "<!--<script></script>-->"],
  ["escaped 里的 </script> 关闭", `<script><!--</script><link rel="canonical" href="/fake"><link rel="canonical" href="/real">`, ["/fake", "/real"], "<!--"],
  ["double-escaped 的 --> 回到 data 后关闭", `<script><!--<script>--></script><link rel="canonical" href="/real">`, ["/real"], "<!--<script>-->"],
  ["double-escaped 两次 </script>：第二次关闭", `<script><!--<script></script></script><link rel="canonical" href="/real"><link rel="canonical" href="/fake2">`, ["/real", "/fake2"], "<!--<script></script>"],
  ["script 字符串里的伪标签", `<script>var x = "<link rel='canonical' href='/fake'>";</script><link rel="canonical" href="/real">`, ["/real"], `var x = "<link rel='canonical' href='/fake'>";`],
  ["double-escaped 中的伪标签+注释", `<script><!--<script>--><link rel='canonical' href='/fake'>--></script><link rel='canonical' href='/real'>`, ["/real"], `<!--<script>--><link rel='canonical' href='/fake'>-->`],
  ["未闭合 script 吞到 EOF", `<script>\n<link rel=canonical href=/real>`, [], `\n<link rel=canonical href=/real>`],
];
for (const [label, htmlText, expectedCanon, expectedContent] of scriptDataCases) {
  assert(`script data：${label}`,
    JSON.stringify(canonHrefs(htmlText)) === JSON.stringify(expectedCanon) && scriptContent(htmlText) === expectedContent,
    JSON.stringify({ canonical: canonHrefs(htmlText), script: scriptContent(htmlText) }), "adversarial");
}
{
  const sample = `<script>abc</script>tail`;
  const scan = scanScriptData(sample, 8);
  assert("script data：scanScriptData 返回内容边界与结束标签之后位置",
    scan.contentEnd === 11 && scan.next === 20,
    JSON.stringify(scan), "unit");
}

// 2) DOCTYPE：public/system 标识符里的 `>` 按规范 abrupt 结束 DOCTYPE（引号不保护），
//    之后的字符按普通 HTML 继续解析；必要时置 force-quirks（tokenizer 不建树，不跟踪）。
const doctypeCases = [
  ["标准 public/system DOCTYPE 不吞后续标签", `<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd"><link rel="canonical" href="/real">`, ["/real"], null],
  ["system 标识符里的 > 提前结束 DOCTYPE", `<!DOCTYPE html SYSTEM "http://example.com/a>b"><link rel="canonical" href="/real">`, ["/real"], `b">`],
  ["public 标识符里的 > 提前结束 DOCTYPE", `<!DOCTYPE html PUBLIC "a>b" "c>d"><link rel="canonical" href="/real">`, ["/real"], `b" "c>d">`],
  ["引号里的伪 link 因 DOCTYPE 提前结束而不成为元素", `<!DOCTYPE html PUBLIC "unclosed><link rel='canonical' href='/fake'>"><link rel="canonical" href="/real">`, ["/fake", "/real"], `">`],
  ["普通 doctype 不影响后续", `<!doctype html><link rel="canonical" href="/real">`, ["/real"], null],
];
for (const [label, htmlText, expectedCanon, expectedText] of doctypeCases) {
  const actualText = expectedText == null ? null : parseHtml(htmlText).text.trim();
  assert(`DOCTYPE：${label}`,
    JSON.stringify(canonHrefs(htmlText)) === JSON.stringify(expectedCanon)
      && (expectedText == null || actualText === expectedText),
    JSON.stringify({ canonical: canonHrefs(htmlText), text: actualText }), "adversarial");
}

// 3) SVG/MathML 命名空间栈：嵌套、集成点、breakout、结束后恢复 HTML、无状态泄漏。
const namespaceCases = [
  ["svg 嵌套 svg 里的伪 link", `<svg><svg><link rel="canonical" href="/fake"></svg></svg><link rel="canonical" href="/real">`, ["/real"], null],
  ["foreignObject 内的 link 是 HTML", `<svg><foreignObject><link rel="canonical" href="/html"></foreignObject></svg>`, ["/html"], null],
  ["foreignObject 内嵌套 svg/foreignObject", `<svg><foreignObject><svg><foreignObject><link rel="canonical" href="/nested"></foreignObject></svg></foreignObject></svg>`, ["/nested"], null],
  ["</svg> 出现在 foreignObject 内会退出整个 svg", `<svg><foreignObject></svg><svg><link rel="canonical" href="/fake"></svg><link rel="canonical" href="/real">`, ["/real"], null],
  ["多层 foreignObject 关闭后不泄漏外域状态", `<svg><foreignObject><svg><foreignObject></foreignObject></svg></foreignObject></svg><link rel="canonical" href="/real">`, ["/real"], null],
  ["嵌套 foreignObject 内部的 link 是 HTML", `<svg><foreignObject><svg><foreignObject><link rel="canonical" href="/nested"></foreignObject></svg></foreignObject></svg><link rel="canonical" href="/real">`, ["/nested", "/real"], null],
  ["math 里的 svg 伪 link", `<math><svg><link rel="canonical" href="/fake"></svg></math><link rel="canonical" href="/real">`, ["/real"], null],
  ["svg title 是 HTML 集成点", `<svg><title><link rel="canonical" href="/t"></title></svg><link rel="canonical" href="/real">`, ["/t", "/real"], null],
  ["svg desc 是 HTML 集成点", `<svg><desc><link rel="canonical" href="/d"></desc></svg><link rel="canonical" href="/real">`, ["/d", "/real"], null],
  ["math mtext 是文本集成点", `<math><mtext><link rel="canonical" href="/m"></mtext></math><link rel="canonical" href="/real">`, ["/m", "/real"], null],
  ["math mi 是文本集成点", `<math><mi><link rel="canonical" href="/mi"></mi></math><link rel="canonical" href="/real">`, ["/mi", "/real"], null],
  ["math mglyph 不是集成点", `<math><mglyph><link rel="canonical" href="/g"></mglyph></math><link rel="canonical" href="/real">`, ["/real"], null],
  ["svg CDATA 里的伪 link", `<svg><![CDATA[> <link rel='canonical' href='/fake'> ]]></svg><link rel='canonical' href='/real'>`, ["/real"], null],
  ["template 内外域状态隔离", `<template><svg><link rel="canonical" href="/fake"></template><svg><link rel="canonical" href="/fake2"></svg><link rel="canonical" href="/real">`, ["/real"], null],
];
for (const [label, htmlText, expectedCanon] of namespaceCases) {
  assert(`命名空间：${label}`,
    JSON.stringify(canonHrefs(htmlText)) === JSON.stringify(expectedCanon),
    JSON.stringify({ canonical: canonHrefs(htmlText), elements: parseHtml(htmlText).elements.map((el) => el.name) }), "adversarial");
}

// 3b) 结束标签/HTML 祖先/集成点边界的浏览器实测用例（F1-F15，见 oracle fixture）。
const stateEdgeCases = [
  ["HTML 结束标签弹掉未闭合的外域（div）", `<div><svg></div><link rel="canonical" href="/real">`, ["/real"]],
  ["HTML 结束标签弹掉未闭合的外域（p/select）", `<p><svg></p><select><svg></select><link rel="canonical" href="/real">`, ["/real"]],
  ["template 里的 svg 不泄漏到 template 之后", `<template><svg></template><link rel="canonical" href="/real">`, ["/real"]],
  ["结束标签里的 = 与引号不吞后续标签", `<div></div ="><link rel="canonical" href="/real">`, ["/real"]],
  ["RAWTEXT 结束标签里的 = 与引号不吞后续标签", `<script>x</script ="><link rel="canonical" href="/real">`, ["/real"]],
  ["外域里的 </p> breakout 结束", `<svg></p><link rel="canonical" href="/real">`, ["/real"]],
  ["MathML annotation-xml encoding=text/html 是集成点", `<math><annotation-xml encoding="text/html"><link rel="canonical" href="/ax"></annotation-xml></math><link rel="canonical" href="/real">`, ["/ax", "/real"]],
  ["MathML annotation-xml encoding=application/xhtml+xml 是集成点", `<math><annotation-xml encoding="application/xhtml+xml"><link rel="canonical" href="/ax"></annotation-xml></math>`, ["/ax"]],
  ["默认 annotation-xml 里的 link 是 MathML 外域", `<math><annotation-xml><link rel="canonical" href="/ax"></annotation-xml></math><link rel="canonical" href="/real">`, ["/real"]],
  ["MathML annotation-xml 上的 svg 走 HTML 规则进入 SVG", `<math><annotation-xml><svg><link rel="canonical" href="/svg"></svg></annotation-xml></math><link rel="canonical" href="/real">`, ["/real"]],
  ["SVG g 里的 title 是集成点", `<svg><g><title><link rel="canonical" href="/g-title"></title></g></svg>`, ["/g-title"]],
  ["foreignObject 里的 title 是 HTML RCDATA", `<svg><foreignObject><title><link rel="canonical" href="/fo-title"></title></foreignObject></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["mtext 里的 mglyph 仍按 MathML 外域", `<math><mtext><mglyph><link rel="canonical" href="/mg"></mglyph></mtext></math><link rel="canonical" href="/real">`, ["/real"]],
  ["foreignObject 内的未闭合 HTML 子元素会忽略 </foreignObject>", `<svg><foreignObject><div><link rel="canonical" href="/a"></foreignObject><link rel="canonical" href="/b">`, ["/a", "/b"]],
  ["foreignObject 关闭后下面的 link 仍是外域", `<svg><foreignObject></foreignObject><link rel="canonical" href="/fake"></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["breakout 只弹到 MathML 文本集成点（不弹 mi）", `<math><mi><mglyph><img src="/real-img.png"></mi><link rel="canonical" href="/x">`, []],
  ["集成点内已有 HTML 子元素时 mglyph 按 HTML", `<math><mn><b><mglyph><link rel="canonical" href="/x">`, ["/x"]],
  ["foreignObject 内 CDATA 吞掉伪 link", `<svg><foreignObject><![CDATA[x> <link rel="canonical" href="/fake">]]></foreignObject><link rel="canonical" href="/real">`, []],
  ["mtext 内 CDATA 吞掉伪 img", `<math><mtext><![CDATA[><img src="/fake.png">`, []],
  ["script 里的 <!--> 回到 data 不吞后续标签", `<script><!--><script></script><link rel="canonical" href="/fake"></script><link rel="canonical" href="/real">`, ["/fake", "/real"]],
  ["script 里的 <!---> 回到 data", `<script><!---><script></script></script><link rel="canonical" href="/real">`, ["/real"]],
  ["集成点内 HTML 元素后嵌套 svg：HTML 结束标签退出", `<svg><foreignObject><div><svg></div><link rel="canonical" href="/x"></foreignObject></svg><link rel="canonical" href="/real">`, ["/x", "/real"]],
  ["集成点内 special 元素阻止错误结束标签", `<svg><foreignObject><span><div></span></foreignObject><link rel="canonical" href="/real">`, ["/real"]],
  ["annotation-xml encoding 前后有空格不算集成点", `<math><annotation-xml encoding=" text/html "><link rel="canonical" href="/fake"></annotation-xml></math><link rel="canonical" href="/real">`, ["/real"]],
];
for (const [label, htmlText, expectedCanon] of stateEdgeCases) {
  assert(`状态边界：${label}`,
    JSON.stringify(canonHrefs(htmlText)) === JSON.stringify(expectedCanon),
    JSON.stringify(canonHrefs(htmlText)), "adversarial");
}
{
  // EOF 处的不完整开始标签不是文本；不完整结束标签 `</` 按浏览器行为输出为文本。
  assert("状态边界：EOF 处不完整开始标签不并入可见文本",
    !parseHtml(`text <link rel="canonical" href="/a"`).text.includes("<link")
      && parseHtml(`text <link rel="canonical" href="/a"`).text.trim() === "text",
    JSON.stringify(parseHtml(`text <link rel="canonical" href="/a"`).text), "boundary");
  assert("状态边界：EOF 处的 </ 按文本输出",
    parseHtml(`abc</`).text.includes("</"),
    JSON.stringify(parseHtml(`abc</`).text), "boundary");
  // 浏览器输入预处理：CR/CRLF → LF；NUL → U+FFFD。
  const crTitle = parseHtml("<title>a\r\nb</title>").elements.find((el) => el.name === "title")?.content;
  assert("状态边界：CRLF 归一化为 LF（title 内容）", crTitle === "a\nb", JSON.stringify(crTitle), "unit");
  // legacy 命名实体（不带分号）：文本解码；属性里后接字母/等号时保留。
  const legacyText = parseHtml("<p>&AMP &frac34; &amp</p>").text;
  assert("字符引用：legacy 命名实体按浏览器规则解码", legacyText.includes("¾") && legacyText.includes("&"),
    JSON.stringify(legacyText), "unit");
  assert("字符引用：无分号命名实体在属性里后接字母/等号时保留",
    decodeCharacterReferences("&ampx", true) === "&ampx" && decodeCharacterReferences("&amp", true) === "&",
    JSON.stringify([decodeCharacterReferences("&ampx", true), decodeCharacterReferences("&amp", true)]), "unit");
}
{
  // 资源属性白名单：<div src/poster/srcset> 不会触发浏览器加载，不能成为待探测资源。
  const resourceCases = [
    [`<div src="/missing.png" poster="/p.png" srcset="/s.png 1x"></div>`, []],
    [`<video poster="/p.png"></video>`, ["video:poster=/p.png"]],
    [`<img src="/i.png" srcset="/a.png 1x,/b.png 2x">`, ["img:src=/i.png", "img:srcset=/a.png", "img:srcset=/b.png"]],
    [`<link rel="stylesheet" href="/app.css"><a href="/nav">x</a>`, ["link:href=/app.css"]],
    [`<image src="/alias.png">`, ["img:src=/alias.png"]],
    [`<input src="/not-image.png">`, []],
    [`<input type="image" src="/is-image.png">`, ["input:src=/is-image.png"]],
  ];
  for (const [htmlText, expected] of resourceCases) {
    const actual = resourceReferences(parseHtml(htmlText).elements).map((r) => `${r.element}:${r.attr}=${r.value}`);
    assert(`资源属性白名单：${htmlText.slice(0, 40)}`, JSON.stringify(actual) === JSON.stringify(expected), JSON.stringify(actual), "unit");
  }
}
{
  // breakout 开始标签（img）会退回 HTML：它真的会被浏览器加载，资源提取必须包含它。
  const breakoutHtml = `<svg><img src="/fake.svg"><link rel="canonical" href="/real"></svg>`;
  const breakoutFacts = {
    canonical: canonHrefs(breakoutHtml),
    imgs: parseHtml(breakoutHtml).elements.filter((el) => el.name === "img").length,
    resources: resourceReferences(parseHtml(breakoutHtml).elements).map((r) => r.value),
  };
  assert("命名空间：breakout img 退回 HTML 并进入资源引用",
    JSON.stringify(breakoutFacts.canonical) === JSON.stringify(["/real"])
      && breakoutFacts.imgs === 1 && breakoutFacts.resources.includes("/fake.svg"),
    JSON.stringify(breakoutFacts), "adversarial");
}
{
  // 未闭合外域不能在文档结束后造成泄漏（后续 HTML 仍要被识别）。
  const leakHtml = `<svg><foreignObject><svg><foreignObject><link rel="canonical" href="/fake"></foreignObject></svg></foreignObject></svg><link rel="canonical" href="/real">`;
  // 注意：嵌套 foreignObject 内部的 link 在浏览器里是 HTML 元素，所以 /fake 会被计数；
  // 这里只验证“关闭后”的 /real 被计数，以及不会出现额外的伪元素。
  assert("命名空间：嵌套外域关闭后恢复 HTML（集成点内部 link 按 HTML 处理）",
    JSON.stringify(canonHrefs(leakHtml)) === JSON.stringify(["/fake", "/real"]),
    JSON.stringify(canonHrefs(leakHtml)), "adversarial");
}

// 3c) HTML 自闭合语义（本轮）：HTML 命名空间只有 void 元素是真空元素；
// `<div/>`/`<span/>`/`<p/>` 的 self-closing flag 被浏览器忽略，必须保持打开。
// 期望值来自 tests/fixtures/html5-oracle.json 的 SC1-SC15 / I1-I7（Chrome/Edge 双引擎一致）。
// 判别用例：依赖 HTML 子元素栈的 SC1-SC5、I1-I3/I5-I7；其余条目为回归锁定。
const selfClosingCases = [
  ["HTML div 自闭合后仍打开，</div> 能弹掉 svg", `<div/><svg></div><link rel="canonical" href="/real">`, ["/real"]],
  ["集成点内 div 自闭合后 </foreignObject> 被忽略，后续 link 仍是 HTML", `<svg><foreignObject><div/></foreignObject><link rel="canonical" href="/real">`, ["/real"]],
  ["集成点内 div 自闭合后 link 在 div 内、后续第二个 link 也在", `<svg><foreignObject><div/><link rel="canonical" href="/in"></foreignObject><link rel="canonical" href="/after">`, ["/in", "/after"]],
  ["MathML 文本集成点内 span 自闭合后 </mtext> 被忽略", `<math><mtext><span/></mtext><link rel="canonical" href="/real">`, ["/real"]],
  ["集成点内 span 自闭合 + 嵌套 svg：fake 是 SVG 外域，真实 link 仍是 HTML", `<svg><foreignObject><span/></foreignObject><svg><link rel="canonical" href="/fake"></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["HTML p 自闭合 + div 自闭合", `<p/><div/><link rel="canonical" href="/real">`, ["/real"]],
  ["template 内的 HTML 自闭合 div 不泄漏到 template 之后", `<template><div/></template><link rel="canonical" href="/real">`, ["/real"]],
  ["foreignObject 内 template 里的自闭合 div 仍隔离", `<svg><foreignObject><template><div/></template><link rel="canonical" href="/real"></foreignObject></svg>`, ["/real"]],
  ["foreign 元素 g 自闭合生效（不吞后续 HTML）", `<svg><g/></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["foreign 元素 foreignObject 自闭合生效", `<svg><foreignObject/></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["MathML mtext 自闭合生效", `<math><mtext/></math><link rel="canonical" href="/real">`, ["/real"]],
  ["foreignObject 内嵌套 svg 自闭合生效", `<svg><foreignObject><svg/></foreignObject></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["mtext 内 svg 自闭合生效", `<math><mtext><svg/></mtext></math><link rel="canonical" href="/real">`, ["/real"]],
  ["外域里的 HTML 非空自闭合 breakout 元素仍按 HTML 插入", `<svg><div/></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["外域里的 a 是 SVG 元素，不能当 HTML 链接", `<svg><a/></svg><link rel="canonical" href="/real">`, ["/real"]],
  ["未引号属性值里的斜杠属于值，不是自闭合标记", `<link rel=canonical href=/a/><link rel="canonical" href="/real">`, ["/a/", "/real"]],
  ["集成点内错误结束标签不破坏 HTML 子元素栈", `<svg><foreignObject><span></strong></foreignObject><link rel="canonical" href="/canon">`, ["/canon"]],
  ["集成点内错误结束标签之后 script 仍是 HTML", `<svg><foreignObject><span></svg></foreignObject><script src="/a.js"></script>`, []],
  ["外域 template 的结束标签不关闭 HTML template 隔离", `<template><svg><template></template><link rel="canonical" href="/canon"></template>`, []],
  ["p 被块级开始标签隐式关闭后集成点退出", `<svg><foreignObject><p><div></div></foreignObject><link rel="canonical" href="/canon">`, []],
  ["p 隐式关闭后 script 是 SVG 外域", `<svg><foreignObject><p><div></div></foreignObject><script src="/a.js"></script>`, []],
];
for (const [label, htmlText, expected] of selfClosingCases) {
  assert(`自闭合语义：${label}`,
    JSON.stringify(canonHrefs(htmlText)) === JSON.stringify(expected),
    JSON.stringify(canonHrefs(htmlText)), "adversarial");
}
{
  // HTML 非空自闭合元素仍应出现在 elements/资源提取中，且不被当成 void。
  const divThenImg = `<div/><div><img src="/img.png"><link rel="canonical" href="/real"></div>`;
  const facts = {
    canonical: canonHrefs(divThenImg),
    imgs: parseHtml(divThenImg).elements.filter((el) => el.name === "img").length,
    resources: resourceReferences(parseHtml(divThenImg).elements).map((r) => r.value),
  };
  assert("自闭合语义：HTML 非空自闭合元素保持打开，内部 img 仍进入资源提取",
    JSON.stringify(facts.canonical) === JSON.stringify(["/real"]) && facts.imgs === 1 && facts.resources.includes("/img.png"),
    JSON.stringify(facts), "adversarial");
}
{
  // 集成点外域/错误结束标签/外域 template 的状态与资源（Chrome 对照 I1-I7）。
  const scriptCount = (htmlText) => parseHtml(htmlText).elements.filter((el) => el.name === "script").length;
  assert("集成点错误结束标签：span 仍打开，link 仍是 HTML canonical",
    JSON.stringify(canonHrefs(`<svg><foreignObject><span></strong></foreignObject><link rel="canonical" href="/canon">`)) === JSON.stringify(["/canon"])
      && scriptCount(`<svg><foreignObject><span></svg></foreignObject><script src="/a.js"></script>`) === 1,
    JSON.stringify({
      canonical: canonHrefs(`<svg><foreignObject><span></strong></foreignObject><link rel="canonical" href="/canon">`),
      scripts: scriptCount(`<svg><foreignObject><span></svg></foreignObject><script src="/a.js"></script>`),
    }), "adversarial");
  assert("外域 template 不关闭 HTML template 隔离",
    JSON.stringify(canonHrefs(`<template><svg><template></template><link rel="canonical" href="/canon"></template>`)) === JSON.stringify([])
      && resourceReferences(parseHtml(`<template><svg><template></template><link rel="preload" as="image" href="/p.png"></template>`).elements).length === 0,
    JSON.stringify({
      canonical: canonHrefs(`<template><svg><template></template><link rel="canonical" href="/canon"></template>`),
      resources: resourceReferences(parseHtml(`<template><svg><template></template><link rel="preload" as="image" href="/p.png"></template>`).elements),
    }), "adversarial");
  assert("p 被块级开始标签隐式关闭后集成点正确退出",
    JSON.stringify(canonHrefs(`<svg><foreignObject><p><div></div></foreignObject><link rel="canonical" href="/canon">`)) === JSON.stringify([])
      && scriptCount(`<svg><foreignObject><p><div></div></foreignObject><script src="/a.js"></script>`) === 0,
    JSON.stringify({
      canonical: canonHrefs(`<svg><foreignObject><p><div></div></foreignObject><link rel="canonical" href="/canon">`),
      scripts: scriptCount(`<svg><foreignObject><p><div></div></foreignObject><script src="/a.js"></script>`),
    }), "adversarial");
  assert("可见文本：外域/desc/title 集成点里的 < 不进入 HTML 可见文本",
    parseHtml(`<svg>1 < 2</svg>`).text.trim() === ""
      && parseHtml(`<svg><desc><`).text.trim() === ""
      && parseHtml(`<svg><title>a < b</title></svg>`).text.trim() === ""
      && parseHtml(`<template><svg><template></template>LEAK</template>`).text.trim() === "",
    JSON.stringify({
      svg: parseHtml(`<svg>1 < 2</svg>`).text,
      desc: parseHtml(`<svg><desc><`).text,
      title: parseHtml(`<svg><title>a < b</title></svg>`).text,
      template: parseHtml(`<template><svg><template></template>LEAK</template>`).text,
    }), "adversarial");
  // 浏览器在其上下文里会丢弃的开始标签不能污染 HTML 祖先栈。
  const droppedTags = ["tr", "td", "th", "thead", "tbody", "tfoot", "caption", "colgroup", "html", "head", "body", "frame", "basefont", "bgsound"];
  let droppedBad = 0;
  let droppedDetail = null;
  for (const dropped of droppedTags) {
    const htmlText = `<svg><foreignObject><${dropped}></foreignObject><link rel="canonical" href="/fake">`;
    const got = canonHrefs(htmlText);
    if (JSON.stringify(got) !== JSON.stringify([])) {
      droppedBad++;
      if (!droppedDetail) droppedDetail = { dropped, got };
    }
  }
  assert("集成点：浏览器丢弃的开始标签不污染 HTML 祖先栈", droppedBad === 0,
    JSON.stringify(droppedDetail || {}), "adversarial");
  // 外域结束标签回退 HTML 时必须在 scope 边界停止；caption/td/tr 等在 body 上下文
  // 本身被浏览器丢弃，不是边界（Chrome K9-K16 对照）。
  const scopeBoundaries = ["table", "object", "marquee", "applet", "select"];
  let scopeBoundaryBad = 0;
  let scopeBoundaryDetail = null;
  for (const boundary of scopeBoundaries) {
    const htmlText = `<div><${boundary}><svg></div><link rel="canonical" href="/fake">`;
    const got = canonHrefs(htmlText);
    if (JSON.stringify(got) !== JSON.stringify([])) {
      scopeBoundaryBad++;
      if (!scopeBoundaryDetail) scopeBoundaryDetail = { boundary, got };
    }
  }
  assert("外域结束标签：HTML 祖先回退在 scope 边界停止", scopeBoundaryBad === 0,
    JSON.stringify(scopeBoundaryDetail || {}), "adversarial");
  assert("外域结束标签：被丢弃的 caption/td/tr 不构成 scope 边界",
    JSON.stringify(canonHrefs(`<div><caption><svg></div><link rel="canonical" href="/fake">`)) === JSON.stringify(["/fake"])
      && JSON.stringify(canonHrefs(`<div><td><svg></div><link rel="canonical" href="/fake">`)) === JSON.stringify(["/fake"])
      && JSON.stringify(canonHrefs(`<div><tr><svg></div><link rel="canonical" href="/fake">`)) === JSON.stringify(["/fake"]),
    JSON.stringify({
      caption: canonHrefs(`<div><caption><svg></div><link rel="canonical" href="/fake">`),
      td: canonHrefs(`<div><td><svg></div><link rel="canonical" href="/fake">`),
      tr: canonHrefs(`<div><tr><svg></div><link rel="canonical" href="/fake">`),
    }), "adversarial");
  assert("外域结束标签：非 scope 边界 HTML 祖先仍可被弹出",
    JSON.stringify(canonHrefs(`<div><p><svg></div><link rel="canonical" href="/real">`)) === JSON.stringify(["/real"])
      && JSON.stringify(canonHrefs(`<div><span><svg></div><link rel="canonical" href="/real">`)) === JSON.stringify(["/real"]),
    JSON.stringify({
      p: canonHrefs(`<div><p><svg></div><link rel="canonical" href="/real">`),
      span: canonHrefs(`<div><span><svg></div><link rel="canonical" href="/real">`),
    }), "adversarial");
  assert("select 插入模式：嵌套 select / input 不会污染集成点栈",
    JSON.stringify(canonHrefs(`<svg><foreignObject><select><select></foreignObject><link rel="canonical" href="/real">`)) === JSON.stringify([])
      && JSON.stringify(canonHrefs(`<svg><foreignObject><select><input></foreignObject><link rel="canonical" href="/real">`)) === JSON.stringify([]),
    JSON.stringify({
      nestedSelect: canonHrefs(`<svg><foreignObject><select><select></foreignObject><link rel="canonical" href="/real">`),
      selectInput: canonHrefs(`<svg><foreignObject><select><input></foreignObject><link rel="canonical" href="/real">`),
    }), "adversarial");
  assert("可见文本：隐藏集成点内 xmp/textarea 不计入，foreignObject CDATA 计入",
    !parseHtml(`<svg><title><xmp>leak</xmp></title></svg><p>VISIBLE</p>`).text.includes("leak")
      && parseHtml(`<svg><title><xmp>leak</xmp></title></svg><p>VISIBLE</p>`).text.includes("VISIBLE")
      && parseHtml(`<svg><foreignObject><![CDATA[visible]]></foreignObject></svg><p>VISIBLE</p>`).text.includes("visible"),
    JSON.stringify({
      hiddenXmp: parseHtml(`<svg><title><xmp>leak</xmp></title></svg><p>VISIBLE</p>`).text,
      cdata: parseHtml(`<svg><foreignObject><![CDATA[visible]]></foreignObject></svg><p>VISIBLE</p>`).text,
    }), "adversarial");
}

// 3d) EOF 不完整标签：浏览器 tokenizer 在 EOF 时不会 emit 未完成开始标签，
// 因此不产生元素、也不把标签字符并入文本；`<`/`</` 单独出现则保留为文本。
// 期望值来自 EF1-EF12 / Chrome+Edge。
{
  const eofNoElement = [
    `text <link rel="canonical" href="/real"`,
    `text <link rel="canonical"`,
    `text <link rel='canonical' href='/real'`,
    `text <link rel=`,
    `text <link`,
    `<svg><foreignObject><link rel="canonical" href="/real"`,
  ];
  for (const htmlText of eofNoElement) {
    const parsed = parseHtml(htmlText);
    assert(`EOF：未完成开始标签不产生元素（${htmlText.slice(0, 28)}）`,
      parsed.elements.length === 0 && !parsed.text.includes("<link"),
      JSON.stringify({ elements: parsed.elements.map((el) => el.name), text: parsed.text }), "boundary");
  }
  {
    const completeNoHref = parseHtml(`text <link rel=canonical>`).elements.find((el) => el.name === "link");
    assert("EOF：完整但缺 href 的 canonical 仍是元素（href=null），与浏览器一致",
      Boolean(completeNoHref) && !getAttribute(completeNoHref, "href").present,
      JSON.stringify(completeNoHref), "boundary");
  }
  {
    const parsed = parseHtml(`<div>text</div`);
    assert("EOF：未完成结束标签被丢弃，元素与文本保留",
      JSON.stringify(parsed.elements.map((el) => el.name)) === JSON.stringify(["div"]) && parsed.text.trim() === "text",
      JSON.stringify({ elements: parsed.elements.map((el) => el.name), text: parsed.text }), "boundary");
  }
  {
    const title = parseHtml(`<title>Hi`).elements.find((el) => el.name === "title");
    const script = parseHtml(`<script>var a=1`).elements.find((el) => el.name === "script");
    assert("EOF：未闭合 title/script 元素的内容保留（EOF 不产生执行/结束标签）",
      title?.content === "Hi" && script?.content === "var a=1",
      JSON.stringify({ title: title?.content, script: script?.content }), "boundary");
  }
  {
    const a = parseHtml(`<a href='/x`).elements;
    const img = parseHtml(`<img src="/x"`).elements;
    assert("EOF：属性值/引号中途 EOF 不产生元素",
      a.length === 0 && img.length === 0,
      JSON.stringify({ a: a.map((el) => el.name), img: img.map((el) => el.name) }), "boundary");
  }
  {
    const parsed = parseHtml(`<div>text</`);
    assert("EOF：`</` 作为字面文本保留", parsed.text.includes("</"),
      JSON.stringify(parsed.text), "boundary");
    const angle = parseHtml(`<div>text<`);
    assert("EOF：单个 `<` 作为字面文本保留", angle.text.includes("text<"),
      JSON.stringify(angle.text), "boundary");
  }
  {
    const script = parseHtml(`<script>x</script`).elements.find((el) => el.name === "script");
    assert("EOF：script 内未闭合的 </script 成为 script 文本内容", script?.content === "x</script",
      JSON.stringify(script?.content), "boundary");
    const title = parseHtml(`<title>x</title`).elements.find((el) => el.name === "title");
    assert("EOF：RCDATA title 内未闭合的 </title 成为 title 内容", title?.content === "x</title",
      JSON.stringify(title?.content), "boundary");
  }
}
// 4) srcset：URL 可含逗号；候选由「URL + 空白 + descriptor + 逗号」切分。
const srcsetCases = [
  ["a.png 1x,b.png 2x", ["a.png", "b.png"]],
  ["a.png 1x, b.png 2x", ["a.png", "b.png"]],
  ["data:image/png;base64,AAA 1x, b.png 2x", ["data:image/png;base64,AAA", "b.png"]],
  ["data:image/svg+xml,%3Csvg%3E 1x, b.png 2x", ["data:image/svg+xml,%3Csvg%3E", "b.png"]],
  ["a.png", ["a.png"]],
  ["a.png, b.png,", ["a.png", "b.png"]],
  ["a.png 1x, b.png 2x, ", ["a.png", "b.png"]],
  ["a.png,b.png", ["a.png,b.png"]],
  [", , a.png 2x, ,", ["a.png"]],
  ["a.png 100w 50h, b.png 2x", ["a.png", "b.png"]],
  ["a.png 1.5x, b.png .5x", ["a.png", "b.png"]],
  ["a.png 0w, b.png 2x", ["b.png"]],
  ["a.png 50h, b.png 2x", ["b.png"]],
  ["a.png 1x 2x, b.png 2x", ["b.png"]],
  ["a.png 100w 1h, b.png 2x", ["a.png", "b.png"]],
  ["a.png 1w 2x, b.png 2x", ["b.png"]],
  ["a.png 1x 1h, b.png 2x", ["b.png"]],
  ["a.png 1x b.png 2x", []],
  ["a.png 2q", []],
  ["a.png -1x", []],
  ["a.png, 2x", ["a.png", "2x"]],
  ["a.png 100w, 200w", ["a.png", "200w"]],
  ["a.png,", ["a.png"]],
  ["a.png 1.5w", []],
  ["a.png 1.0w", []],
  ["a.png 1.5x, b.png .5x", ["a.png", "b.png"]],
  ["a.png 1X", []],
  ["a.png 2W", []],
  ["a.png 1e2x", ["a.png"]],
  ["a.png 1E2x", ["a.png"]],
  ["a.png 1e+2x", ["a.png"]],
  ["a.png 1e-2x", ["a.png"]],
  ["a.png -0x", ["a.png"]],
  ["a.png (x, 1x), b.png", ["b.png"]],
];
for (const [value, expected] of srcsetCases) {
  assert(`srcset：${JSON.stringify(value)}`,
    JSON.stringify(parseSrcset(value)) === JSON.stringify(expected),
    JSON.stringify(parseSrcset(value)), "unit");
}

// 5) 真实浏览器差分：31 个用例的 DOM facts 与本地 tokenizer 逐项比较。
const oracleFixture = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "html5-oracle.json"), "utf8"));
const html5LocalFacts = (htmlText) => {
  const parsed = parseHtml(htmlText);
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
};
const normalizeOracleScripts = (scripts) => scripts.map((s) => (s.text !== undefined
  ? { len: s.len, text: s.text }
  : { len: s.len, containsLink: s.containsLink }));
let oracleBad = 0;
for (const oracleCase of oracleFixture.cases) {
  const actual = html5LocalFacts(oracleCase.html);
  const expected = {
    canonical: oracleCase.expect.canonical,
    htmlTitles: oracleCase.expect.htmlTitles,
    scripts: normalizeOracleScripts(oracleCase.expect.scripts),
    htmlCounts: oracleCase.expect.htmlCounts,
  };
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) oracleBad++;
  assert(`HTML5 浏览器 oracle：${oracleCase.id}`, ok,
    JSON.stringify({ expected, actual, html: oracleCase.html }), "adversarial");
}
assert("HTML5 浏览器 oracle：fixture 用例数不少于 115 且结构完整",
  oracleFixture.cases.length >= 115 && /Chrome|Edge|Chromium/i.test(oracleFixture._browser || "")
    && typeof oracleFixture._provenance === "string" && oracleFixture._provenance.length > 80
    && typeof oracleFixture._recordedAt === "string" && oracleFixture._schema === 1
    && typeof oracleFixture._doctypePrefixRule === "string" && /Edge/i.test(oracleFixture._edgeBrowser || "")
    && new Set(oracleFixture.cases.map((c) => c.id)).size === oracleFixture.cases.length
    && new Set(oracleFixture.cases.map((c) => c.html)).size === oracleFixture.cases.length
    && oracleFixture.cases.every((c) => typeof c.id === "string" && typeof c.html === "string"
      && typeof c.wrappedDoctype === "boolean" && c.expect
      && Array.isArray(c.expect.canonical) && Array.isArray(c.expect.htmlTitles)
      && Array.isArray(c.expect.scripts) && c.expect.htmlCounts
      && Number.isInteger(c.expect.htmlCounts.img) && Number.isInteger(c.expect.htmlCounts.base)),
  `${oracleFixture.cases.length} cases / ${oracleFixture._browser}`, "unit");

// 6) 组合：四类问题同时出现时互不干扰。
{
  const combo = `<script><!--<script></script><link rel="canonical" href="/fake-script">--></script>`
    + `<!DOCTYPE html PUBLIC "<link rel='canonical' href='/fake-doctype'>">`
    + `<svg><foreignObject></svg><svg><link rel="canonical" href="/fake-svg"></svg></svg>`
    + `<link rel="canonical" href="/real">`;
  assert("组合：script + DOCTYPE + SVG 状态泄漏 + 伪 canonical 同时出现",
    JSON.stringify(canonHrefs(combo)) === JSON.stringify(["/real"]),
    JSON.stringify(canonHrefs(combo)), "adversarial");
  const comboIntegration = `<script><!--<script>--></script><svg><title><link rel='canonical' href='/t'></title></svg><math><mtext><link rel='canonical' href='/m'></mtext></math><link rel='canonical' href='/real'>`;
  assert("组合：script 关闭 + 集成点 HTML link + 真实 link 全部识别",
    JSON.stringify(canonHrefs(comboIntegration)) === JSON.stringify(["/t", "/m", "/real"]),
    JSON.stringify(canonHrefs(comboIntegration)), "adversarial");
}

// 7) 随机组合：伪 canonical 出现在各状态里不能被识别；集成点里的必须被识别。
{
  let comboBad = 0;
  let comboDetail = null;
  for (let n = 0; n < 300; n++) {
    const real = `<link rel="canonical" href="/real-${n}">`;
    const fake = `<link rel="canonical" href="/fake-${n}">`;
    const hiddenContexts = [
      `<!-- ${fake} -->`,
      `<template>${fake}</template>`,
      `<svg>${fake}</svg>`,
      `<svg><svg>${fake}</svg></svg>`,
      `<script>${fake}</script>`,
      `<script><!--${fake}--></script>`,
      `<script><!--<script>${fake}--></script>`,
      `<!DOCTYPE html PUBLIC "${fake}">`,
      `<!DOCTYPE html SYSTEM "${fake}">`,
      `<style>${fake}</style>`,
      `<textarea>${fake}</textarea>`,
      `<title>${fake}</title>`,
      `<noscript>${fake}</noscript>`,
    ];
    const integrationContexts = [
      [`<svg><foreignObject>${fake}</foreignObject></svg>`, ["/fake-" + n]],
      [`<svg><title>${fake}</title></svg>`, ["/fake-" + n]],
      [`<svg><desc>${fake}</desc></svg>`, ["/fake-" + n]],
      [`<math><mtext>${fake}</mtext></math>`, ["/fake-" + n]],
      [`<math><mi>${fake}</mi></math>`, ["/fake-" + n]],
    ];
    const pick = n % (hiddenContexts.length + integrationContexts.length);
    let htmlText;
    let expected = ["/real-" + n];
    if (pick < hiddenContexts.length) {
      htmlText = `${hiddenContexts[pick]}${real}`;
    } else {
      const [context, fakeExpected] = integrationContexts[pick - hiddenContexts.length];
      htmlText = `${context}${real}`;
      expected = [...fakeExpected, "/real-" + n];
    }
    const got = canonHrefs(htmlText);
    if (JSON.stringify(got) !== JSON.stringify(expected)) {
      comboBad++;
      if (!comboDetail) comboDetail = { html: htmlText, expected, got };
    }
  }
  assert("HTML5 状态随机组合：隐藏上下文与集成点 300 组", comboBad === 0,
    JSON.stringify(comboDetail || {}), "adversarial");
}

// 确定性伪随机组合：真实标签必须识别，任意上下文里的伪标签必须不识别。
let rngState = 0x2f6e2b1;
const rand = () => ((rngState = (rngState * 1103515245 + 12345) >>> 0) / 0x100000000);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const rawtextTags = ["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript"];
const rcdataTags = ["textarea", "title"];
let fuzzBad = 0;
for (let n = 0; n < 300; n++) {
  const href = pick(["/a", "b.html", "/p/q", "#frag", "/x?q=1"]);
  const quote = pick(["\"", "'", ""]);
  const real = `<link rel="canonical" href=${quote}${href}${quote}>`;
  const fake = `<link rel="canonical" href="/fake-${n}">`;
  const ctx = pick([
    "comment", "template", "attr-value",
    ...rawtextTags.map((t) => `raw:${t}`),
    ...rcdataTags.map((t) => `rc:${t}`),
  ]);
  let htmlText;
  if (ctx === "comment") htmlText = `<!-- ${fake} -->${real}`;
  else if (ctx === "template") htmlText = `<template>${fake}</template>${real}`;
  else if (ctx === "attr-value") htmlText = `<div data-html="${fake}"></div>${real}`;
  else if (ctx.startsWith("raw:")) { const t = ctx.slice(4); htmlText = `<${t}>${fake}</${t}>${real}`; }
  else { const t = ctx.slice(3); htmlText = `<${t}>${fake}</${t}>${real}`; }
  const links = canonElements(htmlText);
  if (links.length !== 1 || getAttribute(links[0], "href").value !== href) fuzzBad++;
}
assert("HTML tokenizer：300 组随机上下文组合只识别真实标签", fuzzBad === 0, `bad=${fuzzBad}`, "adversarial");

// 畸形/超大输入必须线性结束、不抛异常（简化的 DoS 回归）
const malformedBig = "</>".repeat(5000) + "<div></div>".repeat(1000) + "<link rel='canonical' href='/a'>";
const startedAt = Date.now();
const malformedResult = parseHtml(malformedBig);
assert("HTML tokenizer：大量畸形/重复片段后仍能解析出真实标签且不超时",
  malformedResult.elements.some((el) => el.name === "link" && relTokens(el).includes("canonical")) && Date.now() - startedAt < 2000,
  `ms=${Date.now() - startedAt}`, "adversarial");

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
const layers = {};
for (const r of results) layers[r.layer] = (layers[r.layer] || 0) + 1;
const layerLine = `分层覆盖：${Object.entries(layers).map(([k, v]) => `${k}=${v}`).join("，")}`;
const passed = results.length - failed.length;

const fileSha16 = (filePath) => {
  try { return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").slice(0, 16); } catch { return "n/a"; }
};
const fixturePath = path.join(here, "fixtures", "html5-oracle.json");
const fixtureCaseCount = (() => {
  try { return JSON.parse(fs.readFileSync(fixturePath, "utf8")).cases.length; } catch { return 0; }
})();

// 自动化维护 tests/last-run.txt：报告不再依赖人工复制终端输出，也不会出现
// 「文档说这是最近一次结果、文件却停留在旧版本」的漂移。
// 头部带 run-tests.mjs / oracle fixture 的 hash 与用例数，便于判断 last-run 是否过期。
const lastRunText = [
  `# 本文件由 node tests/run-tests.mjs 自动生成，请勿手工编辑`,
  `# ${new Date().toISOString()} / node ${process.version} / ${process.platform}`,
  `# run-tests.mjs sha256:${fileSha16(fileURLToPath(import.meta.url))} / html5-oracle.json sha256:${fileSha16(fixturePath)} (${fixtureCaseCount} cases)`,
  ...results.map((r) => {
    const detail = String(r.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    return `${r.ok ? "通过" : "失败"}  ${r.name}${detail ? ` — ${detail}` : ""}`.trimEnd();
  }),
  "",
  layerLine,
  `${passed}/${results.length} 通过`,
].join("\n");
try {
  fs.writeFileSync(path.join(here, "last-run.txt"), `${lastRunText}\n`, "utf8");
} catch {
  // 写报告失败不能影响测试结论本身。
}

console.log(`\n${layerLine}`);
console.log(`\n${passed}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：");
  failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
  process.exit(1);
}
