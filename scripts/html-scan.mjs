#!/usr/bin/env node
/**
 * html-scan.mjs — 共用的极简 HTML tokenizer（显式状态机，零依赖）。
 *
 * 为什么不用正则：verify-deployment.mjs 和 check-build.mjs 都需要从响应 HTML 里
 * 找「真实的元素/属性/文本」。用 `/<link[^>]*rel=canonical/` 这类正则模拟 HTML
 * 解析会反复在相邻场景出错：注释、script/style/textarea/title 里的伪标签、属性值
 * 里的 `>`、大小写、无引号值、字符引用……每补一个正则就漏掉下一类。
 *
 * 为什么不引入 parse5：本技能以「复制目录即可使用、`node scripts/*.mjs` 直接运行」
 * 的方式分发，仓库没有 package.json / npm install 步骤，测试也要求零安装可复现。
 * 引入运行期依赖会破坏这个分发模型，所以这里实现一个范围明确、状态受控的
 * tokenizer；它不是完整 HTML5 tree builder，但覆盖本技能需要的元素/属性/文本识别。
 *
 * 支持：
 *   - 开始/结束标签、自闭合写法、属性顺序、单/双引号与无引号属性值、属性值里的 ">"
 *   - 标签名 / 属性名 ASCII 大小写归一（HTML 语义）
 *   - 注释、`<!DOCTYPE>`、`<?...>`、bogus comment、HTML 中的 `<![CDATA[`（按 bogus comment 处理）
 *   - RCDATA：title / textarea（内容按文本处理，不再识别标签）
 *   - RAWTEXT：script / style / xmp / iframe / noembed / noframes / noscript
 *   - plaintext：之后全部是文本
 *   - template：内容属于惰性文档片段，不计入本文档的元素
 *   - SVG / MathML 外部内容：其中的 `<link>` 等按命名空间处理，不计入 HTML 元素；
 *     外域里的 `<![CDATA[` 跳到 `]]>`，`<foreignObject>` 内部恢复 HTML 解析
 *   - 数字字符引用（含缺分号情形）与常用命名字符引用（大小写敏感，C1 控制字符按 windows-1252）
 *
 * 已知限制（刻意不做，需人工/DOM 级验证时另行处理）：
 *   - 不做完整 HTML5 tree construction（如隐式闭合、foster parenting）
 *   - script data 的 double-escaped 状态（`<!--<script></script>-->`）不做特殊处理
 *   - 命名实体只覆盖常用集合；URL 中出现冷门命名实体的概率极低
 */

export const RAWTEXT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript"]);
export const RCDATA_ELEMENTS = new Set(["title", "textarea"]);
const FOREIGN_ROOTS = new Set(["svg", "math"]);
// xmp 虽然按 RAWTEXT 解析，但浏览器会把内容当可见文本渲染。
const VISIBLE_RAWTEXT = new Set(["xmp"]);

const ASCII_WS = /[\t\n\f\r ]/;
const TAG_OPEN_ALPHA = /[A-Za-z]/;

// 常用命名字符引用；未列出的命名实体保持原样（不会把 URL 悄悄改错）。
const NAMED_ENTITIES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["apos", "'"], ["nbsp", "\u00a0"],
  ["copy", "\u00a9"], ["reg", "\u00ae"], ["trade", "\u2122"], ["hellip", "\u2026"],
  ["mdash", "\u2014"], ["ndash", "\u2013"], ["lsquo", "\u2018"], ["rsquo", "\u2019"],
  ["ldquo", "\u201c"], ["rdquo", "\u201d"], ["laquo", "\u00ab"], ["raquo", "\u00bb"],
  ["middot", "\u00b7"], ["times", "\u00d7"], ["divide", "\u00f7"],
]);

// windows-1252 对 C1 控制字符（0x80-0x9F）的映射；浏览器按此替换。
const C1_REMAP = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

function codePointToString(code) {
  if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return "\uFFFD";
  }
  if (C1_REMAP.has(code)) code = C1_REMAP.get(code);
  try { return String.fromCodePoint(code); } catch { return "\uFFFD"; }
}

/**
 * 解码数字字符引用与常用命名字符引用。命名实体大小写敏感（`&Amp;` 不是 `&amp;`）。
 * 数字引用允许缺分号；但在属性值里，缺分号且后面紧跟字母数字或 "=" 时按原文保留
 * （HTML tokenizer 的 attribute-value 规则）。
 * @param {string} input
 * @param {boolean} [inAttribute] 是否在属性值里解码
 */
