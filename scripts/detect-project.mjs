#!/usr/bin/env node
/**
 * detect-project.mjs — 只读识别项目，供 Cloudflare 部署使用。
 *
 * 用法：
 *   node scripts/detect-project.mjs [项目目录] [--human]
 *
 * 默认输出 JSON（字段名稳定，带 schemaVersion）；--human 输出摘要。
 * 不写项目文件、不安装依赖、不访问网络。
 *
 * 输出分三层：
 *   project / github / cloudflare / runtime  实际读到的值
 *   evidence                                 每个关键字段的来源与可信度（confirmed / inferred / unknown）
 *   target                                   候选产品，不是最终决定
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { stripJsComments, stripHashComments, parseJsonc, tomlField, tomlHasKey, jsTopLevelValue } from "./config-scan.mjs";

const SCHEMA_VERSION = 2;
const argv = process.argv.slice(2);
const human = argv.includes("--human");
const rootArg = argv.find((a) => !a.startsWith("--"));
const root = path.resolve(rootArg || process.cwd());

const read = (p) => {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const exists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
const readJson = (p) => {
  const s = read(p);
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};
const listDir = (p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
};
const firstExisting = (names) => names.find((n) => exists(path.join(root, n))) || null;
const relToRoot = (f) => path.relative(root, f).replace(/\\/g, "/");
const ev = (value, confidence, source) => ({ value: value ?? null, confidence, source });

if (!exists(root) || !fs.statSync(root).isDirectory()) {
  console.error(`不是目录： ${root}`);
  process.exit(2);
}

function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

const BUILD_NOISE = ["node_modules", ".git", "dist", "dist-web", "out", "build", "_site", "public", ".next", ".output", "vendor", "coverage"];
// HTML 入口发现不能跳过 public/：纯静态站可能只有 public/index.html（Workers assets）。
const HTML_NOISE = BUILD_NOISE.filter((name) => name !== "public");
function walkFiles(dir, maxDepth = 3, acc = [], depth = 0, skipNames = BUILD_NOISE) {
  if (depth > maxDepth) return acc;
  for (const ent of listDir(dir)) {
    if (skipNames.includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, maxDepth, acc, depth + 1, skipNames);
    else acc.push(full);
  }
  return acc;
}

const pkgPath = firstExisting(["package.json"]);
const pkg = pkgPath ? readJson(path.join(root, pkgPath)) || {} : {};
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const scripts = pkg.scripts || {};
const hasDep = (name) => Object.prototype.hasOwnProperty.call(deps, name);

// 配置文件按语言剥离注释后再做字段提取：注释掉的 base/outDir/adapter 不能生效。
const configTextRaw = (names) => {
  for (const n of names) {
    const s = read(path.join(root, n));
    if (s) return s;
  }
  return "";
};
const configText = (names) => stripJsComments(configTextRaw(names));
const viteConfig = configText(["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]);
const nextConfig = configText(["next.config.js", "next.config.mjs", "next.config.ts"]);
const astroConfig = configText(["astro.config.mjs", "astro.config.ts", "astro.config.js"]);
const svelteConfig = configText(["svelte.config.js"]);
const nuxtConfig = configText(["nuxt.config.ts", "nuxt.config.js", "nuxt.config.mjs"]);

const hasIndexHtml = exists(path.join(root, "index.html"));
const jekyllConfig = exists(path.join(root, "_config.yml"));
const gemfile = read(path.join(root, "Gemfile")) || "";
const hasJekyll = jekyllConfig && (/jekyll/i.test(gemfile) || exists(path.join(root, "_layouts")));
const hasHugo = ["hugo.toml", "hugo.yaml", "hugo.json", "config.toml"].some((f) => exists(path.join(root, f))) &&
  (exists(path.join(root, "archetypes")) || exists(path.join(root, "content")) || exists(path.join(root, "layouts")));
const hasMkDocs = exists(path.join(root, "mkdocs.yml"));

let framework = "unknown";
let kind = "unknown";
let frameworkSource = "没有匹配到已知框架";

if (hasDep("next")) { framework = "nextjs"; kind = /output\s*:\s*["']export["']/.test(nextConfig) ? "static" : "ssr"; frameworkSource = "package.json 依赖 next"; }
else if (hasDep("nuxt") || hasDep("nuxt3")) {
  framework = "nuxt";
  // `ssr: false` 只在配置对象顶层生效（routeRules 里的 ssr:false 是按路由 CSR）；
  // build 用 nuxt/nuxi generate 或 nitro preset=static 也是静态产物。
  const nuxtSsr = jsTopLevelValue(nuxtConfig, "ssr");
  const nuxtGenerate = /\b(?:nuxt|nuxi)\s+generate\b/.test(scripts.build || "")
    || /preset\s*:\s*["']static["']/.test(nuxtConfig);
  kind = nuxtSsr === "false" || nuxtGenerate ? "static" : "ssr";
  frameworkSource = "package.json 依赖 nuxt";
}
else if (hasDep("@sveltejs/kit")) { framework = "sveltekit"; kind = /adapter-static/.test(svelteConfig) || hasDep("@sveltejs/adapter-static") ? "static" : "ssr"; frameworkSource = "package.json 依赖 @sveltejs/kit"; }
else if (hasDep("astro")) { framework = "astro"; kind = /adapter/.test(astroConfig) ? "ssr" : "static"; frameworkSource = "package.json 依赖 astro"; }
else if (hasDep("@remix-run/react") || hasDep("@remix-run/node")) { framework = "remix"; kind = "ssr"; frameworkSource = "package.json 依赖 @remix-run"; }
else if (hasDep("gatsby")) { framework = "gatsby"; kind = "static"; frameworkSource = "package.json 依赖 gatsby"; }
else if (hasDep("@docusaurus/core")) { framework = "docusaurus"; kind = "static"; frameworkSource = "package.json 依赖 @docusaurus/core"; }
else if (hasDep("vitepress")) { framework = "vitepress"; kind = "static"; frameworkSource = "package.json 依赖 vitepress"; }
else if (hasDep("vite")) { framework = "vite"; kind = hasIndexHtml ? "spa" : "library"; frameworkSource = "package.json 依赖 vite"; }
else if (hasDep("react-scripts")) { framework = "cra"; kind = "spa"; frameworkSource = "package.json 依赖 react-scripts"; }
else if (hasDep("vue") && hasIndexHtml) { framework = "vue"; kind = "spa"; frameworkSource = "package.json 依赖 vue + 根目录 index.html"; }
else if (hasDep("express") || hasDep("koa") || hasDep("fastify") || hasDep("@nestjs/core") || hasDep("hono")) {
  framework = hasDep("hono") ? "hono" : hasDep("@nestjs/core") ? "nestjs" : hasDep("express") ? "express" : hasDep("koa") ? "koa" : "fastify";
  kind = hasIndexHtml ? "fullstack" : "api";
  frameworkSource = `package.json 依赖 ${framework}`;
}
else if (hasJekyll) { framework = "jekyll"; kind = "static"; frameworkSource = "_config.yml + Gemfile/_layouts"; }
else if (hasHugo) { framework = "hugo"; kind = "static"; frameworkSource = "hugo 配置 + content/layouts"; }
else if (hasMkDocs) { framework = "mkdocs"; kind = "static"; frameworkSource = "mkdocs.yml"; }
else if (hasIndexHtml) { framework = "static-html"; kind = "static"; frameworkSource = "根目录 index.html（无框架依赖）"; }

const htmlIndexes = walkFiles(root, 3, [], 0, HTML_NOISE).filter((f) => /[\\/]index\.html$/i.test(f));
let htmlRoot = null;
if (framework === "unknown" && htmlIndexes.length === 1) {
  framework = "static-html";
  kind = "static";
  htmlRoot = path.relative(root, path.dirname(htmlIndexes[0])) || ".";
  frameworkSource = `唯一的 index.html：${relToRoot(htmlIndexes[0])}`;
}
const htmlEntries = htmlIndexes.slice(0, 20).map(relToRoot);

// 锁文件：多个同时存在时，包管理器只能推断，不能确认。
const LOCKFILES = ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json", "npm-shrinkwrap.json"];
const lockfiles = LOCKFILES.filter((n) => exists(path.join(root, n)));
const manager = lockfiles.includes("pnpm-lock.yaml") ? "pnpm"
  : lockfiles.includes("yarn.lock") ? "yarn"
  : lockfiles.includes("bun.lockb") || lockfiles.includes("bun.lock") ? "bun"
  : lockfiles.includes("package-lock.json") || lockfiles.includes("npm-shrinkwrap.json") ? "npm"
  : pkgPath ? "npm" : null;

const defaultBuild = {
  nextjs: "next build",
  nuxt: "nuxt build",
  sveltekit: "vite build",
  astro: "astro build",
  remix: "remix vite:build",
  gatsby: "gatsby build",
  docusaurus: "docusaurus build",
  vitepress: "vitepress build",
  vite: "vite build",
  cra: "react-scripts build",
  vue: "vite build",
  jekyll: "bundle exec jekyll build",
  hugo: "hugo",
  mkdocs: "mkdocs build",
  hono: null,
  express: null,
  koa: null,
  fastify: null,
  nestjs: null,
  "static-html": null,
};

const defaultOut = {
  nextjs: kind === "static" ? "out" : ".next",
  nuxt: ".output/public",
  sveltekit: kind === "static" ? "build" : ".svelte-kit",
  astro: "dist",
  remix: "build/client",
  gatsby: "public",
  docusaurus: "build",
  vitepress: ".vitepress/dist",
  vite: "dist",
  cra: "build",
  vue: "dist",
  jekyll: "_site",
  hugo: "public",
  mkdocs: "site",
  "static-html": ".",
};

const viteOutCandidates = [...new Set([...viteConfig.matchAll(/outDir\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]))];
const viteBaseExtracted = viteConfig.match(/\bbase\s*:\s*["']([^"']+)["']/)?.[1] || null;
const nextBasePath = nextConfig.match(/basePath\s*:\s*["']([^"']+)["']/)?.[1] || null;
const dynamicConfig = /defineConfig\s*\(\s*(?:async\s*)?(?:\(\s*[^)]*\)\s*=>|function)/.test(viteConfig) ||
  /\bloadEnv\s*\(/.test(viteConfig);
// 条件表达式里的 outDir 不能被当成本次构建的确定产物目录。
const conditionalOutDir = /\?[^\n]*outDir\s*:|\boutDir\s*:[^\n]*\?/.test(viteConfig);
const buildScriptNames = Object.keys(scripts).filter((name) => name === "build" || name.startsWith("build:") || name.startsWith("build-"));
const multipleBuildScripts = buildScriptNames.length > 1;
const primaryBuildScript = scripts.build ? "build" : buildScriptNames[0] || null;
const ambiguousViteOutput = dynamicConfig || conditionalOutDir || viteOutCandidates.length > 1;
// 只有唯一、静态的 outDir 才能当作 confirmed；动态/条件配置只保留候选。
const viteOut = ambiguousViteOutput ? null : viteOutCandidates[0] || null;
// 动态配置里的 base 仍可作为候选，但不能标 confirmed。
const viteBase = viteBaseExtracted;
const buildCommand = primaryBuildScript ? `${manager || "npm"} run ${primaryBuildScript}` : defaultBuild[framework] || null;

const scriptSuffix = primaryBuildScript?.includes(":") ? primaryBuildScript.split(":").slice(1).join(":").toLowerCase() : "";
const pairedOutDir = ambiguousViteOutput
  ? (scriptSuffix ? viteOutCandidates.find((dir) => dir.toLowerCase().includes(scriptSuffix)) : null)
  : null;
// 无法唯一配对时：有 build:web 且 outDir 含 web 就用配对；否则退回框架默认（如 Vite 的 dist）。
// 不能把条件分支里的 dist-web 直接配给 npm run build。
const outputDir = viteOut || htmlRoot || pairedOutDir || defaultOut[framework] || null;
const buildOutputAmbiguous = Boolean(ambiguousViteOutput && !viteOut);

const ghWorkflowDir = path.join(root, ".github", "workflows");
const ghWorkflows = listDir(ghWorkflowDir)
  .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
  .map((e) => {
    // YAML 注释里的 action 不能算数。
    const text = stripHashComments(read(path.join(ghWorkflowDir, e.name)) || "");
    return {
      file: `.github/workflows/${e.name}`,
      pages: /deploy-pages|upload-pages-artifact|actions\/configure-pages/.test(text),
      cloudflare: /wrangler|cloudflare\/pages-action|cloudflare\/wrangler-action/.test(text),
      schedule: /^\s*schedule\s*:/m.test(text),
      pullRequestTarget: /pull_request_target/.test(text),
    };
  });

const cnameFile = firstExisting(["CNAME", "docs/CNAME", "public/CNAME", "static/CNAME"]);
const cname = cnameFile ? (read(path.join(root, cnameFile)) || "").trim().split(/\r?\n/)[0] : null;

const gitRemote = git(["config", "--get", "remote.origin.url"]);
const gitBranch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
const gitTop = git(["rev-parse", "--show-toplevel"]);
const gitDirty = git(["status", "--porcelain"]);
const repoName = gitRemote ? gitRemote.replace(/\.git$/, "").split(/[/:]/).pop() : null;

const wranglerFile = firstExisting(["wrangler.jsonc", "wrangler.json", "wrangler.toml"]);
const wranglerRaw = wranglerFile ? read(path.join(root, wranglerFile)) || "" : "";
const wranglerIsToml = wranglerFile ? /\.toml$/i.test(wranglerFile) : false;
// 先剥离注释：注释掉的 `# main = "x"` / `// "directory": "./legacy"` 不能生效。
// TOML 用 # 注释，JSONC 用 // 和 /* */；JSON 由 parseJsonc 结构化读取。
const wranglerText = wranglerIsToml ? stripHashComments(wranglerRaw) : stripJsComments(wranglerRaw);
const wranglerJson = wranglerFile && !wranglerIsToml ? parseJsonc(wranglerRaw) : null;
// 无法结构化解析（JSONC 语法错误 / 未知写法）时的兜底：在已剥离注释的文本里按字段取。
const wranglerField = (key) => {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = wranglerText.match(new RegExp(`(?:^|[\\s,{"'])["']?${esc}["']?\\s*[:=]\\s*["']([^"']+)["']`, "m"));
  return m ? m[1] : null;
};
const wranglerJsonString = (key) => {
  const v = wranglerJson && typeof wranglerJson === "object" ? wranglerJson[key] : null;
  return typeof v === "string" ? v : null;
};
const assetsDirectory = (() => {
  const nested = wranglerJson && typeof wranglerJson.assets === "object" && wranglerJson.assets
    ? wranglerJson.assets.directory
    : null;
  if (typeof nested === "string") return nested;
  if (wranglerIsToml) return tomlField(wranglerRaw, "directory", "assets");
  return wranglerField("directory");
})();
const wrangler = wranglerFile ? {
  file: wranglerFile,
  name: wranglerJsonString("name") ?? (wranglerIsToml ? tomlField(wranglerRaw, "name") : wranglerField("name")),
  pagesBuildOutputDir: wranglerJsonString("pages_build_output_dir") ?? (wranglerIsToml ? tomlField(wranglerRaw, "pages_build_output_dir") : wranglerField("pages_build_output_dir")),
  assetsDirectory,
  compatibilityDate: wranglerJsonString("compatibility_date") ?? (wranglerIsToml ? tomlField(wranglerRaw, "compatibility_date") : wranglerField("compatibility_date")),
  hasMain: Boolean(wranglerJsonString("main")) || (wranglerIsToml ? tomlHasKey(wranglerRaw, "main") : Boolean(wranglerField("main"))),
  bindings: {
    d1: /d1_databases/.test(wranglerText),
    kv: /kv_namespaces/.test(wranglerText),
    r2: /r2_buckets/.test(wranglerText),
    durableObjects: /durable_objects/.test(wranglerText),
    queues: /queues/.test(wranglerText),
    hyperdrive: /hyperdrive/.test(wranglerText),
  },
} : null;

