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
 *
 * 资源重定向会单独跟随（同主机，最多 5 跳），3xx 不再直接算资源正常；
 * 跨主机重定向只记录不跟随，明确标 warn。
 *
 * 只读：只发 GET/HEAD/OPTIONS。不会跟随跨主机重定向而不报告。
 * 相对路径按站点根解析（支持 /repo/ 这样的子路径站点），以 / 开头的按域名根解析。
 * 不能证明搜索引擎实际选择的 canonical，也不能替代浏览器里的 CORS 判定。
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
const notFoundPath = getArg("--expect-404", `__cf_deploy_check_${Date.now()}/`);
const timeout = Number(getArg("--timeout", "15000"));
const assetsLimit = Math.max(1, Number(getArg("--assets-limit", "20")));
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

const UA = "cloudflare-deploy-verify/2";
const checks = [];
// 附加字段不能覆盖 id/status/detail 本身。
const add = (id, status, detail, extra = {}) => checks.push({ ...extra, id, status, detail });
// 站点可能挂在子路径下（GitHub Pages project site、多站点同域）。
// 相对路径按站点根解析；以 / 开头的仍按域名根解析。
const dirBase = base.endsWith("/") ? base : `${base}/`;
const resolve = (u) => new URL(u, dirBase).toString();

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
    const r = await req(current, { method: "GET", headers: { "user-agent": UA } });
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

const MAX_ASSET_REDIRECTS = 5;

/**
 * 资源专用探针。req() 用 redirect: "manual"，3xx 不会自动跟随；旧逻辑把
 * `status >= 400` 当作唯一失败条件，于是 301/302/307/308 被默默算成资源正常。
 * 这里单独跟随同主机重定向并验证最终 2xx；跨主机只记录最终地址、不跟随，
 * 标 warn 交人工确认；跳数有上限，防止循环。
 */
async function probeAsset(url) {
  const chainHops = [];
  let current = url;
  let method = null;
  let fallback = false;
  const out = (extra) => ({
    url, current, method, fallback, chainHops,
    redirected: chainHops.length > 1,
    finalUrl: current, finalStatus: null, crossHost: false,
    ...extra,
  });
  for (let hop = 0; hop <= MAX_ASSET_REDIRECTS; hop++) {
    const r = await probe(current);
    method = r.method;
    if (r.note) fallback = true;
    if (!r.res) return out({ ok: false, level: "fail", reason: `请求失败：${r.error}` });
    const status = r.res.status;
    const loc = r.res.headers.get("location");
    chainHops.push({ url: current, status, location: loc });
    if (r.res.body) { try { await r.res.body.cancel(); } catch { /* 已关闭 */ } }
    if (status >= 300 && status < 400) {
      if (!loc) return out({ ok: false, level: "fail", reason: `${status} 重定向缺少 Location，无法确认最终资源`, finalStatus: status });
      let next;
      try { next = new URL(loc, current).toString(); }
      catch { return out({ ok: false, level: "fail", reason: `${status} 重定向的 Location 无法解析：${loc}`, finalStatus: status }); }
      if (!sameHost(next, current)) {
        return out({ ok: true, level: "warn", reason: `跨主机重定向到 ${next}（按策略不跟随，最终资源未验证）`, finalUrl: next, finalStatus: status, crossHost: true });
      }
      current = next;
      continue;
    }
    if (status >= 200 && status < 300) return out({ ok: true, level: "pass", reason: null, finalStatus: status });
    return out({ ok: false, level: "fail", reason: `最终状态 ${status} 不是 2xx`, finalStatus: status });
  }
  return out({ ok: false, level: "fail", reason: `重定向超过 ${MAX_ASSET_REDIRECTS} 跳，可能循环`, finalStatus: chainHops.at(-1)?.status ?? null });
}

