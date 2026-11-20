#!/usr/bin/env node
/**
 * platform-matrix.mjs — 平台能力矩阵的读取、校验、筛选与选型纯函数。
 *
 * 数据源：references/platform-matrix.json。
 * 本模块不访问网络、不写文件；select-platform.mjs 和测试共用这里的规则，
 * 避免把平台能力和排序逻辑复制到多个地方。
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
    if (!TYPES.includes(p.type)) errors.push(`${label}.type 非法：${p.type}`);
    if (!Array.isArray(p.render_support) || p.render_support.length === 0) {
      errors.push(`${label}.render_support 必须是非空数组`);
    } else {
      for (const mode of p.render_support) {
        if (!RENDER_MODES.includes(mode)) errors.push(`${label}.render_support 含非法模式：${mode}`);
      }
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
    if (p.limits !== undefined && (typeof p.limits !== "string" || !p.limits.trim())) {
      errors.push(`${label}.limits 必须是非空字符串`);
    }
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
    free_tier_key_points: p.free_tier_key_points,
    best_for: p.best_for,
    limits: p.limits || p.not_for,
    mainland_china_risk: p.mainland_china_risk?.notes || "",
  };
}

function supportsRender(matrix, id, render) {
  const mode = render === "fullstack" ? "ssr" : render;
  return Boolean(matrix.byId[id]?.render_support?.includes(mode));
}

export function filterCandidates({ matrix, render, backend, budget }) {
  if (!matrix?.byId) throw new MatrixError("平台矩阵未加载");
  const paid = budget === "paid";
  const excluded = [];
  const addExcluded = (id, reason) => {
    if (matrix.byId[id] && !excluded.some((e) => e.id === id)) excluded.push({ id, reason });
  };
  const coreOrder = ["cloudflare-pages", "github-pages", "vercel-hobby", "netlify-free", "render-free"];
  const coreIds = matrix.platforms
    .filter((p) => p.core)
    .map((p) => p.id)
    .sort((a, b) => coreOrder.indexOf(a) - coreOrder.indexOf(b));
  const staticPool = coreIds.filter((id) => ["static", "ssg", "spa"].every((mode) => supportsRender(matrix, id, mode)));
  const ssrPool = paid
    ? ["vercel-hobby", "cloudflare-pages", "render-free", "railway", "fly-io"]
    : ["vercel-hobby", "cloudflare-pages", "render-free"];
  const longPool = paid ? ["railway", "fly-io", "render-free"] : ["render-free"];
  let candidates = [];

  const keepSupported = (ids) => ids.filter((id) => {
    if (!matrix.byId[id]) return false;
    if (supportsRender(matrix, id, render)) return true;
    addExcluded(id, `平台能力矩阵未声明支持 ${render} 模式`);
    return false;
  });

  if (backend === "long-running") {
    candidates = keepSupported(longPool);
    if (!paid) {
      addExcluded("railway", "按量计费，不承诺长期免费；免费优先时不作为首选");
      addExcluded("fly-io", "按量计费，不承诺长期免费；免费优先时不作为首选");
    }
    addExcluded("github-pages", "纯静态托管不能运行长期服务");
    addExcluded("cloudflare-pages", "静态托管不承接长期运行进程；如需 Containers 需 Workers Paid，另行评估");
    addExcluded("vercel-hobby", "Vercel Functions 是 Serverless，不适合长期运行服务");
    addExcluded("netlify-free", "Netlify Functions 是 Serverless，不适合长期运行服务");
    addExcluded("supabase", "Supabase 是数据库 / Auth / Storage，不运行长期服务本体");
  } else if (["static", "ssg", "spa"].includes(render)) {
    candidates = keepSupported(staticPool);
  } else if (["ssr", "fullstack"].includes(render)) {
    candidates = keepSupported(ssrPool);
    addExcluded("github-pages", "只能托管静态文件，不能运行 SSR / 全栈服务端代码");
    addExcluded("netlify-free", "纯静态托管不适用；如使用 Netlify Functions / Edge 承载 SSR，需另行评估，不作为本轮默认候选");
  } else if (render === "api") {
    candidates = keepSupported(ssrPool);
    addExcluded("github-pages", "不能运行 API");
    addExcluded("netlify-free", "纯静态托管不适用；Netlify Functions 需另行评估");
  }

  return { candidates, excluded };
}

export function selectPlatforms({ matrix, render, backend, audience, budget, candidates, excluded }) {
  const mainland = audience !== "overseas";
  const has = (id) => candidates.includes(id);
  const backup = [];
  const notRecommended = [];
  let primaryId = null;

  const addBackup = (id, condition) => {
    if (!id || id === primaryId || !has(id) || backup.some((b) => b.id === id)) return;
    backup.push({ id, condition });
  };
  const addNotRecommended = (id, reason) => {
    if (!id || id === primaryId || backup.some((b) => b.id === id) || notRecommended.some((n) => n.id === id)) return;
    notRecommended.push({ id, reason });
  };

  if (backend === "long-running") {
    primaryId = budget === "paid" ? "railway" : "render-free";
    if (budget === "paid") {
      addBackup("fly-io", "按量付费；注意区域和冷启动");
      addBackup("render-free", "可接受免费 Web Service 15 分钟无流量休眠");
    }
  } else if (["ssr", "fullstack", "api"].includes(render)) {
    primaryId = mainland ? "cloudflare-pages" : "vercel-hobby";
    if (mainland) {
      addBackup("vercel-hobby", "绑定自定义域名并接受仍可能被限速；Vercel 不保证中国大陆性能");
      addBackup("render-free", "大陆访问未实测；可接受冷启动");
    } else {
      addBackup("cloudflare-pages", "SSR 需 Functions / 框架适配器；静态免费层仍便宜");
      addBackup("render-free", "可接受冷启动；大陆访问未实测");
    }
  } else if (["static", "ssg", "spa"].includes(render)) {
    primaryId = "cloudflare-pages";
    if (mainland) {
      addBackup("github-pages", "已有仓库且接受中国大陆访问不稳定");
      addNotRecommended("vercel-hobby", "默认域名在中国大陆已被 DNS 污染，直接访问通常超时；除非绑定自定义域名并接受仍可能被限速");
      addNotRecommended("netlify-free", "默认域名在中国大陆常无法直接访问；除非绑定自定义域名并接受风险");
    } else {
      addBackup("github-pages", "仓库已在 GitHub，且不需要大陆稳定访问");
      addBackup("vercel-hobby", "海外个人项目；Hobby 仅个人非商业");
    }
  }

  if (!primaryId || !has(primaryId)) primaryId = candidates[0] || null;
  for (const item of excluded) {
    if (notRecommended.length >= 2) break;
    addNotRecommended(item.id, item.reason);
  }

  const primaryReason = (() => {
    if (!primaryId) return "";
    if (backend === "long-running") {
      return budget === "paid"
        ? "支持 Docker / 长驻服务，按量付费；适合需要常驻进程的项目"
        : "免费 Web Service 可起步；15 分钟无流量休眠，需接受冷启动";
    }
    if (["ssr", "fullstack", "api"].includes(render)) {
      return mainland
        ? "Cloudflare 家族默认域名大陆可达性更好；SSR 需 Workers + 框架适配器"
        : "Next.js / SSR 适配摩擦最低，海外访问稳定";
    }
    return mainland
      ? "免费、静态带宽无限，大陆可达性优于 Vercel 默认域名"
      : "免费、静态带宽无限，适合静态站零配置起步";
  })();

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
  };
}
