#!/usr/bin/env node
/**
 * wrangler-auth.mjs — wrangler 登录态判定的唯一权威实现。
 *
 * check-env.mjs 和 probe.mjs 以前各写一套判断：
 *   - check-env 只看 `whoami` 退出码：exit 0 但输出为空 / `{"loggedIn":false}` /
 *     看不懂的本地化输出，会被误判成「已登录」，进而 canDeploy=true（fail-open）。
 *   - probe 看英文关键词，比 check-env 严格，两者可能给出互相矛盾的结论。
 *
 * 这里统一成「退出码 + 正向证据」：
 *   logged-in   退出码 0，且输出里有可验证的登录证据（邮箱 / Account ID / 明确登录文本）
 *   logged-out  输出明确表示未登录
 *   error       命令执行失败（启动失败、超时等）
 *   unknown     退出码 0 但没有任何正向证据（空输出 / loggedIn:false / 无法识别的格式）
 * 只有 logged-in 才允许继续；unknown 绝不能当成已登录。
 *
 * 纯函数：不执行命令、不读环境变量、不访问网络。
 */

/** 从 whoami 文本里提取 Account ID（32 位十六进制）。多个候选时返回 null，不猜。 */
export function extractAccountId(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const fromTable = new Set();
  for (let i = 0; i < lines.length; i++) {
    // whoami 表格：先有 "Account ID" 列头，后面几行才有值（可能多个账号）。
    if (/account\s*id/i.test(lines[i])) {
      for (let j = i; j < Math.min(i + 5, lines.length); j++) {
        for (const m of lines[j].matchAll(/\b[0-9a-f]{32}\b/gi)) fromTable.add(m[0].toLowerCase());
      }
    }
  }
  if (fromTable.size === 1) return [...fromTable][0];
  if (fromTable.size > 1) return null; // 多账号：不能替用户选
  const all = [...String(text ?? "").matchAll(/\b[0-9a-f]{32}\b/gi)].map((m) => m[0].toLowerCase());
  return new Set(all).size === 1 ? all[0] : null;
}

const firstLine = (s) => String(s ?? "").split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 160) || null;
const shorten = (s) => (s ? s.slice(0, 160) : "");

/**
 * @param {{ok?: boolean, stdout?: string, stderr?: string, error?: string|null}} input
 * @returns {{state:"logged-in"|"logged-out"|"error"|"unknown", email:string|null,
 *            accountId:string|null, reason:string}}
 */
export function classifyWranglerWhoami({ ok = false, stdout = "", stderr = "", error = null } = {}) {
  const text = [stdout, stderr].filter((s) => s && String(s).trim()).join("\n").trim();
  const negative = /not authenticated|not logged in|no account|not authorized|please (?:run|use) .*login|loggedIn["']?\s*:\s*false/i.test(text);
  const email = (text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i) || [])[0] || null;
  const accountId = extractAccountId(text);
  const positive = Boolean(email) || Boolean(accountId)
    || (/\blogged in\b|associated with|loggedIn["']?\s*:\s*true/i.test(text) && !/not\s+logged\s+in|not authenticated|loggedIn["']?\s*:\s*false/i.test(text));

  if (!ok && negative) {
    return { state: "logged-out", email, accountId, reason: "wrangler whoami 明确表示未登录" };
  }
  if (!ok) {
    return {
      state: "error", email, accountId,
      reason: `wrangler whoami 执行失败（${error || firstLine(stderr) || firstLine(stdout) || "未知错误"}）`,
    };
  }
  if (negative && !positive) {
    return { state: "logged-out", email, accountId, reason: "wrangler whoami 明确表示未登录" };
  }
  if (!positive) {
    return {
      state: "unknown", email: null, accountId: null,
      reason: `wrangler whoami 退出码 0，但输出没有可验证的登录证据（${shorten(text) || "空输出"}）`,
    };
  }
  return {
    state: "logged-in", email, accountId,
    reason: `已登录${email ? `：${email}` : ""}${accountId ? `（Account ${accountId.slice(0, 6)}…）` : ""}`,
  };
}
