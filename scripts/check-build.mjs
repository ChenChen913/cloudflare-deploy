#!/usr/bin/env node
/**
 * check-build.mjs — 部署前检查静态构建产物。
 *
 * 用法：
 *   node scripts/check-build.mjs --dir dist [--mode static|spa|ssg|ssr] [--plan free|paid] \
 *     [--target pages|workers] [--wrangler-version 4.34.0] [--pages-wrangler-major 4] [--json]
 *
 * 套餐与文件数（2026-11 官方 Limits；两个产品的 20,000 / 100,000 相同，启用条件不同）：
 *   Free  20,000 文件 —— 默认，不需要任何额外信息。
 *   Paid  最多 100,000 文件 —— 只有显式 --plan paid 才考虑，且必须按部署目标核对：
 *     --target pages   → Wrangler v4 构建 + Pages 项目设置 PAGES_WRANGLER_MAJOR_VERSION=4
 *                        （官方 Pages Limits；该环境变量是 Pages 专属）
 *     --target workers → Wrangler >= 4.34.0（官方 Workers Limits 原文 "you must use version
 *                        4.34.0 or higher"）；不需要 Pages 的环境变量
 *     目标未知         → 不放宽，仍按 Free 20,000（不知道该套用哪套条件）
 *   版本按完整点分数字比较（4.9.0 < 4.34.0）；非法版本视为无法确认。
 *   证据不足时不放宽：仍按 Free 20,000 判定，并给 warn 说明缺什么。
 *   控制台里的账号套餐和 Pages 项目设置本地看不到，脚本只能核对显式参数/环境变量/项目依赖。
 *
 * 模式决定 404 的判定，必须和 verify-deployment.mjs 用同一个值：
 *   static  预渲染的多页站，未知路径应当 404
 *   ssg     生成式静态站（Hugo/Jekyll/Astro 等），判定同 static
 *   spa     客户端路由，未知路径应回退到 app shell，不要求 404.html
 *   ssr     服务端渲染，没有可上传的静态产物目录，本脚本只报告「不适用」
 *
 * 只读。检查静态资源限制、404 行为、_headers/_redirects 位置，以及首页引用的同源资源。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const getArg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

const PLANS = {
  free: { limit: 20000, label: "Free" },
  paid: { limit: 100000, label: "Paid" },
};
const TARGETS = ["pages", "workers"];
const WORKERS_MIN_VERSION = [4, 34, 0];
const MODES = ["static", "spa", "ssg", "ssr"];
const fmt = (n) => n.toLocaleString("en-US");

/**
 * 解析版本号：只接受「可选范围前缀 + 点分数字」。
 * `4.x`、`abc`、`4.34.0-beta.1`、空串都视为「无法确认」，宁可退回 Free 也不猜。
 * 导出以便测试直接覆盖非法版本与补丁版本边界。
 */
export function parseVersion(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/^[v^~><=\s]*(\d+(?:\.\d+)*)\s*$/);
  if (!m) return null;
  const parts = m[1].split(".").map(Number);
  return { raw: m[1], parts, major: parts[0] };
}

