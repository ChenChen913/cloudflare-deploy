#!/usr/bin/env node
/**
 * check-build.mjs — 部署前检查静态构建产物。
 *
 * 用法：
 *   node scripts/check-build.mjs --dir dist [--mode static|spa|ssg] [--json]
 *
 * 模式决定 404 的判定，必须和 verify-deployment.mjs 用同一个值：
 *   static  预渲染的多页站，未知路径应当 404
 *   ssg     生成式静态站（Hugo/Jekyll/Astro 等），判定同 static
 *   spa     客户端路由，未知路径应回退到 app shell，不要求 404.html
 *
 * 只读。检查 Pages/Workers 静态资源限制、404 行为、_headers/_redirects 位置，
 * 以及首页引用的同源资源是否存在。
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const getArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

// --spa 是 --mode spa 的旧写法，保留兼容。
const modeArg = argv.includes("--spa") ? "spa" : (getArg("--mode") || "static");
const MODES = ["static", "spa", "ssg"];
const dirArg = getArg("--dir");

if (!dirArg) {
  console.error("用法：node scripts/check-build.mjs --dir <输出目录> [--mode static|spa|ssg] [--json]");
  process.exit(2);
}
if (!MODES.includes(modeArg)) {
  console.error(`未知模式：${modeArg}；只支持 ${MODES.join(" / ")}`);
  process.exit(2);
}

const mode = modeArg;
const dir = path.resolve(dirArg);
const checks = [];
const push = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.log(JSON.stringify({ schemaVersion: 2, dir, mode, checks: [{ id: "exists", status: "fail", detail: "输出目录不存在" }] }, null, 2));
  process.exit(1);
}

function walk(d, acc = []) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const full = path.join(d, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else if (ent.isFile()) acc.push(full);
  }
  return acc;
}

const files = walk(dir);
const rel = (f) => path.relative(dir, f).replace(/\\/g, "/");
const sizes = files.map((f) => ({ file: rel(f), bytes: fs.statSync(f).size })).sort((a, b) => b.bytes - a.bytes);
const total = sizes.reduce((n, f) => n + f.bytes, 0);
const MAX_FILES = 20000;
const MAX_FILE = 25 * 1024 * 1024;

push("exists", "pass", `${files.length} 个文件，${(total / 1024 / 1024).toFixed(2)} MiB`);

if (files.length > MAX_FILES) push("file-count", "fail", `${files.length} 个文件，超过 Free 计划 20,000 上限`, { actual: files.length, limit: MAX_FILES });
else push("file-count", "pass", `${files.length} / ${MAX_FILES} 个文件`);

const over = sizes.filter((f) => f.bytes > MAX_FILE);
if (over.length) push("file-size", "fail", `${over.length} 个文件超过 25 MiB：${over.slice(0, 3).map((f) => f.file).join("、")}`, { files: over.slice(0, 10) });
else push("file-size", "pass", `最大文件 ${sizes[0] ? (sizes[0].bytes / 1024 / 1024).toFixed(2) : "0"} MiB`);

if (total > 1024 * 1024 * 1024) push("total-size", "warn", "产物超过 1 GiB；确认目标套餐和缓存行为");

const hasIndex = fs.existsSync(path.join(dir, "index.html"));
const has404 = fs.existsSync(path.join(dir, "404.html"));
if (hasIndex) push("index", "pass", "存在 index.html");
else if (mode === "spa") push("index", "warn", "SPA 模式但没有 index.html；app shell 通常就是 index.html，部署前确认入口文件", { severity: "high" });
else push("index", "warn", "产物根目录没有 index.html；站点根路径会 404");

// 404 判定必须与 verify-deployment.mjs 的 --mode 一致。
if (mode === "spa") {
  push(
    "404",
    "pass",
    has404
      ? "SPA 模式：存在 404.html，确认 SPA 回退与 404 的优先级符合预期"
      : "SPA 模式：不要求 404.html；未知路径应回退到 app shell，验收时用 --mode spa",
    { mode }
  );
} else if (has404) {
  push("404", "pass", `存在 404.html（${mode} 模式）`, { mode });
} else {
  push(
    "404",
    "warn",
    `${mode} 模式但缺少顶层 404.html：Pages 会把未知路径回退到 /（200）。多页站应补 404.html；只有确认是 SPA 时才改用 --mode spa`,
    { severity: "high", mode }
  );
}

for (const f of ["_headers", "_redirects"]) {
  if (fs.existsSync(path.join(dir, f))) push(f, "pass", `${f} 在产物根目录`);
  else push(f, "skip", `没有 ${f}`);
}

if (fs.existsSync(path.join(dir, "CNAME"))) {
  push("cname", "warn", "产物里有 CNAME；它不应该出现在 Cloudflare 构建产物中", { severity: "medium" });
}

if (fs.existsSync(path.join(dir, ".nojekyll"))) {
  push("nojekyll", "skip", "存在 .nojekyll（仅 GitHub Pages 用，无害）");
}

// 检查首页引用的同源资源；只覆盖首页，不是全站爬取。
const broken = [];
let checkedAssets = 0;
if (hasIndex) {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//i.test(u) && !u.startsWith("data:") && !u.startsWith("#") && !u.startsWith("mailto:") && !u.startsWith("tel:"))
    .map((u) => u.split(/[?#]/)[0])
    .filter(Boolean);
  const unique = [...new Set(refs)].slice(0, 40);
  checkedAssets = unique.length;
  for (const u of unique) {
    const clean = u.replace(/^\//, "");
    if (!clean) continue;
    let decoded = clean;
    try { decoded = decodeURIComponent(clean); } catch { /* 保留原值 */ }
    if (!fs.existsSync(path.join(dir, decoded))) broken.push(u);
  }
  if (broken.length) push("assets", "warn", `${broken.length} 个引用资源在产物中找不到：${broken.slice(0, 5).join("、")}`, { broken, checked: checkedAssets });
  else push("assets", "pass", `首页引用的 ${checkedAssets} 个同源资源都能找到（只检查首页，不是全站）`, { checked: checkedAssets });
}

const blocking = checks.filter((c) => c.status === "fail").length;
const result = {
  schemaVersion: 2,
  dir,
  mode,
  summary: {
    files: files.length,
    totalBytes: total,
    totalMiB: Number((total / 1024 / 1024).toFixed(2)),
    largest: sizes.slice(0, 5),
    assetsChecked: checkedAssets,
    blocking,
    warnings: checks.filter((c) => c.status === "warn").length,
  },
  checks,
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const c of checks) {
    const mark = { pass: "通过", warn: "警告", fail: "失败", skip: "跳过" }[c.status] || c.status;
    console.log(`[${mark}] ${c.id}: ${c.detail}`);
  }
  console.log(`\n模式=${mode}，${files.length} 个文件，${result.summary.totalMiB} MiB，阻断项=${blocking}`);
}
process.exit(blocking ? 1 : 0);
