#!/usr/bin/env node
/**
 * select-platform.mjs — 部署适配度评分与多平台初选（迭代 2，平台能力矩阵驱动）。
 *
 * 用法：
 *   node scripts/select-platform.mjs [--project <目录|JSON 文件|->] [--render <模式>]
 *     [--backend <形态>] [--audience <地域>] [--budget <预算>] [--human]
 *
 * 默认输出 JSON；--human 输出中文摘要。只读、不上传、不写项目文件、不访问网络。
 * 不传 --project 且不传 --render 时，默认对当前目录运行 detect-project.mjs。
 *
 * 退出码：0 = 有可用结论；1 = 信息不足，暂不选型；2 = 用法错误。
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadMatrix, filterCandidates, selectPlatforms, platformDetails, MatrixError } from "./platform-matrix.mjs";

const SCHEMA_VERSION = 2;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const RENDER_MODES = ["static", "ssg", "spa", "ssr", "fullstack", "api"];
const BACKENDS = ["none", "serverless", "postgres-auth-storage", "long-running", "unknown"];
const AUDIENCES = ["overseas", "mainland", "unknown"];
const BUDGETS = ["free", "paid", "unknown"];

const MAINLAND_NOTICE = [
  "Vercel 的 *.vercel.app 默认域名在中国大陆已被 DNS 污染，直接访问通常超时；绑定自定义域名可能改善，但 Vercel 官方明确不保证中国大陆的可用性或性能。",
  "GitHub Pages 的 *.github.io 在中国大陆访问不稳定，部分网络环境不可达。",
  "Netlify 的 *.netlify.app 同样常无法直接访问。",
  "Cloudflare Pages 的 *.pages.dev 通常可达性更好，但也不是中国大陆合规托管。",
  "换自定义域名只能缓解，不能保证稳定；稳定大陆访问需要 ICP 备案 + 国内云 / CDN。",
];

const MAINLAND_ROUTES = [
  { id: "A", text: "接受海外托管 + 自定义域名 + 自托管关键资源，但承认可能被限速或阻断。" },
  { id: "B", text: "走 ICP 备案 + 国内云 / CDN，获得稳定大陆访问。" },
];

class UsageError extends Error {}
class AnalysisError extends Error {}

function parseArgs(argv) {
  const opts = { project: null, render: null, backend: null, audience: null, budget: null, human: false, help: false };
  const valueFlags = new Set(["--project", "--render", "--backend", "--audience", "--budget"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--human") { opts.human = true; continue; }
    if (arg === "--json") { opts.human = false; continue; }
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new UsageError(`${arg} 需要一个值`);
      }
      opts[arg.slice(2)] = value;
      continue;
    }
    if (arg.startsWith("--")) throw new UsageError(`未知参数 ${arg}`);
    throw new UsageError(`不支持的位置参数 ${arg}`);
  }
  return opts;
}

function validateEnum(value, allowed, flag) {
  if (value === null) return null;
  if (!allowed.includes(value)) {
    throw new UsageError(`${flag} 只接受 ${allowed.join(" / ")}，收到 ${value}`);
  }
  return value;
}

function readJsonText(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${label} 不是合法 JSON：${error.message}`);
  }
}

function loadProject(projectArg) {
  if (!projectArg) return { data: null, source: "flags" };
  if (projectArg === "-") {
    return { data: readJsonText(fs.readFileSync(0, "utf8"), "stdin"), source: "stdin" };
  }
  const abs = path.resolve(projectArg);
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new UsageError(`--project 路径不存在：${abs}`);
  }
  if (stat.isDirectory()) {
    const detectScript = path.join(HERE, "detect-project.mjs");
    const run = spawnSync(process.execPath, [detectScript, abs], { encoding: "utf8", timeout: 60000 });
    if (run.status !== 0) {
      throw new AnalysisError(`detect-project.mjs 执行失败：${String(run.stderr || run.stdout || run.error || run.status).trim().slice(0, 300)}`);
    }
    return { data: readJsonText(run.stdout, "detect-project 输出"), source: "detect-project" };
  }
  return { data: readJsonText(fs.readFileSync(abs, "utf8"), abs), source: "project-json" };
}

function dimension(value, confidence, source) {
  return { value: value ?? "unknown", confidence, source };
}

function deriveRender(data) {
  const project = data?.project || {};
  const mode = project.suggestedMode;
  if (["static", "ssg", "spa", "ssr"].includes(mode)) {
    return dimension(mode, data?.evidence?.kind?.confidence || "inferred", `detect-project: project.suggestedMode=${mode}`);
  }
  if (project.kind === "fullstack") {
    return dimension("fullstack", "inferred", "detect-project: project.kind=fullstack");
  }
  if (project.kind === "api") {
    return dimension("api", "inferred", "detect-project: project.kind=api");
  }
  return dimension("unknown", "unknown", "detect-project 未能确认项目类型");
}

function deriveBackend(data, render, explicit) {
  if (explicit) return dimension(explicit, explicit === "unknown" ? "unknown" : "confirmed", "用户输入");
  const project = data?.project || {};
  const cloudflare = data?.cloudflare || {};
  if (cloudflare.functionsDir || cloudflare.workerJs) {
    return dimension("serverless", "inferred", "检测到 Pages Functions 或 _worker.js；仍需确认运行时和额度");
  }
  if (["express", "nestjs", "koa", "fastify"].includes(project.framework) && ["api", "fullstack", "ssr"].includes(render)) {
    return dimension("long-running", "inferred", `框架 ${project.framework} 通常需要长期运行服务；仍需确认部署形态`);
  }
  if (project.framework === "hono") {
    return dimension("serverless", "inferred", "Hono 通常运行在 Workers / Serverless 运行时");
  }
  const envKeys = data?.runtime?.envKeys || [];
  if (envKeys.some((key) => /SUPABASE_URL|SUPABASE_ANON_KEY|SUPABASE_SERVICE|DATABASE_URL|POSTGRES/i.test(key))) {
    return dimension("postgres-auth-storage", "inferred", "环境变量键名提示 Supabase / PostgreSQL；仍需确认后端范围，不读取键值");
  }
  if (["static", "ssg", "spa"].includes(render)) {
    return dimension("none", "inferred", "静态 / SPA 产物默认不包含托管后端；如使用 Supabase 或外部 API，后端不随前端迁移");
  }
  if (["ssr", "fullstack", "api"].includes(render)) {
    return dimension("unknown", "unknown", "检测到服务端 / 全栈，但无法区分 Serverless、Supabase 或长期运行");
  }
  return dimension("unknown", "unknown", "渲染模式未知，后端需求也无法判断");
}

function deriveAudience(explicit) {
  if (explicit) return dimension(explicit, explicit === "unknown" ? "unknown" : "confirmed", "用户输入");
  return dimension("unknown", "unknown", "用户未说明；按含中国大陆处理");
}

function deriveBudget(explicit) {
  if (explicit) return dimension(explicit, explicit === "unknown" ? "unknown" : "confirmed", "用户输入");
  return dimension("unknown", "unknown", "用户未说明；按免费优先处理");
}

function buildGuidance({ render, backend, budget }) {
  return {
    domain: "如需自定义域名，先确认主要面向海外还是中国大陆；海外可选 Cloudflare Registrar / Porkbun / Namecheap / NameSilo，中国大陆可选腾讯云 / 阿里云并评估 ICP 备案。",
    paid: budget === "paid"
      ? "可按 Cloudflare Workers Paid（$5/月起）或 Vercel Pro（$20/月起）比较；先确认实际超限项，不要默认升级。"
      : "免费优先；额度不够时先确认超限项，轻度超限先优化构建、缓存和资源体积。",
    backend: backend === "postgres-auth-storage"
      ? "推荐 Supabase 作为托管后端，前端仍部署到静态平台；数据库连接串和 Auth 密钥只放平台环境变量。"
      : backend === "long-running"
        ? "长期运行服务优先 Render Web Service、Railway、Fly.io；前端仍可单独部署到静态平台；免费 Render Web Service 15 分钟无流量休眠。"
        : backend === "serverless"
          ? "轻后端优先 Cloudflare Workers / Pages Functions + D1 / KV，或 Vercel / Netlify Functions；先确认运行时兼容和额度。"
          : "未检测到必须迁移的后端；如使用 Supabase 或外部 API，只迁前端，后端不动。",
    cloudflare_path: "如选 Cloudflare，仍按 platform-selection.md 的三问在 Pages / Workers 之间选择；静态免费层默认 Pages。",
    verification: "先部署到预览地址，再用 verify-deployment.mjs 做 HTTP 验收；SSR / 数据库 / 登录 / 第三方回调仍需专项验证，没测就写“未验证”。",
  };
}

function buildResult({ source, projectData, renderDim, backendDim, audienceDim, budgetDim, matrix, matrixError }) {
  const render = renderDim.value;
  const backend = backendDim.value;
  const audience = audienceDim.value;
  const budget = budgetDim.value;
  let candidates = [];
  let excluded = [];
  if (matrix) {
    ({ candidates, excluded } = filterCandidates({ matrix, render, backend, budget }));
  }
  const mainland = audience !== "overseas";
  const selection = matrix && candidates.length
    ? selectPlatforms({ matrix, render, backend, audience, budget, candidates, excluded })
    : null;

  if (selection && backend === "postgres-auth-storage") {
    const supabase = platformDetails(matrix, "supabase");
    selection.backend = supabase
      ? { ...supabase, reason: "需要 PostgreSQL / Auth / Storage；前端仍部署到静态平台，后端不随前端迁移" }
      : null;
  } else if (selection) {
    selection.backend = null;
  }

  const warnings = [];
  const questions = [];
  if (matrixError) {
    warnings.push(`平台矩阵不可用：${matrixError.message}`);
    questions.push("按 SKILL.md 第 2 步手工核对平台能力矩阵，再决定首选 / 备选 / 不推荐。");
  }
  if (renderDim.value === "unknown") {
    warnings.push("渲染模式未确认，暂不进入选型。");
    questions.push("项目是纯静态、SSG、SPA、SSR 还是全栈？");
  }
  if (backendDim.confidence === "unknown") {
    warnings.push("后端形态未确认：Serverless、Supabase 与长期运行服务的选型不同。");
    questions.push("项目是否需要后端或数据库？无 / Serverless / PostgreSQL+Auth+Storage / 长期运行或 Docker");
  } else if (backendDim.value === "postgres-auth-storage" && backendDim.confidence === "inferred") {
    warnings.push("检测到 Supabase / 数据库环境变量键名，已按 PostgreSQL + Auth + Storage 评估；请确认后端范围。");
  }
  if (audienceDim.confidence === "unknown") {
    warnings.push("目标用户地域未说明，已按含中国大陆处理并输出风险提示。");
    questions.push("目标用户主要面向海外，还是包含中国大陆？");
  }
  if (budgetDim.confidence === "unknown") {
    warnings.push("预算未说明，已按免费优先排序；愿意付费时可比较 Workers Paid / Vercel Pro / Railway / Fly.io。");
    questions.push("预算是否只考虑免费额度？");
  }
  if (projectData?.project?.workspaces?.length) {
    warnings.push("Monorepo：先确认要部署哪个子应用，当前评分针对整个仓库。");
    questions.push("Monorepo 里要部署哪个子应用？");
  }

  const relevantIds = new Set([
    ...candidates,
    ...excluded.map((e) => e.id),
    ...(selection?.backup || []).map((b) => b.id),
    ...(selection?.not_recommended || []).map((n) => n.id),
    ...(selection?.backend ? [selection.backend.id] : []),
  ]);
  const platforms = {};
  for (const id of relevantIds) {
    const details = platformDetails(matrix, id);
    if (details) platforms[id] = details;
  }

  const result = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source,
    fit: {
      render_mode: renderDim,
      backend: backendDim,
      audience: audienceDim,
      budget: budgetDim,
    },
    candidates,
    excluded: excluded.map((e) => ({
      id: e.id,
      name: platformDetails(matrix, e.id)?.name || e.id,
      reason: e.reason,
    })),
    selection,
    risk: {
      mainland_china: mainland,
      level: audience === "mainland" ? "high" : audience === "unknown" ? "unknown" : "none",
      notice: mainland ? MAINLAND_NOTICE : [],
      routes: mainland ? MAINLAND_ROUTES : [],
    },
    guidance: buildGuidance({ render, backend, budget }),
    platforms,
    warnings,
    questions,
    degraded: Boolean(matrixError) || renderDim.value === "unknown" || backendDim.confidence === "unknown" || audienceDim.confidence === "unknown" || budgetDim.confidence === "unknown",
  };
  return result;
}

const LABELS = {
  render: { static: "纯静态", ssg: "SSG", spa: "SPA", ssr: "SSR", fullstack: "全栈", api: "API", unknown: "未知" },
  backend: { none: "无", serverless: "Serverless / 轻后端", "postgres-auth-storage": "PostgreSQL + Auth + Storage", "long-running": "长期运行 / Docker", unknown: "未确认" },
  audience: { overseas: "主要海外", mainland: "含中国大陆", unknown: "未明确（按含中国大陆处理）" },
  budget: { free: "免费优先", paid: "愿意付费", unknown: "未说明（按免费优先）" },
};

function formatHuman(result, matrix) {
  const { fit, selection, risk } = result;
  const lines = ["【项目部署适配度】"];
  lines.push(`- 渲染模式：${LABELS.render[fit.render_mode.value]}（${fit.render_mode.confidence}）`);
  lines.push(`- 后端需求：${LABELS.backend[fit.backend.value]}（${fit.backend.confidence}）`);
  lines.push(`- 目标用户：${LABELS.audience[fit.audience.value]}（${fit.audience.confidence}）`);
  lines.push(`- 预算：${LABELS.budget[fit.budget.value]}（${fit.budget.confidence}）`);
  if (result.candidates.length) {
    lines.push(`- 候选平台：${result.candidates.map((id) => platformDetails(matrix, id)?.name || id).join(" / ")}`);
  }
  if (result.excluded.length) {
    const shown = result.excluded.slice(0, 3).map((e) => `${e.name}（${e.reason}）`).join("；");
    lines.push(`- 排除平台：${shown}${result.excluded.length > 3 ? `；等 ${result.excluded.length} 个` : ""}`);
  }
  if (!selection || !selection.primary) {
    lines.push("- 推荐首选：暂不选型（缺平台矩阵或渲染模式未确认）");
  } else {
    lines.push(`- 推荐首选：${selection.primary.name}（${selection.primary.reason}）`);
    lines.push(`- 免费额度：${selection.primary.free_tier_key_points.join("；")}`);
    lines.push(`- 主要限制：${selection.primary.limits}`);
    lines.push(`- 备选：${selection.backup.length ? selection.backup.map((b) => `${b.name}（${b.condition}）`).join("；") : "无"}`);
    lines.push(`- 不推荐：${selection.not_recommended.length ? selection.not_recommended.map((n) => `${n.name}（${n.reason}）`).join("；") : "无"}`);
    if (selection.backend) lines.push(`- 后端建议：${selection.backend.name}（${selection.backend.reason}）`);
  }

  if (risk.mainland_china) {
    lines.push("");
    lines.push("【中国大陆访问风险】");
    for (const item of risk.notice) lines.push(`- ${item}`);
    lines.push("");
    lines.push("【两条路线】");
    for (const route of risk.routes) lines.push(`${route.id}. ${route.text}`);
  }

  if (result.warnings.length) {
    lines.push("");
    lines.push("【需要确认】");
    for (const warning of result.warnings) lines.push(`- ${warning}`);
  }
  if (result.questions.length) {
    lines.push("");
    lines.push("【需要你补充】");
    for (const question of result.questions) lines.push(`- ${question}`);
  }

  lines.push("");
  lines.push("【下一步】");
  const cloudflareInPool = result.candidates.includes("cloudflare-pages")
    || selection?.primary?.id === "cloudflare-pages"
    || selection?.backup?.some((b) => b.id === "cloudflare-pages");
  if (cloudflareInPool) lines.push(`- ${result.guidance.cloudflare_path}`);
  lines.push(`- ${result.guidance.verification}`);
  return lines.join("\n");
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log("用法：node scripts/select-platform.mjs [--project <目录|JSON 文件|->] [--render static|ssg|spa|ssr|fullstack|api] [--backend none|serverless|postgres-auth-storage|long-running|unknown] [--audience overseas|mainland|unknown] [--budget free|paid|unknown] [--human]");
      console.log("默认输出 JSON；只读、不上传、不写项目文件、不访问网络。不传 --project 且不传 --render 时，对当前目录运行 detect-project.mjs。");
      return 0;
    }

    validateEnum(opts.render, RENDER_MODES, "--render");
    validateEnum(opts.backend, BACKENDS, "--backend");
    validateEnum(opts.audience, AUDIENCES, "--audience");
    validateEnum(opts.budget, BUDGETS, "--budget");

    const projectArg = opts.project || (!opts.render ? process.cwd() : null);
    const { data, source } = loadProject(projectArg);

    const renderDim = opts.render
      ? dimension(opts.render, "confirmed", "用户输入")
      : deriveRender(data);
    const backendDim = deriveBackend(data, renderDim.value, opts.backend);
    const audienceDim = deriveAudience(opts.audience);
    const budgetDim = deriveBudget(opts.budget);

    let matrix = null;
    let matrixError = null;
    try {
      matrix = loadMatrix();
    } catch (error) {
      if (error instanceof MatrixError) matrixError = error;
      else throw error;
    }

    const result = buildResult({
      source,
      projectData: data,
      renderDim,
      backendDim,
      audienceDim,
      budgetDim,
      matrix,
      matrixError,
    });

    if (opts.human) {
      console.log(formatHuman(result, matrix));
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    return renderDim.value === "unknown" || !result.selection?.primary ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`用法错误：${error.message}`);
      return 2;
    }
    console.error(`无法完成评分：${error.message}`);
    return 1;
  }
}

const isMain = (() => {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
})();
if (isMain) process.exitCode = main();
