#!/usr/bin/env node
/**
 * probe.mjs — 链路探针：在碰项目之前，先确认「账号 → 权限 → 网络 → 部署」能不能通。
 *
 * 用法：
 *   node scripts/probe.mjs [--json] [--deploy] [--repo <目录>] [--timeout 15000]
 *
 * 默认只读：查网络、wrangler、登录态、账号、Token 读权限。
 * --repo 指定要部署的 git 仓库目录（不传且当前目录是仓库时自动使用），
 *        额外检查 git remote / git ls-remote，并打印脱敏后的代理变量。
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
import { classifyWranglerWhoami } from "./wrangler-auth.mjs";
import { isTransientNetworkError, RETRY_BACKOFF_MS } from "./net-retry.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const doDeploy = argv.includes("--deploy");
// --repo 可选；给定时检查代码托管链路，不把“Cloudflare API 通”误当成“整个部署链路通”。
const repoArg = (() => {
  const idx = argv.indexOf("--repo");
  if (idx === -1) return null;
  const raw = argv[idx + 1];
  if (!raw || raw.startsWith("--")) {
    console.error("用法错误：--repo 需要仓库目录路径");
    process.exit(2);
  }
  return path.resolve(raw);
})();
if (repoArg && (!fs.existsSync(repoArg) || !fs.statSync(repoArg).isDirectory())) {
  console.error(`用法错误：--repo 不是目录：${repoArg}`);
  process.exit(2);
}
// Node.js 定时器（setTimeout/AbortSignal.timeout）允许的最大毫秒数约为 2^31-1；
// 超过该值会被 Node 截断/告警，必须在进入任何网络探测前拒绝。
const MAX_TIMEOUT_MS = 2147483647;
const parseTimeoutArg = () => {
  const idx = argv.indexOf("--timeout");
  if (idx === -1) return { ok: true, value: 15000 };
  const raw = argv[idx + 1];
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    return { ok: false, reason: "缺少值" };
  }
  if (!/^[0-9]+$/.test(raw)) return { ok: false, reason: "必须是有限正整数" };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return { ok: false, reason: "必须大于 0 且是有限正整数" };
  if (value > MAX_TIMEOUT_MS) return { ok: false, reason: `不能超过 Node.js 定时器上限 ${MAX_TIMEOUT_MS}` };
  return { ok: true, value };
};
const timeoutArg = parseTimeoutArg();
if (!timeoutArg.ok) {
  // 参数错误必须在任何 fetch / wrangler 调用之前退出，不能包装成网络连接失败。
  console.error(`用法错误：--timeout ${timeoutArg.reason}；应传 1..${MAX_TIMEOUT_MS} 的毫秒整数，例如 --timeout 15000。`);
  process.exit(2);
}
const timeout = timeoutArg.value;
const apiBase = "https://api.cloudflare.com/client/v4";

const checks = [];
const add = (id, status, detail, extra = {}) => checks.push({ ...extra, id, status, detail });

// Windows 下 .cmd/.bat 必须经过 shell 执行；命令路径可能含空格或 & 等 meta 字符
// （例如 ...\My Project\node_modules\.bin\wrangler.cmd），不加引号会被 cmd 截断成两个命令。
const shellCommand = (cmd) => (process.platform === "win32" && /[\s&|<>^()]/.test(cmd) ? `"${cmd}"` : cmd);

function run(cmd, args, opts = {}) {
  const r = spawnSync(shellCommand(cmd), args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 30000,
    cwd: opts.cwd,
    input: opts.input,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), error: r.error ? String(r.error.code || r.error.message) : null };
}

// git 参数来自仓库配置/远端 URL，不能用 Windows shell 拼接，避免 shell 注入。
function runGit(args, opts = {}) {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 10000,
    cwd: opts.cwd,
    shell: false,
    windowsHide: true,
  });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), error: r.error ? String(r.error.code || r.error.message) : null };
}

const redactUrl = (raw) => {
  if (!raw) return raw;
  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "***";
    }
    return u.toString();
  } catch {
    return String(raw).replace(/\/\/[^/@\s]+@/, "//***@");
  }
};
const proxyEnv = {
  HTTPS_PROXY: redactUrl(process.env.HTTPS_PROXY || process.env.https_proxy || null),
  NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || null,
};
const proxyNote = `HTTPS_PROXY=${proxyEnv.HTTPS_PROXY || "未设置"}，NO_PROXY=${proxyEnv.NO_PROXY || "未设置"}`;


// 与 verify-deployment 共用瞬时网络错误分类：只重试连接类错误，不重试 HTTP 响应。
async function fetchWithTransientRetry(url, opts = {}, maxRetries = 1) {
  let last = { res: null, attempts: 0, error: "请求未执行" };
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeout ?? timeout);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      return { res, attempts: attempt, error: null };
    } catch (e) {
      last = { res: null, attempts: attempt, error: String(e?.cause?.code || e?.message || e) };
      if (attempt <= maxRetries && isTransientNetworkError(e, timedOut)) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS * attempt));
        continue;
      }
      return last;
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
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

// 1. 网络：能不能到 Cloudflare API（瞬时连接错误重试 1 次）。
let networkOk = false;
{
  const started = Date.now();
  const r = await fetchWithTransientRetry(`${apiBase}/user/tokens/verify`, {
    timeout: Math.min(timeout, 10000),
    headers: { "user-agent": "deploy-advisor-probe/1" },
  });
  if (r.res) {
    networkOk = r.res.status < 500;
    add("network", networkOk ? "pass" : "fail", `api.cloudflare.com -> ${r.res.status}（401/403 属正常：可达但未认证），${Date.now() - started}ms${r.attempts > 1 ? `，重试 ${r.attempts - 1} 次` : ""}`);
  } else {
    add("network", "fail", `无法访问 ${apiBase}：${r.error}${r.attempts > 1 ? `（已重试 ${r.attempts - 1} 次）` : ""}；检查代理、DNS 或区域限制`, { error: r.error, attempts: r.attempts });
  }
}

// 1b. 代码托管链路：Cloudflare API 通不代表 GitHub/GitLab 通。
// 只做只读检查；失败默认 warn（Direct Upload/已有产物仍可能部署），不直接 blocked。
{
  const repoDir = repoArg || process.cwd();
  const top = runGit(["rev-parse", "--show-toplevel"], { cwd: repoDir });
  if (!top.ok) {
    add("git", "skip", `未指定 --repo 且当前目录不是 git 仓库；跳过代码托管检查（Git 集成/远端构建前需先确认）；${proxyNote}`, { repo: repoDir, proxy: proxyEnv });
  } else {
    const gitRoot = top.out.split(/\r?\n/)[0];
    const remotesOut = runGit(["remote", "-v"], { cwd: gitRoot });
    const remoteLines = [...new Set(remotesOut.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    const remotes = remoteLines.map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) parts[1] = redactUrl(parts[1]);
      return parts.join(" ");
    });
    const chosen = remoteLines.find((line) => /^origin\s/.test(line)) || remoteLines[0] || null;
    const remoteUrl = chosen ? chosen.split(/\s+/)[1] : null;
    if (!gitRoot || !remoteUrl) {
      add("git", "warn", `git 仓库没有可用的 remote；Git 集成/远端构建不可用，Direct Upload 可能仍可；${proxyNote}`, { repo: gitRoot || repoDir, remotes, proxy: proxyEnv });
    } else {
      const ls = runGit(["ls-remote", "--heads", remoteUrl], { cwd: gitRoot, timeout: 10000 });
      const safeRemote = redactUrl(remoteUrl);
      if (ls.ok) {
        add("git", "pass", `代码托管可达：${safeRemote}（git ls-remote 成功）；${proxyNote}`, { repo: gitRoot, remote: safeRemote, proxy: proxyEnv });
      } else {
        const reason = String(ls.error || ls.err || ls.status).split(/\r?\n/)[0].slice(0, 200);
        add("git", "warn", `代码托管不通：git ls-remote ${safeRemote} 失败（${reason}）；Git 集成/远端构建会失败，Direct Upload 可能仍可；${proxyNote}`, { repo: gitRoot, remote: safeRemote, proxy: proxyEnv, error: reason });
      }
    }
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
  // 与 check-env 共用同一套判定：退出码 0 但输出为空 / loggedIn:false / 不可识别的
  // 本地化输出，都不能当成已登录（否则会 fail-open 到部署）。
  const who = classifyWranglerWhoami({ ok: r.ok, stdout: r.out, stderr: r.err, error: r.error });
  if (who.state !== "logged-in") {
    const label = who.state === "logged-out" ? "未登录" : who.state === "error" ? "wrangler whoami 执行失败" : "无法确认登录态";
    add("auth", "fail", `${label}：${who.reason}。执行 npx wrangler login；CI/无头环境用 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID`);
  } else {
    authOk = true;
    email = who.email;
    whoamiAccountId = who.accountId;
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
    add("auth", "pass", `${who.reason}${account?.name ? `；账号 ${account.name}` : ""}，来源 ${authSource}`, { email, authSource, accountName: account?.name || null, authState: who.state });
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
        headers: { authorization: `Bearer ${token}`, "user-agent": "deploy-advisor-probe/1" },
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
    // 部署失败时没有创建临时 Worker，不应该去 delete，更不能把「删除失败」报成清理问题。
    const del = dep.ok ? call(["delete", name], { cwd: dir, timeout: 60000, input: "y\n" }) : null;
    const verdict = evaluateDeployProbe({
      deployOk: dep.ok, deployOut: dep.out, deployErr: dep.err, deployError: dep.error,
      url, http, cleanupOk: dep.ok ? Boolean(del?.ok) : true, cleanupSkipped: !dep.ok, worker: name,
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