// 显式 wrangler 配置是部署产物的最强证据：优先于框架默认值，避免值来自配置、
// 证据来源却写成框架默认（或反过来）的自相矛盾。
const wranglerOutputDir = wrangler?.pagesBuildOutputDir || wrangler?.assetsDirectory || null;
const resolvedOutputDir = wranglerOutputDir || outputDir || null;

const isNoisePath = (f) => relToRoot(f).split("/").some((part) => ["node_modules", "tests", "test", "scripts", "docs", ".github", ".wrangler", "dist", "dist-web", "out", "build", "_site", "coverage"].includes(part));
const srcFiles = walkFiles(path.join(root, "src"), 6, [], 1)
  .filter((f) => !isNoisePath(f))
  .concat(walkFiles(root, 3, [], 1).filter((f) => /\.(m?[jt]sx?)$/.test(f) && !isNoisePath(f)))
  .slice(0, 400);
const sourceText = srcFiles.map((f) => read(f) || "").join("\n").slice(0, 400000);
// 路由类型只用于决定验收/部署模式：HashRouter 的未知路径可以 404（static），
// BrowserRouter/history 路由需要 SPA fallback（spa）。这里剥离注释和字符串，
// 避免注释/文案里的路由名误导；输出 unknown/mixed 时要求人工确认。
const routerSourceText = srcFiles
  .filter((f) => {
    const rel = relToRoot(f);
    return !/(?:^|\/)(?:__tests__|e2e|tests?)\//i.test(rel)
      && !/\.(?:test|spec|stories)\.[^.]+$/i.test(rel);
  })
  .map((f) => stripJsComments(read(f) || "")).join("\n").slice(0, 400000);
