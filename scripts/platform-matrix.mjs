#!/usr/bin/env node
/**
 * platform-matrix.mjs — 平台能力矩阵的读取、校验、筛选与选型纯函数。
 *
 * 数据源：references/platform-matrix.json。
 * 矩阵描述平台能力；本文件保留少量明确的产品策略（五核心、商业限制、
 * 既有部署保留、首选/备选排序），避免把策略伪装成平台数据。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MATRIX_SCHEMA_VERSION = 1;
export const MATRIX_PATH = path.join(HERE, "..", "references", "platform-matrix.json");

const TYPES = ["static", "frontend-plus-functions", "fullstack", "database-auth"];
const RENDER_MODES = ["static", "ssg", "spa", "ssr", "api"];
const DOMAIN_METHODS = ["CNAME", "A", "AAAA", "nameserver"];
const RISK_LEVELS = ["dns_polluted", "often_unreachable", "unstable", "usually_reachable", "unknown", "not_applicable"];
const RISK_IMPROVEMENTS = ["partial", "no", "unknown", "not_applicable"];
const RISK_EVIDENCE = ["official", "observation", "unverified", "not_applicable"];
const SELECTION_POOLS = ["static", "ssr", "long-running", "database-auth"];
const COMMERCIAL_USE = ["allowed", "not_allowed", "caution", "unknown"];

export class MatrixError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = "MatrixError";
    this.errors = errors;
  }
}

export function validateMatrix(data) {
  const errors = [];
  const warnings = [];

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, errors: ["矩阵根节点必须是对象"], warnings };
  }
  if (data.schema_version !== MATRIX_SCHEMA_VERSION) {
    errors.push(`schema_version 必须是 ${MATRIX_SCHEMA_VERSION}`);
  }
  if (typeof data.checked_at !== "string" || !data.checked_at.trim()) {
    errors.push("缺少 checked_at");
  }
  if (!Array.isArray(data.platforms) || data.platforms.length === 0) {
    return { ok: false, errors: [...errors, "platforms 必须是非空数组"], warnings };
  }

  const ids = new Set();
  let coreCount = 0;
  for (const [index, p] of data.platforms.entries()) {
    const label = p?.id || `platforms[${index}]`;
    if (!p || typeof p !== "object") {
      errors.push(`${label} 必须是对象`);
      continue;
    }
    if (typeof p.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.id)) {
      errors.push(`${label}.id 必须是 kebab-case ASCII`);
    } else if (ids.has(p.id)) {
      errors.push(`平台 ID 重复：${p.id}`);
    } else {
      ids.add(p.id);
    }
    if (p.core === true) coreCount++;
    if (typeof p.name !== "string" || !p.name.trim()) errors.push(`${label}.name 不能为空`);
    if (typeof p.core !== "boolean") errors.push(`${label}.core 必须是布尔值`);
    if (typeof p.family !== "string" || !p.family.trim()) errors.push(`${label}.family 不能为空`);
    if (!Number.isFinite(p.order)) errors.push(`${label}.order 必须是数字`);
    if (!TYPES.includes(p.type)) errors.push(`${label}.type 非法：${p.type}`);
    if (!Array.isArray(p.render_support) || p.render_support.length === 0) {
      errors.push(`${label}.render_support 必须是非空数组`);
    } else {
      for (const mode of p.render_support) {
        if (!RENDER_MODES.includes(mode)) errors.push(`${label}.render_support 含非法模式：${mode}`);
      }
    }
    if (!Array.isArray(p.selection_pools) || p.selection_pools.length === 0) {
      errors.push(`${label}.selection_pools 必须是非空数组`);
    } else {
      for (const pool of p.selection_pools) {
        if (!SELECTION_POOLS.includes(pool)) errors.push(`${label}.selection_pools 含非法值：${pool}`);
      }
    }
    if (typeof p.paid_only !== "boolean") errors.push(`${label}.paid_only 必须是布尔值`);
    if (!COMMERCIAL_USE.includes(p.commercial_use)) errors.push(`${label}.commercial_use 非法：${p.commercial_use}`);
    if (p.commercial_use_note !== undefined && typeof p.commercial_use_note !== "string") {
      errors.push(`${label}.commercial_use_note 必须是字符串`);
    }
    if (p.render_notes !== undefined && typeof p.render_notes !== "string") {
      errors.push(`${label}.render_notes 必须是字符串`);
    }
    if (!Array.isArray(p.free_tier_key_points) || p.free_tier_key_points.length === 0) {
      errors.push(`${label}.free_tier_key_points 必须是非空数组`);
    }
    if (!p.custom_domain || typeof p.custom_domain.supported !== "boolean") {
      errors.push(`${label}.custom_domain.supported 必须是布尔值`);
    } else if (!Array.isArray(p.custom_domain.methods)) {
      errors.push(`${label}.custom_domain.methods 必须是数组`);
    } else {
      for (const method of p.custom_domain.methods) {
        if (!DOMAIN_METHODS.includes(method)) errors.push(`${label}.custom_domain.methods 含非法值：${method}`);
      }
    }
    const risk = p.mainland_china_risk;
    if (!risk || typeof risk !== "object") {
      errors.push(`${label}.mainland_china_risk 必须是对象`);
    } else {
      if (!RISK_LEVELS.includes(risk.default_subdomain)) {
        errors.push(`${label}.mainland_china_risk.default_subdomain 非法：${risk.default_subdomain}`);
      }
      if (!RISK_IMPROVEMENTS.includes(risk.custom_domain_improves)) {
        errors.push(`${label}.mainland_china_risk.custom_domain_improves 非法：${risk.custom_domain_improves}`);
      }
      if (typeof risk.stable !== "boolean") errors.push(`${label}.mainland_china_risk.stable 必须是布尔值`);
      if (!RISK_EVIDENCE.includes(risk.evidence_level)) {
        errors.push(`${label}.mainland_china_risk.evidence_level 非法：${risk.evidence_level}`);
      }
      if (typeof risk.evidence_note !== "string" || !risk.evidence_note.trim()) {
        errors.push(`${label}.mainland_china_risk.evidence_note 不能为空`);
      }
    }
    const migration = p.migration_notes;
    if (!migration || typeof migration !== "object") {
      errors.push(`${label}.migration_notes 必须是对象`);
    } else {
      for (const key of ["base_path", "redirects", "headers", "exit"]) {
        if (typeof migration[key] !== "string" || !migration[key].trim()) {
          errors.push(`${label}.migration_notes.${key} 不能为空`);
        }
      }
      if (!Array.isArray(migration.platform_features)) {
        errors.push(`${label}.migration_notes.platform_features 必须是数组`);
      }
    }
    if (typeof p.best_for !== "string" || !p.best_for.trim()) errors.push(`${label}.best_for 不能为空`);
    if (typeof p.not_for !== "string" || !p.not_for.trim()) errors.push(`${label}.not_for 不能为空`);
    if (typeof p.limits !== "string" || !p.limits.trim()) errors.push(`${label}.limits 不能为空`);
    if (p.sources !== undefined && !Array.isArray(p.sources)) {
      errors.push(`${label}.sources 必须是数组`);
    }
  }

  if (coreCount !== 5) errors.push(`核心平台应为 5 个，实际 ${coreCount}`);
  const extendedCount = data.platforms.length - coreCount;
  if (extendedCount < 3) warnings.push(`扩展平台只有 ${extendedCount} 个；至少应有 Railway / Fly.io / Supabase`);
  return { ok: errors.length === 0, errors, warnings };
}

export function loadMatrix(file = MATRIX_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new MatrixError(`无法读取平台矩阵：${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new MatrixError(`平台矩阵不是合法 JSON：${error.message}`);
  }
  const verdict = validateMatrix(data);
  if (!verdict.ok) {
    throw new MatrixError(`平台矩阵校验失败：${verdict.errors.slice(0, 3).join("；")}`, verdict.errors);
  }
  return {
    ...data,
    byId: Object.fromEntries(data.platforms.map((p) => [p.id, p])),
  };
}

export function platformDetails(matrix, id) {
  const p = matrix?.byId?.[id] || matrix?.platforms?.find((item) => item.id === id);
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    core: p.core,
    family: p.family,
    product: p.product || null,
    plan: p.plan || null,
    free_tier_key_points: p.free_tier_key_points,
    best_for: p.best_for,
    limits: p.limits,
    mainland_china_risk: p.mainland_china_risk?.notes || "",
    mainland_china_risk_evidence: {
      level: p.mainland_china_risk?.evidence_level || "unverified",
      note: p.mainland_china_risk?.evidence_note || "",
    },
    commercial_use: p.commercial_use,
    commercial_use_note: p.commercial_use_note || "",
    render_notes: p.render_notes || "",
    selection_pools: p.selection_pools,
    paid_only: p.paid_only,
  };
}

function supportsRender(matrix, id, render) {
  const mode = render === "fullstack" ? "ssr" : render;
  return Boolean(matrix.byId[id]?.render_support?.includes(mode));
}

function usageAllows(platform, usageType) {
  if (usageType === "commercial") return platform.commercial_use === "allowed";
  return true;
}

function poolIds(matrix, pool, { render, budget, usageType }) {
  const paid = budget === "paid";
  return matrix.platforms
    .filter((p) => p.selection_pools.includes(pool))
    .filter((p) => supportsRender(matrix, p.id, render))
    .filter((p) => !p.paid_only || paid)
    .filter((p) => usageAllows(p, usageType))
    .sort((a, b) => a.order - b.order)
    .map((p) => p.id);
}

export function filterCandidates({
  matrix,
  render,
  backend,
  budget,
  usageType = "unknown",
  existing = "unknown",
  existingStatus = "unknown",
}) {
  if (!matrix?.byId) throw new MatrixError("平台矩阵未加载");
  const paid = budget === "paid";
  const excluded = [];
  const addExcluded = (id, reason) => {
    if (matrix.byId[id] && !excluded.some((e) => e.id === id)) excluded.push({ id, reason });
  };
  const staticPool = poolIds(matrix, "static", { render, budget, usageType });
  const ssrPool = poolIds(matrix, "ssr", { render, budget, usageType });
  const longPool = poolIds(matrix, "long-running", { render, budget, usageType });
  let candidates = [];

  if (backend === "long-running") {
    candidates = longPool;
    if (!paid) {
      addExcluded("railway", "按量计费，不承诺长期免费；免费优先时不作为首选");
      addExcluded("fly-io", "按量计费，不承诺长期免费；免费优先时不作为首选");
      addExcluded("vercel-pro", "无免费层，免费优先时不作为候选");
    }
    addExcluded("github-pages", "纯静态托管不能运行长期服务");
    addExcluded("cloudflare-pages", "静态托管不承接长期运行进程；如需 Containers 需 Workers Paid，另行评估");
    addExcluded("cloudflare-workers", "Workers 是请求级运行时，不是长期运行进程");
    addExcluded("vercel-hobby", "Vercel Functions 是 Serverless，不适合长期运行服务");
    addExcluded("vercel-pro", "Vercel Functions 是 Serverless，不适合长期运行服务");
    addExcluded("netlify-free", "Netlify Functions 是 Serverless，不适合长期运行服务");
    addExcluded("supabase", "Supabase 是数据库 / Auth / Storage，不运行长期服务本体");
  } else if (["static", "ssg", "spa"].includes(render)) {
    candidates = staticPool;
    if (usageType === "commercial") {
      addExcluded("vercel-hobby", "Hobby 仅个人非商业；商业项目改用 Vercel Pro 或其他平台");
      addExcluded("github-pages", "公开仓库免费，但不适合敏感交易或商业 SaaS 主站；商业项目优先其他平台");
    }
    if (!paid) {
      addExcluded("vercel-pro", "无免费层，免费优先时不作为候选");
      addExcluded("railway", "按量计费，不是静态站免费层候选");
      addExcluded("fly-io", "按量计费，不是静态站免费层候选");
    }
  } else if (["ssr", "fullstack", "api"].includes(render)) {
    candidates = ssrPool;
    if (usageType === "commercial") {
      addExcluded("vercel-hobby", "Hobby 仅个人非商业；商业项目改用 Vercel Pro 或其他平台");
    }
    addExcluded("github-pages", "只能托管静态文件，不能运行 SSR / 全栈服务端代码");
    addExcluded("netlify-free", "纯静态托管不适用；如使用 Netlify Functions / Edge 承载 SSR，需另行评估，不作为默认候选");
    addExcluded("cloudflare-pages", "新 SSR / API 项目优先 Cloudflare Workers；Pages Functions 仅在已有 Pages 或明确选择时保留");
    if (!paid) {
      addExcluded("vercel-pro", "无免费层，免费优先时不作为候选");
      addExcluded("railway", "按量计费，不承诺长期免费；免费优先时不作为候选");
      addExcluded("fly-io", "按量计费，不承诺长期免费；免费优先时不作为候选");
    }
  }

  const existingPlatform = existing && existing !== "none" && existing !== "unknown" ? matrix.byId[existing] : null;
  if (existingStatus === "healthy" && existingPlatform && supportsRender(matrix, existing, render) && usageAllows(existingPlatform, usageType)) {
    if (!candidates.includes(existing)) candidates = [existing, ...candidates];
    const index = excluded.findIndex((e) => e.id === existing);
    if (index >= 0) excluded.splice(index, 1);
  }

  return { candidates, excluded };
}

export function selectPlatforms({
  matrix,
  render,
  backend,
  audience,
  budget,
  usageType = "unknown",
  existing = "unknown",
  existingStatus = "unknown",
  candidates,
  excluded,
}) {
  const mainland = audience !== "overseas";
  const has = (id) => candidates.includes(id);
  const backup = [];
  const notRecommended = [];
  const hobbyNotAssumedPersonal = existing === "vercel-hobby" && usageType !== "personal_noncommercial";
  const existingId = existingStatus === "healthy" && has(existing) && !hobbyNotAssumedPersonal ? existing : null;
  const existingPlatform = existingId ? matrix.byId[existingId] : null;
  let primaryId = null;

  const addBackup = (id, condition) => {
    if (!id || id === primaryId || !has(id) || backup.some((b) => b.id === id)) return;
    backup.push({ id, condition });
  };
  const addNotRecommended = (id, reason) => {
    if (!id || id === primaryId || backup.some((b) => b.id === id) || notRecommended.some((n) => n.id === id)) return;
    notRecommended.push({ id, reason });
  };

  if (existingId) {
    primaryId = existingId;
    if (existingId === "cloudflare-pages" && has("cloudflare-workers")) {
      addBackup("cloudflare-workers", "现有 Pages 健康；只有明确需要 Workers 能力时才迁移");
    } else if (existingId === "cloudflare-workers" && has("cloudflare-pages")) {
      addBackup("cloudflare-pages", "现有 Workers 健康；只有纯静态且想用 Pages Git 集成时才迁移");
    } else if (["static", "ssg", "spa"].includes(render) && has("cloudflare-pages")) {
      addBackup("cloudflare-pages", "现有部署健康；Pages 仅作为备选");
    } else if (has("cloudflare-workers")) {
      addBackup("cloudflare-workers", "现有部署健康；Workers 仅作为备选");
    }
  } else if (backend === "long-running") {
    primaryId = budget === "paid" ? "railway" : "render-free";
    if (budget === "paid") {
      addBackup("fly-io", "按量付费；注意区域和冷启动");
      addBackup("render-free", "可接受免费 Web Service 15 分钟无流量休眠");
    }
  } else if (["ssr", "fullstack", "api"].includes(render)) {
    const commercial = usageType === "commercial";
    const personal = usageType === "personal_noncommercial";
    if (mainland) {
      primaryId = has("cloudflare-workers") ? "cloudflare-workers" : has("vercel-pro") ? "vercel-pro" : "render-free";
      addBackup("vercel-pro", "商业项目可用 Pro；大陆访问仍可能被限速");
      addBackup("vercel-hobby", "仅个人非商业；绑定自定义域名并接受大陆风险");
      addBackup("render-free", "大陆访问未实测；可接受冷启动");
    } else if (commercial) {
      primaryId = paidAndHas("vercel-pro") ? "vercel-pro" : has("cloudflare-workers") ? "cloudflare-workers" : "render-free";
      addBackup("cloudflare-workers", "商业用途可用免费层；注意请求额度");
      addBackup("render-free", "可接受冷启动；商业用途以官方条款为准");
    } else if (personal) {
      primaryId = has("vercel-hobby") ? "vercel-hobby" : has("cloudflare-workers") ? "cloudflare-workers" : "render-free";
      addBackup("cloudflare-workers", "SSR 需适配器；免费请求额度足够时可用");
      addBackup("render-free", "可接受冷启动；大陆访问未实测");
    } else {
      primaryId = has("cloudflare-workers") ? "cloudflare-workers" : has("vercel-hobby") ? "vercel-hobby" : "render-free";
      addBackup("vercel-hobby", "仅个人非商业，需确认使用性质；绑定自定义域名");
      addBackup("render-free", "可接受冷启动；大陆访问未实测");
    }
  } else if (["static", "ssg", "spa"].includes(render)) {
    primaryId = has("cloudflare-pages") ? "cloudflare-pages" : candidates[0] || null;
    if (mainland) {
      addBackup("github-pages", "已有仓库且接受中国大陆访问不稳定");
      addNotRecommended("vercel-hobby", "默认域名在中国大陆已被 DNS 污染，直接访问通常超时；除非绑定自定义域名并接受仍可能被限速");
      addNotRecommended("netlify-free", "默认域名在中国大陆常无法直接访问；除非绑定自定义域名并接受风险");
    } else if (usageType === "commercial") {
      addBackup("netlify-free", "商业用途可用；默认域名大陆风险不影响海外用户");
      addBackup("render-free", "静态站免费；可接受冷启动");
    } else {
      addBackup("github-pages", "仓库已在 GitHub，且不需要大陆稳定访问");
      addBackup("vercel-hobby", "海外个人项目；Hobby 仅个人非商业");
    }
  }

  if (!primaryId || !has(primaryId)) primaryId = candidates[0] || null;
  if (primaryId === "vercel-hobby" && usageType !== "personal_noncommercial") {
    const replacement = has("cloudflare-workers") ? "cloudflare-workers" : has("render-free") ? "render-free" : candidates.find((id) => id !== "vercel-hobby");
    if (replacement) {
      addBackup("vercel-hobby", usageType === "commercial" ? "不可用于商业；不要选择" : "仅个人非商业，需确认使用性质");
      primaryId = replacement;
    }
  }
  for (const item of excluded) {
    if (notRecommended.length >= 2) break;
    addNotRecommended(item.id, item.reason);
  }

  const primaryReason = (() => {
    if (!primaryId) return "";
    if (existingId) return `现有部署健康，迁移收益不足；保留 ${existingPlatform.name}`;
    if (backend === "long-running") {
      return budget === "paid"
        ? "支持 Docker / 长驻服务，按量付费；适合需要常驻进程的项目"
        : "免费 Web Service 可起步；15 分钟无流量休眠，需接受冷启动";
    }
    if (primaryId === "cloudflare-workers") {
      return mainland
        ? "Workers 是请求级 SSR / API 运行时；默认域名大陆可达性通常更好（网络观测，不保证）；Pages Functions 仅在已有 Pages 或明确选择时考虑"
        : "新 SSR / API 项目优先 Workers；商业用途可用免费层，避开 Hobby 的非商业限制";
    }
    if (primaryId === "vercel-pro") return "商业用途允许；$20/月起；Next.js / SSR 适配成熟";
    if (primaryId === "vercel-hobby") return "个人非商业可用；Next.js / SSR 适配成熟";
    if (primaryId === "render-free") return "免费 Web Service 可起步；15 分钟无流量休眠，需接受冷启动";
    if (primaryId === "cloudflare-pages") {
      return mainland
        ? "免费、静态带宽无限，大陆可达性优于 Vercel 默认域名；静态站默认 Pages"
        : "免费、静态带宽无限；Pages 的 Git 集成最简单，静态站默认 Pages";
    }
    return "按矩阵能力和规则筛选出的首选";
  })();

  function paidAndHas(id) {
    return budget === "paid" && has(id);
  }

  const primary = platformDetails(matrix, primaryId);
  return {
    primary: primary ? { ...primary, reason: primaryReason } : null,
    backup: backup.slice(0, 2).map((b) => {
      const details = platformDetails(matrix, b.id);
      return details ? { ...details, condition: b.condition } : null;
    }).filter(Boolean),
    not_recommended: notRecommended.slice(0, 2).map((n) => {
      const details = platformDetails(matrix, n.id);
      return details ? { ...details, reason: n.reason } : null;
    }).filter(Boolean),
    existing: existingId ? { id: existingId, name: existingPlatform.name, status: existingStatus } : null,
  };
}
