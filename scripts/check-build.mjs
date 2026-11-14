#!/usr/bin/env node
/**
 * check-build.mjs — 部署前检查静态构建产物。
 *
 * 用法：
 *   node scripts/check-build.mjs --dir dist [--spa] [--json]
 *
 * 只读。检查 Pages/Workers 静态资源限制、404 行为、_headers/_redirects 位置，
 * 以及 index.html 引用的资源是否存在。
 */

import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const spa = argv.includes("--spa");
const dirArg = argv[argv.indexOf("--dir") + 1];
if (!dirArg || dirArg.startsWith("--")) {
  console.error("用法：node scripts/check-build.mjs --dir <输出目录> [--spa] [--json]");
  process.exit(2);
}
const dir = path.resolve(dirArg);
const checks = [];
const push = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });

if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
  console.log(JSON.stringify({ schemaVersion: 1, dir, checks: [{ id: "exists", status: "fail", detail: "输出目录不存在" }] }, null, 2));
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
if (!hasIndex && !spa) push("index", "warn", "产物根目录没有 index.html");
else push("index", "pass", hasIndex ? "存在 index.html" : "SPA 模式，不要求 index.html");

if (has404) push("404", "pass", "存在 404.html");
else push("404", "warn", "没有顶层 404.html：Pages 会把站点当成 SPA，未知路径返回 200 + /", { severity: "high" });

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

// 检查 index.html 引用的同源资源。
const broken = [];
if (hasIndex) {
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//i.test(u) && !u.startsWith("data:") && !u.startsWith("#") && !u.startsWith("mailto:") && !u.startsWith("tel:"))
    .map((u) => u.split(/[?#]/)[0])
    .filter(Boolean);
  const unique = [...new Set(refs)].slice(0, 40);
  for (const u of unique) {
    const clean = u.replace(/^\//, "");
    if (!clean) continue;
    let decoded = clean;
    try { decoded = decodeURIComponent(clean); } catch { /* 保留原值 */ }
    if (!fs.existsSync(path.join(dir, decoded))) broken.push(u);
  }
  if (broken.length) push("assets", "warn", `${broken.length} 个引用资源在产物中找不到：${broken.slice(0, 5).join("、")}`, { broken });
  else push("assets", "pass", `${unique.length} 个引用资源都能找到`);
}

const blocking = checks.filter((c) => c.status === "fail").length;
const result = {
  schemaVersion: 1,
  dir,
  spa,
  summary: {
    files: files.length,
    totalBytes: total,
    totalMiB: Number((total / 1024 / 1024).toFixed(2)),
    largest: sizes.slice(0, 5),
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
  console.log(`\n${files.length} 个文件，${result.summary.totalMiB} MiB，阻断项=${blocking}`);
}
process.exit(blocking ? 1 : 0);
