#!/usr/bin/env node
/**
 * probe.mjs — 链路探针：在碰项目之前，先确认「账号 → 权限 → 网络 → 部署」能不能通。
 *
 * 用法：
 *   node scripts/probe.mjs [--json] [--deploy] [--timeout 15000]
 *
 * 默认只读：查网络、wrangler、登录态、账号、Token 读权限。
 * --deploy 会真实部署一个临时 Worker（名字带随机后缀），验证 URL 后立即删除；
 *           这是写操作，必须先得到用户同意。
 *
 * 退出码：0 = ready，1 = limited（能登录但有缺口），2 = blocked（不能部署）。
 * 绝不打印 Token 或完整密钥。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseDeployUrl, verifyDeployedUrl, evaluateDeployProbe } from "./deploy-verdict.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const doDeploy = argv.includes("--deploy");
const getArg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const timeout = Number(getArg("--timeout", "15000"));
const apiBase = "https://api.cloudflare.com/client/v4";

const checks = [];
const add = (id, status, detail, extra = {}) => checks.push({ ...extra, id, status, detail });

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 30000,
    cwd: opts.cwd,
    input: opts.input,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), error: r.error ? String(r.error.code || r.error.message) : null };
}

// wrangler 可能装在本项目、PATH 或只能走 npx；与 check-env.mjs 保持一致。
function wrangler() {
  const local = path.join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  if (fs.existsSync(local)) return { cmd: local, prefix: [], label: "项目内 wrangler" };
  const onPath = run("wrangler", ["--version"], { timeout: 10000 });
  if (onPath.ok) return { cmd: "wrangler", prefix: [], label: "PATH 上的 wrangler" };
  return { cmd: "npx", prefix: ["--no-install", "wrangler"], label: "npx wrangler" };
}

const wr = wrangler();
const call = (args, opts = {}) => run(wr.cmd, [...wr.prefix, ...args], opts);
const today = new Date().toISOString().slice(0, 10);

// 1. 网络：能不能到 Cloudflare API。
let networkOk = false;
{
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.min(timeout, 10000));
  const started = Date.now();
  try {
    const res = await fetch(`${apiBase}/user/tokens/verify`, { signal: ctrl.signal, headers: { "user-agent": "cloudflare-deploy-probe/1" } });
    networkOk = res.status < 500;
    add("network", networkOk ? "pass" : "fail", `api.cloudflare.com -> ${res.status}（401/403 属正常：可达但未认证），${Date.now() - started}ms`);
  } catch (e) {
    add("network", "fail", `无法访问 ${apiBase}：${e.cause?.code || e.message}；检查代理、DNS 或区域限制`, { error: String(e.cause?.code || e.message) });
  } finally {
    clearTimeout(timer);
  }
}

// 2. Wrangler。
let wranglerOk = false;
{
  const r = call(["--version"], { timeout: 15000 });
  wranglerOk = r.ok;
  add("wrangler", wranglerOk ? "pass" : "fail", wranglerOk ? `${wr.label}：${r.out.split(/\r?\n/)[0]}` : `找不到 wrangler：${String(r.error || r.err || r.status).split(/\r?\n/)[0].slice(0, 160)}`);
}

// 3. 登录态与账号。
// `wrangler whoami --json` 是官方写明的能力（Wrangler General commands：
// "--json ... Return user information as JSON. Exits with a non-zero status if not authenticated."）。
// 本探针仍用纯文本 whoami 做基本判定：不依赖 JSON 字段结构，跨 Wrangler 版本更稳；
// --json 只作可选增强，旧版本不支持或调用失败都不影响「已登录」结论。
let authOk = false;
let account = null;
let email = null;
let authSource = null;
let whoamiAccountId = null;
{
  const r = call(["whoami"], { timeout: 20000 });
  const text = [r.out, r.err].filter(Boolean).join("\n");
  const looksLoggedIn = /logged in|associated with|account id/i.test(text)
    && !/not (?:logged|authenticated)|please (?:run|use) .*login/i.test(text);
  if (!r.ok || !looksLoggedIn) {
    const tail = (r.err || r.out).split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";
    add("auth", "fail", `未登录或 wrangler 读不到登录态。执行 npx wrangler login；CI/无头环境用 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID${tail ? `（${tail.slice(0, 120)}）` : ""}`);
  } else {
    authOk = true;
    email = (text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) || [])[0] || null;
    whoamiAccountId = (text.match(/\b[0-9a-f]{32}\b/i) || [])[0] || null;
    authSource = process.env.CLOUDFLARE_API_TOKEN ? "API Token（环境变量）" : "OAuth / 本地登录态";
    // 官方 --json 是可选增强：能解析就补账号名，解析失败不影响结论。
    const j = call(["whoami", "--json"], { timeout: 10000 });
    if (j.ok) {
      try {
        const parsed = JSON.parse(j.out.slice(j.out.indexOf("{"), j.out.lastIndexOf("}") + 1));
        account = parsed?.accounts?.[0] || parsed?.result?.accounts?.[0] || null;
        email = email || parsed?.email || parsed?.user?.email || null;
      } catch { /* 纯文本已经足够 */ }
    }
    add("auth", "pass", `已登录：${account?.name || email || "(账号名未读出)"}，来源 ${authSource}`, { email, authSource, accountName: account?.name || null });
  }
}

