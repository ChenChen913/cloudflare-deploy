# 验收

验收只回答一件事：**我们实际观察到了什么？** 状态码是证据，部署命令的退出码不是。

## 0. 先定站点模式

所有 404 结论都取决于模式。`check-build.mjs` 和 `verify-deployment.mjs` 必须用同一个 `--mode`，报告里写明用了哪个。

| 模式 | 用在 | 未知路径 | 构建产物 |
|---|---|---|---|
| `static` | 预渲染多页站 | 必须 404 | 通常有顶层 `404.html` |
| `ssg` | Hugo / Jekyll / Astro 生成的静态站 | 必须 404 | 通常有 `404.html` |
| `spa` | 客户端路由 | 200 + app shell | 不要求 `404.html`（Pages 会回退） |
| `ssr` | 服务端渲染 / 全栈 | 通常 404；200 需人工确认 | **不适用**，脚本直接报 `skip` |

同一个站，`static` 判“未知路径返回 200”是失败，`spa` 判“未知路径返回 404”是警告。模式选错，结论就会反。SSR 没有可上传的静态产物目录，不要为了跑 `check-build.mjs` 去建空目录。

## 1. 按项目类型选检查项

| 检查 | 纯静态 | SPA | Jekyll/博客 | 静态 + Supabase | API + 数据库 |
|---|---|---|---|---|---|
| 首页 200 + 标题 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 未知路径 404（`static`/`ssg`） | 必须 | — | 必须 | 按模式 | 按模式 |
| 深链回退（`spa`） | — | 必须 | — | 按模式 | — |
| 同源资源 | 必须 | 必须 | 必须 | 必须 | 必须 |
| SPA 深链 + 刷新 | — | 必须 | — | 必须 | — |
| 旧 `.html` 链接 | — | — | 必须 | — | — |
| `_headers` / `_redirects` 生效 | 用了就查 | 用了就查 | 用了就查 | 用了就查 | 用了就查 |
| API 状态/JSON | — | — | — | 只读 | 必须 |
| CORS + 凭证 | — | — | — | 必须 | 必须 |
| 登录/会话 | — | — | — | 必须 | 必须 |
| 数据库读写 | — | — | — | — | 必须 |
| PWA 安装/离线 | — | 有 PWA 就查 | 有 PWA 就查 | 有 PWA 就查 | — |
| 备用站独立性 | 用户要求就查 | 同左 | 同左 | 同左 | 同左 |
| canonical/noindex | 公开站就查 | 同左 | 同左 | 同左 | 同左 |

纯静态站不要跑数据库测试。项目没有 manifest / service worker，就不要声称验证了 PWA。

## 2. 自动基线

```bash
node "<技能目录>/scripts/verify-deployment.mjs" --url "<地址>" --mode "<static|spa|ssg|ssr>" --json
```

带备用站、CORS 和独立 API 域：

```bash
node "<技能目录>/scripts/verify-deployment.mjs" \
  --url "https://site.example.com" \
  --mode "static" \
  --backup "https://owner.github.io/repo/" \
  --origin "https://app.example.com" \
  --cors-url "https://api.example.com/items" \
  --json
```

脚本输出 `pass`、`warn`、`fail`、`skip`。`fail` 是阻断项；`warn` 要读清楚再决定是否接受。参数写错时脚本以退出码 2 报用法错误，不会输出半截 JSON：`--api` / `--expect-404` / `--backup` / `--cors-url` / `--url` 不是合法 URL、`--timeout` 非正数、`--assets-limit` 非正整数、`--origin` 非法、或给了 CORS 参数却没给 `--origin`。

### 2.1 SSR / 全栈的自动基线

```bash
node "<技能目录>/scripts/verify-deployment.mjs" \
  --url "<地址>" --mode "ssr" \
  --api /api/health --expect-json '{"ok":true}' \
  --api /api/items --json
```

`--api` 可重复传；每个接口检查 2xx、`Content-Type` 是否为 JSON，以及（给了 `--expect-json` 时）把预期值和响应体都解析成 JSON 做**子集比较**——字段顺序与格式化空格不影响结论，字段缺失、值不匹配、无效 JSON、非 JSON 响应都会给出具体原因。旧版的「字符串包含」判断已废弃；现在 `--expect-json` 必须是一段合法 JSON。没给 `--api` 却给了 `--expect-json` 会报 `warn`。

