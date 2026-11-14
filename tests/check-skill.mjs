#!/usr/bin/env node
/**
 * check-skill.mjs — 仓库自带的技能结构检查，不依赖任何外部工具。
 *
 * 用法：
 *   node tests/check-skill.mjs [技能目录]
 *
 * 检查：SKILL.md frontmatter、name/description、文档里引用的相对路径是否存在、
 * 本地绝对路径残留、文件名是否 ASCII、空目录、SKILL.md 体量。
 * 退出码 1 表示有阻断项。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(process.argv[2] || path.join(here, ".."));
const problems = [];
const notes = [];
const fail = (msg) => problems.push(msg);

const rel = (p) => path.relative(skillRoot, p).replace(/\\/g, "/");
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules" || ent.name === ".work") continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const skillFile = path.join(skillRoot, "SKILL.md");
if (!isFile(skillFile)) {
  console.error(`找不到 SKILL.md：${skillFile}`);
  process.exit(2);
}

const text = fs.readFileSync(skillFile, "utf8");
const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
if (!fm) fail("SKILL.md 缺少 YAML frontmatter（--- ... ---）");

let name = null;
let description = null;
if (fm) {
  const lines = fm[1].split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    if (m[1] === "name") name = m[2].trim().replace(/^["']|["']$/g, "");
    if (m[1] === "description") description = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

if (!name) fail("frontmatter 缺少 name");
else {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) fail(`name 只能是 kebab-case ASCII：${name}`);
  if (name.length > 64) fail(`name 超过 64 字符：${name.length}`);
  if (name !== path.basename(skillRoot)) fail(`name（${name}）必须和目录名（${path.basename(skillRoot)}）一致`);
}

if (!description) fail("frontmatter 缺少 description");
else {
  if (description.length > 1024) fail(`description 超过 1024 字符：${description.length}`);
  if (description.length < 40) fail(`description 太短，无法触发技能：${description.length}`);
  notes.push(`description 长度：${description.length}`);
}

const skillLines = text.replace(/\s+$/, "").split(/\r?\n/).length;
if (skillLines > 400) notes.push(`SKILL.md 有 ${skillLines} 行，偏长；考虑把细节移到 references/`);

// 文档里提到的相对路径必须真实存在。忽略 <某目录>/scripts/... 这类外部路径。
const mdFiles = walk(skillRoot).filter((f) => /\.md$/i.test(f));
const pathRef = /(?<![<\w/])(references|templates|scripts|tests)\/[A-Za-z0-9._/-]+\b/g;
const seen = new Set();
for (const f of mdFiles) {
  const body = fs.readFileSync(f, "utf8");
  for (const m of body.matchAll(pathRef)) {
    const ref = m[0].replace(/[.,;:)]+$/, "");
    // tests/.work 与 last-run.txt 是运行期产物，不属于仓库内容。
    if (/^tests\/(\.work|last-run\.txt)/.test(ref)) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    if (!isFile(path.join(skillRoot, ref))) fail(`${rel(f)} 引用了不存在的路径：${ref}`);
  }
  // 本地 markdown 链接
  for (const m of body.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
    const target = m[1].split("#")[0];
    if (!target) continue;
    if (!isFile(path.join(path.dirname(f), target))) fail(`${rel(f)} 里有失效的相对链接：${m[1]}`);
  }
}

// 不允许把某台机器的绝对路径写进技能。
for (const f of [...mdFiles, ...walk(skillRoot).filter((x) => /\.(mjs|jsonc?|toml|ya?ml)$/i.test(x))]) {
  const body = fs.readFileSync(f, "utf8");
  for (const m of body.matchAll(/[A-Za-z]:\\\\?Users\\\\?[^\\\s"']+|\/Users\/[^/\s"']+\/|\/home\/[^/\s"']+\//g)) {
    fail(`${rel(f)} 含本机绝对路径：${m[0]}`);
  }
}

// 文件名保持 ASCII：中文名在压缩包、CI、跨系统复制时容易乱码。
for (const f of walk(skillRoot)) {
  const base = path.basename(f);
  if (!/^[\x20-\x7E]+$/.test(base)) fail(`文件名不是 ASCII：${rel(f)}`);
}

// 空目录会让打包和安装行为不一致。
const dirs = [];
(function collect(dir) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    if (ent.isDirectory()) {
      dirs.push(path.join(dir, ent.name));
      collect(path.join(dir, ent.name));
    }
  }
})(skillRoot);
for (const d of dirs) {
  if (fs.readdirSync(d).length === 0) fail(`空目录：${rel(d)}`);
}

console.log(`技能目录：${skillRoot}`);
console.log(`SKILL.md：${skillLines} 行`);
notes.forEach((n) => console.log(`说明：${n}`));
console.log(`引用的相对路径：${seen.size} 个`);
if (problems.length === 0) {
  console.log("结构检查：通过");
  process.exit(0);
}
console.log(`\n结构检查：${problems.length} 个问题`);
problems.forEach((p) => console.log(`  - ${p}`));
process.exit(1);
