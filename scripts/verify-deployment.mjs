#!/usr/bin/env node
/**
 * verify-deployment.mjs — 对已部署站点做 HTTP 验收。
 *
 * 用法：
 *   node scripts/verify-deployment.mjs --url https://site.example.com \
 *     [--mode static|spa|ssg|ssr] [--backup https://owner.github.io/repo/] \
 *     [--origin https://app.example.com] [--cors-url https://api.example.com/items] \
 *     [--cors-method POST] [--cors-headers "content-type,authorization"] [--cors-credentials] \
 *     [--api /api/health --expect-json '{"ok":true}'] \
 *     [--expect-404 /__missing__] [--assets-limit 20] [--json]
 *
 * 模式必须和 check-build.mjs 用同一个值：
 *   static / ssg  未知路径应当 404
 *   spa           未知路径应当回退到 app shell（200 + HTML）
 *   ssr           未知路径通常 404；额外检查服务端渲染内容、TTFB 和 --api 接口
 *
 * --expect-json 的语义：把预期值解析为 JSON，要求它「是响应 JSON 的子集」，
 * 与字段顺序、缩进空白无关。旧版的字符串包含判断已废弃（无法判断结构）。
 * CORS 预检只对用户显式提供的 --cors-method / --cors-headers / --cors-credentials
 * 做断言；没提供的检查会列进 notChecked，绝不替用户推断实际请求方法或请求头。
 * `*` 只在无凭据请求里是通配符（Fetch 规范）；带凭据时它是字面值，
 * 且 Authorization / Range 永远不被 `*` 覆盖。GET/HEAD/POST 是 CORS-safelisted method，
 * 不要求出现在 Allow-Methods 里；方法名按规范大小写敏感比较（已知方法先规范化为大写）。
 * 简单请求的凭据模式只由 --cors-credentials 声明：响应里带 ACAC: true 不代表
 * 请求带了凭据，不能据此判 ACAO=* 无效。脚本本身不发 Cookie / Authorization。
 *
 * 主站与资源的重定向都只自动跟随「同源」（协议 + 主机 + 端口，见 redirect-policy.mjs）；
 * 跨源、协议变化、非 http/https 协议、Location 缺失或无法解析一律不请求目标，
 * 只记录 Location、状态码和重定向链，避免 3xx 把验收脚本带去 127.0.0.1、
 * 内网地址或云厂商元数据端点。主站结果用 redirectOutcome 区分
 * 同源验证成功 / 跨源目标未验证 / 循环或超跳数 / Location 无法解析 / 协议不受支持。
 * 两者共用 MAX_REDIRECTS：最多跟随 5 次同源重定向，并额外请求一次最终地址；
 * 该地址再返回 3xx（第 6 次重定向）即判超限，且不请求它的目标。
 * 资源 3xx 只要带可解析的 Location 就记为发生过重定向，不看链长度。
 *
 * 3xx 只有 301/302/303/307/308 是需要读取 Location 的重定向。304 Not Modified
 * 是缓存协商结果，不进入重定向链，也不会因为缺少 Location 被报成无效重定向；
 * 其他 3xx（300、305 等）既不跟随，也不能当作成功。主站链、资源探针和
 * `/index.html` 检查共用 classifyStatus()，避免三处规则分叉。
 *
 * canonical 只在协议、主机、规范化路径三者都一致时才算指向自身；协议不同单独标 warn。
 * href 缺失、空值、无法解析会分别报告，绝不把空 href 解析成当前站点后判成 self-canonical；
 * 属性值支持双引号、单引号和不带引号三种合法写法。
 *
 * 只读：只发 GET/HEAD/OPTIONS。跨源目标不会被请求。
 * 相对路径按站点根解析（支持 /repo/ 这样的子路径站点），以 / 开头的按域名根解析。
 * 不能证明搜索引擎实际选择的 canonical，也不能替代浏览器里的 CORS 判定。
 */

import { classifyRedirect, classifyStatus } from "./redirect-policy.mjs";

const argv = process.argv.slice(2);
const getArg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const json = argv.includes("--json");
const base = getArg("--url");
const backup = getArg("--backup");
const origin = getArg("--origin");
const notFoundPath = getArg("--expect-404", `__cf_deploy_check_${Date.now()}/`);
const timeoutRaw = getArg("--timeout", "15000");
const assetsLimitRaw = getArg("--assets-limit", "20");
const timeout = Number(timeoutRaw);
const assetsLimit = Number(assetsLimitRaw);
const MODES = ["static", "spa", "ssg", "ssr"];
const mode = argv.includes("--spa") ? "spa" : (getArg("--mode") || "static");
const apiPaths = argv.reduce((acc, a, i) => (a === "--api" && argv[i + 1] && !argv[i + 1].startsWith("--") ? [...acc, argv[i + 1]] : acc), []);
const expectJson = getArg("--expect-json");
const corsMethod = getArg("--cors-method");
const corsHeadersArg = getArg("--cors-headers");
const corsCredentials = argv.includes("--cors-credentials");

// --expect-json：预期值是响应的「子集」，对象按字段递归比较（不看键顺序），
// 数组按长度与下标比较，标量严格相等。任何不匹配都返回字段路径与原因。
function parseExpectedJson(raw) {
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch (e) { return { ok: false, error: `--expect-json 不是合法 JSON：${e.message}` }; }
}
function compareJson(expected, actual, at = "$") {
  if (expected === null || typeof expected !== "object") {
    return expected === actual
      ? { match: true, reason: `${at} 匹配` }
      : { match: false, reason: `${at} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}` };
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return { match: false, reason: `${at} 期望数组，实际 ${actual === null ? "null" : Array.isArray(actual) ? "数组" : typeof actual}` };
    if (expected.length !== actual.length) return { match: false, reason: `${at} 数组长度期望 ${expected.length}，实际 ${actual.length}` };
    for (let i = 0; i < expected.length; i++) {
      const r = compareJson(expected[i], actual[i], `${at}[${i}]`);
      if (!r.match) return r;
    }
    return { match: true, reason: `${at} 数组匹配` };
  }
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
    return { match: false, reason: `${at} 期望对象，实际 ${actual === null ? "null" : Array.isArray(actual) ? "数组" : typeof actual}` };
  }
  for (const key of Object.keys(expected)) {
    if (!Object.prototype.hasOwnProperty.call(actual, key)) return { match: false, reason: `字段 ${at}.${key} 缺失` };
    const r = compareJson(expected[key], actual[key], `${at}.${key}`);
    if (!r.match) return r;
  }
  return { match: true, reason: `${at} 的 ${Object.keys(expected).length} 个字段全部匹配` };
}