`--mode ssr` 下：未知路径 404 判通过，返回 200 只给 `warn`（要确认是自定义 404 还是 catch-all）；另外检查首页服务端渲染的可见文本长度（空壳会 `warn`；`title`、注释、`script`/`style` 等 RAWTEXT 内容不计入可见文本）和单次 TTFB。**单次 TTFB 不是性能结论**，冷启动会污染它。

CORS 预检要把「实际请求」说清楚，只填你确实会用的项：

```bash
node "<技能目录>/scripts/verify-deployment.mjs" \
  --url "https://site.example.com" --mode "static" \
  --origin "https://app.example.com" \
  --cors-url "https://api.example.com/items" \
  --cors-method POST \
  --cors-headers "content-type,authorization" \
  --cors-credentials --json
```

`OPTIONS` 返回 200/204 **不等于** CORS 通过。脚本始终检查 `ACAO` 是否匹配请求 Origin；`Allow-Methods`、`Allow-Headers`、`Allow-Credentials` 只在你显式提供对应参数时才断言，而且**不会凭空发送** `Access-Control-Request-Method/Headers`。没提供的检查会写进结果的 `notChecked`；没有显式方法/请求头断言的预检最多给 `warn`，不能判通过。`--cors-url` 返回非 2xx（含 3xx 重定向）时 CORS 检查不判通过（脚本不跟随 CORS URL 的重定向，最终响应未验证）。

`--cors-credentials` 是**用户声明的预期请求模式**，不是脚本真的携带了浏览器 Cookie 或身份凭据——脚本只发 GET / HEAD / OPTIONS。简单请求的凭据判定只看这个声明：响应里的 `Access-Control-Allow-Credentials: true` 不能反推请求带凭据，所以「无凭据 + `ACAO: *` + `ACAC: true`」仍然有效；只有显式声明带凭据时，才要求 `ACAO` 精确匹配 Origin 且必须有 `ACAC: true`。预检断言不受影响，仍只按显式提供的参数执行。

断言按 Fetch 规范实现，不是「看到 `*` 就算通过」：

- `Allow-Methods` / `Allow-Headers` 的 `*` **只在无凭据请求里**是通配符；带 `--cors-credentials` 时它是字面值，必须显式列出方法和请求头。
- 简单请求里 `ACAO: *` 只对无凭据请求有效；凭据模式由 `--cors-credentials` 决定，与响应头 `ACAC` 无关。
- `GET` / `HEAD` / `POST` 是 **CORS-safelisted method**，永远允许，不要求出现在 `Allow-Methods` 里；`PUT` / `DELETE` 等才需要显式匹配。
- `Authorization` 是 **CORS non-wildcard request-header name**：即使无凭据，`Allow-Headers: *` 也不覆盖它。`Range` 不是 non-wildcard，可以被 `*` 覆盖。
- HTTP 方法名大小写敏感：浏览器只把已知方法（`DELETE/GET/HEAD/OPTIONS/POST/PUT`）规范化成大写，所以服务器回小写 `delete` 不会匹配 `DELETE`。
- 失败原因会点名具体是哪个响应头不符合要求。

### 2.2 HTML 解析与资源引用边界

脚本的 HTML 识别统一走 `scripts/html-scan.mjs`（显式状态机，零依赖），不是标签正则：

