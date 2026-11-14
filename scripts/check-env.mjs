#!/usr/bin/env node
/**
 * check-env.mjs — 检查本机工具链和 Cloudflare/GitHub 登录状态。
 *
 * 用法：
 *   node scripts/check-env.mjs [--json] [--build-only]
 *
 * 退出码：0 可部署；1 可构建但不可部署；2 连构建条件都不满足。
 * --build-only 只按「可构建」判定，用于本就不打算部署的场景。
 *
 * 只读：只执行版本/登录查询，不安装、不登录、不改配置。
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { classifyWranglerWhoami } from "./wrangler-auth.mjs";

const json = process.argv.includes("--json");
const root = process.cwd();

// Windows 下 .cmd/.bat 必须经过 shell 执行；命令路径可能含空格或 & 等 meta 字符
// （例如 ...\My Project\node_modules\.bin\wrangler.cmd），不加引号会被 cmd 截断成两个命令。
const shellCommand = (cmd) => (process.platform === "win32" && /[\s&|<>^()]/.test(cmd) ? `"${cmd}"` : cmd);

function run(cmd, args = [], timeout = 8000) {
  const r = spawnSync(shellCommand(cmd), args, {
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
// whoami 必须用实际解析到的那个 wrangler：PATH 上的 wrangler 不等于能用 npx --no-install 调起。
let wranglerCmd = null;
let wranglerPrefix = [];
const useWrangler = (cmd, prefix, result) => {
  wranglerCmd = cmd;
  wranglerPrefix = prefix;
  wrangler = result;
};

if (fs.existsSync(wranglerLocal)) {
  useWrangler(wranglerLocal, [], checkCommand("wrangler", "wrangler（项目内）", wranglerLocal, ["--version"], { required: true }));
} else {
  const onPath = checkCommand("wrangler", "wrangler", "wrangler", ["--version"], { required: false });
  if (onPath.status === "pass") {
    useWrangler("wrangler", [], onPath);
  } else {
    const viaNpx = checkCommand("wrangler", "wrangler（npx --no-install）", "npx", ["--no-install", "wrangler", "--version"], { required: false });
    useWrangler("npx", ["--no-install", "wrangler"], viaNpx.status === "pass"
      ? viaNpx
      : { ...viaNpx, status: "warn", detail: "未找到 wrangler；执行 npx wrangler@latest，或在项目内安装。" });
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
  const who = run(wranglerCmd, [...wranglerPrefix, "whoami"], 15000);
  // 单一权威：退出码 0 不等于已登录，必须有可验证的登录证据。
  const auth = classifyWranglerWhoami({ ok: who.ok, stdout: who.stdout, stderr: who.stderr, error: who.error });
  const loggedIn = auth.state === "logged-in";
  const detail = loggedIn
    ? auth.reason
    : auth.state === "logged-out"
      ? "未登录。执行：npx wrangler login（或设置 CLOUDFLARE_API_TOKEN）。"
      : `${auth.reason}；到 \`npx wrangler whoami\` 手动确认，当前不能判定为已登录`;
  checks.push({
    id: "wrangler-auth",
    label: "Cloudflare 登录",
    status: loggedIn ? "pass" : "warn",
    version: null,
    detail,
    authState: auth.state,
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
  if (!result.summary.canDeploy && result.summary.canBuild) {
    console.log("下一步：npx wrangler login，或设置 CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID；再跑一次本脚本。");
  }
}

// 退出码要和结论一致，否则 Agent 会以为「可部署=false」还能继续。
// 0 = 可部署；1 = 可构建但不可部署；2 = 连构建条件都不满足。
if (process.argv.includes("--build-only")) {
  process.exitCode = result.summary.canBuild ? 0 : 2;
} else {
  process.exitCode = !result.summary.canBuild ? 2 : result.summary.canDeploy ? 0 : 1;
}