// 4. 账号 ID（环境变量 > 可选 JSON > whoami 文本里的 32 位十六进制）。
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || account?.id || whoamiAccountId || null;
if (authOk) {
  add("account-id", accountId ? "pass" : "warn", accountId ? `Account ID 已确定（${accountId.slice(0, 6)}…）` : "没有 Account ID；设置 CLOUDFLARE_ACCOUNT_ID 或在控制台 Account Home 复制", { accountId });
}

// 5. Token 读权限：只有能直接拿到 API Token 时才查。
// `wrangler auth token --json` 同样是官方命令，但 OAuth 登录态下再取 Token 是额外调用；
// 这里只认显式环境变量 CLOUDFLARE_API_TOKEN，取不到就如实 skip，不把「跳过」说成「权限没问题」。
if (authOk && accountId) {
  const token = process.env.CLOUDFLARE_API_TOKEN || null;
  if (!token) {
    add("api-read", "skip", "当前是 OAuth 登录态，没有可直接读取的 API Token；跳过 Token 细粒度权限检查（不代表部署权限一定没问题）");
  } else {
    try {
      const res = await fetch(`${apiBase}/accounts/${accountId}/workers/scripts?per_page=1`, {
        headers: { authorization: `Bearer ${token}`, "user-agent": "cloudflare-deploy-probe/1" },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 200) add("api-read", "pass", "Token 可以读取该账号的 Workers 列表");
      else if (res.status === 403) add("api-read", "warn", "Token 缺少 Workers Scripts 读取权限；部署可能同样被拒");
      else add("api-read", "warn", `Workers 列表返回 ${res.status}；账号或 Token 可能有问题`);
    } catch (e) {
      add("api-read", "warn", `API 权限检查失败：${e.cause?.code || e.message}`);
    }
  }
}

// 6. 可选：真实部署探针。判定逻辑在 deploy-verdict.mjs，可单独测试。
if (doDeploy) {
  if (!authOk || !wranglerOk) {
    add("deploy", "fail", "缺少登录态或 Wrangler，跳过部署探针", { verified: false });
  } else {
    const name = `cf-deploy-probe-${Math.random().toString(36).slice(2, 8)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-deploy-probe-"));
    fs.writeFileSync(path.join(dir, "wrangler.toml"), `name = "${name}"\nmain = "index.js"\ncompatibility_date = "${today}"\n`);
    fs.writeFileSync(path.join(dir, "index.js"), `export default { fetch() { return new Response("ok"); } };\n`);
    const dep = call(["deploy"], { cwd: dir, timeout: 180000 });
    const url = parseDeployUrl(dep.out);
    // 只有拿到 URL 才发真实请求；部署命令成功本身不算线上验证。
    const http = url && dep.ok ? await verifyDeployedUrl(url, fetch) : null;
    const del = call(["delete", name], { cwd: dir, timeout: 60000, input: "y\n" });
    const verdict = evaluateDeployProbe({
      deployOk: dep.ok, deployOut: dep.out, deployErr: dep.err,
      url, http, cleanupOk: del.ok, worker: name,
    });
    checks.push(verdict.deploy, verdict.cleanup);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 目录留给系统清理 */ }
  }
}

const blocked = checks.some((c) => c.status === "fail");
const limited = !blocked && checks.some((c) => c.status === "warn");
const status = blocked ? "blocked" : limited ? "limited" : "ready";
const deployCheck = checks.find((c) => c.id === "deploy") || null;
const nextSteps = blocked
  ? ["npx wrangler login（或设置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID）", "没有账号时可用 npx wrangler deploy --temporary 验证网络，但它用的是临时账号，不能验证你的账号、权限或套餐，且会过期"]
  : limited
    ? ["补齐上面 warn 的项；部署前再跑一次本探针"]
    : ["可以开始识别项目并部署到预览地址"];
if (deployCheck && deployCheck.verified === false) {
  nextSteps.push("部署探针没有完成线上验证；到控制台确认临时 Worker 地址并手动请求，不要把它记成已验证");
}
const result = {
  schemaVersion: 1,
  status,
  deployProbe: doDeploy,
  checkedAt: new Date().toISOString(),
  checks,
  nextSteps,
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const c of checks) {
    const mark = { pass: "通过", warn: "警告", fail: "失败", skip: "跳过" }[c.status] || c.status;
    console.log(`[${mark}] ${c.id}: ${c.detail}`);
  }
  console.log(`\n链路状态=${status}`);
  nextSteps.forEach((s) => console.log(`  - ${s}`));
}

process.exitCode = blocked ? 2 : limited ? 1 : 0;