- 只统计 DOM 中真实存在的元素。注释、bogus comment（`<!-->`、`<!DOCTYPE>`、`<?...>`、CDATA）、RAWTEXT（`script` / `style` / `xmp` / `iframe` / `noembed` / `noframes` / `noscript`）、RCDATA（`title` / `textarea`）、`template` 惰性内容、SVG/MathML 外部内容（`foreignObject` 内部恢复 HTML）、属性值和畸形/未闭合标签里的伪标签都不算。
- 属性支持单/双引号、无引号、属性值里的 `>`、重复属性（第一个生效）和字符引用（`&amp;`、数字引用等，含缺分号的数字引用与 C1 字符的 windows-1252 映射）；标签名/属性名 ASCII 大小写归一。
- 相对 URL 按 `<base href>`（第一个带 href 的 base）解析；没有 base 时按**文档 URL**解析（与浏览器一致，例如最终页面 `/sub` 里的 `app.js` 解析为 `/app.js`，不会强行补成 `/sub/app.js`）。根路径有同源重定向时，404 / API / CORS / `/index.html` / 资源 / canonical 都基于**最终页面 URL**。
- 资源引用只取真实元素上的子资源属性：`src`、`srcset`、`poster`、`<object data>`、`<link href>`。`srcset` 按「逗号 + 空白」拆候选（URL 里的逗号不误拆）；`<a href>` 导航链接、canonical、`<base>` 不是资源；跨源 / 畸形引用只记进 `ignored`，不发请求。
- `probed[].finalUrl` 只表示最后真正请求过的地址；没跟随的目标在 `redirectTarget`，超过跳数在 `limitReached`。不要再把 `finalUrl` 当成「期望跟随到的目标」。
- 只有最终 200 的首页才做 title/canonical/资源/可见文本检查；4xx/5xx 错误页的内容不作为站点证据。

**HTTP 验收不是全栈验收。** 这条命令只证明页面和指定接口能返回；数据库写入、登录会话、第三方回调、真实 Secrets、冷启动仍要人工或专项验证，没测就在报告里写「未验证」。

三个限制必须写进报告：

- 同源资源只查首页引用的前 20 个（`--assets-limit`），不是全站爬取；报告要写 `checked / total`。
- 主站、资源和 `--backup` 请求都用 `redirect: "manual"`，且**只自动跟随同源重定向**（同源 = 协议 + 主机 + 端口，见 `scripts/redirect-policy.mjs`）。三者共用 `MAX_REDIRECTS=5`：**最多跟随 5 次重定向，并额外请求一次第 5 次重定向指向的最终地址**（共最多 6 次请求）；如果最终地址仍返回 3xx，也就是第 6 次重定向，判「超出跳数 / 循环」，不请求它的目标，主站结果的 `limitHop` 保留未跟随那一跳的状态码与 Location（资源探针的未跟随跳保留在 `chain` 里）。跨源、协议变化（HTTP ↔ HTTPS）、非 HTTP(S) 协议、Location 缺失/含 userinfo/无法解析都不请求目标，只记录 Location / 状态码 / 重定向链，避免把验收请求带去 `127.0.0.1`、内网地址或云厂商元数据端点；跨源恰好发生在跳数边界时仍优先按跨源分类。主站结果的 `redirectOutcome` 区分：同源验证成功、跨源目标未验证、循环或超跳数、Location 无法解析、协议不受支持、`not-modified`（304）、`unexpected-3xx`（少见 3xx）；跨源时是 `warn` 且 `verified: false`，别的网站返回 200 不会给原始站点判 pass。根路径有同源重定向时，后续 404 / API / CORS / `/index.html` / 资源 / canonical 都按**最终页面 URL** 解析。**5 次重定向后最终 404 是 `same-origin-final-failed`，不是跳数超限。**
- **3xx 不等于重定向。** 只有 `301 / 302 / 303 / 307 / 308` 需要读取 Location 并继续请求；`304 Not Modified` 是缓存协商结果（`statusClass: "not-modified"`），不进入重定向链，也不会因为缺少 Location 被报成「无效重定向」。其他 3xx（`300`、`305` 等，`statusClass: "unexpected-3xx"`）既不跟随也不能当成功。主站链、资源探针和 `/index.html` 检查共用同一分类规则（`scripts/redirect-policy.mjs` 的 `classifyStatus()`），结果里的跳记录都带 `statusClass`。
- 资源 3xx **不算通过**：同源按上述同一跳数语义跟随并验证最终 2xx；跨主机只记录最终地址、不跟随，判 `warn` 交人工确认；循环、缺 `Location`、非 HTTP(S) 目标、最终 4xx/5xx 判 `fail`。只要收到带有效 Location 的 3xx 就记进 `redirects`（不再用链长度推断），`probed` / `warnings` / `redirects` 都保留原始地址、最终地址、最终状态、跨主机标记与完整链。**304 不是重定向，也不代表资源可用**：不进入 `redirects`，判 `fail`；少见 3xx 判 `warn` 且不进 `redirects`，需要人工确认。资源只从真实元素的子资源属性（`src` / `srcset` / `poster` / `<object data>` / `<link href>`）收集；导航链接、canonical、`<base>` 不算资源。相对地址按 `<base href>`（没有则最终站点根）解析；跨源 / 畸形引用（包括用反斜杠伪装成相对地址的跨源 URL）解析后只记进 `ignored`，不请求目标。`probed[].finalUrl` 只表示最后真正请求过的地址，未跟随目标在 `redirectTarget`，超限在 `limitReached`。
- CORS 检查默认查 `--url` 首页；API 在别的子域时必须用 `--cors-url`，否则“首页没有 CORS 头”会被误读成接口有问题。