export function decodeCharacterReferences(input, inAttribute = false) {
  const s = String(input ?? "");
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}))(;?)/g, (whole, dec, hex, named, semi, offset) => {
    if (dec != null || hex != null) {
      const code = dec != null ? Number(dec) : Number.parseInt(hex, 16);
      if (!semi && inAttribute) {
        const next = s[offset + whole.length];
        if (next && /[a-zA-Z0-9=]/.test(next)) return whole;
      }
      return codePointToString(code);
    }
    // 命名实体只认带分号且大小写完全匹配的常用集合。
    if (!semi) return whole;
    return NAMED_ENTITIES.get(named) ?? whole;
  });
}

const isWs = (ch) => ch !== undefined && ASCII_WS.test(ch);
const lower = (s) => String(s).toLowerCase();

/**
 * 解析开始标签（从 "<" 开始）。EOF 中断时返回 null：不完整标签不当作元素，
 * 这是安全默认（不会把没闭合的伪 canonical 当成真实标签）。
 */
function parseStartTag(html, start) {
  const n = html.length;
  let i = start + 1;
  let name = "";
  while (i < n && !isWs(html[i]) && html[i] !== "/" && html[i] !== ">") { name += html[i]; i++; }
  if (!name) return null;
  name = lower(name);
  const attrs = [];
  const seen = new Set();
  let selfClosing = false;

  for (;;) {
    while (i < n && isWs(html[i])) i++;
    if (i >= n) return null; // 标签没写完
    if (html[i] === ">") return { tag: { name, attrs, selfClosing, raw: html.slice(start, i + 1) }, next: i + 1 };
    if (html[i] === "/") {
      if (html[i + 1] === ">") {
        selfClosing = true;
        i += 2;
        return { tag: { name, attrs, selfClosing, raw: html.slice(start, i) }, next: i };
      }
      i++;
      continue; // 游离的 "/" 是解析错误，忽略
    }
    // 属性名：到空白、"/"、"=""、">" 为止
    let attrName = "";
    if (html[i] === "=") { attrName = "="; i++; } // 属性名以 "=" 开头：parse error，但浏览器保留
    while (i < n && !isWs(html[i]) && html[i] !== "/" && html[i] !== "=" && html[i] !== ">") { attrName += html[i]; i++; }
    if (!attrName) { i++; continue; }
    attrName = lower(attrName);
    while (i < n && isWs(html[i])) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < n && isWs(html[i])) i++;
      if (i >= n) return null;
      const quote = html[i];
      if (quote === "\"" || quote === "'") {
        i++;
        const valueStart = i;
        while (i < n && html[i] !== quote) i++;
        if (i >= n) return null; // 引号没闭合
        value = html.slice(valueStart, i);
        i++;
      } else {
        const valueStart = i;
        while (i < n && !isWs(html[i]) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    // 重复属性按 HTML 规范保留第一个，后面的丢弃
    if (!seen.has(attrName)) {
      seen.add(attrName);
      attrs.push({ name: attrName, value: decodeCharacterReferences(value, true) });
    }
  }
}

/** 找到 `</name ... >` 的起始位置；找不到返回 -1。结束标签名后必须是空白、"/" 或 ">"。 */
function findEndTag(html, from, name) {
  const re = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, "gi");
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

/**
 * 跳过标签到 ">" 之后。只有属性值位置（前一个非空白字符是 "="）的引号才保护 ">"；
 * 结束标签里游离的引号（如 `</a ">`）不会吞掉后面的真实标签。
 */
function skipTagToGt(html, from) {
  let quote = null;
  let lastNonWs = "";
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = null;
      lastNonWs = ch;
      continue;
    }
    if ((ch === "\"" || ch === "'") && lastNonWs === "=") {
      quote = ch;
      lastNonWs = ch;
      continue;
    }
    if (ch === ">") return i + 1;
    if (!isWs(ch)) lastNonWs = ch;
  }
  return html.length;
}

/** 解析结束标签（从 "<" 开始），返回 {name, next}；无法识别返回 null。 */
function parseEndTag(html, start) {
  const n = html.length;
  let i = start + 2; // 跳过 "</"
  let name = "";
  while (i < n && !isWs(html[i]) && html[i] !== "/" && html[i] !== ">") { name += html[i]; i++; }
  if (!name) return null;
  return { name: lower(name), next: skipTagToGt(html, i) };
}

/**
 * 扫描 HTML，返回真实元素（文档顺序）和可见文本。
 *
 * 返回：
 *   elements[]  开始标签，按文档顺序；template 内容不计入
 *     { name, attrs: [{name, value}], selfClosing, raw, content? }
 *     content 仅 RCDATA（title/textarea）元素有：解码后的文本内容
 *   text        可见文本（不含注释、script/style 等 RAWTEXT、template 内容；含 title/textarea）
 *
 * @param {string} input
 * @returns {{elements: object[], text: string}}
 */