/** 完整版本比较，短版本按 0 补齐；避免把 4.9 当成比 4.34 新。 */
export function compareVersions(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 决定「本次实际用哪个上限」。导出以便单元测试直接测边界，不用真造两万个文件。
 * 只有 declaredPlan === "paid" 且目标明确、对应证据齐全，才允许放宽到 100,000。
 * opts: { target, wranglerVersion, wranglerMajor（旧字段，兼容）, pagesMajor }
 */
export function resolvePlan(declaredPlan, opts = {}) {
  if (!PLANS[declaredPlan]) return null;
  const target = TARGETS.includes(opts.target) ? opts.target : null;
  // 兼容只给主版本的旧调用：按 [major] 参与比较，因此不能证明 >= 4.34.0。
  let version = null;
  if (opts.wranglerVersion != null) version = parseVersion(opts.wranglerVersion);
  else if (opts.wranglerMajor != null && Number.isFinite(Number(opts.wranglerMajor))) {
    const major = Number(opts.wranglerMajor);
    version = { raw: String(major), parts: [major], major };
  }
  const pagesMajor = String(opts.pagesMajor ?? "").trim();
  const basis = [];
  const missing = [];
  let requirement = "";

  if (declaredPlan !== "paid") {
    requirement = "默认 Free 上限，不需要套餐证据";
  } else if (target === "pages") {
    requirement = "Pages 需要 Wrangler v4 + PAGES_WRANGLER_MAJOR_VERSION=4";
    if (version && version.major >= 4) basis.push(`Wrangler ${version.raw}`);
    else missing.push("Wrangler 主版本 >= 4 未确认或版本非法（--wrangler-version 4，或项目 package.json 声明 wrangler@^4）");
    if (pagesMajor === "4") basis.push("PAGES_WRANGLER_MAJOR_VERSION=4");
    else missing.push("PAGES_WRANGLER_MAJOR_VERSION=4 未确认（Pages 项目设置/CI 环境变量；--pages-wrangler-major 4）");
  } else if (target === "workers") {
    requirement = "Workers Static Assets 需要 Wrangler >= 4.34.0（不需要 Pages 环境变量）";
    if (version && compareVersions(version.parts, WORKERS_MIN_VERSION) >= 0) basis.push(`Wrangler ${version.raw} >= 4.34.0`);
    else missing.push("Wrangler >= 4.34.0 未确认或版本非法（官方 Workers Limits；--wrangler-version 4.34.0，或 package.json 声明 wrangler@^4.34.0）");
  } else {
    requirement = "部署目标未知：不擅自套用任何放宽条件";
    missing.push("未提供 --target pages|workers，无法确认部署目标及其启用条件");
  }

  const effective = declaredPlan === "paid" && missing.length === 0 ? "paid" : "free";
  const limit = PLANS[effective].limit;
  const planInfo = {
    declared: declaredPlan,
    effective,
    limit,
    target,
    requirement,
    basis,
    missing,
    note: "本地只核对显式参数、环境变量与项目依赖；账号套餐与 Pages 项目设置里的变量仍需人工确认",
  };
  const limitReason = effective === "paid"
    ? `Paid 上限 ${fmt(limit)} 已按证据启用（${requirement}：${basis.join(" + ")}）`
    : declaredPlan === "paid"
      ? `声明 paid 但证据不足（${missing.join("；")}），仍按 Free 上限 ${fmt(limit)} 判定`
      : `默认 Free 上限 ${fmt(limit)}（未声明 --plan paid）`;
  return { planInfo, limitReason };
}

/** 按生效上限判定文件数，detail 里写明当前上限与判定原因。 */
export function evaluateFileCount(count, planInfo, limitReason) {
  const limit = planInfo.limit;
  const over = count > limit;
  return {
    status: over ? "fail" : "pass",
    detail: over
      ? `${count} 个文件，超出当前生效上限 ${fmt(limit)}（${planInfo.effective}）；${limitReason}`
      : `${count} / ${fmt(limit)} 个文件（${planInfo.effective} 上限）：${limitReason}`,
    actual: count,
    limit,
    plan: planInfo.effective,
    declaredPlan: planInfo.declared,
    reason: limitReason,
  };
}

// Wrangler 完整版本的本地证据：显式参数 > 环境变量 > 从产物目录向上找 package.json。
// 故意不调用 `wrangler --version`：本脚本是只读的产物检查，npx 可能联网下载，且产物目录
// 通常不是项目根。返回原始字符串交给 parseVersion 解析，拿不到就由调用方退回 Free。
function readWranglerVersion(dir) {
  const explicit = getArg("--wrangler-version") || process.env.CF_DEPLOY_WRANGLER_VERSION || null;
  if (explicit) return String(explicit).trim();
  let d = dir || process.cwd();
  for (let i = 0; i < 4; i++) {
    const pj = path.join(d, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
        const spec = pkg?.devDependencies?.wrangler || pkg?.dependencies?.wrangler || null;
        if (spec) return String(spec).trim();
      } catch { /* 不是 JSON 就跳过 */ }
    }
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return null;
}

function emit(result, tail) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const c of result.checks) {
      const mark = { pass: "通过", warn: "警告", fail: "失败", skip: "跳过" }[c.status] || c.status;
      console.log(`[${mark}] ${c.id}: ${c.detail}`);
    }
    console.log(`\n${tail}`);
  }
}