## 3. 脚本做不到的人工检查

### 3.1 SPA 深链

新标签页直接打开子路由，刷新，再用浏览器前进/后退。不能只看地址栏，要确认标题和主内容都变了。

### 3.2 Service Worker / PWA

用全新配置或无痕窗口：

1. 首次访问：SW 注册；
2. 刷新：页面受 SW 控制；
3. 跳到子页：没有变成首页；
4. 断网：有合理的离线页；
5. 发新版本：旧缓存没有一直生效。

### 3.3 登录与 Cookie

- 登录、刷新、退出、再刷新；
- 未登录访问受保护页面；
- 检查 `Domain`、`Path`、`SameSite`、`Secure`；
- 跨站 Cookie 需要 `SameSite=None; Secure`，并且要接受浏览器对第三方 Cookie 的限制。

### 3.4 API

- 状态码、Content-Type、JSON 结构；
- 超时和错误响应；
- 旧客户端兼容；
- CORS 预检（`OPTIONS`）和带凭证请求；
- 响应体里没有密钥。

### 3.5 SSR / 全栈专项

- 服务端渲染的 HTML 里是否已有真实数据（不是空壳靠客户端补）；
- 至少一次真实的数据库读 + 写（获批准后），核对行数 / ID / 时间戳；
- 登录 → 刷新 → 退出 → 再刷新，以及未登录访问受保护路由；
- 第三方回调、邮件、队列消费是否到达；
- 冷启动与并发下的表现（多次采样取中位数）；
- `wrangler dev` 本地跑通不算线上证据：本地没有体积上限、真实 TLS/TCP 限制、冷启动，也能连 `127.0.0.1` 的数据库。

## 4. 怎么读 HTTP 证据

### 状态码

- `/` 至少 200；只有最终 200 才做内容检查（4xx/5xx 错误页的 title/canonical 不作为站点证据）。
- `static`/`ssg`：未知路径必须 404。返回 200 说明 SPA 回退或 rewrite 把所有路径都吞了。
- `spa`：未知路径应 200 且返回 app shell（含 root 容器或入口脚本）。404 说明深链刷新会断；如果用的是 hash 路由，可以接受。
- `ssr`：未知路径通常 404；返回 200 要人工确认是自定义 404 还是 catch-all 把所有路径渲染成首页。
- Pages 上 `/index.html` 跳 `/`（301/308）是正常的。脚本只把**同源且目标就是站点根**的重定向判 `pass`（结果带 `convergesToRoot`）；跨源、非 HTTP(S)、其他路径只给 `warn`，不请求目标，也不证明收敛到 `/`；`/index.html` 返回 5xx 判 `fail`。
- 自定义域名 5xx、但 `pages.dev` 正常，通常是 DNS/证书/zone 配置，不是构建。
- 资源检查只覆盖首页引用的前 N 个。写了“资源正常”就必须说明检查了多少个。
- 资源 301/302/307/308 只是**一跳**，不是结论；要看最终状态。跨主机重定向（CDN、签名 URL）要单独确认，不能默默算正常；脚本不会为了确认而自动请求跨源目标。
- `304 Not Modified` 不是重定向：脚本没有发送条件请求，`/` 返回 304 不能当作首页可用；`/index.html` 返回 304 也不能证明收敛到 `/`；资源返回 304 判 `fail` 且不进入 `redirects`。
- 少见 3xx（如 `300 Multiple Choices`）既不跟随也不判通过：主站/资源/`/index.html` 都单独分类（`unexpected-3xx`），按警告处理并交人工确认。
- 首页 `redirectOutcome` 为 `cross-origin-unverified` 时写「主站跨源重定向，目标未验证」，`warn` 不等于通过，也不能写成「首页 200」。

