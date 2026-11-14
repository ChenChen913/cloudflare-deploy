#!/usr/bin/env node
/**
 * check-build.mjs — 部署前检查静态构建产物。
 *
 * 用法：
 *   node scripts/check-build.mjs --dir dist [--mode static|spa|ssg|ssr] [--plan free|paid] [--json]
 *   node scripts/check-build.mjs --dir dist --plan paid --wrangler-version 4 \
 *     --pages-wrangler-major 4 [--json]
 *
 * 套餐与文件数（Cloudflare Pages / Workers Static Assets，2026-11 官方 Limits）：
 *   Free  20,000 文件 —— 默认，不需要任何额外信息。
 *   Paid  最多 100,000 文件 —— 只有显式 --plan paid 才考虑；Pages 还必须在项目设置里
 *         设置 PAGES_WRANGLER_MAJOR_VERSION=4 并用 Wrangler v4 构建。
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
const MODES = ["static", "spa", "ssg", "ssr"];
const fmt = (n) => n.toLocaleString("en-US");

/**
 * 决定「本次实际用哪个上限」。导出以便单元测试直接测边界，不用真造两万个文件。
 * 只有 declaredPlan === "paid" 且两项证据齐全，才允许放宽到 100,000。
 */
export function resolvePlan(declaredPlan, opts = {}) {
  if (!PLANS[declaredPlan]) return null;
  const wranglerMajor = opts.wranglerMajor ?? null;
  const pagesMajor = String(opts.pagesMajor ?? "").trim();
  const basis = [];
  const missing = [];
  if (wranglerMajor !== null && wranglerMajor >= 4) basis.push(`Wrangler v${wranglerMajor}`);
  else missing.push("Wrangler 主版本 >= 4 未确认（--wrangler-version 4，或项目 package.json 声明 wrangler@^4）");
  if (pagesMajor === "4") basis.push("PAGES_WRANGLER_MAJOR_VERSION=4");
  else missing.push("PAGES_WRANGLER_MAJOR_VERSION=4 未确认（Pages 项目设置/CI 环境变量；--pages-wrangler-major 4）");

  const effective = declaredPlan === "paid" && missing.length === 0 ? "paid" : "free";
  const limit = PLANS[effective].limit;
  const planInfo = {
    declared: declaredPlan,
    effective,
    limit,
    basis,
    missing,
    note: "本地只核对显式参数、环境变量与项目依赖；账号套餐与 Pages 项目设置里的变量仍需人工确认",
  };
  const limitReason = effective === "paid"
    ? `Paid 上限 ${fmt(limit)} 已按证据启用（${basis.join(" + ")}）`
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

// Wrangler 主版本的本地证据：显式参数 > 环境变量 > 从产物目录向上找 package.json。
// 故意不调用 `wrangler --version`：本脚本是只读的产物检查，npx 可能联网下载，且产物目录
// 通常不是项目根。拿不到版本就返回 null，由调用方决定是否放宽。
function readWranglerMajor(dir) {
  const explicit = getArg("--wrangler-version") || process.env.CF_DEPLOY_WRANGLER_VERSION || null;
  if (explicit) {
    const m = String(explicit).match(/\d+/);
    return m ? Number(m[0]) : null;
  }
  let d = dir || process.cwd();
  for (let i = 0; i < 4; i++) {
    const pj = path.join(d, "package.json");
    if (fs.existsSync(pj)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pj, "utf8"));
        const spec = pkg?.devDependencies?.wrangler || pkg?.dependencies?.wrangler || null;
        if (spec) {
          const m = String(spec).match(/\d+/);
          if (m) return Number(m[0]);
        }
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

  if (!MODES.includes(modeArg)) {
    console.error(`未知模式：${modeArg}；只支持 ${MODES.join(" / ")}`);
    return 2;
  }
  if (!PLANS[declaredPlan]) {
    console.error(`未知套餐：${declaredPlan}；只支持 ${Object.keys(PLANS).join(" / ")}`);
    return 2;
  }

  const mode = modeArg;
  const dir = dirArg ? path.resolve(dirArg) : null;
  const checks = [];
  const push = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });

  // --plan paid 只有同时满足两个条件才生效；缺一就不放宽。
  const { planInfo, limitReason } = resolvePlan(declaredPlan, {
    wranglerMajor: readWranglerMajor(dir),
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
    console.error("用法：node scripts/check-build.mjs --dir <输出目录> [--mode static|spa|ssg|ssr] [--plan free|paid] [--json]");
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
        ? `按 Paid 上限 ${fmt(limit)} 检查：${planInfo.basis.join(" + ")}；账号套餐与 Pages 项目设置仍需人工确认`
        : `声明 --plan paid 但条件不满足，仍按 Free ${fmt(limit)} 检查：${planInfo.missing.join("；")}`,
      { declared: declaredPlan, effective: effectivePlan, limit, basis: planInfo.basis, missing: planInfo.missing }
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
      blocking,
      warnings: checks.filter((c) => c.status === "warn").length,
    },
    checks,
  };

  emit(result, `模式=${mode}，${files.length} 个文件，${result.summary.totalMiB} MiB，套餐=${effectivePlan}（上限 ${fmt(limit)}），阻断项=${blocking}`);
  return blocking ? 1 : 0;
}

// 用 exitCode 而不是 process.exit()：Windows 上偶发 0xC0000409，会把已输出的 JSON 判成失败。
// 主模块守卫：测试可以 import 上面的纯函数，而不会触发一次真实检查。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = main();
