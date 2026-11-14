/**
 * 网络重试的纯分类逻辑（无 I/O，便于单测）。
 *
 * 只重试「连接尚未建立或连接被对端重置」这类瞬时错误；一旦拿到 HTTP 响应
 * （包括 3xx/4xx/5xx）就绝不能再重试，否则会掩盖真实的 HTTP 断言失败。
 * 证书错误、DNS 解析失败、非法 URL、脚本自己的超时 AbortError 都不重试。
 */

export const DEFAULT_RETRIES = 1;
export const MAX_RETRIES = 3;
export const RETRY_BACKOFF_MS = 300;

// undici / Node 常见的瞬时连接错误码。未识别的错误一律不重试（fail-closed）。
// 注意：DNS 解析失败（ENOTFOUND/EAI_AGAIN）和证书错误不在白名单；脚本自身的
// --timeout AbortError 由 isTransientNetworkError 的 timedOut 参数单独排除。
export const TRANSIENT_NETWORK_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);

/** 从 Error / AggregateError / cause 链收集所有 `code`。 */
export function collectNetworkErrorCodes(error) {
  const codes = new Set();
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (typeof value.code === "string") codes.add(value.code.toUpperCase());
    if (Array.isArray(value.errors)) for (const child of value.errors) visit(child, depth + 1);
    if (value.cause) visit(value.cause, depth + 1);
  };
  visit(error, 0);
  return [...codes];
}

/**
 * 是否值得重试。`timedOut` 由调用方的计时器标记：脚本自己的单次超时不重试，
 * 避免把一次慢请求放大成多倍等待；外部取消（AbortError）也不重试。
 */
export function isTransientNetworkError(error, timedOut = false) {
  if (!error || timedOut) return false;
  if (error.name === "AbortError") return false;
  return collectNetworkErrorCodes(error).some((code) => TRANSIENT_NETWORK_CODES.has(code));
}

/** 参数校验：--retries 必须是 0..MAX_RETRIES 的整数。 */
export function parseRetries(raw) {
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RETRIES) return null;
  return value;
}

