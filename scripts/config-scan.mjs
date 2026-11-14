#!/usr/bin/env node
/**
 * config-scan.mjs — 读取「代码/配置文件里的静态值」时使用的注释与字符串剥离工具。
 *
 * detect-project.mjs 以前直接用正则扫 JS / TOML / JSONC / YAML 原文，于是注释里
 * 的 `// base: "/legacy/"`、`# main = "x"`、注释掉的 workflow action 都会被当成
 * 真实配置。这和 HTML 里的「伪标签」是同一类问题：没有区分「代码」和「注释/字符串」。
 *
 * 这些函数不是完整语言解析器，只负责让后续的字段提取不会被注释骗到：
 *   - stripJsComments：处理 //、/* *\/，跳过 '...' / "..." / `...` 字符串与转义
 *   - stripHashComments：行内 # 注释，跳过引号字符串（TOML/YAML 用）
 *   - parseJsonc：剥离 JSONC 注释与尾逗号后 JSON.parse，失败返回 null
 *   - tomlField：按 [section] 取 TOML 字符串字段
 *
 * 已知限制：模板字符串 ${...} 里的表达式按字符串内容处理；不处理 YAML 多行标量。
 */

/** 跳过字符串字面量：返回字符串结束后的下标（未闭合则到末尾）。 */
function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") { i += 2; continue; }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

/** 剥离 JS / JSONC 的 // 与 /* *\/ 注释；字符串内容原样保留。 */
export function stripJsComments(text) {
  const s = String(text ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 把多行字符串（TOML """ / '''）内容替换为空白，保留换行与行数。 */
function stripMultilineQuoted(text) {
  const s = String(text ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const triple = s.startsWith("\"\"\"", i) ? "\"\"\"" : s.startsWith("'''", i) ? "'''" : null;
    if (!triple) { out += s[i]; i++; continue; }
    let j = i + 3;
    while (j < s.length && !s.startsWith(triple, j)) {
      j += s[j] === "\\" ? 2 : 1;
    }
    j = Math.min(s.length, s.startsWith(triple, j) ? j + 3 : s.length);
    out += s.slice(i, j).replace(/[^\n]/g, " ");
    i = j;
  }
  return out;
}

/** 去掉 YAML 块标量（`key: |` / `key: >`）的缩进内容，保留行数。 */
function stripYamlBlockScalars(text) {
  const lines = String(text ?? "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (!/^\s*[^#\n]*?:\s*[|>][+-]?\s*(?:#.*)?$/.test(line)) continue;
    const baseIndent = line.search(/\S/);
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (next.trim() === "") { out.push(""); i++; continue; }
      if (next.search(/\S/) <= baseIndent) break;
      out.push("");
      i++;
    }
    i--;
  }
  return out.join("\n");
}

/** 剥离 TOML / YAML 风格的行内 # 注释；多行字符串与块标量内容不算配置。 */
export function stripHashComments(text) {
  const s = stripYamlBlockScalars(stripMultilineQuoted(String(text ?? "")));
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\"" || ch === "'") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "#") {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** 去掉 JSON 的尾逗号（字符串内不处理）。 */
function stripTrailingCommas(text) {
  const s = String(text ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\"") {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === "}" || s[j] === "]") { i = j; continue; }
    }
    out += ch;
    i++;
  }
  return out;
}

/** 解析 JSONC（允许 //、/* *\/ 注释与尾逗号）；失败返回 null。 */
export function parseJsonc(text) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsComments(String(text ?? ""))));
  } catch {
    return null;
  }
}

/**
 * 取 TOML 里的字符串字段。section=null 表示顶层；section="assets" 表示 [assets]。
 * 只返回带引号的字符串值；数组/布尔等返回 null（不是本项目的需求）。
 */
export function tomlField(text, key, section = null) {
  const lines = stripHashComments(String(text ?? "")).split(/\r?\n/);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*["']?${esc}["']?\\s*=\\s*["']([^"']*)["']`);
  let current = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\[\]]+)\]\s*$/);
    if (header) { current = header[1].trim().toLowerCase(); continue; }
    if (current !== (section === null ? null : String(section).toLowerCase())) continue;
    const m = line.match(re);
    if (m) return m[1];
  }
  return null;
}

/** TOML 顶层是否出现某个 key（不要求值类型）。 */
export function tomlHasKey(text, key) {
  const lines = stripHashComments(String(text ?? "")).split(/\r?\n/);
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*["']?${esc}["']?\\s*=`);
  let current = null;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\[\]]+)\]\s*$/);
    if (header) { current = header[1].trim().toLowerCase(); continue; }
    if (current === null && re.test(line)) return true;
  }
  return false;
}

/**
 * 读取 JS/TS 配置对象顶层（depth === 1）某个 key 的原始值 token。
 * 只用于布尔/字符串这类简单值（例如 Nuxt 的 `ssr: false`）。
 * 嵌套对象里的同名 key（如 routeRules 的 ssr）不会被误读。
 * @returns {string|null} 例如 "false" / "static"（去掉引号），找不到返回 null
 */
export function jsTopLevelValue(text, key) {
  const s = stripJsComments(String(text ?? ""));
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyRe = new RegExp(`^(?:["']?${esc}["']?)\\s*:\\s*`);
  let depth = 0;
  let objectDepth = null; // 配置对象所在的深度（defineNuxtConfig({...}) 前面可能有函数调用括号）
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\"" || ch === "'" || ch === "`") { i = skipString(s, i); continue; }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      if (ch === "{" && objectDepth === null) objectDepth = depth;
      i++;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (objectDepth !== null && depth === objectDepth) {
      const m = s.slice(i).match(keyRe);
      const before = s.slice(0, i).replace(/\s+$/, "");
      if (m && (before.endsWith("{") || before.endsWith(","))) {
        let j = i + m[0].length;
        const rest = s.slice(j);
        const value = rest.match(/^(false|true|null|["'][^"']*["'])/);
        if (Boolean(value)) {
          return value[1].startsWith("\"") || value[1].startsWith("'") ? value[1].slice(1, -1) : value[1];
        }
        return null;
      }
    }
    i++;
  }
  return null;
}
