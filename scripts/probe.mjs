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
// `wrangler whoami` 的纯文本输出才是稳定契约；`--json` 只是部分版本的便利选项，
// 不是官方承诺的能力。不能因为某个版本不认 --json 就把「已登录」误判成「未登录」。
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
    // 可选增强：能解析 JSON 就补上账号名，解析失败不影响结论。
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
// OAuth 登录态不暴露可复用的 Token；不要靠非官方子命令去猜，也不要把「跳过」说成「权限没问题」。
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

// 6. 可选：真实部署探针。
if (doDeploy) {
  if (!authOk || !wranglerOk) {
    add("deploy", "fail", "缺少登录态或 Wrangler，跳过部署探针");
  } else {
    const name = `cf-deploy-probe-${Math.random().toString(36).slice(2, 8)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cf-deploy-probe-"));
    fs.writeFileSync(path.join(dir, "wrangler.toml"), `name = "${name}"\nmain = "index.js"\ncompatibility_date = "${today}"\n`);
    fs.writeFileSync(path.join(dir, "index.js"), `export default { fetch() { return new Response("ok"); } };\n`);
    const dep = call(["deploy"], { cwd: dir, timeout: 180000 });
    const url = (dep.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i) || [])[0] || null;
    let served = false;
    if (url) {
      for (let i = 0; i < 5 && !served; i++) {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          served = res.status === 200 && (await res.text()).includes("ok");
        } catch { /* 路由生效可能有延迟 */ }
        if (!served) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    add(
      "deploy",
      dep.ok && (!url || served) ? "pass" : "fail",
      dep.ok
        ? `临时 Worker ${name} 部署成功${url ? `，${served ? "URL 可访问" : "但 URL 未返回预期内容"}` : "（未解析到 URL，跳过访问检查）"}`
        : `部署失败：${(dep.err || dep.out).split(/\r?\n/).slice(-2).join(" ")}`,
      { worker: name, url }
    );
    const del = call(["delete", name], { cwd: dir, timeout: 60000, input: "y\n" });
    add(
      "deploy-cleanup",
      del.ok ? "pass" : "warn",
      del.ok ? `已删除临时 Worker ${name}` : `未能删除 ${name}，请到控制台手动删除（不要留着占资源）`,
      { worker: name }
    );
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 目录留给系统清理 */ }
  }
}

const blocked = checks.some((c) => c.status === "fail");
const limited = !blocked && checks.some((c) => c.status === "warn");
const status = blocked ? "blocked" : limited ? "limited" : "ready";
const result = {
  schemaVersion: 1,
  status,
  deployProbe: doDeploy,
  checkedAt: new Date().toISOString(),
  checks,
  nextSteps: blocked
    ? ["npx wrangler login（或设置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID）", "没有账号时可用 npx wrangler deploy --temporary 验证网络，但它用的是临时账号，不能验证你的账号、权限或套餐，且会过期"]
    : limited
      ? ["补齐上面 warn 的项；部署前再跑一次本探针"]
      : ["可以开始识别项目并部署到预览地址"],
};

if (json) console.log(JSON.stringify(result, null, 2));
else {
  for (const c of checks) {
    const mark = { pass: "通过", warn: "警告", fail: "失败", skip: "跳过" }[c.status] || c.status;
    console.log(`[${mark}] ${c.id}: ${c.detail}`);
  }
  console.log(`\n链路状态=${status}`);
  result.nextSteps.forEach((s) => console.log(`  - ${s}`));
}

process.exitCode = blocked ? 2 : limited ? 1 : 0;
