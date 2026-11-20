#!/usr/bin/env node
/**
 * migration-plan.mjs — 跨平台迁移计划与报告骨架（迭代 3）。
 *
 * 用法：
 *   node scripts/migration-plan.mjs --source <平台> --target <平台> --project-type <类型>
 *     [--build-command <命令>] [--output-dir <目录>] [--env-keys "A,B"]
 *     [--domain <域名>] [--dns-provider <提供商>] [--retain-days 7]
 *     [--human] [--report]
 *
 * 平台：github-pages / cloudflare-pages / vercel / netlify / render。
 * 默认输出 JSON；--human 输出迁移计划；--report 只输出报告骨架。
 * 只读、不上传、不写项目文件、不访问网络、不执行 DNS / 部署 / 数据库操作。
 *
 * 退出码：0 = 已生成计划；1 = 目标平台不支持或矩阵不可用；2 = 用法错误。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMatrix, MatrixError } from "./platform-matrix.mjs";

const SCHEMA_VERSION = 1;

const PROJECT_TYPES = ["static", "ssg", "spa", "ssr", "fullstack"];
const PLATFORM_ALIASES = {
  "github-pages": "github-pages",
  "cloudflare-pages": "cloudflare-pages",
  "cloudflare-workers": "cloudflare-workers",
  vercel: "vercel-hobby",
  "vercel-pro": "vercel-pro",
  netlify: "netlify-free",
  render: "render-free",
};
const MIGRATION_PLATFORMS = Object.keys(PLATFORM_ALIASES);

const IMPORT_ACTIONS = {
  "github-pages": "推送到部署分支，或走 GitHub Actions 发布",
  "cloudflare-pages": "Cloudflare Dashboard → Workers & Pages → Create application → Pages → Import an existing Git repository；填写构建命令和输出目录；或使用 wrangler pages deploy",
  "cloudflare-workers": "使用 wrangler 部署 Worker，或 Workers Builds 导入仓库；确认静态资源、SSR 入口和绑定，不要把 Workers 配置当成 Pages",
  vercel: "在 Vercel 导入同一仓库，或使用 vercel CLI；先确认框架预设和输出目录",
  "vercel-pro": "在 Vercel 导入同一仓库，确认项目已升级到 Pro；商业用途不要回到 Hobby",
  netlify: "在 Netlify 导入同一仓库，或使用 netlify deploy；构建配置写在 netlify.toml",
  render: "在 Render 导入同一仓库或使用 Blueprint；静态站选 Static Site，常驻服务选 Web Service",
};

const MODE_BY_PROJECT_TYPE = {
  static: "static",
  ssg: "ssg",
  spa: "spa",
  ssr: "ssr",
  fullstack: "ssr",
};

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    source: null,
    target: null,
    projectType: null,
    buildCommand: null,
    outputDir: null,
    envKeys: [],
    domain: null,
    dnsProvider: null,
    retainDays: 7,
    human: false,
    report: false,
    help: false,
  };
  const valueFlags = new Set(["--source", "--target", "--project-type", "--build-command", "--output-dir", "--env-keys", "--domain", "--dns-provider", "--retain-days"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--human") { opts.human = true; continue; }
    if (arg === "--json") { opts.human = false; continue; }
    if (arg === "--report") { opts.report = true; continue; }
    if (arg === "--help" || arg === "-h") { opts.help = true; continue; }
    if (valueFlags.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new UsageError(`${arg} 需要一个值`);
      }
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = value;
      continue;
    }
    if (arg.startsWith("--")) throw new UsageError(`未知参数 ${arg}`);
    throw new UsageError(`不支持的位置参数 ${arg}`);
  }
  if (opts.help) return opts;
  if (!opts.source) throw new UsageError("缺少 --source");
  if (!opts.target) throw new UsageError("缺少 --target");
  if (!opts.projectType) throw new UsageError("缺少 --project-type");
  opts.source = String(opts.source).toLowerCase();
  opts.target = String(opts.target).toLowerCase();
  if (opts.source === opts.target) throw new UsageError("--source 与 --target 相同，无需迁移");
  if (!PROJECT_TYPES.includes(opts.projectType)) {
    throw new UsageError(`--project-type 只接受 ${PROJECT_TYPES.join(" / ")}，收到 ${opts.projectType}`);
  }
  opts.envKeys = parseEnvKeys(opts.envKeys);
  opts.retainDays = parseRetainDays(opts.retainDays);
  for (const key of ["buildCommand", "outputDir", "domain", "dnsProvider"]) {
    if (opts[key] !== null) opts[key] = String(opts[key]).trim();
  }
  return opts;
}

function parseEnvKeys(raw) {
  if (!raw) return [];
  const items = String(raw).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
  const keys = [];
  for (const item of items) {
    if (item.includes("=") || item.includes(":")) {
      throw new UsageError("--env-keys 只接受环境变量键名，不接受键值；不要提供密钥值");
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item)) {
      throw new UsageError(`--env-keys 含非法键名：${item}`);
    }
    if (!keys.includes(item)) keys.push(item);
  }
  if (keys.length > 200) throw new UsageError("--env-keys 最多 200 个键名");
  return keys;
}

function parseRetainDays(raw) {
  if (raw === null || raw === undefined) return 7;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new UsageError("--retain-days 必须是正整数");
  const days = Number(text);
  if (!Number.isSafeInteger(days) || days <= 0) throw new UsageError("--retain-days 必须是正整数");
  return days;
}

function platformOf(matrix, id) {
  const matrixId = PLATFORM_ALIASES[id];
  const platform = matrixId ? matrix?.byId?.[matrixId] : null;
  if (!platform) {
    return {
      id,
      matrix_id: matrixId || null,
      name: id,
      known: false,
      type: null,
      platform: null,
    };
  }
  return {
    id,
    matrix_id: matrixId,
    name: platform.name,
    known: true,
    type: platform.type,
    platform,
  };
}

function supportStatus(target, mode) {
  if (!target.known || !target.platform) return "unknown";
  return target.platform.render_support.includes(mode) ? "supported" : "unsupported";
}

function precheckItems({ source, target, projectType, mode, buildCommand, outputDir, envKeys, domain, dnsProvider, retainDays, support }) {
  const pending = "pending";
  const envDetail = envKeys.length
    ? `已记录 ${envKeys.length} 个键名：${envKeys.join("、")}；仅代表清单已提供，不代表目标平台已配置`
    : "尚未提供环境变量键名；只记录键名，不读取值";
  return [
    {
      id: "build",
      label: "构建命令与输出目录",
      status: buildCommand || outputDir ? "provided" : pending,
      detail: buildCommand || outputDir
        ? `已提供构建：${buildCommand || "未提供"}；输出：${outputDir || "未提供"}；尚未在目标平台构建验证`
        : "需要源平台实际构建命令和输出目录；不要用目标平台默认值代替",
    },
    {
      id: "env",
      label: "环境变量键名",
      status: envKeys.length ? "provided" : pending,
      detail: envDetail,
    },
    {
      id: "domain",
      label: "自定义域名与 DNS",
      status: domain ? "provided" : pending,
      detail: domain
        ? `已提供域名：${domain}；DNS 提供商：${dnsProvider || "未提供"}；DNS 记录和 TTL 尚未核实`
        : "尚未提供自定义域名和 DNS 提供商；切换前必须确认",
    },
    {
      id: "redirects",
      label: "重定向 / headers / 平台配置",
      status: pending,
      detail: `源：${source.platform?.migration_notes?.redirects || "按源平台配置核对"}；目标：${target.platform?.migration_notes?.redirects || "按目标平台配置核对"}`,
    },
    {
      id: "features",
      label: "平台特有能力依赖",
      status: pending,
      detail: source.platform?.migration_notes?.platform_features?.join("、") || "逐项核对源平台特有能力并找替代方案",
    },
    {
      id: "retention",
      label: "回滚保留时长",
      status: "provided",
      detail: `计划保留 ${retainDays} 天；这是计划值，不是验证结果；关键业务建议 2–4 周`,
    },
    {
      id: "target_support",
      label: "目标平台渲染支持",
      status: support === "supported" ? "inferred" : support === "unsupported" ? "blocked" : pending,
      detail: support === "supported"
        ? `${target.name} 的矩阵声明支持 ${mode}；这是矩阵推断，仍需用目标预览验证`
        : support === "unsupported"
          ? `${target.name} 的矩阵未声明支持 ${mode}；不要直接迁移，先换平台或改用 Functions / Edge / Workers 并另行评估`
          : "目标平台不在矩阵中，无法自动判断渲染支持；按目标平台文档人工确认",
    },
    {
      id: "verification",
      label: "目标预览验收",
      status: pending,
      detail: "首页、关键内页、静态资源、404、重定向、HTTPS；如有 API / SSR，检查运行时兼容和环境变量键名",
    },
    {
      id: "database",
      label: "数据库迁移",
      status: ["ssr", "fullstack"].includes(projectType) ? pending : "not_applicable",
      detail: ["ssr", "fullstack"].includes(projectType)
        ? "如涉及数据库，必须单独备份、staging 导入、数量 / 校验和核对、冻结写入、用户确认；不与平台迁移混在一起"
        : "静态 / SPA 项目默认不迁数据库；如使用 Supabase 或外部 API，后端不随前端迁移",
    },
  ];
}

function buildDualLive({ source, target, projectType, retainDays }) {
  const importAction = IMPORT_ACTIONS[target.id] || "按目标平台官方 Git 集成或 CLI 导入同一仓库";
  const runtimeCheck = ["ssr", "fullstack"].includes(projectType)
    ? "检查 SSR / API 运行时兼容、函数额度、环境变量键名和数据库连接"
    : "抽查深链、404 / SPA 回退、重定向和静态资源同一性";
  return [
    {
      step: 1,
      title: "目标平台预览",
      actions: [importAction, "先使用目标平台免费子域名，不碰正式域名"],
      gate: "目标预览可访问，构建成功",
    },
    {
      step: 2,
      title: "源平台保持在线",
      actions: ["源平台不动，作为回滚目标", "不要删除源站、旧分支或旧 DNS 记录"],
      gate: "源站仍可访问，回滚路径可用",
    },
    {
      step: 3,
      title: "验收清单",
      actions: ["首页、关键内页、静态资源、404、重定向、HTTPS", runtimeCheck],
      gate: "验收通过后才进入域名切换；失败则停止迁移",
    },
    {
      step: 4,
      title: "自定义域名切换",
      actions: ["提前 24–48 小时降低 DNS TTL", "先在目标平台绑定域名", "再按目标平台提示改 CNAME / A / nameserver"],
      gate: "必须用户明确确认；脚本不执行任何 DNS 变更",
    },
    {
      step: 5,
      title: "观察与停用源平台",
      actions: [`源平台至少保留 ${retainDays} 天`, "观察流量、错误日志、Search Console 和核心接口", "确认无异常后再停用源平台"],
      gate: "观察期结束且用户确认",
    },
  ];
}

function buildTips({ source, target, support, projectType }) {
  const tips = [];
  if (source.id === "github-pages" && target.id === "cloudflare-pages") {
    tips.push("GitHub Pages → Cloudflare Pages：Dashboard → Workers & Pages → Create application → Pages → Import an existing Git repository；填写构建命令和输出目录；自定义域名在 Pages 项目 Custom domains 中绑定后再改 DNS。");
  }
  if (source.id === "github-pages" && target.id === "vercel") {
    tips.push("GitHub Pages → Vercel：导入同一仓库，修正 GitHub Pages 需要的 base path；自定义域名按 Vercel 提示的 DNS 记录迁移；重定向放在 vercel.json。");
  }
  if (source.id === "cloudflare-pages" && target.id === "cloudflare-workers") {
    tips.push("Pages → Workers：Pages 的 _redirects / _headers 与 Workers Static Assets 不完全等价；重新核对 wrangler 配置、绑定、SSR 入口和自定义域名要求。");
  }
  if (source.id === "cloudflare-workers" && target.id === "cloudflare-pages") {
    tips.push("Workers → Pages：确认项目不再依赖 Workers 的 D1 / DO / Queues / Cron；Pages Functions 不能替代全部 Workers 能力。");
  }
  if (source.id === "vercel" && target.id === "vercel-pro") {
    tips.push("Vercel Hobby → Pro：商业用途必须升级；确认计费、团队席位和 Functions 额度，不要把 Hobby 的非商业限制带到生产。");
  }
  if (source.id === "vercel-pro" && target.id === "vercel") {
    tips.push("Vercel Pro → Hobby：确认项目确实是个人非商业；商业项目不要降级到 Hobby。");
  }
  if (target.id === "netlify") {
    tips.push("任意平台 → Netlify：在仓库根目录创建 netlify.toml 管理构建配置，不要只依赖面板设置；重定向和 headers 也写进配置。");
  }
  if (target.id === "render") {
    tips.push("任意平台 → Render：静态站免费；Web Service 15 分钟无流量休眠；如需常驻后端，提前告知冷启动和免费额度限制。");
  }
  if (source.id === "vercel") {
    tips.push("迁移出 Vercel：注意单仓库“源-部署分离”时自动 promote 可能异常；必要时重新导入仓库恢复自动更新。");
  }
  if (source.id === "github-pages") {
    tips.push("迁移出 GitHub Pages：将 deploy branch 切换为 None 即可停止发布，但保留仓库和回滚能力。");
  }
  if (target.id === "cloudflare-pages" && ["ssr", "fullstack"].includes(projectType)) {
    tips.push("Cloudflare Pages 的 SSR / API 依赖 Pages Functions 或框架适配器；新 SSR 项目优先 Workers + vinext / OpenNext，不要把 Pages 当纯静态上传。");
  }
  if (target.id === "cloudflare-workers" && ["ssr", "fullstack"].includes(projectType)) {
    tips.push("Cloudflare Workers 的 SSR 需要框架适配器 / OpenNext；不要复制 Pages Functions 配置，也不要把 Workers 当成 Pages 的别名。");
  }
  if (target.id === "netlify" && ["ssr", "fullstack"].includes(projectType)) {
    tips.push("Netlify 的 SSR 依赖 Functions / Edge；纯静态托管不适用，需另行评估运行时和额度。");
  }
  if (support === "unsupported") {
    tips.push(`目标平台 ${target.name} 未声明支持 ${projectType}；请改用支持该模式的平台，或在目标平台用 Functions / Edge / Workers 承载并另行验证。`);
  }
  tips.push(`源平台 ${source.name}：${source.platform?.migration_notes?.exit || "停用前先导出环境变量键名、域名和配置，保留回滚能力"}`);
  tips.push(`目标平台 ${target.name}：base path ${target.platform?.migration_notes?.base_path || "按目标平台文档"}；重定向 ${target.platform?.migration_notes?.redirects || "按目标平台文档"}；响应头 ${target.platform?.migration_notes?.headers || "按目标平台文档"}`);
  tips.push(`目标自定义域名：${target.platform?.custom_domain?.notes || "按目标平台控制台提示绑定 CNAME / A / nameserver"}`);
  if (target.id === "render") {
    tips.push("Render 免费 Web Service 15 分钟无流量休眠；静态站免费；免费数据库的时长和容量限制以官方为准。");
  }
  return tips;
}

export function buildMigrationPlan({
  matrix,
  source,
  target,
  projectType,
  buildCommand = null,
  outputDir = null,
  envKeys = [],
  domain = null,
  dnsProvider = null,
  retainDays = 7,
}) {
  if (typeof source !== "string" || !source || (!MIGRATION_PLATFORMS.includes(source) && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(source))) {
    throw new UsageError(`--source 不是合法平台标识：${source}`);
  }
  if (typeof target !== "string" || !target || (!MIGRATION_PLATFORMS.includes(target) && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(target))) {
    throw new UsageError(`--target 不是合法平台标识：${target}`);
  }
  if (typeof projectType !== "string" || !PROJECT_TYPES.includes(projectType)) {
    throw new UsageError(`--project-type 只接受 ${PROJECT_TYPES.join(" / ")}`);
  }
  if (source === target) throw new UsageError("--source 与 --target 相同，无需迁移");
  const sourceInfo = platformOf(matrix, source);
  const targetInfo = platformOf(matrix, target);
  const mode = MODE_BY_PROJECT_TYPE[projectType];
  const support = supportStatus(targetInfo, mode);
  const clampedRetain = retainDays < 7 ? 7 : retainDays;
  const warnings = [];
  if (retainDays < 7) warnings.push(`回滚保留期至少 7 天，已从 ${retainDays} 调整为 7 天。`);
  if (!matrix) warnings.push("平台矩阵不可用：已生成通用迁移计划，但目标平台能力需要人工核对。");
  if (!sourceInfo.known) warnings.push(`源平台 ${source} 未纳入矩阵：按通用步骤人工核对构建、重定向、headers 和平台特有能力。`);
  if (!targetInfo.known) warnings.push(`目标平台 ${target} 未纳入矩阵：按通用步骤人工核对渲染支持、域名和配置。`);
  if (support === "unsupported") warnings.push(`目标平台 ${targetInfo.name} 未声明支持 ${projectType}；不要直接迁移。`);
  if (targetInfo.id === "netlify" && ["ssr", "fullstack"].includes(projectType)) {
    warnings.push("Netlify 的 SSR 依赖 Functions / Edge，纯静态托管不适用；需另行评估。");
  }
  if (targetInfo.id === "cloudflare-pages" && ["ssr", "fullstack"].includes(projectType)) {
    warnings.push("Cloudflare Pages 的 SSR 依赖 Functions / 适配器；新 SSR 项目优先 Workers。");
  }
  if (["ssr", "fullstack"].includes(projectType)) {
    warnings.push("如涉及数据库，必须单独备份、staging 导入、冻结写入和用户确认；不要与平台迁移混在一起。");
  }
  warnings.push("DNS 切换和自定义域名绑定必须用户确认；本脚本不执行任何 DNS、部署或数据库操作。");

  const precheck = precheckItems({
    source: sourceInfo,
    target: targetInfo,
    projectType,
    mode,
    buildCommand,
    outputDir,
    envKeys,
    domain,
    dnsProvider,
    retainDays: clampedRetain,
    support,
  });
  const questions = [];
  if (!buildCommand) questions.push("源平台实际构建命令是什么？");
  if (!outputDir) questions.push("构建输出目录是什么？");
  if (!envKeys.length) questions.push("需要迁移哪些环境变量键名？只提供键名，不要提供值。");
  if (!domain) questions.push("是否绑定自定义域名？当前 DNS 提供商和 TTL 是多少？");
  if (support === "unsupported") questions.push("是否改用支持该渲染模式的平台，或在目标平台用 Functions / Edge / Workers 承载？");

  const blocked = precheck.some((item) => item.status === "blocked");
  // 本脚本只做计划和清单，不执行构建、DNS 或部署验证；provided / inferred / pending
  // 都不等于 verified。ready 只有在所有适用项都实际验证通过后才可能出现。
  const allVerified = precheck.every((item) => item.status === "verified" || item.status === "not_applicable");
  const status = blocked ? "blocked" : allVerified ? "ready" : "needs_input";
  const plan = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    source: { id: sourceInfo.id, name: sourceInfo.name, known: sourceInfo.known, type: sourceInfo.type },
    target: { id: targetInfo.id, name: targetInfo.name, known: targetInfo.known, type: targetInfo.type },
    project_type: projectType,
    verification_mode: mode,
    status,
    precheck,
    dual_live: buildDualLive({ source: sourceInfo, target: targetInfo, projectType, retainDays: clampedRetain }),
    dns: {
      requires_confirmation: true,
      status: "pending_user_confirmation",
      ttl_before_switch: "24–48 小时",
      target_methods: targetInfo.platform?.custom_domain?.methods || ["CNAME", "A", "nameserver"],
      steps: [
        "提前降低 DNS TTL",
        "先在目标平台绑定自定义域名",
        "再按目标平台提示修改 CNAME / A / nameserver",
        "等待证书签发并验证 HTTPS",
        "保留旧记录到观察期结束",
      ],
      note: "脚本只输出步骤，不执行 DNS 变更；没有用户确认不能切换。",
    },
    rollback: {
      retain_source_days: clampedRetain,
      triggers: ["目标站 5xx 或关键页面不可用", "HTTPS 证书失败", "核心 API / 登录 / 支付异常"],
      steps: [
        "恢复 DNS 记录到源平台",
        `重新绑定 ${sourceInfo.name} 的自定义域名`,
        "重新启用源平台的发布分支或部署",
      ],
      data_warning: "如涉及数据库，回滚前先确认备份、冻结写入和数据一致性。",
    },
    platform_tips: buildTips({ source: sourceInfo, target: targetInfo, support, projectType }),
    warnings,
    questions,
    degraded: Boolean(!matrix || !sourceInfo.known || !targetInfo.known),
  };
  plan.report = renderMigrationReport(plan);
  return plan;
}

export function renderMigrationReport(plan) {
  const precheckRows = plan.precheck
    .map((item) => `| ${item.label} | ${item.status} | ${item.detail} |`)
    .join("\n");
  const tips = plan.platform_tips.map((tip) => `- ${tip}`).join("\n");
  return `# 迁移报告：${plan.source.name} → ${plan.target.name}

## 概要

| 项目 | 值 |
|---|---|
| 源平台 / 目标平台 | ${plan.source.name} / ${plan.target.name} |
| 项目类型 | ${plan.project_type} |
| 验收模式 | ${plan.verification_mode} |
| 当前状态 | ${plan.status} |
| 源地址 / 目标预览地址 | {{source_url}} / {{target_preview_url}} |
| 迁移方式 | {{Git 集成 / CLI / 控制台导入}} |
| 迁移日期 | {{YYYY-MM-DD}} |

## 迁移前检查

| 检查项 | 状态 | 证据 / 备注 |
|---|---|---|
${precheckRows}

状态定义：provided = 用户提供，尚未验证；inferred = 从配置或矩阵推断；verified = 实际构建 / 探测 / 配置检查通过；pending = 尚未确认；blocked = 存在阻断；not_applicable = 不适用。

## 双活与验收

| 检查 | 结果 | 证据 |
|---|---|---|
| 首页 | {{通过 / 失败 / 未验证}} | {{GET / -> 状态码、标题}} |
| 关键内页 | {{通过 / 失败 / 未验证}} | {{...}} |
| 静态资源 | {{通过 / 失败 / 未验证}} | {{检查数量、哈希同一性}} |
| 404 / SPA 回退 | {{通过 / 失败 / 未验证}} | {{模式与状态码}} |
| 重定向 | {{通过 / 失败 / 未验证}} | {{路径与目标}} |
| HTTPS | {{通过 / 失败 / 未验证}} | {{签发者、到期时间}} |
| API / SSR | {{通过 / 失败 / 未验证}} | {{接口、JSON、数据库 / 登录另测}} |
| 环境变量键名齐全 | {{通过 / 失败 / 未验证}} | {{只列键名}} |

## DNS 变更记录

| 时间 | 记录 | 原值 | 新值 | TTL | 操作人 | 用户确认 |
|---|---|---|---|---|---|---|
| {{...}} | {{CNAME / A / nameserver}} | {{...}} | {{...}} | {{...}} | {{...}} | {{是 / 否}} |

DNS 切换前置条件：${plan.dns.requires_confirmation ? "必须用户确认；先降 TTL，再绑定目标平台，再改 DNS。" : "无"}

## 回滚路径

- 源平台保留：至少 ${plan.rollback.retain_source_days} 天
- 触发条件：${plan.rollback.triggers.join("；")}
- 回滚步骤：${plan.rollback.steps.join("；")}
- 数据提醒：${plan.rollback.data_warning}

## 建议观察期

- 急性故障观察：24–72 小时
- 搜索 / 缓存 / 长尾观察：1–4 周
- 停用源平台：不早于观察期结束，且用户确认

## 平台提示

${tips}

## 未验证

| 项目 | 原因 |
|---|---|
| {{Search Console}} | {{没有站点权限}} |
| {{生产数据库写入}} | {{等待批准}} |
| {{第三方回调}} | {{需要真实密钥和授权}} |

## 备注

{{平台项目名、域名、环境变量键名、坑。绝不写密钥值。}}
`;
}

function formatHuman(plan) {
  const rows = plan.precheck
    .map((item) => `| ${item.label} | ${item.status} | ${item.detail} |`)
    .join("\n");
  const steps = plan.dual_live
    .map((step) => `${step.step}. ${step.title}\n   - ${step.actions.join("\n   - ")}\n   - 门：${step.gate}`)
    .join("\n");
  return `# 迁移计划：${plan.source.name} → ${plan.target.name}

- 项目类型：${plan.project_type}
- 验收模式：${plan.verification_mode}
- 状态：${plan.status}

## 迁移前检查

| 检查项 | 状态 | 证据 / 备注 |
|---|---|---|
${rows}

## 双活五步

${steps}

## DNS 切换

- 需要用户确认：是
- 切换前 TTL：${plan.dns.ttl_before_switch}
- 目标绑定方式：${plan.dns.target_methods.join(" / ")}
- 步骤：${plan.dns.steps.join("；")}

## 回滚

- 源平台至少保留 ${plan.rollback.retain_source_days} 天
- 触发条件：${plan.rollback.triggers.join("；")}
- 回滚步骤：${plan.rollback.steps.join("；")}

## 平台提示

${plan.platform_tips.map((tip) => `- ${tip}`).join("\n")}

## 报告骨架

${plan.report}
`;
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(`用法：node scripts/migration-plan.mjs --source <${MIGRATION_PLATFORMS.join("|")}> --target <${MIGRATION_PLATFORMS.join("|")}> --project-type <${PROJECT_TYPES.join("|")}> [--build-command <命令>] [--output-dir <目录>] [--env-keys "A,B"] [--domain <域名>] [--dns-provider <提供商>] [--retain-days 7] [--human] [--report]`);
      console.log("只读、不上传、不写项目文件、不访问网络；不执行 DNS、部署或数据库操作。");
      return 0;
    }

    let matrix = null;
    let matrixError = null;
    try {
      matrix = loadMatrix();
    } catch (error) {
      if (error instanceof MatrixError) matrixError = error;
      else throw error;
    }

    const plan = buildMigrationPlan({
      matrix,
      source: opts.source,
      target: opts.target,
      projectType: opts.projectType,
      buildCommand: opts.buildCommand,
      outputDir: opts.outputDir,
      envKeys: opts.envKeys,
      domain: opts.domain,
      dnsProvider: opts.dnsProvider,
      retainDays: opts.retainDays,
    });
    if (matrixError) plan.warnings.unshift(`平台矩阵不可用：${matrixError.message}`);

    if (opts.report) {
      console.log(plan.report);
    } else if (opts.human) {
      console.log(formatHuman(plan));
    } else {
      console.log(JSON.stringify(plan, null, 2));
    }
    return plan.status === "blocked" || matrixError ? 1 : 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`用法错误：${error.message}`);
      return 2;
    }
    console.error(`无法生成迁移计划：${error.message}`);
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