// CORS 头是逗号分隔的 token 列表。请求头名大小写不敏感；HTTP 方法大小写敏感
// （Fetch 规范只把 DELETE/GET/HEAD/OPTIONS/POST/PUT 规范化成大写）。
const splitTokens = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const methodTokens = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
const CORS_SAFELISTED_METHODS = ["GET", "HEAD", "POST"];
const NORMALIZED_METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"];
// Fetch 规范：Authorization / Range 是 CORS non-wildcard request-header name，
// 即使是无凭据请求，`Access-Control-Allow-Headers: *` 也不覆盖它们。
const NON_WILDCARD_HEADERS = ["authorization", "range"];
const normalizeMethod = (m) => {
  const raw = String(m || "").trim();
  const upper = raw.toUpperCase();
  return NORMALIZED_METHODS.includes(upper) ? upper : raw;
};

/** Allow-Methods 判定：`*` 只在无凭据请求里是通配符；GET/HEAD/POST 永远允许。 */
function allowMethodCheck(headerValue, wanted, credentials) {
  const tokens = methodTokens(headerValue);
  const method = normalizeMethod(wanted);
  if (tokens.includes(method)) return { ok: true };
  if (!credentials && tokens.includes("*")) return { ok: true };
  if (CORS_SAFELISTED_METHODS.includes(method)) return { ok: true };
  return {
    ok: false,
    reason: `Access-Control-Allow-Methods=${headerValue || "无"} 不含实际请求方法 ${method}`
      + (credentials && tokens.includes("*") ? "（带凭据时 * 是字面方法名，不是通配符）" : tokens.includes("*") ? "（* 不是有效方法名）" : ""),
  };
}

/** Allow-Headers 判定：`*` 只在无凭据时通配，且永不覆盖 Authorization / Range。 */
function allowHeaderCheck(headerValue, wanted, credentials) {
  const tokens = splitTokens(headerValue);
  const header = String(wanted).trim().toLowerCase();
  if (tokens.includes(header)) return { ok: true };
  if (!credentials && tokens.includes("*") && !NON_WILDCARD_HEADERS.includes(header)) return { ok: true };
  return {
    ok: false,
    reason: `Access-Control-Allow-Headers=${headerValue || "无"} 不含实际请求头 ${wanted}`
      + (NON_WILDCARD_HEADERS.includes(header) && tokens.includes("*") ? "（Authorization/Range 是 CORS non-wildcard request-header，* 不覆盖）" : credentials && tokens.includes("*") ? "（带凭据时 * 不作通配符）" : ""),
  };
}

if (!base) {
  console.error("用法：node scripts/verify-deployment.mjs --url https://site.example.com [--mode static|spa|ssg|ssr] [--backup ...] [--origin ...] [--cors-method POST] [--cors-headers 'content-type,authorization'] [--cors-credentials] [--api /api/health --expect-json '{\"ok\":true}'] [--json]");
  process.exit(2);
}
if (!MODES.includes(mode)) {
  console.error(`未知模式：${mode}；只支持 ${MODES.join(" / ")}`);
  process.exit(2);
}
try {
  new URL(base);
} catch {
  console.error(`--url 不是合法 URL：${base}`);
  process.exit(2);
}
const corsArg = getArg("--cors-url");
if (corsArg) {
  try { new URL(corsArg, base); } catch { console.error(`--cors-url 不是合法 URL：${corsArg}`); process.exit(2); }
}
// 数值参数和 URL 参数在这里先校验：否则运行到一半才抛 TypeError 时，
// 用户拿不到 JSON 结果，也无法区分是参数写错还是站点有问题。
if (!Number.isFinite(timeout) || timeout <= 0) {
  console.error(`--timeout 必须是正数（毫秒）：${timeoutRaw}`);
  process.exit(2);
}
if (!Number.isInteger(assetsLimit) || assetsLimit < 1) {
  console.error(`--assets-limit 必须是正整数：${assetsLimitRaw}`);
  process.exit(2);
}
if (backup) {
  try { new URL(backup); } catch { console.error(`--backup 不是合法 URL：${backup}`); process.exit(2); }
}
for (const [flag, value] of [["--expect-404", notFoundPath], ...apiPaths.map((p) => ["--api", p])]) {
  try { new URL(value, base); } catch { console.error(`${flag} 的 URL 无法解析：${value}`); process.exit(2); }
}

const UA = "cloudflare-deploy-verify/2";
// 主站链与资源探针共用的跳数上限：最多跟随 5 次同源重定向，并额外请求一次
// 第 5 次重定向指向的最终地址；该地址仍返回 3xx（第 6 次重定向）即判超限。
const MAX_REDIRECTS = 5;
const checks = [];
// 附加字段不能覆盖 id/status/detail 本身。
const add = (id, status, detail, extra = {}) => checks.push({ ...extra, id, status, detail });
// 站点可能挂在子路径下（GitHub Pages project site、多站点同域）。
// 相对路径按站点根解析；以 / 开头的仍按域名根解析。
const dirBase = base.endsWith("/") ? base : `${base}/`;
const resolve = (u) => new URL(u, dirBase).toString();

/**
 * 从首页 HTML 收集「可探测的同源 http(s) 资源」。
 *
 * 不能只按字符串前缀过滤：`\\\\127.0.0.1:port/x` 这类写法会经 URL 解析变成
 * 协议相对地址，脚本若直接 fetch 就违反了「只请求同源」的承诺。这里先解析，
 * 再按协议与 origin 判定；跨源、非 HTTP(S)、畸形地址只记录，不发请求。
 * 带 scheme 或 `//` 的绝对/协议相对引用沿用旧行为：不探测（外链、CDN、canonical）。
 *
 * @returns {{unique:{url:string,abs:string}[], ignored:{url:string,reason:string}[]}}
 */
