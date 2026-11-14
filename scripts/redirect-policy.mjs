#!/usr/bin/env node
/**
 * redirect-policy.mjs — 验收脚本的重定向跟随策略。
 *
 * 纯函数：只解析 URL，不发任何请求、不依赖第三方包、不读写文件。
 * verify-deployment.mjs 的主站链和资源探针共用这里，避免两处对「同源」的定义不一致。
 *
 * 默认只自动跟随同源重定向。同源按 URL.origin 判定（协议 + 主机 + 端口），
 * 所以 http -> https、https -> http、端口变化都算跨源，不能只比 hostname。
 * 跨源、非 http/https 协议、Location 缺失或无法解析一律不请求目标，
 * 只把 Location 交回调用方记录。这样 3xx 不会把验收脚本带去
 * 127.0.0.1、内网地址或云厂商元数据端点。
 *
 * kind 取值：
 *   same-origin            允许自动跟随
 *   cross-origin           跨源，只记录不跟随
 *   unsupported-protocol   非 http/https，直接拒绝
 *   invalid-location       Location 缺失或无法解析
 */

export const HTTP_PROTOCOLS = ["http:", "https:"];

/**
 * @param {string} fromUrl     当前这一跳的绝对 URL
 * @param {string|null} location 响应头 Location 原值
 * @param {string|null} startOrigin 被验收站点的起始 origin；不传则用当前这一跳的 origin
 * @returns {{kind:string,next:string|null,location:string|null,from:string,
 *            protocolChanged:boolean,originChanged:boolean,reason:string}}
 */
export function classifyRedirect(fromUrl, location, startOrigin = null) {
  const raw = location == null ? "" : String(location);
  let from;
  try {
    from = new URL(fromUrl);
  } catch {
    return {
      kind: "invalid-location", next: null, location: raw || null, from: String(fromUrl),
      protocolChanged: false, originChanged: false, reason: `来源 URL 无法解析：${fromUrl}`,
    };
  }
  const allowed = startOrigin || from.origin;
  const blank = (kind, reason, extra = {}) => ({
    kind, next: null, location: raw || null, from: from.toString(),
    protocolChanged: false, originChanged: false, reason, ...extra,
  });

  if (!raw.trim()) return blank("invalid-location", "重定向缺少 Location");

  let next;
  try {
    next = new URL(raw, from);
  } catch {
    return blank("invalid-location", `Location 无法解析：${raw}`);
  }

  const protocolChanged = from.protocol !== next.protocol;
  const originChanged = next.origin !== allowed;
  const nextUrl = next.toString();

  // 先挡协议，再谈同源：file: / data: / ftp: 等永远不会进入 fetch()。
  if (!HTTP_PROTOCOLS.includes(next.protocol)) {
    return {
      kind: "unsupported-protocol", next: nextUrl, location: raw, from: from.toString(),
      protocolChanged, originChanged,
      reason: `重定向目标协议不受支持：${next.protocol}（只允许 http/https）；目标 ${nextUrl}`,
    };
  }

  if (originChanged) {
    const change = protocolChanged
      ? `协议变化 ${from.protocol} → ${next.protocol}`
      : `目标源 ${next.origin} 与起始源 ${allowed} 不同`;
    return {
      kind: "cross-origin", next: nextUrl, location: raw, from: from.toString(),
      protocolChanged, originChanged: true,
      reason: `跨源重定向（${change}）到 ${nextUrl}`,
    };
  }

  return {
    kind: "same-origin", next: nextUrl, location: raw, from: from.toString(),
    protocolChanged, originChanged: false, reason: "同源重定向，允许跟随",
  };
}