### 响应头

```bash
curl -sI https://site.example.com/ | grep -iE 'server|cache-control|x-robots-tag|strict-transport|x-frame|content-security|referrer'
```

- `Server: cloudflare` 说明请求到了 Cloudflare。
- 有自定义域名时，`pages.dev` 上的 `X-Robots-Tag: noindex` 是预期。
- 缺安全头是警告，不是部署失败。
- `Cache-Control: max-age=0, must-revalidate` 是 Pages 默认；非哈希资源配长缓存是 bug。

### Canonical

```bash
curl -s https://site.example.com/ | grep -io '<link[^>]*canonical[^>]*>'
```

多个标签的检测用脚本（`canonical` 检查会数数量并判 `fail`），不要只肉眼看第一条。脚本用共享 HTML tokenizer 只统计 DOM 中真实存在的 `<link rel="canonical">`：注释、bogus comment、RAWTEXT（`script`/`style`/`xmp`/`iframe`/`noembed`/`noframes`）、RCDATA（`title`/`textarea`）、`template` 惰性内容、属性值和畸形标签里的伪标签都不计入；`rel` 按 HTML 空白分隔 token 精确匹配（`canonicalized` 以及 `data-rel` / `aria-rel` 都不算）。

- 主站：只有一个 canonical，指向自己。**指向自己要求协议、主机、规范化路径三者全部一致**；只比 host + pathname 会把 `https` 页面上的 `http` canonical 误判成 self-canonical。脚本在 `canonical` 检查结果里给出 `sameProtocol` / `sameHost` / `samePath`。
- `href` 缺失、`href=""`、`href` 无法解析分别判 `fail`，结果带 `hrefState`（`missing` / `empty` / `invalid`）；**不会**把空值交给 `new URL("", base)` 解析成当前站点再误判成指向自身。属性值支持单/双引号、无引号、属性值里的 `>` 和字符引用（`&amp;` 等）；相对 canonical 按 `<base href>`（第一个带 href 的 base）或最终页面 URL 解析。
- 一个页面出现多个 canonical 标签 → 模板重复输出，必须修（脚本会判 `fail`）。
- canonical 指向其他主机 → 如果这是备用站、策略是“指主站”，属预期；否则权重被指向外部。
- canonical 指向另一个路径 → 可能是有意的（分页/聚合），确认后再接受。
- 主机和路径都相同但**协议不同**（如 `https://example.com/` 的 canonical 写成 `http://example.com/`）→ 脚本判 `warn` 并在 detail 里点名协议不一致，不能当作通过；统一到站点的实际协议。
- 备用站：要么 `noindex`，要么 canonical 指主站，不能同时。
- 两个 self-canonical 主机 = 两个规范地址。改策略，不是改标签。

Search Console 的“网址检查”才能看到 Google 实际选择的 canonical。没人检查之前，标为未验证。

### CORS

```bash
# 简单请求
curl -sI -H 'Origin: https://app.example.com' https://site.example.com/data.json \
  | grep -iE 'access-control-|vary'

# ACAO 值数量，必须是 1
curl -sI -H 'Origin: https://app.example.com' https://site.example.com/data.json \
  | grep -ci '^access-control-allow-origin:'

# 预检
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  https://api.example.com/items
```

`curl` 只显示头，不执行浏览器的 CORS 判定。最终以 DevTools → Network 的失败请求和 Console 报错为准。

如果前端和 API 不同源（`app.example.com` 调 `api.example.com`），请求必须打到 **API 地址**，不是首页：`verify-deployment.mjs --cors-url https://api.example.com/items`。查首页只能得到“首页没有 CORS 头”，会被误读成接口坏了。

判定要点：