export function parseHtml(input) {
  // HTML 输入预处理：NUL 替换为 U+FFFD（与浏览器一致），避免出现在文件路径里。
  const html = String(input ?? "").replace(/\0/g, "\uFFFD");
  const n = html.length;
  const elements = [];
  const textParts = [];
  let textBuf = "";
  let i = 0;
  let templateDepth = 0;
  // SVG / MathML 外部内容：其中的元素不是 HTML 元素；foreignObject 内部恢复 HTML。
  let foreignDepth = 0;
  let foreignObjectDepth = 0;
  const inForeign = () => foreignDepth > 0 && foreignObjectDepth === 0;

  const pushText = (raw) => {
    const decoded = decodeCharacterReferences(raw);
    if (decoded) textParts.push(decoded);
  };
  const flushText = () => {
    if (!textBuf) return;
    if (templateDepth === 0) pushText(textBuf);
    textBuf = "";
  };
  const inTemplate = () => templateDepth > 0;

  while (i < n) {
    const ch = html[i];
    if (ch !== "<") {
      // 外部命名空间（SVG/MathML）里的文本不计入 HTML 可见文本。
      if (!inForeign()) textBuf += ch;
      i++;
      continue;
    }

    const next = html[i + 1];

    // SVG/MathML 里的 CDATA 一直读到 "]]>"（不是 bogus comment）。
    if (inForeign() && html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      i = end === -1 ? n : end + 3;
      continue;
    }

    // 注释 / DOCTYPE / bogus comment / CDATA（HTML 中按 bogus comment 处理）
    if (next === "!") {
      if (html.startsWith("<!--", i)) {
        // `<!-->` 是 abrupt closing of empty comment；`--!>` 也是合法结束。
        // 从 i+3 开始找：`<!--->` 的结束序列是 opener 的最后一个 "-" + "->"。
        if (html[i + 4] === ">") { i += 5; continue; }
        const close = /--!?>/.exec(html.slice(i + 3));
        i = close ? i + 3 + close.index + close[0].length : n;
        continue;
      }
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (next === "?") {
      const end = html.indexOf(">", i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }

    // 结束标签
    if (next === "/") {
      flushText();
      const endTag = parseEndTag(html, i);
      if (!endTag) {
        // "</" 后不是标签名：按 bogus comment 处理到下一个 ">"
        const end = html.indexOf(">", i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      if (inForeign()) {
        // 外部命名空间的结束标签：维护深度，不参与 HTML 元素判定。
        if (endTag.name === "foreignobject" && foreignObjectDepth > 0) foreignObjectDepth--;
        else if (FOREIGN_ROOTS.has(endTag.name) && foreignDepth > 0) foreignDepth--;
        i = endTag.next;
        continue;
      }
      if (foreignDepth > 0 && endTag.name === "foreignobject" && foreignObjectDepth > 0) {
        foreignObjectDepth--;
        i = endTag.next;
        continue;
      }
      if (endTag.name === "template" && templateDepth > 0) templateDepth--;
      i = endTag.next;
      continue;
    }

    // 开始标签
    if (next !== undefined && TAG_OPEN_ALPHA.test(next)) {
      flushText();
      const wasForeign = inForeign();
      const parsed = parseStartTag(html, i);
      if (!parsed) {
        // 不完整的标签：按文本吃掉剩余内容，不产生元素（安全默认）
        textBuf += html.slice(i);
        i = n;
        break;
      }
      const tag = parsed.tag;
      i = parsed.next;
      if (FOREIGN_ROOTS.has(tag.name)) {
        // SVG/MathML 根：进入外部命名空间；它本身不是 HTML 元素（但保留以便调试/定位）。
        if (!tag.selfClosing) foreignDepth++;
        if (!inTemplate() && !wasForeign) elements.push(tag);
        continue;
      }
      if (wasForeign) {
        // 外域内的元素（link/title 等）不参与 HTML 判定；foreignObject 恢复 HTML 解析。
        if (tag.name === "foreignobject" && !tag.selfClosing) foreignObjectDepth++;
        continue;
      }
      if (tag.name === "template") {
        // template 元素本身属于文档；它的内容不属于
        if (!inTemplate()) elements.push(tag);
        templateDepth++;
        continue;
      }
      if (!inTemplate()) elements.push(tag);
      if (tag.name === "plaintext") {
        // plaintext 之后全部是文本，不再有标签
        if (!inTemplate()) textBuf = html.slice(i);
        i = n;
        break;
      }
      if (RAWTEXT_ELEMENTS.has(tag.name)) {
        const closeAt = findEndTag(html, i, tag.name);
        const contentEnd = closeAt === -1 ? n : closeAt;
        tag.content = html.slice(i, contentEnd);
        // xmp 虽然是 RAWTEXT，但浏览器会把内容按文本渲染；其余 RAWTEXT 不进可见文本。
        if (!inTemplate() && VISIBLE_RAWTEXT.has(tag.name) && tag.content) textParts.push(tag.content);
        i = closeAt === -1 ? n : skipTagToGt(html, closeAt);
        continue;
      }
      if (RCDATA_ELEMENTS.has(tag.name)) {
        const closeAt = findEndTag(html, i, tag.name);
        const contentEnd = closeAt === -1 ? n : closeAt;
        tag.content = decodeCharacterReferences(html.slice(i, contentEnd));
        // title 是文档标题，不是「可见文本」；textarea 的内容则属于可见文本。
        if (!inTemplate() && tag.content && tag.name !== "title") textParts.push(tag.content);
        i = closeAt === -1 ? n : skipTagToGt(html, closeAt);
        continue;
      }
      continue;
    }

    // "<" 后面不是标签起始：当普通文本
    textBuf += ch;
    i++;
  }
  flushText();
  return { elements, text: textParts.join(" ") };
}

/** 取元素的第一个同名属性（属性名已是小写）。返回 {present, value}。 */
export function getAttribute(element, name) {
  const wanted = lower(name);
  const attr = element?.attrs?.find((a) => a.name === wanted);
  return attr ? { present: true, value: attr.value } : { present: false, value: null };
}

/** rel 是 HTML 空白分隔的 token 列表，token 按 ASCII 大小写不敏感比较。 */
export function relTokens(element) {
  const rel = getAttribute(element, "rel");
  if (!rel.present) return [];
  return String(rel.value)
    .split(/[\t\n\f\r ]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/**
 * 从真实元素中提取「会加载子资源」的引用，供 verify-deployment 和 check-build 共用，
 * 避免两个脚本各自维护一套「哪些属性算资源」的规则而给出相反结论。
 *
 * 规则（保守、与浏览器资源加载语义对齐）：
 *   - `src` / `poster`：任意元素
 *   - `srcset`：拆出每个候选 URL（逗号分隔、首个 token 是 URL）
 *   - `data`：仅 `<object>`
 *   - `href`：仅 `<link>`，且排除 rel token 含 canonical 的 link（canonical 是文档关系，不是资源）
 * 不包含 `<a href>`（导航链接不是子资源）、`<base href>`（解析基准）和 `data:` 等内联内容。
 *
 * @returns {{element:string, attr:string, value:string}[]} 按文档与属性顺序
 */
export function resourceReferences(elements) {
  const out = [];
  const push = (el, attr, value) => {
    const v = String(value ?? "").trim();
    if (v) out.push({ element: el.name, attr, value: v });
  };
  for (const el of elements) {
    for (const attr of el.attrs) {
      if (attr.name === "src" || attr.name === "poster") { push(el, attr.name, attr.value); continue; }
      if (attr.name === "srcset") {
        // srcset 候选以「逗号 + 空白」分隔；URL 本身可以含逗号（如 data: URI）。
        for (const candidate of String(attr.value).split(/,(?=\s)/)) {
          const url = candidate.trim().split(/\s+/)[0].replace(/,$/, "");
          if (url) push(el, "srcset", url);
        }
        continue;
      }
      if (attr.name === "data" && el.name === "object") { push(el, attr.name, attr.value); continue; }
      if (attr.name === "href" && el.name === "link" && !relTokens(el).includes("canonical")) {
        push(el, attr.name, attr.value);
      }
    }
  }
  return out;
}

/**
 * 按 HTML 语义计算文档的 effective base URL：第一个带 href 的 <base>（文档顺序，
 * 不在 template 内）决定相对地址的解析基准；没有或无法解析时返回传入的 documentUrl。
 * @param {object[]} elements parseHtml().elements
 * @param {string} documentUrl 当前文档 URL
 * @returns {string}
 */
export function effectiveBaseUrl(elements, documentUrl) {
  const baseEl = elements.find((el) => el.name === "base" && getAttribute(el, "href").present);
  if (!baseEl) return documentUrl;
  try {
    return new URL(getAttribute(baseEl, "href").value, documentUrl).toString();
  } catch {
    return documentUrl;
  }
}