function collectAssetRefs(htmlText, siteBase, pageBase) {
  const site = new URL(siteBase);
  const entries = [];
  const ignored = [];
  for (const m of htmlText.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("#")) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue;
    const bare = raw.split(/[?#]/)[0];
    if (!bare) continue;
    let abs = null;
    try { abs = new URL(bare, pageBase); } catch { ignored.push({ url: raw, reason: "URL 无法解析" }); continue; }
    if (abs.protocol !== "http:" && abs.protocol !== "https:") {
      ignored.push({ url: raw, reason: `非 HTTP(S) 协议 ${abs.protocol}` });
      continue;
    }
    if (abs.origin !== site.origin) {
      ignored.push({ url: raw, reason: `跨源地址 ${abs.origin}，按策略不请求` });
      continue;
    }
    entries.push({ url: bare, abs: abs.href });
  }
  // 同一目标用不同写法时按解析后的 URL 去重。
  return { unique: [...new Map(entries.map((e) => [e.abs, e])).values()], ignored };
}

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

/**
 * 主站重定向链。只自动跟随同源（协议 + 主机 + 端口）重定向；其他情况立即停止，
 * 把 Location、状态码和已发生的 hops 记进结果，绝不请求目标地址。
 * 跳数语义与 probeAsset 一致（共用 MAX_REDIRECTS）：最多跟随 max 次重定向，
 * 并额外请求一次第 max 次重定向指向的最终地址，所以最多 max+1 次请求。
 * 最后一次请求若仍是同源 3xx，就是第 max+1 次重定向，判 loop-or-limit 且不请求
 * 它的目标；这跳不计入「已跟随链」，证据放在 limitHop / stopReason。
 * stopped 用于报告分类：cross-origin / unsupported-protocol / invalid-location / loop-or-limit。
 */
async function chain(url, max = MAX_REDIRECTS) {
  const hops = [];
  let current = url;
  let startOrigin = null;
  try { startOrigin = new URL(url).origin; } catch { /* --url / --backup 已在入口校验 */ }
  const done = (extra = {}) => ({
    error: null, hops, final: current, status: null, res: null,
    stopped: null, stopReason: null, redirectTarget: null, ...extra,
  });
  // redirects 表示「本跳之前已跟随的重定向次数」；0..max 共 max+1 次请求。
  for (let redirects = 0; redirects <= max; redirects++) {
    const r = await req(current, { method: "GET", headers: { "user-agent": UA } });
    if (!r.res) return done({ error: r.error });
    const loc = r.res.headers.get("location");
    const status = r.res.status;
    const statusClass = classifyStatus(status);
    // 3xx 里只有 304 之外的常见重定向才需要看 Location；304 直接结束，
    // 不能因为缺少 Location 被报成 invalid-location。
    if (statusClass !== "redirect") {
      hops.push({ url: current, status, location: loc, ms: r.ms, statusClass });
      if (statusClass === "not-modified") {
        return done({
          status, res: r.res, stopped: "not-modified",
          stopReason: "304 Not Modified 是缓存协商结果，不是重定向；本次请求没有发送条件请求头，也没有可验证的响应体",
        });
      }
      if (statusClass === "unexpected-3xx") {
        return done({
          status, res: r.res, stopped: "unexpected-3xx",
          stopReason: `${status} 属于 3xx，但不在需要跟随的重定向状态（301/302/303/307/308）里，也没有可验证的 2xx 响应`,
        });
      }
      return done({ status, res: r.res });
    }
    const c = classifyRedirect(current, loc, startOrigin);
    const hop = {
      url: current, status, location: loc, ms: r.ms, statusClass,
      redirect: c.kind, next: c.next, protocolChanged: c.protocolChanged,
    };
    if (r.res.body) { try { await r.res.body.cancel(); } catch { /* 已关闭 */ } }
    // 安全策略优先：跨源 / 非 http(s) / 无效 Location 一律不请求目标。
    if (c.kind !== "same-origin") {
      hops.push(hop);
      return done({ status, res: r.res, stopped: c.kind, stopReason: c.reason, redirectTarget: c.next });
    }
    // 第 max+1 次同源重定向 = 超限；不跟随，也不为「完成最终验证」请求目标。
    if (redirects === max) {
      return done({
        status, res: r.res, stopped: "loop-or-limit",
        stopReason: `重定向超过 ${max} 跳，可能循环（第 ${max + 1} 次重定向指向 ${c.next || loc || "未知地址"}，未请求目标）`,
        limitHop: { ...hop, followed: false },
      });
    }
    hops.push(hop);
    current = c.next;
  }
  return done({ stopped: "loop-or-limit", stopReason: `重定向超过 ${max} 跳，可能循环`, status: hops.at(-1)?.status ?? null });
}

// HEAD 优先；405/501 或网络错误时用 GET 复核，避免把「支持 GET 不支持 HEAD」误判为失败。
async function probe(url, headers = {}) {
  const h = await req(url, { method: "HEAD", headers: { "user-agent": UA, ...headers } });
  if (h.res && ![405, 501].includes(h.res.status)) return { res: h.res, method: "HEAD", error: null, note: null };
  const g = await req(url, { method: "GET", headers: { "user-agent": UA, ...headers } });
  if (g.res?.body) { try { await g.res.body.cancel(); } catch { /* 已关闭 */ } }
  return {
    res: g.res,
    method: "GET",
    error: g.error,
    note: h.res ? `HEAD ${h.res.status}，已用 GET 复核` : `HEAD 失败（${h.error}），已用 GET 复核`,
  };
}

const sameHost = (a, b) => {
  try { return new URL(a, base).host === new URL(b, base).host; } catch { return false; }
};

/**
 * 资源专用探针。req() 用 redirect: "manual"，3xx 不会自动跟随；旧逻辑把
 * `status >= 400` 当作唯一失败条件，于是 301/302/307/308 被默默算成资源正常。
 * 这里与主站链共用 redirect-policy：只跟随同源重定向并验证最终 2xx；
 * 跨源 / 非 http(s) 协议只记录目标、不跟随；跳数有上限，防止循环。
 * redirected 由「是否收到带有效 Location 的 3xx」决定，不看链长度——
 * 跨源会提前返回，链只有 1 跳，但它确实发生过重定向。
 */
async function probeAsset(url) {
  const chainHops = [];
  let current = url;
  let method = null;
  let fallback = false;
  let sawRedirect = false;
  let startOrigin = null;
  try { startOrigin = new URL(url).origin; } catch { /* resolve() 保证是绝对 URL */ }
  const out = (extra) => ({
    url, current, method, fallback, chainHops,
    redirected: sawRedirect,
    finalUrl: current, finalStatus: null, crossHost: false,
    ...extra,
  });
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const r = await probe(current);
    method = r.method;
    if (r.note) fallback = true;
    if (!r.res) return out({ ok: false, level: "fail", reason: `请求失败：${r.error}` });
    const status = r.res.status;
    const loc = r.res.headers.get("location");
    const statusClass = classifyStatus(status);
    const entry = { url: current, status, location: loc, statusClass };
    chainHops.push(entry);
    if (r.res.body) { try { await r.res.body.cancel(); } catch { /* 已关闭 */ } }
    if (statusClass === "redirect") {
      const c = classifyRedirect(current, loc, startOrigin);
      entry.redirect = c.kind;
      entry.next = c.next;
      entry.protocolChanged = c.protocolChanged;
      if (c.kind === "invalid-location") {
        return out({
          ok: false, level: "fail",
          reason: loc
            ? `${status} 重定向的 Location 无法解析：${loc}，无法确认最终资源`
            : `${status} 重定向缺少 Location，无法确认最终资源`,
          finalStatus: status,
        });
      }
      // 3xx + 可解析的 Location = 发生过重定向，无论后面是否跟随成功。
      sawRedirect = true;
      if (c.kind === "unsupported-protocol") {
        return out({
          ok: false, level: "fail", reason: `${status} ${c.reason}；已拒绝且不请求目标`,
          finalUrl: c.next, finalStatus: status, crossHost: true,
        });
      }
      if (c.kind === "cross-origin") {
        return out({
          ok: true, level: "warn",
          reason: `${status} ${c.reason}（按策略不跟随，最终资源未验证）`,
          finalUrl: c.next, finalStatus: status, crossHost: true,
        });
      }
      current = c.next;
      continue;
    }
    if (statusClass === "success") return out({ ok: true, level: "pass", reason: null, finalStatus: status });
    if (statusClass === "not-modified") {
      // 304 不是重定向，也不代表资源可用：脚本没发送条件请求，拿不到内容也拿不到 2xx。
      return out({
        ok: false, level: "fail",
        reason: "304 Not Modified 不是重定向，也没有返回资源内容（脚本未发送条件请求）；不能判定资源正常",
        finalStatus: status,
      });
    }
    if (statusClass === "unexpected-3xx") {
      return out({
        ok: false, level: "warn",
        reason: `${status} 属于 3xx，但不在需要跟随的重定向状态（301/302/303/307/308）里；资源未通过验证，需人工确认`,
        finalStatus: status,
      });
    }
    return out({ ok: false, level: "fail", reason: `最终状态 ${status} 不是 2xx`, finalStatus: status });
  }
  return out({ ok: false, level: "fail", reason: `重定向超过 ${MAX_REDIRECTS} 跳，可能循环`, finalStatus: chainHops.at(-1)?.status ?? null });
}

