#!/usr/bin/env node
/**
 * check-env.mjs — 检查本机工具链和 Cloudflare/GitHub 登录状态。
 *
 * 用法：
 *   node scripts/check-env.mjs [--json]
 *
 * 只读：只执行版本/登录查询，不安装、不登录、不改配置。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const json = process.argv.includes("--json");
const root = process.cwd();

function run(cmd, args = [], timeout = 8000) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || "").trim(),
    stderr: (r.stderr || "").trim(),
    error: r.error ? String(r.error.code || r.error.message) : null,
  };
}

function firstLine(s) {
  return (s || "").split(/\r?\n/)[0].slice(0, 200);
}

function checkCommand(id, label, cmd, args, opts = {}) {
  const r = run(cmd, args);
  const ok = r.ok && !r.error;
  return {
    id,
    label,
    status: ok ? "pass" : opts.required ? "fail" : "warn",
    version: ok ? firstLine(r.stdout || r.stderr) : null,
    detail: ok ? null : r.error || firstLine(r.stderr) || `退出码 ${r.status}`,
    required: Boolean(opts.required),
  };
}

const checks = [];

// 三档标准，别混：
//   本技能的脚本：最低 Node 18（ESM + 内置 fetch，零依赖）
//   完整部署：建议 Node 22+（当前仍在维护的最老 LTS 线）
//   Wrangler：只支持 Current / Active / Maintenance 三个分支
const nodeMajor = Number(process.versions.node.split(".")[0]);
const nodeEven = nodeMajor % 2 === 0;
const nodeDetail = nodeMajor < 18
  ? "脚本需要 Node 18+（ESM 与内置 fetch）；先升级 Node。"
  : nodeMajor < 22
    ? "脚本能跑（最低 Node 18），但 Node 18/20 已 EOL，Wrangler 只支持 Current/Active/Maintenance；部署前升级到 Node 22+。"
    : !nodeEven
      ? `Node ${nodeMajor} 是奇数版本，已结束支持；Wrangler 只支持 Current/Active/Maintenance，建议换到偶数 LTS（22/24/26）。`
      : null;
checks.push({
  id: "node",
  label: "Node.js",
  status: nodeMajor >= 22 && nodeEven ? "pass" : nodeMajor >= 18 ? "warn" : "fail",
  version: process.version,
  detail: nodeDetail,
  required: true,
});

checks.push(checkCommand("git", "git", "git", ["--version"], { required: true }));

const wranglerLocal = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
let wrangler = null;
let wranglerIsLocal = false;

if (fs.existsSync(wranglerLocal)) {
  wranglerIsLocal = true;
  wrangler = checkCommand("wrangler", "wrangler（项目内）", wranglerLocal, ["--version"], { required: true });
} else {
  const onPath = checkCommand("wrangler", "wrangler", "wrangler", ["--version"], { required: false });
  if (onPath.status === "pass") {
    wrangler = onPath;
  } else {
    const viaNpx = checkCommand("wrangler", "wrangler（npx --no-install）", "npx", ["--no-install", "wrangler", "--version"], { required: false });
    wrangler = viaNpx.status === "pass"
      ? viaNpx
      : { ...viaNpx, status: "warn", detail: "未找到 wrangler；执行 npx wrangler@latest，或在项目内安装。" };
  }
}
checks.push(wrangler);

const gh = checkCommand("gh", "GitHub CLI", "gh", ["--version"], { required: false });
checks.push(gh);

checks.push(checkCommand("curl", "curl", "curl", ["--version"], { required: false }));
checks.push(checkCommand("openssl", "openssl", "openssl", ["version"], { required: false }));

const dnsTool = process.platform === "win32"
  ? checkCommand("dns", "DNS 查询工具", "nslookup", ["-version"], { required: false })
  : checkCommand("dns", "DNS 查询工具", "dig", ["-v"], { required: false });
if (process.platform === "win32") dnsTool.version = null; // nslookup 输出是本地化编码
checks.push({ ...dnsTool, id: "dns" });

if (gh.status === "pass") {
  const auth = run("gh", ["auth", "status"]);
  checks.push({
    id: "gh-auth",
    label: "GitHub 登录",
    status: auth.ok ? "pass" : "warn",
    version: null,
    detail: auth.ok ? firstLine(auth.stdout || auth.stderr) : "未登录。执行：gh auth login",
    required: false,
  });
}

if (wrangler.status === "pass") {
  const who = run(
    wranglerIsLocal ? wranglerLocal : "npx",
    wranglerIsLocal ? ["whoami"] : ["--no-install", "wrangler", "whoami"],
    15000
  );
  const loggedIn = who.ok && !/not authenticated|not logged in|no account/i.test(who.stdout + who.stderr);
  checks.push({
    id: "wrangler-auth",
    label: "Cloudflare 登录",
    status: loggedIn ? "pass" : "warn",
    version: null,
    detail: loggedIn ? firstLine(who.stdout || who.stderr) : "未登录。执行：npx wrangler login（或设置 CLOUDFLARE_API_TOKEN）。",
    required: false,
  });
} else {
  checks.push({
    id: "wrangler-auth",
    label: "Cloudflare 登录",
    status: "warn",
    version: null,
    detail: "跳过：wrangler 不可用。",
    required: false,
  });
}

const blocking = checks.filter((c) => c.status === "fail").map((c) => c.id);
const warnings = checks.filter((c) => c.status === "warn").map((c) => c.id);

const result = {
  schemaVersion: 1,
  platform: `${process.platform} ${process.arch}`,
  cwd: root,
  checks,
  summary: {
    canBuild: !blocking.includes("node") && !blocking.includes("git"),
    canDeploy: !blocking.includes("node") && !blocking.includes("git") && wrangler.status === "pass" && checks.find((c) => c.id === "wrangler-auth")?.status === "pass",
    blocking,
    warnings,
  },
};

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const c of checks) {
    const mark = c.status === "pass" ? "通过" : c.status === "warn" ? "警告" : "失败";
    console.log(`[${mark}] ${c.label}${c.version ? ` — ${c.version}` : ""}${c.detail ? `\n       ${c.detail}` : ""}`);
  }
  console.log(`\n可构建=${result.summary.canBuild} 可部署=${result.summary.canDeploy}`);
  if (blocking.length) console.log(`阻断项：${blocking.join("、")}`);
}