const routerInlineScripts = htmlIndexes.slice(0, 3).map((f) => read(f) || "").join("\n").slice(0, 100000);
const routerScanText = `${routerSourceText}\n${routerInlineScripts}`;
const routerCode = routerScanText
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '""')
  .replace(/"(?:\\[\s\S]|[^"\\])*"/g, '""')
  .replace(/'(?:\\[\s\S]|[^'\\])*'/g, '""');
const hashRouterSignal = /\bHashRouter\b|\bcreateHashRouter\b|\bcreateWebHashHistory\s*\(|\bcreateHashHistory\s*\(|\buseHashLocation\b|\bwithHashLocation\s*\(|\bHashLocationStrategy\b|\buseHash\s*:\s*true\b/.test(routerCode);
const historyRouterSignal = /\bBrowserRouter\b|\bcreateBrowserRouter\b|\bcreateWebHistory\s*\(|\bcreateBrowserHistory\s*\(/.test(routerCode);
// Vue Router 3 的 mode 是字符串配置；只在确实依赖 vue-router 时读取，避免普通
// 配置字符串被误当成路由模式。
const vueModeHashSignal = hasDep("vue-router") && /\bmode\s*:\s*["']hash["']/i.test(routerSourceText);
const vueModeHistorySignal = hasDep("vue-router") && /\bmode\s*:\s*["']history["']/i.test(routerSourceText);
const hashSignal = hashRouterSignal || vueModeHashSignal;
const historySignal = historyRouterSignal || vueModeHistorySignal;
const routerDeps = ["react-router", "react-router-dom", "vue-router", "@angular/router", "wouter", "@tanstack/react-router", "history"].filter((d) => hasDep(d));
const vueRouterVersion = routerDeps.includes("vue-router") ? String(deps["vue-router"] || "") : "";
const vueRouterV3DefaultHash = /^[~^=v\s]*3(?:\.|$)/.test(vueRouterVersion)
  && !historySignal && !vueModeHashSignal && !vueModeHistorySignal;
const routerContext = kind === "spa"
  || ((kind === "static" || kind === "static-html" || kind === "unknown") && routerDeps.length > 0);
const spaRouting = !routerContext ? null
  : hashSignal && historySignal ? "mixed"
  : hashSignal ? "hash"
  : historySignal ? "history"
  : vueRouterV3DefaultHash ? "hash"
  : "unknown";
const nativeRisk = ["sharp", "canvas", "puppeteer", "playwright", "bcrypt", "argon2"]
  .filter((n) => hasDep(n));
const fsUsage = /\bfrom\s+["'](?:node:)?fs["']|require\(\s*["'](?:node:)?fs["']\s*\)/.test(sourceText);
const longRunning = /setInterval\s*\(|while\s*\(\s*true\s*\)|createServer\s*\(/.test(sourceText);

// 运行时兼容性：只标注「需要核对」的依赖，不在这里下「能/不能跑」的结论。
const runtimeDeps = [
  { dep: "prisma", note: "需要 driver adapter；Prisma 7 的查询编译器是 WASM，打包链路可能把预编译模块变成运行时编译" },
  { dep: "@prisma/client", note: "同 prisma，见 references/runtime-compat.md" },
  { dep: "drizzle-orm", note: "确认驱动类型：neon-http 不支持交互式事务，需要事务时用 neon-serverless/WebSocket" },
  { dep: "@neondatabase/serverless", note: "HTTP 驱动不支持交互式事务" },
  { dep: "pg", note: "需要 nodejs_compat 或 Hyperdrive；连接数受限，不适合高频短查询" },
  { dep: "mysql2", note: "需要 nodejs_compat/Hyperdrive，并确认驱动不依赖原生扩展" },
  { dep: "typeorm", note: "依赖反射和驱动兼容性，部署前先验证" },
  { dep: "sequelize", note: "依赖 Node 驱动和部分内置模块，部署前先验证" },
].filter((d) => hasDep(d.dep));
const sqliteNative = ["better-sqlite3", "sqlite3"].filter((n) => hasDep(n));
const neonHttp = hasDep("@neondatabase/serverless") && /drizzle-orm\/neon-http|neon-http/.test(sourceText);

const envFiles = listDir(root)
  .filter((e) => e.isFile() && /^\.env(\.|$)/.test(e.name))
  .map((e) => e.name);
const envExample = listDir(root)
  .filter((e) => e.isFile() && /^\.env\.(example|sample|template)$/.test(e.name))
  .map((e) => e.name);
const envKeys = envExample.length
  ? (read(path.join(root, envExample[0])) || "").split(/\r?\n/)
      .map((l) => l.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1])
      .filter(Boolean)
  : [];

const monorepo = exists(path.join(root, "pnpm-workspace.yaml")) || Boolean(pkg.workspaces) ||
  exists(path.join(root, "turbo.json")) || exists(path.join(root, "lerna.json")) || exists(path.join(root, "nx.json"));

// monorepo 里真正可部署的子应用；只看一层，不猜更深的结构。
const workspaces = [];
if (monorepo) {
  for (const group of ["apps", "packages", "services"]) {
    for (const ent of listDir(path.join(root, group))) {
      if (!ent.isDirectory()) continue;
      const pj = path.join(root, group, ent.name, "package.json");
      if (!exists(pj)) continue;
      const j = readJson(pj) || {};
      workspaces.push({
        path: `${group}/${ent.name}`,
        name: j.name || ent.name,
        hasBuild: Boolean(j.scripts?.build),
      });
    }
  }
}

const startScript = scripts.start || "";
// 从启动命令里取真实入口：跳过 node/tsx 及其参数（含带值的 -r/--require 等）。
function extractNodeEntry(command) {
  const tokens = String(command || "").trim().split(/\s+/).filter(Boolean);
  const runner = tokens.findIndex((t) => /^(?:node|tsx|ts-node|bun)$/.test(t));
  if (runner < 0) return null;
  const takesValue = new Set(["-r", "--require", "--loader", "--experimental-loader", "--import", "--env-file", "-c", "--config"]);
  for (let i = runner + 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith("-")) {
      if (takesValue.has(token)) i++;
      continue;
    }
    return token;
  }
  return null;
}
const serverEntry = pkg.main || extractNodeEntry(startScript) || null;

const risks = [];
if (!buildCommand && !resolvedOutputDir && kind !== "api" && kind !== "fullstack") risks.push("没有检测到构建脚本；请手动生成输出目录，或补一个 build 脚本。");
if (framework === "nextjs" && kind !== "static") risks.push("Next.js SSR 不能当纯静态资源上传；改用 Workers 上的 vinext/OpenNext，或改成 output: 'export'。");
if (nativeRisk.length) risks.push(`以下原生/重依赖可能无法在 Workers 上运行：${nativeRisk.join(", ")}。`);
if (sqliteNative.length) risks.push(`检测到原生 SQLite 驱动（${sqliteNative.join(", ")}）；Workers 无法加载原生模块，改用 D1 或远程数据库。`);
if (runtimeDeps.length) risks.push(`运行时依赖需要核对：${runtimeDeps.map((d) => d.dep).join("、")}；见 references/runtime-compat.md。`);
if (neonHttp) risks.push("检测到 Neon HTTP 驱动：不支持交互式事务，需要事务时改用 WebSocket 驱动（drizzle-orm/neon-serverless）。");
if (fsUsage) risks.push("源码引用了 node:fs；Workers 没有持久本地文件系统。把文件迁到 R2，或保留原主机。");
if (longRunning) risks.push("检测到长驻服务模式（setInterval/createServer/while true）；Workers 是请求级的。考虑 Cron/Queues，或保留原主机。");
if (kind === "api" || kind === "fullstack") risks.push("服务端运行时需要适配 Workers；迁移前先检查 Node API 和数据库驱动。");
if (!resolvedOutputDir) risks.push("输出目录未知；部署前先确认构建产物位置。");
if (monorepo) risks.push(`检测到 monorepo${workspaces.length ? `（${workspaces.map((w) => w.path).join("、")}）` : ""}；部署前确认要发布哪个子包及其输出路径。`);
if (framework === "static-html" && htmlIndexes.length > 1) risks.push(`发现 ${htmlIndexes.length} 个 index.html（${htmlEntries.slice(0, 3).join("、")}${htmlEntries.length > 3 ? " 等" : ""}）；确认哪个目录才是站点根目录。`);
if (framework === "unknown" && htmlIndexes.length > 1) risks.push(`发现 ${htmlIndexes.length} 个 index.html（${htmlEntries.slice(0, 3).join("、")}${htmlEntries.length > 3 ? " 等" : ""}），但没有识别出框架；确认站点根目录，或补构建配置。`);
if (!hasIndexHtml && htmlIndexes.length === 0) {
  const htmlFiles = walkFiles(root, 3).filter((f) => /\.html?$/i.test(f));
  if (htmlFiles.length) risks.push(`找到 ${htmlFiles.length} 个 HTML 文件，但没有 index.html；直接部署目录根会 404。选择入口目录，或补一个 index。`);
}
if (lockfiles.length > 1) risks.push(`同时存在 ${lockfiles.length} 个锁文件（${lockfiles.join("、")}）；包管理器不确定，先确认 CI 实际用哪个，避免混用。`);
if (dynamicConfig && (!viteBase || !viteOut)) risks.push("Vite 配置是动态的（函数或环境变量）；base 和输出目录无法静态确认，构建后必须核对产物路径。");
if (buildOutputAmbiguous) {
  const scriptsText = buildScriptNames.length ? buildScriptNames.join("、") : "无 build 脚本";
  const dirsText = viteOutCandidates.length ? viteOutCandidates.join("、") : "无显式 outDir";
  risks.push(`构建脚本与输出目录无法唯一配对（脚本：${scriptsText}；配置中的 outDir：${dirsText}）；已按 ${primaryBuildScript || "框架默认"} + ${outputDir} 推断，构建后必须核对实际产物，不能把当前结果当作 confirmed。`);
}
if (spaRouting === "hash") risks.push(`检测到 HashRouter/默认 hash 路由${routerDeps.length ? `（${routerDeps.join("、")}）` : ""}：部署验收建议用 --mode static 并提供 404.html；未知路径 404 对 hash 路由是正常行为。`);
if (spaRouting === "history") risks.push(`检测到 history 路由（BrowserRouter/createBrowserRouter/createWebHistory）：Pages 需要 _redirects /* /index.html 200（或 Workers not_found_handling），否则刷新深链会 404；验收用 --mode spa。`);
if (spaRouting === "mixed") risks.push("同时检测到 hash 与 history 路由特征；先确认实际 Router，再选择 static（hash）或带 fallback 的 spa（history），不要凭默认值部署。");
if (spaRouting === "unknown" && kind === "spa") risks.push("未识别出客户端路由类型，验收模式为 unknown：HashRouter 用 --mode static + 404.html，BrowserRouter/history 用 --mode spa + fallback；不要默认 spa。");
if (spaRouting && kind !== "spa") risks.push(`检测到客户端路由依赖但项目类型按 ${kind} 识别（常见于 Vue CLI/Angular/webpack 等未被框架识别的构建）；请人工确认这是 SPA，并按 ${spaRouting} 选择验收模式。`);

// 目标：只给候选。最终由 DNS、部署方式和未来后端需求决定。
const decideBy = ["域名 NS 是否在 Cloudflare（Workers 要求 NS 托管，Pages 的子域可用外部 CNAME）", "是否要零配置 git push 部署", "以后是否需要 Cloudflare 侧后端（D1/DO/Queues/Cron）"];
const target = (() => {
  if (nativeRisk.length || longRunning) {
    return {
      candidates: [],
      suggested: "assess",
      confidence: "high",
      basis: ["检测到原生/重依赖或长驻进程，Workers 运行时可能无法承载"],
      decideBy: ["能否替换依赖（sharp→图像服务、better-sqlite3→D1/外部库）", "是否改用 Containers 或保留原主机"],
    };
  }
  if (wrangler?.pagesBuildOutputDir) {
    return { candidates: ["pages"], suggested: "pages", confidence: "high", basis: [`wrangler 配置里已有 pages_build_output_dir = ${wrangler.pagesBuildOutputDir}`], decideBy: [] };
  }
  if (wrangler && (wrangler.hasMain || wrangler.assetsDirectory)) {
    const parts = [];
    if (wrangler.hasMain) parts.push("main 入口");
    if (wrangler.assetsDirectory) parts.push(`assets.directory = ${wrangler.assetsDirectory}`);
    return { candidates: ["workers"], suggested: "workers", confidence: "high", basis: [`现有 wrangler 配置已经是 Workers 形态（${parts.join("，")}）`], decideBy: [] };
  }
  if (wrangler?.bindings.durableObjects || wrangler?.bindings.queues) {
    return { candidates: ["workers"], suggested: "workers", confidence: "high", basis: ["wrangler 配置使用了 Durable Objects 或 Queues，Pages Functions 没有这些能力"], decideBy: [] };
  }
  if (exists(path.join(root, "functions")) || exists(path.join(root, "_worker.js"))) {
    return {
      candidates: ["pages"],
      suggested: "pages",
      confidence: "medium",
      basis: ["仓库里有 Pages Functions 的入口（functions/ 或 _worker.js）"],
      decideBy: ["确认 Functions 只在 Pages 上运行过；如果已经迁到 Workers，改用 main + assets 配置"],
    };
  }
  if (kind === "ssr" || kind === "fullstack" || kind === "api") {
    return {
      candidates: ["workers"],
      suggested: "workers",
      confidence: "medium",
      basis: [`kind=${kind}：需要服务端运行时，Pages 只能通过 Functions 做有限承载`],
      decideBy: ["框架是否有官方 Workers 适配器（vinext/OpenNext/其他）", "服务端依赖的 Node API 是否被 workerd 支持"],
    };
  }
  if (kind === "static" || kind === "spa") {
    return {
      candidates: ["pages", "workers"],
      suggested: null,
      confidence: "medium",
      basis: [`kind=${kind}：构建产物是静态资源，Pages 和 Workers 都能托管`],
      decideBy,
    };
  }
  return { candidates: [], suggested: null, confidence: "low", basis: ["未能确认项目类型"], decideBy: ["先确认框架、构建命令和产物目录"] };
})();

const SSG_FRAMEWORKS = new Set(["jekyll", "hugo", "mkdocs", "gatsby", "docusaurus", "vitepress", "astro", "sveltekit"]);
const suggestedMode = (() => {
  if (kind === "ssr" || kind === "fullstack") return "ssr";
  if (spaRouting === "mixed") return "unknown";
  if (spaRouting === "hash") return "static";
  if (spaRouting === "history") return "spa";
  // kind=spa 只说明“构建产物像 SPA”，不证明路由类型；没有 hash/history 证据时
  // 不能默认推荐 spa（否则 BrowserRouter 与 HashRouter 的验收结论会相反）。
  if (kind === "spa") return "unknown";
  if (kind === "static") return SSG_FRAMEWORKS.has(framework) || framework === "nextjs" ? "ssg" : "static";
  return "unknown";
})();

const unknowns = [
  "DNS 托管在哪、域名是否使用 Cloudflare 的 NS",
  "Cloudflare 账号、API Token 和 wrangler 登录状态",
  "生产密钥及其真实值",
  "用户是否要保留 GitHub Pages 作为独立备用站",
];
if (framework === "unknown") unknowns.push("框架类型（未识别）");
if (!resolvedOutputDir) unknowns.push("构建产物目录（未能确认）");
if (buildOutputAmbiguous) unknowns.push("构建命令与输出目录的对应关系（存在多个 build 脚本或条件 outDir；当前为推断，需构建后核对）");
if (framework === "vite" && !viteBase) unknowns.push("base path（Vite 配置里没有静态值，默认 / 但需构建后核对）");
if (kind === "spa" && spaRouting === "unknown") unknowns.push("客户端路由类型（未识别；HashRouter 用 static，BrowserRouter/history 用 spa + fallback）");
if (spaRouting === "mixed") unknowns.push("实际 Router（同时检测到 hash 与 history 特征，验收模式保持 unknown，禁止自动选）");
if (spaRouting && kind !== "spa") unknowns.push("项目是否确实是客户端路由 SPA（检测到 router 依赖但框架类型未识别）");
if (lockfiles.length === 0 && pkgPath) unknowns.push("实际包管理器（没有锁文件，按 npm 推断）");
if (kind === "api" || kind === "fullstack") unknowns.push("服务端入口是否就是检测到的那个文件");

const evidence = {
  framework: ev(framework, frameworkSource.startsWith("package.json") ? "confirmed" : "inferred", frameworkSource),
  spaRouting: ev(
    spaRouting,
    spaRouting === "hash" || spaRouting === "history" || spaRouting === "mixed" ? "inferred" : "unknown",
    spaRouting === "hash" || spaRouting === "history" || spaRouting === "mixed"
      ? "源码中的 Router 特征（HashRouter/BrowserRouter/createWebHashHistory/createWebHistory/mode）"
      : "没有可确认的客户端路由特征（unknown 时不能凭默认值断言）"
  ),
  kind: ev(kind, "inferred", `结合 ${frameworkSource} 与构建配置推断`),
  buildCommand: ev(
    buildCommand,
    scripts.build && !multipleBuildScripts ? "confirmed" : buildCommand ? "inferred" : "unknown",
    multipleBuildScripts
      ? `package.json 有多个 build 脚本（${buildScriptNames.join("、")}），默认取 ${primaryBuildScript || "第一个"}`
      : scripts.build ? "package.json scripts.build" : primaryBuildScript ? `package.json scripts.${primaryBuildScript}` : "框架默认构建命令"
  ),
  outputDir: ev(
    resolvedOutputDir,
    wranglerOutputDir || (viteOut && !buildOutputAmbiguous) ? "confirmed" : resolvedOutputDir ? "inferred" : "unknown",
    wrangler?.pagesBuildOutputDir ? `${wrangler.file} 的 pages_build_output_dir` : wrangler?.assetsDirectory ? `${wrangler.file} 的 assets.directory` : viteOut ? "vite.config 的 build.outDir" : buildOutputAmbiguous ? "Vite 动态/条件配置无法唯一确认，按构建脚本或框架默认值推断" : htmlRoot ? "唯一的 index.html 所在目录" : "框架默认输出目录"
  ),
  packageManager: ev(
    manager,
    lockfiles.length === 1 ? "confirmed" : lockfiles.length > 1 ? "inferred" : pkgPath ? "inferred" : "unknown",
    lockfiles.length ? `锁文件：${lockfiles.join("、")}` : pkgPath ? "没有锁文件，按 npm 推断" : "没有 package.json"
  ),
  basePath: ev(
    viteBase || nextBasePath || null,
    viteBase || nextBasePath ? (dynamicConfig && viteBase ? "inferred" : "confirmed") : "unknown",
    viteBase ? (dynamicConfig ? "vite.config 的 base（动态配置，未静态确认）" : "vite.config 的 base") : nextBasePath ? "next.config 的 basePath" : "没有静态 base 配置"
  ),
  nodeEngine: ev(pkg.engines?.node || read(path.join(root, ".nvmrc"))?.trim() || read(path.join(root, ".node-version"))?.trim() || null, pkg.engines?.node || read(path.join(root, ".nvmrc")) || read(path.join(root, ".node-version")) ? "confirmed" : "unknown", "package.json engines / .nvmrc / .node-version"),
};

const result = {
  schemaVersion: SCHEMA_VERSION,
  root,
  detectedAt: new Date().toISOString(),
  project: {
    name: pkg.name || repoName || path.basename(root),
    framework,
    kind,
    packageManager: manager,
    lockfiles,
    nodeEngine: evidence.nodeEngine.value,
    monorepo,
    workspaces,
    buildCommand,
    outputDir: resolvedOutputDir,
    scripts: Object.keys(scripts),
    buildCandidates: buildScriptNames.map((name) => `${manager || "npm"} run ${name}`),
    outputDirCandidates: [...new Set([...viteOutCandidates, ...(outputDir ? [outputDir] : [])])],
    basePath: viteBase || nextBasePath || null,
    suggestedMode,
    spaRouting,
    hasIndexHtml,
    htmlEntries,
    serverEntry,
  },
  evidence,
  github: {
    repo: gitRemote,
    branch: gitBranch,
    root: gitTop,
    dirty: Boolean(gitDirty),
    repoName,
  },
  githubPages: {
    configured: Boolean(cname) || ghWorkflows.some((w) => w.pages),
    cname,
    cnameFile,
    workflows: ghWorkflows.filter((w) => w.pages),
    likelyProjectSite: Boolean(cname) && Boolean(gitRemote) && !/^[^/]+\.github\.io$/.test(repoName || ""),
  },
  cloudflare: {
    configured: Boolean(wranglerFile),
    wrangler,
    functionsDir: exists(path.join(root, "functions")),
    workerJs: exists(path.join(root, "_worker.js")),
    headers: exists(path.join(root, "_headers")),
    redirects: exists(path.join(root, "_redirects")),
    workflows: ghWorkflows.filter((w) => w.cloudflare),
  },
  runtime: {
    envFiles,
    envExample,
    envKeys,
    pwa: exists(path.join(root, "public", "manifest.webmanifest")) || exists(path.join(root, "public", "manifest.json")) ||
      exists(path.join(root, "manifest.json")) || /vite-plugin-pwa|next-pwa/.test(JSON.stringify(deps)),
    serviceWorker: ["public/sw.js", "sw.js", "src/sw.js", "public/service-worker.js"].some((f) => exists(path.join(root, f))),
  },
  target,
  // 兼容旧字段：只是候选的别名，不代表最终决定。
  recommendedTarget: target.suggested || "either",
  risks,
  unknowns,
  nextSteps: [
    "先跑 scripts/probe.mjs：确认账号、权限、网络能通；blocked 就停下来，不要先改项目。",
    "执行任何部署命令前，再跑 scripts/check-env.mjs（它会用退出码表达可构建/可部署）。",
    "按 target.candidates 和 decideBy 里的问题确认 Pages 还是 Workers；SSR/全栈先读 references/runtime-compat.md。",
    suggestedMode === "unknown"
      ? "路由/验收模式未确认：先人工确认是 HashRouter（static + 404.html）还是 BrowserRouter/history（spa + fallback），不要默认选 spa；确认后再跑 check-build --mode <...>。"
      : `本地构建后，用 scripts/check-build.mjs --mode ${suggestedMode} 检查输出目录。`,
    "按选定的目标读 references/deployment-workflows.md。",
  ],
};

if (human) {
  const p = result.project;
  const t = result.target;
  const tLabel = t.suggested ? `${t.suggested}（${t.confidence}）` : `待定（${t.confidence}）；候选：${t.candidates.join(" / ") || "无"}`;
  console.log(`项目： ${p.name}`);
  console.log(`  根目录     ${root}`);
  console.log(`  框架       ${p.framework} (${p.kind})`);
  console.log(`  包管理器   ${p.packageManager || "n/a"}${p.lockfiles.length > 1 ? `（${p.lockfiles.length} 个锁文件，需确认）` : ""}${p.nodeEngine ? `, node ${p.nodeEngine}` : ""}`);
  console.log(`  构建       ${p.buildCommand || "n/a"}`);
  console.log(`  输出目录   ${p.outputDir || "n/a"}（${result.evidence.outputDir.confidence}）`);
  console.log(`  验收模式   ${p.suggestedMode}${p.spaRouting ? `（路由：${p.spaRouting}）` : ""}${p.suggestedMode === "unknown" ? " — 需人工确认，不要默认 spa" : ""}`);
  if (p.suggestedMode === "unknown") console.log("    待确认   路由/项目类型未确认：HashRouter 用 static + 404.html，BrowserRouter/history 用 spa + fallback；确认后再选 --mode。");
  console.log(`  目标       ${tLabel}`);
  t.basis.forEach((b) => console.log(`    依据     ${b}`));
  if (t.decideBy.length) console.log(`    待确认   ${t.decideBy.join("；")}`);
  if (p.workspaces.length) console.log(`  子应用     ${p.workspaces.map((w) => `${w.path}${w.hasBuild ? "" : "(无 build)"}`).join("、")}`);
  console.log(`  GH Pages   ${result.githubPages.configured ? "configured" : "no"}${result.githubPages.cname ? ` (${result.githubPages.cname})` : ""}`);
  console.log(`  CF 配置    ${result.cloudflare.configured ? result.cloudflare.wrangler.file : "no"}`);
  if (risks.length) {
    console.log("\n风险：");
    risks.forEach((r) => console.log(`  - ${r}`));
  }
  console.log("\n未知：");
  unknowns.forEach((u) => console.log(`  - ${u}`));
} else {
  console.log(JSON.stringify(result, null, 2));
}
