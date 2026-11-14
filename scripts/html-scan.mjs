#!/usr/bin/env node
/**
 * html-scan.mjs — 共用的极简 HTML tokenizer + 局部状态机（零依赖）。
 *
 * 为什么不用正则：verify-deployment.mjs 和 check-build.mjs 都需要从响应 HTML 里
 * 找「真实的 HTML 元素/属性/文本」。用 `/<link[^>]*rel=canonical/` 这类正则模拟
 * HTML 解析会反复在相邻场景出错：注释、script/style/textarea/title 里的伪标签、
 * 属性值里的 `>`、大小写、无引号值、字符引用、DOCTYPE 引号……每补一个正则就漏掉
 * 下一类。
 *
 * 为什么不引入 parse5：本技能以「复制目录即可使用、`node scripts/*.mjs` 直接运行」
 * 的方式分发，仓库没有 package.json / npm install 步骤，测试也要求零安装可复现。
 * 引入运行期依赖会破坏这个分发模型。这里实现的是**针对本技能需求**的 tokenizer：
 * 它只输出 HTML 命名空间的开始标签、文本和资源引用，不做完整 HTML5 tree
 * construction；但对会影响 canonical/资源/可见文本识别的状态机（script data、
 * RCDATA/RAWTEXT、注释/DOCTYPE、SVG/MathML 外部内容、template、属性语法、字符
 * 引用）按规范状态转换处理。
 *
 * 支持：
 *   - 开始/结束标签、自闭合、属性顺序/引号/无引号、属性值里的 ">"、重复属性
 *   - script data 的 escaped / double-escaped 状态（`<!--<script></script>-->`）
 *   - 注释、`<!DOCTYPE>`（public/system 标识符里的 `>` 按规范 abrupt 结束 DOCTYPE，
 *     force-quirks；之后的文本继续按 HTML 解析，不假装引号能保护 `>`）、
 *     `<?...>`、bogus comment、HTML 中的 `<![CDATA[`（按 bogus comment 处理）
 *   - RCDATA：title / textarea
 *   - RAWTEXT：style / xmp / iframe / noembed / noframes / noscript
 *   - plaintext
 *   - template：内容属于惰性文档片段，不计入本文档的元素
 *   - SVG / MathML 外部内容：命名空间状态栈；`foreignObject` / `desc` / `title` /
 *     MathML 文本集成点内部的 HTML 开始标签；外域 CDATA；HTML breakout 开始标签；
 *     外域结束后恢复 HTML
 *   - 数字字符引用（含缺分号）与常用命名字符引用（大小写敏感、windows-1252 C1）
 *   - srcset 候选解析（含 data: URI 里的逗号、无空格逗号、尾随逗号、畸形候选）
 *
 * 已知限制（刻意不做，需 DOM 级精确结论时用浏览器复核）：
 *   - 不做完整 HTML5 tree construction（隐式闭合、foster parenting、活动格式化
 *     元素重建、adoption agency 等）；只输出 HTML 命名空间里“序列化文本中真实
 *     出现的”开始标签
 *   - 外域内容用命名空间状态栈覆盖 svg/math 根、SVG 集成点、MathML 文本集成点、
 *     annotation-xml 的 encoding 分支、breakout 标签与 HTML 祖先结束标签；但不做
 *     完整集成点/foreign content 树构建（如 annotation-xml 内更复杂的树规则）
 *   - 命名实体只覆盖常用集合；legacy（无分号）实体只覆盖常见子集
 *   - DOCTYPE 只保证 token 边界正确；不暴露 force-quirks/compatMode
 *   - 输入预处理只做 CR/CRLF→LF 与 NUL→U+FFFD，不做完整 UTF-8 解码错误替换
 *   - textarea 内容计入本模块的“可见文本”（浏览器 innerText 口径可能不同）
 *   - 属性重复时按“第一个生效”处理（与浏览器一致）
 */

