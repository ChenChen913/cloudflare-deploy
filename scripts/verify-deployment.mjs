#!/usr/bin/env node
/**
 * verify-deployment.mjs — 对已部署站点做 HTTP 验收。
 *
 * 用法：
 *   node scripts/verify-deployment.mjs --url https://site.example.com \
 *     [--backup https://owner.github.io/repo/] [--origin https://app.example.com] \
 *     [--expect-404 /__missing__] [--json]
 *
 * 只读：只发 GET/HEAD/OPTIONS。不会跟随跨主机重定向而不报告。
 * 不能证明搜索引擎实际选择的 canonical。
 */

const argv = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const json = argv.includes("--json");
const base = getArg("--url");
const backup = getArg("--backup");
const origin = getArg("--origin");
const notFoundPath = getArg("--expect-404", `/__cf_deploy_check_${Date.now()}/`);
const timeout = Number(getArg("--timeout", "15000"));

if (!base) {
  console.error("用法：node scripts/verify-deployment.mjs --url https://site.example.com [--backup ...] [--origin ...] [--json]");
  process.exit(2);
}

const checks = [];
const add = (id, status, detail, extra = {}) => checks.push({ id, status, detail, ...extra });

async function req(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const started = Date.now();
  try {
    const res = await fetch(url, { redirect: "manual", ...opts, signal: ctrl.signal });
    return { res, ms: Date.now() - started, error: null };
  } catch (e) {
    return { res: null, ms: Date.now() - started, error: String(e.cause?.code || e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function chain(url, max = 5) {
  const hops = [];
  let current = url;
  for (let i = 0; i < max; i++) {
    const r = await req(current, { method: "GET", headers: { "user-agent": "cloudflare-deploy-verify/1" } });
    if (!r.res) return { error: r.error, hops, final: current, status: null, res: null };
    const loc = r.res.headers.get("location");
    hops.push({ url: current, status: r.res.status, location: loc, ms: r.ms });
    if (r.res.status >= 300 && r.res.status < 400 && loc) {
      current = new URL(loc, current).toString();
      continue;
    }
    return { error: null, hops, final: current, status: r.res.status, res: r.res };
  }
  return { error: "重定向次数过多", hops, final: current, status: null, res: null };
}

const root = await chain(base);
if (root.error || !root.res) {
  add("root", "fail", `请求失败：${root.error}`, { hops: root.hops });
} else {
  add("root", root.status === 200 ? "pass" : "fail", `GET / -> ${root.status}，${root.hops[0]?.ms ?? "?"}ms`, { hops: root.hops });
  const ct = root.res.headers.get("content-type") || "";
  add("content-type", /text\/html/i.test(ct) ? "pass" : "warn", ct || "缺少 content-type");
}

// 404 行为：Pages 迁移后最常见的静默故障。
const missing = await req(new URL(notFoundPath, base).toString(), { method: "GET" });
if (!missing.res) add("404", "warn", `无法检查 404：${missing.error}`);
else if (missing.res.status === 404) add("404", "pass", `GET ${notFoundPath} -> 404`);
else add("404", "fail", `GET ${notFoundPath} -> ${missing.res.status}；期望 404（可能是 SPA 回退吞掉了未知路径）`, { status: missing.res.status });

// HTML 与资源
let html = "";
if (root.res) {
  try { html = await root.res.text(); } catch { html = ""; }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().replace(/\s+/g, " ").slice(0, 120) || null;
  add("title", title ? "pass" : "warn", title || "没有 <title>");

  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0] || null;
  if (canonical) {
    const href = canonical.match(/href=["']([^"']+)["']/i)?.[1] || "";
    const sameHost = (() => { try { return new URL(href, base).host === new URL(base).host; } catch { return false; } })();
    add("canonical", sameHost ? "pass" : "warn", canonical.slice(0, 240), { href, sameHost });
  } else {
    add("canonical", "skip", "没有 canonical 标签");
  }

  const robots = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i)?.[0] || null;
  add("meta-robots", robots ? "pass" : "skip", robots ? robots.slice(0, 160) : "没有 meta robots");

  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//i.test(u) && !u.startsWith("data:") && !u.startsWith("#") && !u.startsWith("mailto:") && !u.startsWith("tel:"))
    .map((u) => u.split(/[?#]/)[0])
    .filter(Boolean);
  const unique = [...new Set(refs)].slice(0, 20);
  const broken = [];
  for (const u of unique) {
    const target = new URL(u, base).toString();
    const r = await req(target, { method: "HEAD" });
    if (!r.res || r.res.status >= 400) broken.push({ url: u, status: r.res?.status ?? r.error });
  }
  add("assets", broken.length ? "fail" : "pass", broken.length ? `${broken.length} 个资源失败：${broken.slice(0, 5).map((b) => `${b.url}（${b.status}）`).join("、")}` : `${unique.length} 个同源资源正常`, { broken });
}

// 响应头
const headers = root.res?.headers;
if (headers) {
  const server = headers.get("server");
  add("server", server ? "pass" : "skip", server || "没有 Server 头");
  add("x-robots-tag", headers.get("x-robots-tag") ? "pass" : "skip", headers.get("x-robots-tag") || "无");
  add("cache-control", headers.get("cache-control") ? "pass" : "warn", headers.get("cache-control") || "缺失");
  const security = ["strict-transport-security", "x-content-type-options", "referrer-policy", "x-frame-options", "content-security-policy"]
    .filter((h) => headers.get(h));
  add("security-headers", security.length >= 2 ? "pass" : "warn", security.length ? security.join("、") : "没有常见安全头（HSTS/XCTO/Referrer-Policy/XFO/CSP）");
}

// /index.html 是否收敛到 /
for (const p of ["/index.html"]) {
  const r = await req(new URL(p, base).toString(), { method: "HEAD" });
  if (r.res) add("index-redirect", r.res.status >= 300 && r.res.status < 400 ? "pass" : "warn", `HEAD ${p} -> ${r.res.status}${r.res.headers.get("location") ? ` -> ${r.res.headers.get("location")}` : ""}`);
}

// CORS（可选）
if (origin) {
  const r = await req(base, { method: "GET", headers: { origin } });
  if (!r.res) add("cors", "warn", `CORS 检查失败：${r.error}`);
  else {
    const acao = r.res.headers.get("access-control-allow-origin");
    const acac = r.res.headers.get("access-control-allow-credentials");
    const multiple = acao && acao.includes(",");
    add("cors", multiple ? "fail" : acao ? "pass" : "warn",
      multiple ? `多个 Access-Control-Allow-Origin 值：${acao}` : `ACAO=${acao || "无"}${acac ? `，ACAC=${acac}` : ""}`,
      { acao, acac });
  }
  const pre = await req(base, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });
  if (pre.res) add("cors-preflight", [200, 204].includes(pre.res.status) ? "pass" : "warn", `OPTIONS -> ${pre.res.status}；ACAO=${pre.res.headers.get("access-control-allow-origin") || "无"}`);
}

// 备用站独立性（GitHub Pages）
if (backup) {
  const b = await chain(backup);
  if (b.error || !b.res) add("backup", "fail", `备用站请求失败：${b.error}`, { hops: b.hops });
  else {
    const server = b.res.headers.get("server") || "";
    const redirectedToMain = b.hops.some((h) => h.location && (() => { try { return new URL(h.location, h.url).host === new URL(base).host; } catch { return false; } })());
    if (b.status !== 200) add("backup", "fail", `备用站 -> ${b.status}${b.hops.at(-1)?.location ? `（${b.hops.at(-1).location}）` : ""}`, { hops: b.hops });
    else if (redirectedToMain) add("backup", "fail", "备用站跳转到主站，不是独立备用入口", { hops: b.hops });
    else if (/cloudflare/i.test(server)) add("backup", "warn", `备用站由 Cloudflare 提供（${server}），可能扛不住 Cloudflare 故障`, { hops: b.hops });
    else add("backup", "pass", `备用站 200，Server: ${server || "未知"}`, { hops: b.hops });
  }
}

const summary = {
  pass: checks.filter((c) => c.status === "pass").length,
  warn: checks.filter((c) => c.status === "warn").length,
  fail: checks.filter((c) => c.status === "fail").length,
  skip: checks.filter((c) => c.status === "skip").length,
};
const result = { schemaVersion: 1, url: base, backup, origin, checkedAt: new Date().toISOString(), summary, checks };

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const c of checks) {
    const mark = { pass: "通过", warn: "警告", fail: "失败", skip: "跳过" }[c.status] || c.status;
    console.log(`[${mark}] ${c.id}: ${c.detail}`);
  }
  console.log(`\n通过=${summary.pass} 警告=${summary.warn} 失败=${summary.fail} 跳过=${summary.skip}`);
}
process.exit(summary.fail ? 1 : 0);