function main() {
  const modeArg = argv.includes("--spa") ? "spa" : (getArg("--mode") || "static");
  const dirArg = getArg("--dir");
  const declaredPlan = getArg("--plan", "free");
  const targetArg = getArg("--target");

  if (!MODES.includes(modeArg)) {
    console.error(`未知模式：${modeArg}；只支持 ${MODES.join(" / ")}`);
    return 2;
  }
  if (!PLANS[declaredPlan]) {
    console.error(`未知套餐：${declaredPlan}；只支持 ${Object.keys(PLANS).join(" / ")}`);
    return 2;
  }
  if (targetArg && !TARGETS.includes(targetArg)) {
    console.error(`未知部署目标：${targetArg}；只支持 ${TARGETS.join(" / ")}`);
    return 2;
  }

  const mode = modeArg;
  const dir = dirArg ? path.resolve(dirArg) : null;
  const checks = [];
  const push = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });

  // 放宽条件按部署目标分流；目标未知或证据不足一律退回 Free。
  const { planInfo, limitReason } = resolvePlan(declaredPlan, {
    target: targetArg,
    wranglerVersion: readWranglerVersion(dir),
    pagesMajor: getArg("--pages-wrangler-major", process.env.PAGES_WRANGLER_MAJOR_VERSION || ""),
  });
  const { effective: effectivePlan, limit } = planInfo;

  // SSR 没有「可上传的静态产物目录」，文件数/404 检查在这里没有意义。
  if (mode === "ssr") {
    const result = {
      schemaVersion: 2,
      dir,
      mode,
      plan: planInfo,
      summary: { files: 0, totalBytes: 0, totalMiB: 0, assetsChecked: 0, blocking: 0, warnings: 0 },
      checks: [{ id: "mode-ssr", status: "skip", detail: "SSR 模式没有静态产物目录；跳过文件数/404 检查，改用 verify-deployment.mjs --mode ssr 验收首页、API 和服务端渲染内容" }],
    };
    emit(result, `模式=${mode}，SSR 没有静态产物目录，文件数上限 ${fmt(limit)}（${effectivePlan}）不适用`);
    return 0;
  }

  if (!dirArg) {
    console.error("用法：node scripts/check-build.mjs --dir <输出目录> [--mode static|spa|ssg|ssr] [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0] [--pages-wrangler-major 4] [--json]");
    return 2;
  }

  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    emit(
      { schemaVersion: 2, dir, mode, plan: planInfo, checks: [{ id: "exists", status: "fail", detail: "输出目录不存在" }] },
      `输出目录不存在；当前文件数上限 ${fmt(limit)}（${effectivePlan}）`
    );
    return 1;
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
  const MAX_FILE = 25 * 1024 * 1024;

  push("exists", "pass", `${files.length} 个文件，${(total / 1024 / 1024).toFixed(2)} MiB`);

  if (declaredPlan === "paid") {
    push(
      "plan",
      effectivePlan === "paid" ? "pass" : "warn",
      effectivePlan === "paid"
        ? `按 Paid 上限 ${fmt(limit)} 检查：${planInfo.requirement}；证据 ${planInfo.basis.join(" + ")}；账号套餐与 Pages 项目设置仍需人工确认`
        : `声明 --plan paid 但条件不满足，仍按 Free ${fmt(limit)} 检查：${planInfo.requirement}；缺 ${planInfo.missing.join("；")}`,
      { declared: declaredPlan, effective: effectivePlan, limit, target: planInfo.target, requirement: planInfo.requirement, basis: planInfo.basis, missing: planInfo.missing }
    );
  }

  const fc = evaluateFileCount(files.length, planInfo, limitReason);
  push("file-count", fc.status, fc.detail, {
    actual: fc.actual, limit: fc.limit, plan: fc.plan, declaredPlan: fc.declaredPlan, reason: fc.reason,
  });

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
    plan: planInfo,
    summary: {
      files: files.length,
      totalBytes: total,
      totalMiB: Number((total / 1024 / 1024).toFixed(2)),
      largest: sizes.slice(0, 5),
      assetsChecked: checkedAssets,
      fileLimit: limit,
      effectivePlan,
      target: planInfo.target,
      blocking,
      warnings: checks.filter((c) => c.status === "warn").length,
    },
    checks,
  };

  emit(result, `模式=${mode}，${files.length} 个文件，${result.summary.totalMiB} MiB，目标=${planInfo.target || "未知"}，套餐=${effectivePlan}（上限 ${fmt(limit)}），阻断项=${blocking}`);
  return blocking ? 1 : 0;
}

// 用 exitCode 而不是 process.exit()：Windows 上偶发 0xC0000409，会把已输出的 JSON 判成失败。
// 主模块守卫：测试可以 import 上面的纯函数，而不会触发一次真实检查。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