export const RAWTEXT_ELEMENTS = new Set(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript"]);
export const RCDATA_ELEMENTS = new Set(["title", "textarea"]);
const FOREIGN_ROOTS = new Set(["svg", "math"]);
// SVG 的 HTML 集成点：这些元素内部的开始标签按 HTML 规则解析。
const SVG_INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title"]);
// MathML 文本集成点：子开始标签（除 mglyph/malignmark）按 HTML 规则解析。
const MATHML_TEXT_INTEGRATION_POINTS = new Set(["mi", "mo", "mn", "ms", "mtext"]);
// HTML 空元素（开始标签后立即结束，没有结束标签；用于集成点内的 HTML 子节点栈）。
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
// HTML 树构建在普通 body 上下文里会丢弃/自弹的开始标签：它们不应污染我们
// 近似用的 HTML 祖先栈（例如 `<svg><foreignObject><tr></foreignObject>` 中的
// tr 在浏览器里根本不会创建，不能让它挡住外域结束标签）。
const UNTRACKED_HTML_START_TAGS = new Set([
  "tr", "td", "th", "thead", "tbody", "tfoot", "caption", "colgroup",
  "html", "head", "body", "frame", "basefont", "bgsound",
]);
// 外域结束标签回退 HTML 时，浏览器会沿栈找同名 HTML 祖先；但这些 scope 边界
// 会阻止继续向上（table/object/marquee/applet/select；caption/td/tr 等在 body
// 上下文本身就被丢弃，不属于边界）。
const HTML_SCOPE_BOUNDARY_ELEMENTS = new Set(["table", "object", "marquee", "applet", "select"]);
// select 插入模式下会关闭 select 并重新处理这些开始标签；其余多数标签被忽略。
const SELECT_CLOSES_ON_START = new Set(["input", "keygen", "textarea"]);
// HTML 规范中的 special 元素（用于近似“any other end tag”在 special 元素处停止的规则）。
const HTML_SPECIAL_ELEMENTS = new Set([
  "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote",
  "body", "br", "button", "caption", "center", "col", "colgroup", "dd", "details", "dir", "div",
  "dl", "dt", "embed", "fieldset", "figcaption", "figure", "footer", "form", "frame", "frameset",
  "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "iframe", "img",
  "input", "keygen", "li", "link", "listing", "main", "marquee", "menu", "meta", "nav", "noembed",
  "noframes", "noscript", "object", "ol", "p", "param", "plaintext", "pre", "script", "section",
  "select", "source", "style", "summary", "table", "tbody", "td", "template", "textarea", "tfoot",
  "th", "thead", "title", "tr", "track", "ul", "wbr", "xmp",
]);
// 外域内容里会“打破”命名空间、退回 HTML 处理的开始标签（WHATWG 规范列表）。
const FOREIGN_BREAKOUT_TAGS = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt",
  "em", "embed", "h1", "h2", "h3", "h4", "h5", "h6", "head", "hr", "i", "img", "li",
  "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small", "span",
  "strike", "strong", "sub", "sup", "table", "tt", "u", "ul", "var",
]);
// HTML 中遇到这些开始标签时，浏览器会先隐式关闭已打开的 <p>（HTML 树构建的
// 「p in button scope」规则）。这里只做最小近似以降低集成点栈的误判。
const P_CLOSING_START_TAGS = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div",
  "dl", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5",
  "h6", "header", "hgroup", "hr", "listing", "main", "menu", "nav", "ol", "p", "pre",
  "section", "summary", "table", "ul",
]);
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
  // URL / 文本里常见的标点与分数实体。
  ["colon", ":"], ["semi", ";"], ["comma", ","], ["period", "."], ["sol", "/"],
  ["quest", "?"], ["num", "#"], ["dollar", "$"], ["percnt", "%"], ["plus", "+"],
  ["equals", "="], ["lpar", "("], ["rpar", ")"], ["ast", "*"], ["lowbar", "_"],
  ["hyphen", "-"], ["frac12", "\u00bd"], ["frac14", "\u00bc"], ["frac34", "\u00be"],
]);
// HTML 允许不带分号的 legacy 命名引用（浏览器在文本里会解码；属性里后接
// 字母数字/等号时按原文保留，见 decodeCharacterReferences）。
const LEGACY_NAMED_ENTITIES = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", "\""], ["nbsp", "\u00a0"],
  ["copy", "\u00a9"], ["reg", "\u00ae"], ["times", "\u00d7"], ["divide", "\u00f7"],
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
    // 命名实体只认常用集合；不带分号的 legacy 实体按浏览器规则处理。
    if (!semi) {
      if (inAttribute) {
        const next = s[offset + whole.length];
        if (next && /[a-zA-Z0-9=]/.test(next)) return whole;
      }
      return LEGACY_NAMED_ENTITIES.get(named) ?? whole;
    }
    return NAMED_ENTITIES.get(named) ?? whole;
  });
}

const isWs = (ch) => ch !== undefined && ASCII_WS.test(ch);
const lower = (s) => String(s).toLowerCase();

/**
 * 解析开始标签（从 "<" 开始）。EOF 中断时返回 null。
 *
 * 与浏览器一致的 EOF 策略（不是额外的保守拒绝）：HTML tokenizer 在标签名/
 * 属性名/属性值/引号中遇到 EOF 时会报错并发出 EOF token，**不会 emit 未完成的
 * 开始标签**；tree builder 因此不会插入元素，标签字符也不会变成文本。这里返回
 * null 后主循环丢弃剩余输入，正是同一结果。RCDATA/RAWTEXT/script 内的未闭合
 * 结束标签按各自 raw 文本保留（见 scanScriptData / findEndTag）。
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
    // 属性名：HTML tokenizer 在属性名前允许 "=" 作为名字的一部分（parse error 但保留）。
    let attrName = "";
    if (html[i] === "=") { attrName = "="; i++; }
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
 * 跳过标签到 ">" 之后。按 tokenizer 的属性状态处理引号：只有「属性名之后、
 * 等号之后」的引号才进入属性值并保护 ">"；结束标签里游离的 `=` / 引号只是
 * 属性名或解析错误字符，不会吞掉后面的真实标签。
 */