const root = await chain(base);
let html = "";
// 跨源时 final 仍是最后一跳的原地址，真正的目标在 redirectTarget 里。
const rootCrossTarget = root.redirectTarget || root.final;
const crossedHost = Boolean(root.redirectTarget) && !sameHost(rootCrossTarget, base);
const rootExtra = {
  hops: root.hops, finalUrl: root.final, redirectTarget: root.redirectTarget,
  crossedHost, httpStatus: root.status, statusClass: root.status == null ? null : classifyStatus(root.status),
  limitHop: root.limitHop || null,
};
if (root.error) {
  add("root", "fail", `请求失败：${root.error}`, { ...rootExtra, redirectOutcome: "network-error", verified: false });
} else if (root.stopped === "cross-origin") {
  // 关键：不请求跨源目标，也就不会拿到「别的网站返回 200」来给原站点判 pass。
  add("root", "warn",
    `主站跨源重定向，目标未验证：${root.stopReason}；按策略不请求目标地址，只记录 Location、状态码和重定向链`,
    { ...rootExtra, redirectOutcome: "cross-origin-unverified", verified: false });
} else if (root.stopped === "unsupported-protocol") {
  add("root", "fail", `主站重定向到非 HTTP/HTTPS 协议，已拒绝且不请求目标：${root.stopReason}`,
    { ...rootExtra, redirectOutcome: "unsupported-protocol", verified: false });
} else if (root.stopped === "invalid-location") {
  add("root", "fail", `主站重定向的 Location 缺失或无法解析：${root.stopReason}`,
    { ...rootExtra, redirectOutcome: "invalid-location", verified: false });
} else if (root.stopped === "not-modified") {
  // 304 不是重定向：既不能说「重定向成功」，也不能说「缺少 Location」。
  add("root", "fail", `主站返回 304 Not Modified，不是重定向，也没有可验证的首页内容：${root.stopReason}`,
    { ...rootExtra, redirectOutcome: "not-modified", verified: false });
} else if (root.stopped === "unexpected-3xx") {
  // 300 / 305 等少见 3xx：不跟随、不判通过，交给人工确认。
  add("root", "warn", `主站返回 ${root.status}（3xx 但不是需要跟随的重定向）：${root.stopReason}；按策略不跟随，也不能当作通过`,
    { ...rootExtra, redirectOutcome: "unexpected-3xx", verified: false });
} else if (root.stopped === "loop-or-limit") {
  add("root", "fail", `主站重定向循环或超过跳数：${root.stopReason}；未取得最终响应`,
    { ...rootExtra, redirectOutcome: "loop-or-limit", verified: false });
} else {
  const first = root.hops[0];
  const sameOriginHops = root.hops.length - 1;
  const ok = root.status === 200;
  add(
    "root",
    ok ? "pass" : "fail",
    `GET / -> ${root.status}，${first?.ms ?? "?"}ms`
      + (sameOriginHops > 0 ? `；同源重定向 ${sameOriginHops} 跳后${ok ? "最终验证成功" : "最终状态未通过"}` : ""),
    {
      ...rootExtra, redirectTarget: null, crossedHost: false, verified: ok,
      redirectOutcome: sameOriginHops > 0
        ? (ok ? "same-origin-verified" : "same-origin-final-failed")
        : "no-redirect",
    }
  );
  const ct = root.res.headers.get("content-type") || "";
  add("content-type", /text\/html/i.test(ct) ? "pass" : "warn", ct || "缺少 content-type");
  try { html = await root.res.text(); } catch { html = ""; }
}

// ---------------------------------------------------------------- 404 / SPA 回退
const missingUrl = resolve(notFoundPath);
const missing = await req(missingUrl, { method: "GET", headers: { "user-agent": UA } });

