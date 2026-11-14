#!/usr/bin/env node
/**
 * detect-project.mjs — 只读识别项目，供 Cloudflare 部署使用。
 *
 * 用法：
 *   node scripts/detect-project.mjs [项目目录] [--human]
 *
 * 默认输出 JSON（字段名稳定，带 schemaVersion）；--human 输出摘要。
 * 不写项目文件、不安装依赖、不访问网络。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCHEMA_VERSION = 1;
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

if (!exists(root) || !fs.statSync(root).isDirectory()) {
  console.error(`不是目录： ${root}`);
  process.exit(2);
}

function git(args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5000 });
  if (r.status !== 0) return null;
  return (r.stdout || "").trim() || null;
}

function walkFiles(dir, maxDepth = 3, acc = [], depth = 0) {
  if (depth > maxDepth) return acc;
  for (const ent of listDir(dir)) {
    if (["node_modules", ".git", "dist", "build", "_site", "public", ".next", ".output", "vendor"].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(full, maxDepth, acc, depth + 1);
    else acc.push(full);
  }
  return acc;
}

const pkgPath = firstExisting(["package.json"]);
const pkg = pkgPath ? readJson(path.join(root, pkgPath)) || {} : {};
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const scripts = pkg.scripts || {};
const hasDep = (name) => Object.prototype.hasOwnProperty.call(deps, name);

const configText = (names) => {
  for (const n of names) {
    const s = read(path.join(root, n));
    if (s) return s;
  }
  return "";
};

const viteConfig = configText(["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]);
const nextConfig = configText(["next.config.js", "next.config.mjs", "next.config.ts"]);
const astroConfig = configText(["astro.config.mjs", "astro.config.ts", "astro.config.js"]);
const svelteConfig = configText(["svelte.config.js"]);
const nuxtConfig = configText(["nuxt.config.ts", "nuxt.config.js"]);

const hasIndexHtml = exists(path.join(root, "index.html"));
const jekyllConfig = exists(path.join(root, "_config.yml"));
const gemfile = read(path.join(root, "Gemfile")) || "";
const hasJekyll = jekyllConfig && (/jekyll/i.test(gemfile) || exists(path.join(root, "_layouts")));
const hasHugo = ["hugo.toml", "hugo.yaml", "hugo.json", "config.toml"].some((f) => exists(path.join(root, f))) &&
  (exists(path.join(root, "archetypes")) || exists(path.join(root, "content")) || exists(path.join(root, "layouts")));
const hasMkDocs = exists(path.join(root, "mkdocs.yml"));

let framework = "unknown";
let kind = "unknown";

if (hasDep("next")) { framework = "nextjs"; kind = /output\s*:\s*["']export["']/.test(nextConfig) ? "static" : "ssr"; }
else if (hasDep("nuxt") || hasDep("nuxt3")) { framework = "nuxt"; kind = "ssr"; }
else if (hasDep("@sveltejs/kit")) { framework = "sveltekit"; kind = /adapter-static/.test(svelteConfig) || hasDep("@sveltejs/adapter-static") ? "static" : "ssr"; }
else if (hasDep("astro")) { framework = "astro"; kind = /adapter/.test(astroConfig) ? "ssr" : "static"; }
else if (hasDep("@remix-run/react") || hasDep("@remix-run/node")) { framework = "remix"; kind = "ssr"; }
else if (hasDep("gatsby")) { framework = "gatsby"; kind = "static"; }
else if (hasDep("@docusaurus/core")) { framework = "docusaurus"; kind = "static"; }
else if (hasDep("vitepress")) { framework = "vitepress"; kind = "static"; }
else if (hasDep("vite")) { framework = "vite"; kind = hasIndexHtml ? "spa" : "library"; }
else if (hasDep("react-scripts")) { framework = "cra"; kind = "spa"; }
else if (hasDep("vue") && hasIndexHtml) { framework = "vue"; kind = "spa"; }
else if (hasDep("express") || hasDep("koa") || hasDep("fastify") || hasDep("@nestjs/core") || hasDep("hono")) {
  framework = hasDep("hono") ? "hono" : hasDep("@nestjs/core") ? "nestjs" : hasDep("express") ? "express" : hasDep("koa") ? "koa" : "fastify";
  kind = hasIndexHtml ? "fullstack" : "api";
}
else if (hasJekyll) { framework = "jekyll"; kind = "static"; }
else if (hasHugo) { framework = "hugo"; kind = "static"; }
else if (hasMkDocs) { framework = "mkdocs"; kind = "static"; }
else if (hasIndexHtml) { framework = "static-html"; kind = "static"; }

const htmlIndexes = walkFiles(root, 2).filter((f) => /[\\/]index\.html$/i.test(f));
let htmlRoot = null;
if (framework === "unknown" && htmlIndexes.length === 1) {
  framework = "static-html";
  kind = "static";
  htmlRoot = path.relative(root, path.dirname(htmlIndexes[0])) || ".";
}

const manager = exists(path.join(root, "pnpm-lock.yaml")) ? "pnpm"
  : exists(path.join(root, "yarn.lock")) ? "yarn"
  : exists(path.join(root, "bun.lockb")) || exists(path.join(root, "bun.lock")) ? "bun"
  : exists(path.join(root, "package-lock.json")) ? "npm"
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

const viteOut = viteConfig.match(/outDir\s*:\s*["']([^"']+)["']/)?.[1] || null;
const viteBase = viteConfig.match(/\bbase\s*:\s*["']([^"']+)["']/)?.[1] || null;
const nextBasePath = nextConfig.match(/basePath\s*:\s*["']([^"']+)["']/)?.[1] || null;

const buildCommand = scripts.build ? `${manager || "npm"} run build` : defaultBuild[framework] || null;
const outputDir = viteOut || htmlRoot || defaultOut[framework] || null;

const ghWorkflowDir = path.join(root, ".github", "workflows");
const ghWorkflows = listDir(ghWorkflowDir)
  .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
  .map((e) => {
    const text = read(path.join(ghWorkflowDir, e.name)) || "";
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
const wranglerText = wranglerFile ? read(path.join(root, wranglerFile)) || "" : "";
const wrangler = wranglerFile ? {
  file: wranglerFile,
  name: wranglerText.match(/\bname\s*[:=]\s*["']([^"']+)["']/)?.[1] || null,
  pagesBuildOutputDir: wranglerText.match(/pages_build_output_dir\s*[:=]\s*["']([^"']+)["']/)?.[1] || null,
  assetsDirectory: wranglerText.match(/directory\s*[:=]\s*["']([^"']+)["']/)?.[1] || null,
  compatibilityDate: wranglerText.match(/compatibility_date\s*[:=]\s*["']([^"']+)["']/)?.[1] || null,
  bindings: {
    d1: /d1_databases/.test(wranglerText),
    kv: /kv_namespaces/.test(wranglerText),
    r2: /r2_buckets/.test(wranglerText),
    durableObjects: /durable_objects/.test(wranglerText),
    queues: /queues/.test(wranglerText),
    hyperdrive: /hyperdrive/.test(wranglerText),
  },
} : null;

const resolvedOutputDir = outputDir || wrangler?.assetsDirectory || wrangler?.pagesBuildOutputDir || null;

const relToRoot = (f) => path.relative(root, f).replace(/\\/g, "/");
const isNoisePath = (f) => relToRoot(f).split("/").some((part) => ["node_modules", "tests", "test", "scripts", "docs", ".github", ".wrangler"].includes(part));
const srcFiles = walkFiles(path.join(root, "src"), 3, [], 1)
  .filter((f) => !isNoisePath(f))
  .concat(walkFiles(root, 2, [], 1).filter((f) => /\.(m?[jt]sx?)$/.test(f) && !isNoisePath(f)))
  .slice(0, 400);
const sourceText = srcFiles.map((f) => read(f) || "").join("\n").slice(0, 400000);
const nativeRisk = ["sharp", "canvas", "puppeteer", "playwright", "bcrypt", "argon2", "sqlite3", "better-sqlite3"]
  .filter((n) => hasDep(n));
const fsUsage = /\bfrom\s+["'](?:node:)?fs["']|require\(\s*["'](?:node:)?fs["']\s*\)/.test(sourceText);
const longRunning = /setInterval\s*\(|while\s*\(\s*true\s*\)|createServer\s*\(/.test(sourceText);

const envFiles = listDir(root)
  .filter((e) => e.isFile() && /^\.env(\.|$)/.test(e.name))
  .map((e) => e.name);
const envExample = listDir(root)
  .filter((e) => e.isFile() && /^\.env\.(example|sample|template)$/.test(e.name))
  .map((e) => e.name);
const envKeys = envExample.length
  ? (read(path.join(root, envExample[0])) || "").split(/\r?\n/)
      .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1])
      .filter(Boolean)
  : [];

const monorepo = exists(path.join(root, "pnpm-workspace.yaml")) || Boolean(pkg.workspaces) ||
  exists(path.join(root, "turbo.json")) || exists(path.join(root, "lerna.json")) || exists(path.join(root, "nx.json"));

const risks = [];
if (!buildCommand && !resolvedOutputDir && kind !== "api" && kind !== "fullstack") risks.push("没有检测到构建脚本；请手动生成输出目录，或补一个 build 脚本。");
if (framework === "nextjs" && kind !== "static") risks.push("Next.js SSR 不能当纯静态资源上传；改用 Workers 上的 vinext/OpenNext，或改成 output: 'export'。");
if (nativeRisk.length) risks.push(`以下原生/重依赖可能无法在 Workers 上运行： ${nativeRisk.join(", ")}.`);
if (fsUsage) risks.push("源码引用了 node:fs；Workers 没有持久本地文件系统。把文件迁到 R2，或保留原主机。");
if (longRunning) risks.push("检测到长驻服务模式（setInterval/createServer/while true）；Workers 是请求级的。考虑 Cron/Queues，或保留原主机。");
if (kind === "api" || kind === "fullstack") risks.push("服务端运行时需要适配 Workers；迁移前先检查 Node API 和数据库驱动。");
if (!resolvedOutputDir) risks.push("输出目录未知；部署前先确认构建产物位置。");
if (monorepo) risks.push("检测到 monorepo；部署前确认要发布哪个子包及其输出路径。");
if (framework === "static-html" && htmlIndexes.length > 1) risks.push(`Multiple index.html files found (${htmlIndexes.length}); 确认哪个目录才是站点根目录。`);
if (!hasIndexHtml && htmlIndexes.length === 0) {
  const htmlFiles = walkFiles(root, 3).filter((f) => /\.html?$/i.test(f));
  if (htmlFiles.length) risks.push(`Found ${htmlFiles.length} 个 HTML 文件，但没有 index.html；直接部署目录根会 404。选择入口目录，或补一个 index。`);
}

const deployTarget = (() => {
  if (nativeRisk.length || longRunning) return "assess";
  if (wrangler?.pagesBuildOutputDir || (framework !== "unknown" && kind !== "ssr" && kind !== "api")) return "pages";
  if (wrangler && (wrangler.bindings.d1 || wrangler.bindings.kv || wrangler.bindings.r2 || wrangler.bindings.durableObjects)) return "workers";
  if (kind === "ssr" || kind === "fullstack" || kind === "api") return "workers";
  if (kind === "static" || kind === "spa") return "pages";
  return "undetermined";
})();

const result = {
  schemaVersion: SCHEMA_VERSION,
  root,
  detectedAt: new Date().toISOString(),
  project: {
    name: pkg.name || repoName || path.basename(root),
    framework,
    kind,
    packageManager: manager,
    nodeEngine: pkg.engines?.node || read(path.join(root, ".nvmrc"))?.trim() || read(path.join(root, ".node-version"))?.trim() || null,
    monorepo,
    buildCommand,
    outputDir: resolvedOutputDir,
    scripts: Object.keys(scripts),
    basePath: viteBase || nextBasePath || null,
    hasIndexHtml,
  },
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
  recommendedTarget: deployTarget,
  risks,
  unknowns: [
    "DNS 托管在哪、域名是否使用 Cloudflare 的 NS",
    "Cloudflare 账号、API Token 和 wrangler 登录状态",
    "生产密钥及其真实值",
    "用户是否要保留 GitHub Pages 作为独立备用站",
  ],
  nextSteps: [
    "执行任何部署命令前，先跑 scripts/check-env.mjs。",
    "读 references/platform-selection.md，确认 Pages 还是 Workers。",
    "本地构建后，用 scripts/check-build.mjs 检查输出目录。",
    "按选定的目标读 references/deployment-workflows.md。",
  ],
};

if (human) {
  const p = result.project;
  console.log(`项目： ${p.name}`);
  console.log(`  根目录     ${root}`);
  console.log(`  框架       ${p.framework} (${p.kind})`);
  console.log(`  包管理器   ${p.packageManager || "n/a"}${p.nodeEngine ? `, node ${p.nodeEngine}` : ""}`);
  console.log(`  构建       ${p.buildCommand || "n/a"}`);
  console.log(`  输出目录   ${p.outputDir || "n/a"}`);
  console.log(`  建议目标   ${result.recommendedTarget}`);
  console.log(`  GH Pages   ${result.githubPages.configured ? "configured" : "no"}${result.githubPages.cname ? ` (${result.githubPages.cname})` : ""}`);
  console.log(`  CF 配置    ${result.cloudflare.configured ? result.cloudflare.wrangler.file : "no"}`);
  if (risks.length) {
    console.log("\n风险：");
    risks.forEach((r) => console.log(`  - ${r}`));
  }
} else {
  console.log(JSON.stringify(result, null, 2));
}
