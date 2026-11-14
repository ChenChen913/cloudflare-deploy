#!/usr/bin/env node
/**
 * deploy-verdict.mjs — probe.mjs 里 `--deploy` 分支的纯逻辑。
 *
 * 单独成文件，是为了在不接触真实 Cloudflare 账号的前提下做单元测试：
 * 这里不访问网络、不执行子进程，外部动作全部由调用方注入。
 *
 * 核心规则：部署命令成功 != 线上验证成功。必须拿到 URL 并真实请求通过，
 * 才允许把 deploy 判为 pass。
 */

/** 从 wrangler deploy 的输出里解析 workers.dev 地址；解析不到返回 null。 */
export function parseDeployUrl(output = "") {
  const m = String(output).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev\b/i);
  return m ? m[0] : null;
}

/**
 * 真实访问部署地址。fetchImpl 可注入以便测试。
 * @returns {{served:boolean, attempts:number, status:number|null, bodyOk:boolean, reason:string}}
 */
export async function verifyDeployedUrl(url, fetchImpl = fetch, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 5);
  const delayMs = Math.max(0, opts.delayMs ?? 2000);
  const timeout = Math.max(1, opts.timeout ?? 10000);
  // 临时 Worker 的响应体就是 "ok"。用全等而不是 includes：
  // "not ok".includes("ok") 为 true，会把错误响应误判成部署成功的线上证据。
  const expectedText = opts.expectedText ?? "ok";
  let last = { served: false, attempts: 0, status: null, bodyOk: false, reason: "未发起请求" };

  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
      const text = await res.text();
      const bodyOk = String(text).trim() === expectedText;
      last = {
        served: res.status === 200 && bodyOk,
        attempts: i,
        status: res.status,
        bodyOk,
        reason: res.status === 200
          ? (bodyOk ? "返回 200 且内容匹配" : "返回 200 但内容不匹配")
          : `返回 ${res.status}`,
      };
      if (last.served) return last;
    } catch (e) {
      last = {
        served: false,
        attempts: i,
        status: null,
        bodyOk: false,
        reason: `请求失败：${e?.cause?.code || e?.message || String(e)}`,
      };
    }
    if (i < attempts && delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

/**
 * 给出 deploy / deploy-cleanup 两条结论。
 *
 * | 情况 | deploy 结论 |
 * |---|---|
 * | 部署命令失败 | fail |
 * | 成功但没解析到 URL | warn（未做线上验证，绝不 pass） |
 * | 成功、拿到 URL，但 HTTP 验证未通过 | fail |
 * | 成功、拿到 URL 且 HTTP 验证通过 | pass |
 *
 * 清理失败单独记 warn，不并入 deploy 判定，也不会被忽略。
 */
export function evaluateDeployProbe(input = {}) {
  const {
    deployOk = false,
    deployErr = "",
    deployOut = "",
    url = null,
    http = null,
    cleanupOk = true,
    cleanupSkipped = false,
    worker = "",
  } = input;

  const tail = String(deployErr || deployOut).split(/\r?\n/).slice(-2).join(" ").trim();
  const verified = Boolean(deployOk && url && http && http.served);
  let deploy;

  if (!deployOk) {
    deploy = {
      worker, url, verified: false, http,
      id: "deploy", status: "fail",
      detail: `部署失败：${tail || "wrangler deploy 返回非零退出码"}`,
    };
  } else if (!url) {
    deploy = {
      worker, url, verified: false, http,
      id: "deploy", status: "warn",
      detail: "部署命令成功，但没有解析到线上 URL；未发起 HTTP 请求，不能判定线上验证通过。到控制台确认临时 Worker 地址后手动复核",
    };
  } else if (!verified) {
    deploy = {
      worker, url, verified: false, http,
      id: "deploy", status: "fail",
      detail: `部署命令成功，但 ${url} 的线上验证未通过（${http?.reason || "没有完成 HTTP 验证"}）；不能报告完整成功`,
    };
  } else {
    deploy = {
      worker, url, verified: true, http,
      id: "deploy", status: "pass",
      detail: `部署命令成功，${url} 返回 200 且内容匹配，线上验证通过`,
    };
  }

  // 部署失败时没有创建临时 Worker，清理不适用；不能写成「未能删除」。
  const cleanup = cleanupSkipped
    ? {
      worker,
      id: "deploy-cleanup",
      status: "skip",
      detail: `部署命令失败，没有创建临时 Worker ${worker}，无需清理`,
    }
    : {
      worker,
      id: "deploy-cleanup",
      status: cleanupOk ? "pass" : "warn",
      detail: cleanupOk
        ? `已删除临时 Worker ${worker}`
        : `未能删除 ${worker}，请到控制台手动删除（不要留着占资源）`,
    };

  return { deploy, cleanup };
}