if (!missing.res) {
  add("404", "warn", `无法检查 404：${missing.error}`, { mode });
} else {
  const status = missing.res.status;
  const ct = missing.res.headers.get("content-type") || "";
  const isHtml = /text\/html/i.test(ct);

  if (mode === "spa") {
    if (status === 200 && isHtml) {
      const body = await missing.res.text().catch(() => "");
      const markers = ["id=\"root\"", "id='root'", "id=\"app\"", "id='app'", "id=\"__next\"", "id='__next'"].filter((m) => html.includes(m));
      const moduleScript = html.match(/<script[^>]+type=["']module["'][^>]*src=["']([^"']+)["']/i)?.[1];
      const tokens = [...markers, ...(moduleScript ? [moduleScript] : [])];
      const shellOk = tokens.length ? tokens.some((t) => body.includes(t)) : body.length > 0;
      add(
        "spa-fallback",
        shellOk ? "pass" : "warn",
        shellOk
          ? `GET ${notFoundPath} -> 200，返回的 HTML 含有 app shell 标记`
          : `GET ${notFoundPath} -> 200，但返回内容不像 app shell（没有 root 容器或入口脚本）；确认没有把 404 页当 200 返回`,
        { httpStatus: status, mode, markers: tokens.length }
      );
    } else if (status === 404) {
      add("spa-fallback", "warn", `GET ${notFoundPath} -> 404：纯客户端路由刷新会断；若使用 hash 路由可接受`, { httpStatus: status, mode });
    } else if (classifyStatus(status) === "redirect") {
      add("spa-fallback", "warn", `GET ${notFoundPath} -> ${status}${missing.res.headers.get("location") ? ` -> ${missing.res.headers.get("location")}` : ""}；重定向式回退会让深链丢失原路径`, { httpStatus: status, mode });
    } else {
      add("spa-fallback", "fail", `GET ${notFoundPath} -> ${status}；SPA 期望 200 + HTML`, { httpStatus: status, mode });
    }
  } else if (mode === "ssr") {
    // SSR 框架通常对未知路由返回 404；返回 200 可能是 catch-all 或自定义 404，先提示不判死。
    if (status === 404) {
      add("404", "pass", `GET ${notFoundPath} -> 404（ssr 模式）`, { httpStatus: status, mode });
    } else if (status >= 200 && status < 300) {
      add("404", "warn", `GET ${notFoundPath} -> ${status}；SSR 返回 200，确认这是自定义 404 而不是把所有未知路径都渲染成首页`, { httpStatus: status, mode });
    } else {
      add("404", "warn", `GET ${notFoundPath} -> ${status}；ssr 模式通常期望 404`, { httpStatus: status, mode });
    }
  } else if (status === 404) {
    add("404", "pass", `GET ${notFoundPath} -> 404（${mode} 模式）`, { httpStatus: status, mode });
  } else if (status === 200) {
    const body = await missing.res.text().catch(() => "");
    const looksLikeRoot = html.length > 0 && body.length > 0 && (body === html || (body.includes("<title") && body.length > html.length * 0.5));
    add(
      "404",
      "fail",
      `GET ${notFoundPath} -> 200；${mode} 模式期望 404${looksLikeRoot ? "。返回内容与首页接近：SPA 回退把未知路径吞掉了" : "。可能是 rewrite 或自定义 404 用了 200"}`,
      { httpStatus: status, mode, looksLikeRoot }
    );
  } else {
    add("404", "fail", `GET ${notFoundPath} -> ${status}；${mode} 模式期望 404`, { httpStatus: status, mode });
  }
}

/**
 * 读取标签上的属性值，按 HTML 属性语法处理三种合法写法：
 *   href="..." / href='...' / href=不带引号的值
 * 返回 { present, value }：
 *   present=false 标签没有该属性
 *   value=""      有属性但值为空（href=""、href=''、不带值的 href）
 *   value="..."   原始属性值，是否 trim / 能否解析交给调用方
 * 不能只用 /href=(["'])(...)/：那会把不带引号的合法值漏成空字符串，
 * 而后者被 new URL("", base) 解析成当前站点，正是 canonical 误判的来源。
 */
function readHtmlAttr(tag, name) {
  // 去掉标签名和结尾的 ">"，逐段扫描属性；引号内的空格不会被当成属性分隔符。
  const src = tag.replace(/^<\s*[^\s/>]+/, "").replace(/\/?>\s*$/, "");
  const wanted = name.toLowerCase();
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (i >= src.length) break;
    const nameStart = i;
    while (i < src.length && !/[\s=]/.test(src[i])) i++;
    const attrName = src.slice(nameStart, i).toLowerCase();
    while (i < src.length && /\s/.test(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src[i] === '"' || src[i] === "'") {
        const quote = src[i];
        i++;
        const valueStart = i;
        while (i < src.length && src[i] !== quote) i++;
        value = src.slice(valueStart, i);
        if (i < src.length) i++; // 跳过收尾引号
      } else {
        const valueStart = i;
        while (i < src.length && !/[\s"'=<>`]/.test(src[i])) i++;
        value = src.slice(valueStart, i);
      }
    }
    if (attrName === wanted) return { present: true, value };
  }
  return { present: false, value: null };
}

// ---------------------------------------------------------------- HTML 内容
if (html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().replace(/\s+/g, " ").slice(0, 120) || null;
  add("title", title ? "pass" : "warn", title || "没有 <title>");

  const canonTags = [...html.matchAll(/<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>/gi)].map((m) => m[0]);
  if (canonTags.length === 0) {
    add("canonical", "skip", "没有 canonical 标签");
  } else if (canonTags.length > 1) {
    add("canonical", "fail", `发现 ${canonTags.length} 个 canonical 标签；浏览器和爬虫只认第一个，通常意味着模板重复输出`, { count: canonTags.length, tags: canonTags.slice(0, 3) });
  } else {
    const tag = canonTags[0];
    const snippet = tag.length > 160 ? `${tag.slice(0, 157)}…` : tag;
    const attr = readHtmlAttr(tag, "href");
    if (!attr.present) {
      // 缺 href 不是「空 URL」，更不能拿 base 顶替：它是无效的 canonical 声明。
      add("canonical", "fail", `canonical 标签缺少 href 属性：${snippet}；没有 href 不算指向自身，也没有可解析目标`,
        { href: null, hrefState: "missing", tag: snippet });
    } else if (!attr.value.trim()) {
      add("canonical", "fail", `canonical href 为空字符串：${snippet}；空值不会被解析成当前站点，也不算指向自身`,
        { href: attr.value, hrefState: "empty", tag: snippet });
    } else {
      const href = attr.value;
      let parsed = null;
      try { parsed = new URL(href, base); } catch { parsed = null; }
      const norm = (p) => (p.replace(/\/index\.html$/i, "/").replace(/\/+$/, "") || "/");
      if (!parsed) {
        // 明确报告无法解析，绝不回退到 base 再判 self-canonical。
        add("canonical", "fail", `canonical href 无法解析：${href}；不回退到当前站点，也不判指向自身`,
          { href, hrefState: "invalid", tag: snippet });
      } else {
        const baseUrl = new URL(base);
        // 指向自身必须协议、主机、规范化路径三者都一致；只比 host + pathname 会把
        // https 站点上的 http canonical 误判成 self-canonical。
        const protocolOk = parsed.protocol === baseUrl.protocol;
        const hostOk = parsed.host === baseUrl.host;
        const pathOk = norm(parsed.pathname) === norm(baseUrl.pathname);
        const self = protocolOk && hostOk && pathOk;
        const protoNote = protocolOk ? "" : `协议不一致（canonical 为 ${parsed.protocol}，当前站点为 ${baseUrl.protocol}）；`;
        add(
          "canonical",
          self ? "pass" : "warn",
          self
            ? `canonical 指向自身（${parsed.pathname}）`
            : !hostOk
              ? protoNote + `canonical 指向其他主机：${parsed.origin}${parsed.pathname}；如果这是备用站且策略是「canonical 指主站」属预期，否则权重被指向外部`
              : !pathOk
                ? protoNote + `canonical 指向另一个路径：${parsed.pathname}；确认这是有意为之（分页/聚合页）`
                : `${protoNote}canonical 协议与当前站点不一致：${parsed.href}；主机和路径相同但协议不同，不算指向自身（当前站点 ${baseUrl.href}）`,
          { href, hrefState: "valid", sameProtocol: protocolOk, sameHost: hostOk, samePath: pathOk }
        );
      }
    }
  }

  const robots = html.match(/<meta[^>]+name=["']robots["'][^>]*>/i)?.[0] || null;
  add("meta-robots", robots ? "pass" : "skip", robots ? robots.slice(0, 160) : "没有 meta robots");

  // SSR 的关键差异：HTML 里应当已经有服务端渲染的内容，而不是空壳 + 客户端补。
  if (mode === "ssr") {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    add(
      "ssr-html",
      text.length >= 200 ? "pass" : "warn",
      `服务端输出的可见文本 ${text.length} 字符${text.length < 200 ? "；可能只是空壳，真实内容主要靠客户端渲染" : ""}`,
      { textLength: text.length }
    );
    // 用最终响应测 TTFB；同源重定向时第一跳只是 3xx，不代表首页耗时。
    const ms = root.hops.at(-1)?.ms;
    if (typeof ms === "number") {
      add("ttfb", ms < 2000 ? "pass" : "warn", `首页 TTFB ${ms}ms（单次采样，可能含冷启动；不是性能结论）`, { ms });
    }
  }

  // ---------------------------------------------------------------- 同源资源
  const { unique: allUnique, ignored } = collectAssetRefs(html, base, dirBase);
  const unique = allUnique.slice(0, assetsLimit);
  const broken = [];
  const warnings = [];
  const probed = [];
  for (const ref of unique) {
    const a = await probeAsset(ref.abs);
    // 报告保留原始地址、完整重定向链和最终状态，便于事后核对。
    probed.push({
      url: ref.url, method: a.method, status: a.finalStatus, fallback: a.fallback,
      redirected: a.redirected, finalUrl: a.finalUrl, finalStatus: a.finalStatus,
      crossHost: a.crossHost, chain: a.chainHops, level: a.level, reason: a.reason,
    });
    // probed / broken / warnings / redirects 用同一组字段，跨源重定向不会在汇总里丢掉。
    const entry = {
      url: ref.url, reason: a.reason, finalUrl: a.finalUrl, finalStatus: a.finalStatus,
      redirected: a.redirected, crossHost: a.crossHost, level: a.level, chain: a.chainHops,
    };
    if (a.level === "fail") broken.push({ ...entry, status: a.finalStatus ?? a.reason, method: a.method });
    else if (a.level === "warn") warnings.push(entry);
  }
  const fallbackCount = probed.filter((p) => p.fallback).length;
  const redirects = probed.filter((p) => p.redirected).map((p) => ({
    url: p.url, finalUrl: p.finalUrl, finalStatus: p.finalStatus,
    crossHost: p.crossHost, level: p.level, reason: p.reason, chain: p.chain,
  }));
  const suffix = allUnique.length > unique.length ? `（只检查前 ${unique.length} 个，共 ${allUnique.length} 个；不是全站爬取）` : `（共 ${allUnique.length} 个，覆盖首页引用）`;
  const headNote = fallbackCount ? `；其中 ${fallbackCount} 个 HEAD 不可用，改用 GET` : "";
  const ignoredNote = ignored.length ? `；另有 ${ignored.length} 个跨源或非 HTTP(S) 引用按策略未请求` : "";
  const crossRedirects = redirects.filter((r) => r.crossHost).length;
  const redirectNote = redirects.length
    ? `；${redirects.length} 个发生重定向${crossRedirects ? `（其中 ${crossRedirects} 个跨主机／跨源，目标未验证）` : ""}；见 chain / finalUrl / finalStatus`
    : "";
  add(
    "assets",
    broken.length ? "fail" : warnings.length ? "warn" : "pass",
    broken.length
      ? `${broken.length}/${unique.length} 个资源失败${suffix}：${broken.slice(0, 5).map((b) => `${b.url}（${b.reason}）`).join("、")}${redirectNote}${ignoredNote}`
      : warnings.length
        ? `${warnings.length}/${unique.length} 个资源需人工确认${suffix}：${warnings.slice(0, 5).map((w) => `${w.url}（${w.reason}）`).join("、")}${redirectNote}${ignoredNote}`
        : `${unique.length} 个同源资源正常${suffix}${headNote}${redirectNote}${ignoredNote}`,
    { broken, warnings, redirects, ignored, checked: unique.length, total: allUnique.length, limited: allUnique.length > unique.length, probed }
  );
} else {
  add("html", "warn", "没有拿到首页 HTML；跳过标题、canonical、资源检查");
}

// ---------------------------------------------------------------- API（可选）
const expected = expectJson ? parseExpectedJson(expectJson) : null;
if (apiPaths.length) {
  for (const p of apiPaths) {
    const u = resolve(p);
    const started = Date.now();
    const r = await req(u, { method: "GET", headers: { "user-agent": UA } });
    if (!r.res) {
      add("api", "fail", `GET ${p} 请求失败：${r.error}`, { path: p, expectedFound: expected ? false : null });
      continue;
    }
    const status = r.res.status;
    const ct = r.res.headers.get("content-type") || "";
    const isJson = /application\/(?:[\w.+-]*\+)?json/i.test(ct);
    let body = "";
    try { body = await r.res.text(); } catch { body = ""; }

    const reasons = [];
    if (!(status >= 200 && status < 300)) reasons.push(`状态码 ${status} 不是 2xx`);
    if (!isJson) reasons.push(`Content-Type 不是 JSON（${ct || "无"}）`);

    let comparison = null;
    let expectedFound = expected ? false : null;
    let expectedJsonError = null;
    if (expected) {
      if (!expected.ok) {
        expectedJsonError = expected.error;
        reasons.push(expected.error);
      } else if (isJson) {
        let actual = null;
        let bodyError = null;
        try { actual = JSON.parse(body); } catch (e) { bodyError = e.message; }
        if (bodyError) {
          reasons.push(`响应体不是合法 JSON：${bodyError}`);
        } else {
          comparison = compareJson(expected.value, actual);
          expectedFound = comparison.match;
          if (!comparison.match) reasons.push(`期望 JSON 不匹配：${comparison.reason}`);
        }
      }
    }
    add(
      "api",
      reasons.length ? "fail" : "pass",
      `GET ${p} -> ${status}${isJson ? " JSON" : ` ${ct || "(无 content-type)"}`}`
        + (comparison?.match ? "，期望 JSON 子集匹配" : "")
        + (reasons.length ? `；${reasons.join("；")}` : "")
        + `（${Date.now() - started}ms）`,
      { path: p, httpStatus: status, isJson, expectedFound, expectedJsonError, jsonComparison: comparison }
    );
  }
} else if (expectJson) {
  add("api", "warn", "--expect-json 需要配合 --api 使用", { expectedFound: null });
}

// ---------------------------------------------------------------- 响应头
// 只有拿到最终 2xx 的首页响应时才检查响应头：3xx/304 的响应头不能代表页面。
const headers = root.status === 200 ? root.res?.headers : null;
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
{
  const target = resolve("index.html");
  const r = await probe(target);
  if (r.res) {
    const status = r.res.status;
    const statusClass = classifyStatus(status);
    const loc = r.res.headers.get("location");
    const locNote = loc ? ` -> ${loc}` : "";
    // 只有「常见重定向状态 + 可解析 Location」才算发生了有效重定向；
    // 304 与少见 3xx 既不跟随，也不能判 pass。
    if (statusClass === "redirect") {
      const c = classifyRedirect(target, loc, new URL(base).origin);
      // HTTP 状态码放 httpStatus：add() 的 status 是检查结论（pass/warn/fail），
      // 同名的附加字段会被覆盖，root / backup 也用 httpStatus。
      const baseExtra = { httpStatus: status, statusClass, location: loc, redirect: false, redirectKind: c.kind, next: c.next || null };
      if (c.kind === "invalid-location") {
        add("index-redirect", "warn",
          `${r.method} /index.html -> ${status}${locNote}，但 Location 缺失或无法解析：${c.reason}；不能确认收敛到 /`,
          { ...baseExtra, convergesToRoot: false });
      } else if (c.kind !== "same-origin") {
        // 跨源 / 非 HTTP(S) 目标按策略不请求，也不能把「有重定向」当成收敛到 /。
        add("index-redirect", "warn",
          `${r.method} /index.html -> ${status}${locNote}；目标不是同源 HTTP(S)（${c.kind}），按策略不请求，也不能证明收敛到 /：${c.reason}`,
          { ...baseExtra, convergesToRoot: false });
      } else {
        // 只有同源且重定向目标就是站点根时才算收敛；指向别处的 3xx 不能判 pass。
        const normPath = (p) => (p.replace(/\/index\.html$/i, "/").replace(/\/+$/, "") || "/");
        const rootPath = normPath(new URL(base).pathname);
        const targetPath = normPath(new URL(c.next).pathname);
        const convergesToRoot = targetPath === rootPath;
        const rootLabel = rootPath === "/" ? "/" : `${rootPath}/`;
        add("index-redirect", convergesToRoot ? "pass" : "warn",
          convergesToRoot
            ? `${r.method} /index.html -> ${status}${locNote}（同源，收敛到站点根 ${rootLabel}）`
            : `${r.method} /index.html -> ${status}${locNote}；重定向目标不是站点根 ${rootLabel}，确认这是有意为之`,
          { ...baseExtra, redirect: convergesToRoot, targetPath, convergesToRoot });
      }
    } else if (statusClass === "not-modified") {
      add("index-redirect", "warn",
        `${r.method} /index.html -> 304 Not Modified，不是重定向；脚本未发送条件请求，不能确认收敛到 /`,
        { httpStatus: status, statusClass, location: loc, redirect: false });
    } else if (statusClass === "unexpected-3xx") {
      add("index-redirect", "warn",
        `${r.method} /index.html -> ${status}（3xx 但不是可跟随的重定向），不能确认收敛到 /`,
        { httpStatus: status, statusClass, location: loc, redirect: false });
    } else {
      add("index-redirect", "warn",
        `${r.method} /index.html -> ${status}${locNote}；没有重定向到 /（确认这是有意为之）`,
        { httpStatus: status, statusClass, location: loc, redirect: false });
    }
  }
}

// ---------------------------------------------------------------- CORS（可选）
if (origin) {
  // 默认查首页；API 在别的子域时用 --cors-url 指到真正的接口。
  const corsUrl = resolve(getArg("--cors-url", base));
  const r = await req(corsUrl, { method: "GET", headers: { "user-agent": UA, origin } });
  if (!r.res) {
    add("cors", "warn", `CORS 检查失败：${r.error}`, { url: corsUrl });
  } else {
    const acao = r.res.headers.get("access-control-allow-origin");
    const acac = r.res.headers.get("access-control-allow-credentials");
    const vary = r.res.headers.get("vary") || "";
    const multiple = Boolean(acao && acao.includes(","));
    // 凭据模式只由 --cors-credentials 声明（脚本本身不发 Cookie / Authorization）。
    // 响应里的 ACAC: true 是服务器声明，不能反推「请求带凭据」，因此
    // 无凭据 + ACAO=* + ACAC=true 仍然允许；反过来，声明带凭据时
    // 既要求 ACAO 精确匹配 Origin，也要求 ACAC: true。
    const wildcardRejected = acao === "*" && corsCredentials;
    const matches = acao === origin || (acao === "*" && !corsCredentials);
    const credentialsHeaderOk = !corsCredentials || String(acac || "").trim().toLowerCase() === "true";
    const issues = [];
    if (multiple) issues.push(`多个 Access-Control-Allow-Origin 值：${acao}`);
    if (wildcardRejected) issues.push("ACAO=* 不能用于带凭据请求（--cors-credentials 声明的预期模式），必须精确匹配 Origin");
    else if (acao && !matches) issues.push(`ACAO=${acao} 与请求的 Origin（${origin}）不匹配，浏览器会拒绝`);
    if (acao && !credentialsHeaderOk) issues.push(`带凭据请求需要 Access-Control-Allow-Credentials: true，实际 ${acac || "无"}`);
    const okDetail = `GET ${new URL(corsUrl).pathname} → ACAO=${acao || "无"}${acac ? `，ACAC=${acac}` : ""}${vary.includes("Origin") ? "，Vary: Origin" : ""}`
      + (corsCredentials ? "；按 --cors-credentials 声明的带凭据模式判定" : "；按无凭据模式判定（ACAC 响应头不改变请求模式）");
    add(
      "cors",
      issues.length ? "fail" : acao ? "pass" : "warn",
      issues.length ? issues.join("；") : acao ? okDetail : "缺少 Access-Control-Allow-Origin；CORS 未验证",
      {
        url: corsUrl, acao, acac, vary, origin, credentials: corsCredentials,
        credentialsMode: corsCredentials ? "declared-with-credentials" : "declared-no-credentials",
        credentialsDeclaredByUser: true,
      }
    );
    if (acao && !vary.toLowerCase().includes("origin")) {
      add("cors-vary", "warn", "缺少 Vary: Origin；CDN 可能把给 A 站的响应缓存给 B 站");
    }
    // 没显式给实际方法/请求头时，用默认值发「探针」，但不对 Allow-* 做断言。
    // 不能因为预检返回 200/204 就说 CORS 通过。
    const probeMethod = corsMethod || "POST";
    const probeHeaders = corsHeadersArg || "content-type,authorization";
    const pre = await req(corsUrl, {
      method: "OPTIONS",
      headers: {
        "user-agent": UA, origin,
        "access-control-request-method": probeMethod,
        "access-control-request-headers": probeHeaders,
      },
    });
    const notChecked = [];
    if (!corsMethod) notChecked.push("Allow-Methods（未提供 --cors-method，预检仅用默认探针 POST）");
    if (!corsHeadersArg) notChecked.push("Allow-Headers（未提供 --cors-headers，预检仅用默认探针 content-type,authorization）");
    if (!corsCredentials) notChecked.push("Allow-Credentials（未提供 --cors-credentials，未假设使用 Cookie/凭据）");

    if (!pre.res) {
      add("cors-preflight", "warn", `预检请求失败：${pre.error}`, {
        url: corsUrl, origin, requestMethod: corsMethod, requestHeaders: corsHeadersArg,
        credentials: corsCredentials, probeMethod, probeHeaders, notChecked, issues: [pre.error],
      });
    } else {
      const preAcao = pre.res.headers.get("access-control-allow-origin");
      const allowMethods = pre.res.headers.get("access-control-allow-methods") || "";
      const allowHeaders = pre.res.headers.get("access-control-allow-headers") || "";
      const allowCred = pre.res.headers.get("access-control-allow-credentials");
      const issues = [];
      const checked = ["ACAO", "HTTP 状态"];

      // ACAO：始终检查，不依赖额外输入。
      if (!preAcao) issues.push("缺少 Access-Control-Allow-Origin");
      else if (preAcao.includes(",")) issues.push(`ACAO 有多个值：${preAcao}`);
      else if (preAcao !== "*" && preAcao !== origin) issues.push(`ACAO=${preAcao} 与请求 Origin（${origin}）不匹配`);

      // 2xx 是必要条件，不是充分条件。
      if (!(pre.res.status >= 200 && pre.res.status < 300)) issues.push(`OPTIONS 返回 ${pre.res.status}，不是 2xx`);

      if (corsMethod) {
        checked.push("Allow-Methods");
        const r = allowMethodCheck(allowMethods, corsMethod, corsCredentials);
        if (!r.ok) {
          // 缺头本身不必然失败：GET/HEAD/POST 是 CORS-safelisted，无需列在 Allow-Methods。
          if (!allowMethods) issues.push("缺少 Access-Control-Allow-Methods");
          issues.push(r.reason);
        }
      }
      if (corsHeadersArg) {
        checked.push("Allow-Headers");
        for (const h of splitTokens(corsHeadersArg)) {
          const r = allowHeaderCheck(allowHeaders, h, corsCredentials);
          if (!r.ok) {
            if (!allowHeaders) { issues.push("缺少 Access-Control-Allow-Headers"); break; }
            issues.push(r.reason);
          }
        }
      }
      if (corsCredentials) {
        checked.push("Allow-Credentials");
        if (preAcao === "*") issues.push("带凭据时 ACAO 不能是 *，必须精确匹配 Origin");
        if (String(allowCred || "").toLowerCase() !== "true") issues.push(`带凭据需要 Access-Control-Allow-Credentials: true，实际 ${allowCred || "无"}`);
      }

      const detail = `OPTIONS -> ${pre.res.status}；ACAO=${preAcao || "无"}；Allow-Methods=${allowMethods || "无"}；Allow-Headers=${allowHeaders || "无"}${allowCred ? `；ACAC=${allowCred}` : ""}`
        + (issues.length ? `；失败：${issues.join("；")}` : `；已提供的断言全部通过（${checked.join("、")}）`)
        + (notChecked.length ? `；未执行：${notChecked.join("；")}` : "");
      add("cors-preflight", issues.length ? "fail" : "pass", detail, {
        url: corsUrl, origin,
        httpStatus: pre.res.status, acao: preAcao, methods: allowMethods, headers: allowHeaders,
        allowCredentials: allowCred, requestMethod: corsMethod, requestHeaders: corsHeadersArg,
        credentials: corsCredentials, probeMethod, probeHeaders, checked, notChecked, issues,
      });
    }
  }
}

// ---------------------------------------------------------------- 备用站独立性（GitHub Pages）
if (backup) {
  const b = await chain(backup);
  // 只解析 hops 里的 Location 判断是否指向主站，不需要请求主站；
  // 跨源目标按策略一律不跟随，避免为「识别」而访问不受信任的地址。
  const mainHost = new URL(base).host;
  const redirectedToMain = b.hops.some((h) => h.location && (() => {
    try { return new URL(h.location, h.url).host === mainHost; } catch { return false; }
  })());
  const bExtra = {
    hops: b.hops, redirectOutcome: b.stopped, redirectTarget: b.redirectTarget,
    httpStatus: b.status, statusClass: b.status == null ? null : classifyStatus(b.status),
  };
  if (b.error) add("backup", "fail", `备用站请求失败：${b.error}`, bExtra);
  else if (redirectedToMain) add("backup", "fail", "备用站跳转到主站，不是独立备用入口（只解析 Location 判断，未请求主站）", bExtra);
  else if (b.stopped === "not-modified" || b.stopped === "unexpected-3xx") {
    // 与主站共用状态分类：这两种 3xx 不是重定向，不能写成「重定向未完成验证」。
    add("backup", "fail", `备用站返回 ${b.status}，不是可验证的响应：${b.stopReason}`, bExtra);
  } else if (b.stopped) add("backup", "fail", `备用站重定向未完成验证：${b.stopReason}（目标未请求）`, bExtra);
  else {
    const server = b.res.headers.get("server") || "";
    if (b.status !== 200) add("backup", "fail", `备用站 -> ${b.status}${b.hops.at(-1)?.location ? `（${b.hops.at(-1).location}）` : ""}`, bExtra);
    else if (/cloudflare/i.test(server)) add("backup", "warn", `备用站由 Cloudflare 提供（${server}），可能扛不住 Cloudflare 故障`, bExtra);
    else add("backup", "pass", `备用站 200，Server: ${server || "未知"}`, bExtra);
  }
}

const summary = {
  pass: checks.filter((c) => c.status === "pass").length,
  warn: checks.filter((c) => c.status === "warn").length,
  fail: checks.filter((c) => c.status === "fail").length,
  skip: checks.filter((c) => c.status === "skip").length,
};
const result = {
  schemaVersion: 2, url: base, mode, backup, origin,
  corsUrl: origin ? resolve(getArg("--cors-url", base)) : null,
  corsOptions: origin ? { method: corsMethod, headers: corsHeadersArg, credentials: corsCredentials } : null,
  api: apiPaths.length ? apiPaths : null,
  expectJson,
  expectJsonMode: expectJson ? "json-subset" : null,
  checkedAt: new Date().toISOString(), summary, checks,
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const c of checks) {
    const mark = { pass: "通过", warn: "警告", fail: "失败", skip: "跳过" }[c.status] || c.status;
    console.log(`[${mark}] ${c.id}: ${c.detail}`);
  }
  console.log(`\n模式=${mode}，通过=${summary.pass} 警告=${summary.warn} 失败=${summary.fail} 跳过=${summary.skip}`);
}
process.exitCode = summary.fail ? 1 : 0;