function skipTagToGt(html, from) {
  let state = "beforeAttrName"; // beforeAttrName | attrName | afterAttrName | beforeValue | quoted | unquoted
  let quote = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (state === "quoted") {
      if (ch === quote) { state = "beforeAttrName"; quote = null; }
      continue;
    }
    if (state === "beforeValue") {
      if (isWs(ch)) continue;
      if (ch === ">") return i + 1;
      if (ch === "\"" || ch === "'") { state = "quoted"; quote = ch; continue; }
      state = "unquoted";
      continue;
    }
    if (state === "unquoted") {
      if (ch === ">") return i + 1;
      if (isWs(ch)) state = "beforeAttrName";
      continue;
    }
    if (state === "beforeAttrName") {
      if (isWs(ch)) continue;
      if (ch === ">") return i + 1;
      // before-attribute-name 里的 "=" 是属性名首字符，不是赋值。
      state = "attrName";
      continue;
    }
    if (state === "attrName") {
      if (ch === ">") return i + 1;
      if (isWs(ch)) { state = "afterAttrName"; continue; }
      if (ch === "=") { state = "beforeValue"; continue; }
      continue;
    }
    // afterAttrName
    if (isWs(ch)) continue;
    if (ch === ">") return i + 1;
    if (ch === "=") { state = "beforeValue"; continue; }
    state = "attrName";
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

/** 从已知的结束标签起点返回标签之后的位置。 */
function afterEndTag(html, start) {
  const endTag = parseEndTag(html, start);
  return endTag ? endTag.next : skipTagToGt(html, start + 2);
}

/** 判断从 pos 开始是否是 `</script` 且后面是合法的结束标签分隔符。 */
function isScriptEndTagAt(html, pos) {
  return /^<\/script(?=[\t\n\f\r />])/i.test(html.slice(pos, pos + 9));
}

/**
 * 扫描 script data 直到真正的 `</script>`。
 *
 * 这不是「找第一个 </script>」：HTML 的 script data 有 escaped / double-escaped
 * 子状态。典型 `<!--<script></script>-->` 里的第一个 `</script>` 只让状态从
 * double-escaped 回到 escaped，**不关闭** script；只有 script data / escaped
 * 状态下的 `</script>` 才关闭。
 *
 * @param {string} html 完整输入
 * @param {number} from script 开始标签之后的位置
 * @returns {{contentEnd:number, next:number}} contentEnd 是 `</script` 的起始位置
 *   （未闭合时为 html.length），next 是结束标签之后（未闭合为 html.length）
 */
export function scanScriptData(html, from) {
  const n = html.length;
  let i = from;
  let state = "data"; // data | escaped | double
  while (i < n) {
    if (state === "data") {
      // `<!--` 进入 script data escaped 前的 dash-dash 状态；紧跟的 `>`（或再若干
      // `-` 后跟 `>`）会退回 script data，例如 `<!-->` / `<!--->`。
      if (html.startsWith("<!--", i)) {
        let j = i + 4;
        while (j < n && html[j] === "-") j++;
        if (j < n && html[j] === ">") { i = j + 1; state = "data"; continue; }
        i = j;
        state = "escaped";
        continue;
      }
      if (html[i] === "<" && isScriptEndTagAt(html, i)) {
        return { contentEnd: i, next: afterEndTag(html, i) };
      }
      i++;
      continue;
    }
    if (state === "escaped") {
      if (html[i] === "<") {
        // escaped 状态下的 `</script>` 仍然关闭 script。
        if (isScriptEndTagAt(html, i)) {
          return { contentEnd: i, next: afterEndTag(html, i) };
        }
        // `<!--...` 之后的 `<script ...>` 进入 double-escaped；只对 ASCII 字母
        // 起头的标签名做 buffer 判断，其他情况保持 escaped。
        if (i + 1 < n && TAG_OPEN_ALPHA.test(html[i + 1])) {
          let j = i + 1;
          while (j < n && TAG_OPEN_ALPHA.test(html[j])) j++;
          const name = html.slice(i + 1, j);
          if (j < n && /[\t\n\f\r \/>]/.test(html[j]) && lower(name) === "script") {
            i = j + 1;
            state = "double";
            continue;
          }
          // 不匹配的标签名：继续按 escaped 扫描（`<` 之后的字符照常是文本）。
        }
        i++;
        continue;
      }
      // escaped dash dash 的 `>` 回到 data（即 `-->` 结束转义注释）。
      if (html.startsWith("-->", i)) { i += 3; state = "data"; continue; }
      i++;
      continue;
    }
    // state === "double"
    if (html[i] === "<" && html[i + 1] === "/" && i + 2 < n && TAG_OPEN_ALPHA.test(html[i + 2])) {
      let j = i + 2;
      while (j < n && TAG_OPEN_ALPHA.test(html[j])) j++;
      const name = html.slice(i + 2, j);
      if (j < n && /[\t\n\f\r \/>]/.test(html[j]) && lower(name) === "script") {
        // double-escaped 里的 `</script>` 只回到 escaped，不关闭元素。
        i = j + 1;
        state = "escaped";
        continue;
      }
    }
    // double escaped dash dash 的 `>` 与 escaped 一样回到 script data 状态。
    if (html.startsWith("-->", i)) { i += 3; state = "data"; continue; }
    i++;
  }
  return { contentEnd: n, next: n };
}

/**
 * 跳过 DOCTYPE 到结束的 ">"。
 *
 * 按 WHATWG tokenizer 的 DOCTYPE 状态机：`public` / `system` 标识符虽然用引号
 * 包围，但标识符状态遇到 `>` 会 **abruptly** 结束 DOCTYPE 并置 force-quirks，
 * 引号并不会保护 `>`。因此这里与浏览器一致：从 `<!DOCTYPE` 之后找第一个 `>`
 * （标识符里的 `>` 会让 DOCTYPE 提前结束，其后的文本按 HTML 继续解析）。
 * 这与“剔除注释/伪标签”的目标一致：既不把伪标签当 DOCTYPE 内容吞掉，也不
 * 假装引号能保护 `>` 而偏离浏览器实际解析。
 */
function skipDoctype(html, start) {
  const end = html.indexOf(">", start + 2);
  return end === -1 ? html.length : end + 1;
}

/**
 * 校验 srcset candidate 的 descriptor 列表。
 * 规则（WHATWG）：
 *   - 没有 descriptor 合法；
 *   - `Nw` / `Nx` / `Nh`（N 为非负数），同一种 descriptor 只能出现一次；
 *   - `h` 只能和 `w` 一起出现；`w` / `h` 必须大于 0。
 */
function validSrcsetDescriptors(tokens) {
  if (!tokens.length) return true;
  let hasWidth = false;
  let hasHeight = false;
  let hasDensity = false;
  for (const token of tokens) {
    // w/h 必须是非负整数且单位小写（`1.5w`/`1.0w`/`1X` 都是非法 descriptor）。
    let m = /^([0-9]+)([wh])$/.exec(token);
    if (m) {
      const value = Number(m[1]);
      if (!Number.isFinite(value)) return false;
      if (m[2] === "w") {
        if (hasWidth || value <= 0) return false;
        hasWidth = true;
      } else {
        if (hasHeight || value <= 0) return false;
        hasHeight = true;
      }
      continue;
    }
    // x 是 valid floating-point number（支持指数/`.5`/`-0`；负密度仅 `-0` 算 0 合法）。
    m = /^([+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)(x)$/.exec(token);
    if (!m) return false;
    const density = Number(m[1]);
    if (!Number.isFinite(density) || density < 0 || hasDensity) return false;
    hasDensity = true;
  }
  if (hasHeight && !hasWidth) return false;
  if (hasWidth && hasDensity) return false; // width 与 density 互斥
  return true;
}

/**
 * 解析 srcset 属性，返回候选 URL 列表（按出现顺序）。
 *
 * 依据 WHATWG HTML 的 srcset 解析算法（简化 descriptor 校验，但保留 URL/逗号
 * 边界语义）：
 *   - URL 是「直到空白」的一串字符，URL 里可以包含逗号（data: URI、文件名）；
 *   - URL 若以逗号结尾，去掉尾随逗号，该候选没有 descriptor；
 *   - 否则跳过空白，读取 descriptor 直到逗号；
 *   - `a.png 1x,b.png 2x` 与 `a.png 1x, b.png 2x` 都得到两个候选；
 *   - 尾随逗号、空候选、畸形或重复 descriptor 的候选不产生 URL。
 *
 * @param {string} value
 * @returns {string[]}
 */
export function parseSrcset(value) {
  const s = String(value ?? "");
  const n = s.length;
  let i = 0;
  const out = [];
  while (i < n) {
    while (i < n && (isWs(s[i]) || s[i] === ",")) i++;
    if (i >= n) break;
    // URL：一直取到空白；HTML 允许 URL 本身含逗号。
    const urlStart = i;
    while (i < n && !isWs(s[i])) i++;
    let url = s.slice(urlStart, i);
    if (!url) break;
    // URL 以逗号结尾：去掉尾随逗号，没有 descriptor。
    const trimmedUrl = url.replace(/,+$/, "");
    if (trimmedUrl !== url) {
      if (trimmedUrl) out.push(trimmedUrl);
      continue;
    }
    // descriptor tokenizer：空白结束一个 descriptor；逗号结束候选；`(`...`)` 里的
    // 空白/逗号属于同一个 descriptor（通常随后被判非法而丢弃整个候选）。
    const descriptors = [];
    let token = "";
    let inParens = false;
    while (i < n) {
      const dch = s[i];
      if (inParens) {
        token += dch;
        if (dch === ")") inParens = false;
        i++;
        continue;
      }
      if (isWs(dch)) {
        if (token) { descriptors.push(token); token = ""; }
        i++;
        continue;
      }
      if (dch === ",") {
        if (token) { descriptors.push(token); token = ""; }
        i++;
        break;
      }
      if (dch === "(") { token += "("; inParens = true; i++; continue; }
      token += dch;
      i++;
    }
    if (token) descriptors.push(token);
    if (validSrcsetDescriptors(descriptors)) out.push(url);
  }
  return out;
}

/** 当前是否处于外域内容（非集成点）。 */
function isForeignStartBreakout(tag) {
  if (FOREIGN_BREAKOUT_TAGS.has(tag.name)) return true;
  if (tag.name === "font") {
    return tag.attrs.some((a) => a.name === "color" || a.name === "face" || a.name === "size");
  }
  return false;
}

/**
 * 扫描 HTML，返回 HTML 命名空间的真实元素（文档顺序）和文本。
 *
 * 返回：
 *   elements[]  开始标签，按文档顺序；template 内容与 SVG/MathML 元素不计入
 *     { name, attrs: [{name, value}], selfClosing, raw, content? }
 *     content 仅 RCDATA（title/textarea）与 script 元素有：解码后的文本内容
 *   text        可见文本（不含注释、RAWTEXT（xmp 除外）、template、外域内容、
 *               title；含 textarea 与普通文本）
 *
 * @param {string} input
 * @returns {{elements: object[], text: string}}
 */
export function parseHtml(input) {
  // HTML 输入预处理：CRLF/CR 归一化为 LF，NUL 替换为 U+FFFD（与浏览器一致）。
  const html = String(input ?? "").replace(/\r\n?/g, "\n").replace(/\0/g, "\uFFFD");
  const n = html.length;
  const elements = [];
  const textParts = [];
  let textBuf = "";
  let i = 0;
  let templateDepth = 0;
  // 外域命名空间状态栈。frame: {name, ns, integration, kind, textVisible, htmlStack, annotationXml}
  // 用显式栈而不是 depth 计数器：嵌套 svg / foreignObject / MathML 混合时，
  // 退出顺序和“退到哪一层”由栈精确表达，不会出现计数器错配导致状态泄漏。
  let foreign = [];
  // HTML 上下文里已开始但未结束的元素名（仅用于“外域结束标签碰到 HTML 祖先”时
  // 该退到哪一层；不用于构建完整 DOM）。template 内容单独隔离，不参与。
  let htmlOpenStack = [];
  const templateForeignStack = [];
  const templateHtmlStack = [];
  const currentForeign = () => (foreign.length ? foreign[foreign.length - 1] : null);
  const inForeignContent = () => {
    const frame = currentForeign();
    return Boolean(frame) && !frame.integration;
  };
  const inIntegrationContent = () => {
    const frame = currentForeign();
    return Boolean(frame) && Boolean(frame.integration);
  };
  const textVisibleNow = () => {
    const frame = currentForeign();
    if (!frame) return true;
    if (!frame.integration) return false;
    return Boolean(frame.textVisible);
  };

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

  // 集成点内的 HTML 子元素栈：只有当前 frame 是集成点时才跟踪，
  // 这样 `</foreignObject>` 在 HTML 子元素未闭合时会被忽略（与浏览器一致）。
  const trackHtmlChildStart = (tag) => {
    if (inTemplate()) return;
    if (UNTRACKED_HTML_START_TAGS.has(tag.name)) return;
    const frame = currentForeign();
    const closeImpliedP = (stack) => {
      if (!P_CLOSING_START_TAGS.has(tag.name)) return;
      const pIndex = stack.lastIndexOf("p");
      if (pIndex >= 0) stack.length = pIndex;
    };
    // select 插入模式的近似：嵌套 select 关闭旧 select 并忽略 token；
    // input/keygen/textarea 关闭 select 后按 HTML 规则处理；其余标签在 select
    // 内大多被浏览器忽略，不压栈（完整 select 树构建不在本模块范围）。
    const handleSelectContext = (stack) => {
      const selectIndex = stack.lastIndexOf("select");
      if (selectIndex < 0) return false;
      if (tag.name === "select") { stack.length = selectIndex; return true; }
      if (SELECT_CLOSES_ON_START.has(tag.name)) { stack.length = selectIndex; return false; }
      if (tag.name === "option" || tag.name === "optgroup") return false;
      return true;
    };
    // HTML 命名空间里只有 void 元素才是真正的空元素；`<div/>`/`<span/>` 的
    // self-closing flag 被浏览器忽略，元素仍然打开，必须压栈。
    if (!frame || !frame.integration) {
      // 普通 HTML 元素：记入全局栈，供外域结束标签找到 HTML 祖先。
      if (VOID_ELEMENTS.has(tag.name) || tag.name === "template") {
        // input/keygen 等 void 标签也可能触发 select 插入模式的自动关闭。
        handleSelectContext(htmlOpenStack);
        return;
      }
      if (handleSelectContext(htmlOpenStack)) return;
      closeImpliedP(htmlOpenStack);
      htmlOpenStack.push(tag.name);
      return;
    }
    // 集成点内同样先处理 select 插入模式（void 的 input 也会关闭 select）。
    if (handleSelectContext(frame.htmlStack)) return;
    if (VOID_ELEMENTS.has(tag.name) || tag.name === "template") return;
    closeImpliedP(frame.htmlStack);
    frame.htmlStack.push(tag.name);
  };
  // 非破坏性实现 HTML “any other end tag” 的近似：只查找同名 HTML 元素；
  // 遇到 special 元素且名字不匹配就整 token 忽略（不 pop、不破坏栈）。
  const htmlEndMatchIndex = (stack, name) => {
    for (let idx = stack.length - 1; idx >= 0; idx--) {
      if (stack[idx] === name) return idx;
      if (HTML_SPECIAL_ELEMENTS.has(stack[idx])) return -1;
    }
    return -1;
  };
  const applyHtmlEndRule = (stack, name) => {
    const idx = htmlEndMatchIndex(stack, name);
    if (idx >= 0) stack.length = idx;
    return idx >= 0;
  };
  const handleIntegrationHtmlEnd = (name) => {
    const top = currentForeign();
    if (top && top.integration && top.htmlStack.length) {
      applyHtmlEndRule(top.htmlStack, name);
      return true;
    }
    // 集成点上方可能又嵌套了 svg/math：在更深的集成点帧里找 HTML 子元素。
    for (let k = foreign.length - 1; k >= 0; k--) {
      const frame = foreign[k];
      if (!frame.integration || frame.htmlStack.length === 0) continue;
      const matched = applyHtmlEndRule(frame.htmlStack, name);
      if (matched && k + 1 < foreign.length) foreign.length = k + 1;
      return true;
    }
    return false;
  };
  const popForeignToHtmlContext = () => {
    // 外域 breakout/结束标签只弹到最近的 HTML integration point 或 HTML 祖先，
    // 不能一次清空整个外域栈（否则 `<math><mi><mglyph><img>` 会把 mi 也弹掉）。
    while (foreign.length && !currentForeign().integration) foreign.pop();
  };
  const popHtmlAncestor = (name) => applyHtmlEndRule(htmlOpenStack, name);
  // 外域结束标签回退 HTML 的专用查找：可以越过普通 special 元素（p/span/…），
  // 但遇到 table/object/marquee/applet/select 等 scope 边界就停止。
  const popHtmlAncestorAcrossScope = (name) => {
    const idx = htmlOpenStack.lastIndexOf(name);
    if (idx < 0) return false;
    for (let k = htmlOpenStack.length - 1; k > idx; k--) {
      if (HTML_SCOPE_BOUNDARY_ELEMENTS.has(htmlOpenStack[k])) return false;
    }
    htmlOpenStack.length = idx;
    return true;
  };

  while (i < n) {
    const ch = html[i];
    if (ch !== "<") {
      // 外域内容里的文本不计入 HTML 可见文本；集成点按 frame.textVisible 决定。
      if (textVisibleNow()) textBuf += ch;
      i++;
      continue;
    }

    const next = html[i + 1];
    if (next === undefined) {
      if (textVisibleNow()) textBuf += ch;
      i++;
      continue;
    }

    // 外域里的 CDATA 一直读到 "]]>"（不是 bogus comment）。文本 tokenizer 的
    // CDATA 判定取决于 adjusted current node 是否在 HTML 命名空间：集成点元素
    // 本身是外域元素（CDATA 识别），但集成点内已有 HTML 子元素时当前节点是 HTML，
    // 此时 `<![CDATA[` 按 bogus comment 处理。
    const currentFrameForCdata = currentForeign();
    const cdataAllowed = Boolean(currentFrameForCdata)
      && (!currentFrameForCdata.integration || currentFrameForCdata.htmlStack.length === 0);
    if (cdataAllowed && html.startsWith("<![CDATA[", i)) {
      const end = html.indexOf("]]>", i + 9);
      const contentEnd = end === -1 ? n : end;
      if (textVisibleNow() && contentEnd > i + 9) textParts.push(html.slice(i + 9, contentEnd));
      i = end === -1 ? n : end + 3;
      continue;
    }

    // 注释 / DOCTYPE / bogus comment
    if (next === "!") {
      if (html.startsWith("<!--", i)) {
        // `<!-->` 是 abrupt closing of empty comment；`--!>` 也是合法结束。
        if (html[i + 4] === ">") { i += 5; continue; }
        const close = /--!?>/.exec(html.slice(i + 3));
        i = close ? i + 3 + close.index + close[0].length : n;
        continue;
      }
      if (/^<!doctype(?=[\t\n\f\r >])/i.test(html.slice(i, i + 10))) {
        i = skipDoctype(html, i);
        continue;
      }
      // 其他 `<!...>`（含 HTML 里的 `<![CDATA[`）按 bogus comment 处理到第一个 ">"。
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
        // `</` 后面直接 EOF：按浏览器行为输出 "<" "/" 两个字符；否则按 bogus comment。
        if (i + 2 >= n) {
          if (textVisibleNow()) textBuf += html.slice(i);
          i = n;
          break;
        }
        const end = html.indexOf(">", i + 2);
        i = end === -1 ? n : end + 1;
        continue;
      }
      i = endTag.next;

      // 1) 集成点里未闭合的 HTML 子元素：结束标签先按 HTML 规则处理；
      //    `</foreignObject>` 等在外域子元素未闭合时会被浏览器忽略，不能直接弹栈。
      const topAtEnd = currentForeign();
      if (topAtEnd && topAtEnd.integration && topAtEnd.htmlStack.length > 0) {
        handleIntegrationHtmlEnd(endTag.name);
        if (endTag.name === "template" && templateDepth > 0) {
          templateDepth--;
          foreign = templateForeignStack.pop() || [];
          htmlOpenStack = templateHtmlStack.pop() || [];
        }
        continue;
      }

      // 2) 外域结束标签：从栈顶向下找同名 frame，找到就弹到它；但如果命中的是
      //    仍有 HTML 子元素的集成点帧，先不弹，交给 HTML 子元素栈规则判断。
      let matched = -1;
      for (let k = foreign.length - 1; k >= 0; k--) {
        if (foreign[k].name === endTag.name) { matched = k; break; }
      }
      if (matched >= 0 && foreign[matched].integration && foreign[matched].htmlStack.length > 0) {
        matched = -1;
      }
      if (matched >= 0) {
        foreign.length = matched;
        // 外域元素 `<template>` 的 </template> 只弹外域帧，绝不能改动 HTML
        // template 的隔离栈（HTML template 从不作为 foreign frame 出现）。
        continue;
      }

      // 2b) 集成点上方又嵌套了 svg/math 时，结束标签可能匹配更深的 HTML 子元素
      //     （`<svg><foreignObject><div><svg></div>`）。匹配到才弹掉上方的外域帧。
      if (handleIntegrationHtmlEnd(endTag.name)) continue;

      // 3) 没有匹配的外域 frame：如果这个结束标签匹配 HTML 祖先元素，
      //    浏览器会退回到 HTML 规则并弹掉外域内容（例如 `<div><svg></div>`），
      //    但会在 table/object/marquee/applet/select 等 scope 边界停止。
      if (foreign.length > 0 && popHtmlAncestorAcrossScope(endTag.name)) {
        foreign = [];
        continue;
      }

      // `</p>` / `</br>` 在外域内容里是 breakout 结束标签：退回 HTML 上下文。
      if (foreign.length > 0 && (endTag.name === "p" || endTag.name === "br")) {
        popForeignToHtmlContext();
        continue;
      }

      if (endTag.name === "template" && templateDepth > 0) {
        templateDepth--;
        foreign = templateForeignStack.pop() || [];
        htmlOpenStack = templateHtmlStack.pop() || [];
        continue;
      }
      // 4) 普通 HTML 结束标签：只维护 HTML 祖先栈，弹到匹配元素。
      popHtmlAncestor(endTag.name);
      continue;
    }

    // 开始标签
    if (next !== undefined && TAG_OPEN_ALPHA.test(next)) {
      flushText();
      const parsed = parseStartTag(html, i);
      if (!parsed) {
        // EOF 在不完整开始标签里：浏览器 tokenizer 不会 emit 该开始标签（也不把
        // 标签字符当文本），tree builder 不插入元素；这里与浏览器 DOM 一致地丢弃。
        i = n;
        break;
      }
      const tag = parsed.tag;
      i = parsed.next;
      const topBefore = currentForeign();
      // MathML 文本集成点里，mglyph/malignmark 仍按 MathML 外域元素处理；
      // 但当前节点已是集成点内的 HTML 子元素时（htmlStack 非空），token 走 HTML 规则。
      const mathTextForeign = Boolean(topBefore && topBefore.integration && topBefore.kind === "math-text"
        && topBefore.htmlStack.length === 0 && (tag.name === "mglyph" || tag.name === "malignmark"));
      // MathML annotation-xml 上的 <svg> 走特殊派发：按 HTML 规则插入真正的 SVG 元素。
      const annotationSvg = Boolean(topBefore && topBefore.annotationXml && tag.name === "svg" && !tag.selfClosing);
      const wasForeign = inForeignContent() && !mathTextForeign && !annotationSvg;

      if (mathTextForeign) {
        if (!tag.selfClosing) {
          foreign.push({
            name: tag.name, ns: topBefore.ns, integration: false, kind: null,
            textVisible: false, htmlStack: [],
          });
        }
        continue;
      }

      if (wasForeign) {
        if (isForeignStartBreakout(tag)) {
          // HTML breakout 开始标签：只弹到最近的 HTML integration point/HTML 祖先，
          // 再按 HTML 规则处理这个标签（不能把 integration point 本身弹掉）。
          popForeignToHtmlContext();
          // fall through 到下面的 HTML 处理
        } else {
          // 外域开始标签：只维护命名空间栈，不产生 HTML 元素。
          if (!tag.selfClosing) {
            const frame = currentForeign();
            const ns = frame ? frame.ns : "svg";
            if (FOREIGN_ROOTS.has(tag.name)) {
              foreign.push({ name: tag.name, ns, integration: false, kind: null, textVisible: false, htmlStack: [] });
            } else if (frame && frame.ns === "svg" && SVG_INTEGRATION_POINTS.has(tag.name)) {
              // foreignObject 内的文本是 HTML 文本；desc/title 的文本不渲染。
              foreign.push({
                name: tag.name, ns: "svg", integration: true, kind: "html-integration",
                textVisible: tag.name === "foreignobject", htmlStack: [],
              });
            } else if (frame && frame.ns === "math" && MATHML_TEXT_INTEGRATION_POINTS.has(tag.name)) {
              foreign.push({
                name: tag.name, ns: "math", integration: true, kind: "math-text",
                textVisible: true, htmlStack: [],
              });
            } else if (frame && frame.ns === "math" && tag.name === "annotation-xml") {
              // annotation-xml 只有 encoding 是 text/html 或 application/xhtml+xml 时
              // 才是 HTML integration point；否则是普通 MathML 外域元素。
              const encoding = lower(getAttribute(tag, "encoding").value || "");
              const htmlChildren = encoding === "text/html" || encoding === "application/xhtml+xml";
              foreign.push({
                name: tag.name, ns: "math", integration: htmlChildren, kind: "html-integration",
                textVisible: false, htmlStack: [], annotationXml: !htmlChildren,
              });
            } else {
              foreign.push({
                name: tag.name, ns, integration: false, kind: null,
                textVisible: false, htmlStack: [],
              });
            }
          }
          continue;
        }
      }

      // HTML 上下文（含集成点内部）：`<image>` 是 `<img>` 的历史别名。
      if (!wasForeign && tag.name === "image") tag.name = "img";

      // HTML 上下文（含集成点内部）：`<svg>` / `<math>` 进入外域命名空间。
      if (!wasForeign && FOREIGN_ROOTS.has(tag.name)) {
        if (!tag.selfClosing) {
          foreign.push({
            name: tag.name, ns: tag.name === "math" ? "math" : "svg", integration: false,
            kind: null, textVisible: false, htmlStack: [],
          });
        }
        continue;
      }

      if (tag.name === "template") {
        // template 元素本身属于文档；它的内容不属于。外域/HTML 状态随 template 隔离，
        // 防止 template 内未闭合的 svg 泄漏到 template 之后。
        if (!inTemplate()) elements.push(tag);
        templateForeignStack.push(foreign);
        templateHtmlStack.push(htmlOpenStack);
        foreign = [];
        htmlOpenStack = [];
        templateDepth++;
        continue;
      }
      if (!inTemplate()) elements.push(tag);
      if (tag.name === "plaintext") {
        // plaintext 之后全部是文本，不再有标签（外域/不渲染集成点里不计入可见文本）。
        if (!inTemplate() && textVisibleNow()) textBuf = html.slice(i);
        i = n;
        break;
      }
      if (tag.name === "script") {
        const script = scanScriptData(html, i);
        tag.content = html.slice(i, script.contentEnd);
        i = script.next;
        continue;
      }
      if (RAWTEXT_ELEMENTS.has(tag.name)) {
        const closeAt = findEndTag(html, i, tag.name);
        const contentEnd = closeAt === -1 ? n : closeAt;
        tag.content = html.slice(i, contentEnd);
        // xmp 虽然是 RAWTEXT，但浏览器会把内容按文本渲染；其余 RAWTEXT 不进可见文本。
        if (!inTemplate() && textVisibleNow() && VISIBLE_RAWTEXT.has(tag.name) && tag.content) textParts.push(tag.content);
        i = closeAt === -1 ? n : afterEndTag(html, closeAt);
        continue;
      }
      if (RCDATA_ELEMENTS.has(tag.name)) {
        const closeAt = findEndTag(html, i, tag.name);
        const contentEnd = closeAt === -1 ? n : closeAt;
        tag.content = decodeCharacterReferences(html.slice(i, contentEnd));
        // title 是文档标题，不是「可见文本」；textarea 的内容则属于可见文本。
        if (!inTemplate() && textVisibleNow() && tag.content && tag.name !== "title") textParts.push(tag.content);
        i = closeAt === -1 ? n : afterEndTag(html, closeAt);
        continue;
      }
      // 普通 HTML 元素：记录到 HTML 祖先/集成点 HTML 子元素栈。
      trackHtmlChildStart(tag);
      continue;
    }

    // "<" 后面不是标签起始：当普通文本（外域/不渲染集成点里不进入可见文本）。
    if (textVisibleNow()) textBuf += ch;
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
 *   - `src`：只有会加载资源的元素（img/script/iframe/embed/video/audio/source/
 *     track/input）；`<div src>` 这类非资源属性不探测
 *   - `poster`：仅 `<video>`
 *   - `srcset`：仅 `<img>` / `<source>`，按 WHATWG srcset 解析算法拆出候选 URL
 *   - `data`：仅 `<object>`
 *   - `href`：仅 `<link>`，且排除 rel token 含 canonical 的 link（canonical 是文档关系，不是资源）
 * 不包含 `<a href>`（导航链接不是子资源）、`<base href>`（解析基准）和 `data:` 等内联内容。
 *
 * @returns {{element:string, attr:string, value:string}[]} 按文档与属性顺序
 */
const SRC_RESOURCE_ELEMENTS = new Set([
  "img", "script", "iframe", "embed", "video", "audio", "source", "track", "input",
]);
const SRCSET_RESOURCE_ELEMENTS = new Set(["img", "source"]);

export function resourceReferences(elements) {
  const out = [];
  const push = (el, attr, value) => {
    const v = String(value ?? "").trim();
    if (v) out.push({ element: el.name, attr, value: v });
  };
  for (const el of elements) {
    for (const attr of el.attrs) {
      if (attr.name === "src") {
        const inputIsImage = el.name === "input"
          && String(getAttribute(el, "type").value || "").trim().toLowerCase() === "image";
        if (SRC_RESOURCE_ELEMENTS.has(el.name) && (el.name !== "input" || inputIsImage)) push(el, attr.name, attr.value);
        continue;
      }
      if (attr.name === "poster" && el.name === "video") { push(el, attr.name, attr.value); continue; }
      if (attr.name === "srcset" && SRCSET_RESOURCE_ELEMENTS.has(el.name)) {
        for (const url of parseSrcset(attr.value)) push(el, "srcset", url);
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