- `ACAO` 必须等于请求的 `Origin`，或（仅无凭据时）是 `*`；值不匹配等于没配。
- 带 Cookie / 凭据时 `ACAO` 不能是 `*`，且需要 `Access-Control-Allow-Credentials: true`；`Allow-Methods` / `Allow-Headers` 的 `*` 也不再是通配符，必须显式列出。
- `GET` / `HEAD` / `POST` 是 CORS-safelisted method，不要求出现在 `Allow-Methods`；其他方法必须显式匹配，且大小写敏感。
- `Authorization` / `Range` 是 CORS non-wildcard request-header name，`Allow-Headers: *` 永远不覆盖，必须显式列出。
- 出现多个 `ACAO` 值（逗号连接）时浏览器判为无效。
- 缺 `Vary: Origin` 时，CDN 可能把给 A 站的响应缓存给 B 站。
- 预检还要看 `Access-Control-Allow-Methods` 是否含实际请求方法、`Access-Control-Allow-Headers` 是否含实际请求头；`OPTIONS` 的 2xx 只是必要条件。
- 用 `verify-deployment.mjs` 时，「实际方法 / 请求头 / 凭据」必须由 `--cors-method` / `--cors-headers` / `--cors-credentials` 显式提供。没提供就只检查 ACAO 和状态码，结果里的 `notChecked` 会写明哪些没执行——不要替用户推断。`--cors-credentials` 只是声明预期的请求模式，不能写成「脚本已带 Cookie 验证过」。

### DNS

```bash
dig +short example.com A
dig +short example.com NS
dig @1.1.1.1 +short example.com
dig @8.8.8.8 +short example.com
```

PowerShell：

```powershell
Resolve-DnsName example.com -Type A
Resolve-DnsName example.com -Type NS
```

证书：

```bash
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

### 备用站

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://owner.github.io/repo/
curl -sIL https://owner.github.io/repo/ | grep -i '^location' || echo "no redirect"
curl -sI https://owner.github.io/repo/ | grep -i '^server'
```

期望 `200`、没有指向主站的 `Location`、`Server: GitHub.com`。301 到自定义域名 = 备用站不独立。

### 数据

先比数量，再比指纹，再抽样：

```sql
SELECT COUNT(*) FROM users;
SELECT COUNT(*), SUM(LENGTH(COALESCE(name,''))) FROM users;
SELECT id, name, email, created_at FROM users ORDER BY id LIMIT 20 OFFSET 1000;
```

然后写一次：插入 → 读 → 更新 → 删除。检查自增 ID、唯一索引、时间戳/时区、布尔值、`NULL` 与空字符串。

### 性能

```bash
for i in 1 2 3 4 5; do
  curl --noproxy '*' -s -o /dev/null -w '%{time_starttransfer}\n' https://site.example.com/
done | sort -n | sed -n '3p'
```

记录 TTFB 中位数、LCP、首屏请求数、总传输。比较时同一网络、同一时段、同一视口。单次 Lighthouse 分数不是对比。

### 部署链路

```bash
gh run list --workflow=deploy.yml --limit 5
gh api repos/{owner}/{repo}/actions/workflows --jq '.workflows[] | {name, state}'
git log -1 --format='commit: %cI'
```

- 最近一次成功部署的时间必须 ≥ 最近一次内容提交。
- `state` 必须是 `active`；`disabled_inactivity` 表示公开仓库 60 天无活动后定时工作流被禁用。
- 定时任务要覆盖安装 + 构建，不能只 ping URL。

## 5. 报告规则

- 每项写 `通过`、`失败`、`警告` 或 `未验证`。
- 写明用了哪个 `--mode`；换模式会改变 404 的结论。
- `未验证` 要写原因（没账号、没数据库权限、用户拒绝、超出范围）。
- 只看了响应头，不能写“CORS 正常”。
- 只看了 DNS，不能写“备用站正常”。
- 资源检查要写“检查了 N 个 / 共 M 个”，不能写成“全站资源正常”；发生重定向时要附原始地址、最终地址、最终状态、跨主机标记和重定向链，跨源目标一律写「目标未验证」。
- 写清楚实际测试的 URL。预览地址不是生产地址。