const root = await chain(base);
let html = "";
if (root.error || !root.res) {
  add("root", "fail", `请求失败：${root.error}`, { hops: root.hops });
} else {
  const first = root.hops[0];
  const crossedHost = root.final !== base && !sameHost(root.final, base);
  add(
    "root",
    root.status === 200 ? "pass" : "fail",
    `GET / -> ${root.status}，${first?.ms ?? "?"}ms${crossedHost ? `；跨主机重定向到 ${root.final}` : ""}`,
    { hops: root.hops, finalUrl: root.final, crossedHost }
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
        { status, mode, markers: tokens.length }
      );
    } else if (status === 404) {
      add("spa-fallback", "warn", `GET ${notFoundPath} -> 404：纯客户端路由刷新会断；若使用 hash 路由可接受`, { status, mode });
    } else if (status >= 300 && status < 400) {
      add("spa-fallback", "warn", `GET ${notFoundPath} -> ${status}${missing.res.headers.get("location") ? ` -> ${missing.res.headers.get("location")}` : ""}；重定向式回退会让深链丢失原路径`, { status, mode });
    } else {
      add("spa-fallback", "fail", `GET ${notFoundPath} -> ${status}；SPA 期望 200 + HTML`, { status, mode });
    }
  } else if (mode === "ssr") {
    // SSR 框架通常对未知路由返回 404；返回 200 可能是 catch-all 或自定义 404，先提示不判死。
    if (status === 404) {
      add("404", "pass", `GET ${notFoundPath} -> 404（ssr 模式）`, { status, mode });
    } else if (status >= 200 && status < 300) {
      add("404", "warn", `GET ${notFoundPath} -> ${status}；SSR 返回 200，确认这是自定义 404 而不是把所有未知路径都渲染成首页`, { status, mode });
    } else {
      add("404", "warn", `GET ${notFoundPath} -> ${status}；ssr 模式通常期望 404`, { status, mode });
    }
  } else if (status === 404) {
    add("404", "pass", `GET ${notFoundPath} -> 404（${mode} 模式）`, { status, mode });
  } else if (status === 200) {
    const body = await missing.res.text().catch(() => "");
    const looksLikeRoot = html.length > 0 && body.length > 0 && (body === html || (body.includes("<title") && body.length > html.length * 0.5));
    add(
      "404",
      "fail",
      `GET ${notFoundPath} -> 200；${mode} 模式期望 404${looksLikeRoot ? "。返回内容与首页接近：SPA 回退把未知路径吞掉了" : "。可能是 rewrite 或自定义 404 用了 200"}`,
      { status, mode, looksLikeRoot }
    );
  } else {
    add("404", "fail", `GET ${notFoundPath} -> ${status}；${mode} 模式期望 404`, { status, mode });
  }
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
    const href = canonTags[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1] || "";
    let parsed = null;
    try { parsed = new URL(href, base); } catch { parsed = null; }
    const norm = (p) => (p.replace(/\/index\.html$/i, "/").replace(/\/+$/, "") || "/");
    if (!parsed) {
      add("canonical", "fail", `canonical href 无法解析：${href || "(空)"}`, { href });
    } else {
      const hostOk = parsed.host === new URL(base).host;
      const pathOk = norm(parsed.pathname) === norm(new URL(base).pathname);
      add(
        "canonical",
        hostOk && pathOk ? "pass" : "warn",
        hostOk && pathOk
          ? `canonical 指向自身（${parsed.pathname}）`
          : !hostOk
            ? `canonical 指向其他主机：${parsed.origin}${parsed.pathname}；如果这是备用站且策略是「canonical 指主站」属预期，否则权重被指向外部`
            : `canonical 指向另一个路径：${parsed.pathname}；确认这是有意为之（分页/聚合页）`,
        { href, sameHost: hostOk, samePath: pathOk }
      );
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
    const ms = root.hops[0]?.ms;
    if (typeof ms === "number") {
      add("ttfb", ms < 2000 ? "pass" : "warn", `首页 TTFB ${ms}ms（单次采样，可能含冷启动；不是性能结论）`, { ms });
    }
  }

  // ---------------------------------------------------------------- 同源资源
  const refs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((m) => m[1])
    .filter((u) => !/^(?:https?:)?\/\//i.test(u) && !u.startsWith("data:") && !u.startsWith("#") && !u.startsWith("mailto:") && !u.startsWith("tel:"))
    .map((u) => u.split(/[?#]/)[0])
    .filter(Boolean);
  const allUnique = [...new Set(refs)];
  const unique = allUnique.slice(0, assetsLimit);
  const broken = [];
  const warnings = [];
  const probed = [];
  for (const u of unique) {
    const a = await probeAsset(resolve(u));
    // 报告保留原始地址、完整重定向链和最终状态，便于事后核对。
    probed.push({
      url: u, method: a.method, status: a.finalStatus, fallback: a.fallback,
      redirected: a.redirected, finalUrl: a.finalUrl, finalStatus: a.finalStatus,
      crossHost: a.crossHost, chain: a.chainHops, level: a.level, reason: a.reason,
    });
    const entry = { url: u, reason: a.reason, finalUrl: a.finalUrl, finalStatus: a.finalStatus, chain: a.chainHops };
    if (a.level === "fail") broken.push({ ...entry, status: a.finalStatus ?? a.reason, method: a.method });
    else if (a.level === "warn") warnings.push(entry);
  }
  const fallbackCount = probed.filter((p) => p.fallback).length;
  const redirects = probed.filter((p) => p.redirected).map((p) => ({ url: p.url, finalUrl: p.finalUrl, finalStatus: p.finalStatus, chain: p.chain }));
  const suffix = allUnique.length > unique.length ? `（只检查前 ${unique.length} 个，共 ${allUnique.length} 个；不是全站爬取）` : `（共 ${allUnique.length} 个，覆盖首页引用）`;
  const headNote = fallbackCount ? `；其中 ${fallbackCount} 个 HEAD 不可用，改用 GET` : "";
  const redirectNote = redirects.length ? `；${redirects.length} 个发生重定向（见 chain / finalStatus）` : "";
  add(
    "assets",
    broken.length ? "fail" : warnings.length ? "warn" : "pass",
    broken.length
      ? `${broken.length}/${unique.length} 个资源失败${suffix}：${broken.slice(0, 5).map((b) => `${b.url}（${b.reason}）`).join("、")}${redirectNote}`
      : warnings.length
        ? `${warnings.length}/${unique.length} 个资源需人工确认${suffix}：${warnings.slice(0, 5).map((w) => `${w.url}（${w.reason}）`).join("、")}${redirectNote}`
        : `${unique.length} 个同源资源正常${suffix}${headNote}${redirectNote}`,
    { broken, warnings, redirects, checked: unique.length, total: allUnique.length, limited: allUnique.length > unique.length, probed }
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
      { path: p, status, isJson, expectedFound, expectedJsonError, jsonComparison: comparison }
    );
  }
} else if (expectJson) {
  add("api", "warn", "--expect-json 需要配合 --api 使用", { expectedFound: null });
}

// ---------------------------------------------------------------- 响应头
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
{
  const r = await probe(resolve("index.html"));
  if (r.res) {
    add(
      "index-redirect",
      r.res.status >= 300 && r.res.status < 400 ? "pass" : "warn",
      `${r.method} /index.html -> ${r.res.status}${r.res.headers.get("location") ? ` -> ${r.res.headers.get("location")}` : ""}`
    );
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
    // 用户用 --cors-credentials 声明实际请求带凭据时，ACAO=* 同样无效；
    // 不能只看服务器有没有回 Allow-Credentials: true。
    const wildcardWithCredentials = acao === "*" && (acac === "true" || corsCredentials);
    const matches = (acao === "*" && !wildcardWithCredentials) || acao === origin;
    const status = multiple || wildcardWithCredentials || (acao && !matches) ? "fail" : acao ? "pass" : "warn";
    add(
      "cors",
      status,
      multiple
        ? `多个 Access-Control-Allow-Origin 值：${acao}`
        : wildcardWithCredentials
          ? `ACAO=* 与带凭据请求${acac === "true" ? "（或 Allow-Credentials: true）" : "（--cors-credentials）"}组合无效，浏览器会拒绝`
          : acao && !matches
            ? `ACAO=${acao}，与请求的 Origin（${origin}）不匹配，浏览器会拒绝`
            : `GET ${new URL(corsUrl).pathname} → ACAO=${acao || "无"}${acac ? `，ACAC=${acac}` : ""}${vary.includes("Origin") ? "，Vary: Origin" : ""}`,
      { url: corsUrl, acao, acac, vary, origin, credentials: corsCredentials }
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
