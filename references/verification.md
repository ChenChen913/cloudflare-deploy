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

脚本输出 `pass`、`warn`、`fail`、`skip`。`fail` 是阻断项；`warn` 要读清楚再决定是否接受。

### 2.1 SSR / 全栈的自动基线

```bash
node "<技能目录>/scripts/verify-deployment.mjs" \
  --url "<地址>" --mode "ssr" \
  --api /api/health --expect-json '{"ok":true}' \
  --api /api/items --json
```

`--api` 可重复传；每个接口检查 2xx、`Content-Type` 是否为 JSON，以及（给了 `--expect-json` 时）把预期值和响应体都解析成 JSON 做**子集比较**——字段顺序与格式化空格不影响结论，字段缺失、值不匹配、无效 JSON、非 JSON 响应都会给出具体原因。旧版的「字符串包含」判断已废弃；现在 `--expect-json` 必须是一段合法 JSON。没给 `--api` 却给了 `--expect-json` 会报 `warn`。

`--mode ssr` 下：未知路径 404 判通过，返回 200 只给 `warn`（要确认是自定义 404 还是 catch-all）；另外检查首页服务端渲染的可见文本长度（空壳会 `warn`）和单次 TTFB。**单次 TTFB 不是性能结论**，冷启动会污染它。

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

`OPTIONS` 返回 200/204 **不等于** CORS 通过。脚本始终检查 `ACAO` 是否匹配请求 Origin；`Allow-Methods`、`Allow-Headers`、`Allow-Credentials` 只在你显式提供对应参数时才断言。没提供的检查会写进结果的 `notChecked`，报告里必须写「未验证」，不能合并成「CORS 正常」。

断言按 Fetch 规范实现，不是「看到 `*` 就算通过」：

- `Allow-Methods` / `Allow-Headers` 的 `*` **只在无凭据请求里**是通配符；带 `--cors-credentials` 时它是字面值，必须显式列出方法和请求头。
- `GET` / `HEAD` / `POST` 是 **CORS-safelisted method**，永远允许，不要求出现在 `Allow-Methods` 里；`PUT` / `DELETE` 等才需要显式匹配。
- `Authorization` / `Range` 是 **CORS non-wildcard request-header name**，即使无凭据，`Allow-Headers: *` 也不覆盖。
- HTTP 方法名大小写敏感：浏览器只把已知方法（`DELETE/GET/HEAD/OPTIONS/POST/PUT`）规范化成大写，所以服务器回小写 `delete` 不会匹配 `DELETE`。
- 失败原因会点名具体是哪个响应头不符合要求。

**HTTP 验收不是全栈验收。** 这条命令只证明页面和指定接口能返回；数据库写入、登录会话、第三方回调、真实 Secrets、冷启动仍要人工或专项验证，没测就在报告里写「未验证」。

三个限制必须写进报告：

- 同源资源只查首页引用的前 20 个（`--assets-limit`），不是全站爬取；报告要写 `checked / total`。
- 资源请求用 `redirect: "manual"`：3xx **不算通过**。同主机最多跟随 5 跳并验证最终 2xx；跨主机只记录最终地址、不跟随，判 `warn` 交人工确认；循环、缺 `Location`、最终 4xx/5xx 判 `fail`。`probed[].chain` / `finalUrl` / `finalStatus` 保留完整证据。
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

- `/` 至少 200。
- `static`/`ssg`：未知路径必须 404。返回 200 说明 SPA 回退或 rewrite 把所有路径都吞了。
- `spa`：未知路径应 200 且返回 app shell（含 root 容器或入口脚本）。404 说明深链刷新会断；如果用的是 hash 路由，可以接受。
- `ssr`：未知路径通常 404；返回 200 要人工确认是自定义 404 还是 catch-all 把所有路径渲染成首页。
- Pages 上 `/index.html` 跳 `/`（301/308）是正常的。
- 自定义域名 5xx、但 `pages.dev` 正常，通常是 DNS/证书/zone 配置，不是构建。
- 资源检查只覆盖首页引用的前 N 个。写了“资源正常”就必须说明检查了多少个。
- 资源 301/302/307/308 只是**一跳**，不是结论；要看最终状态。跨主机重定向（CDN、签名 URL）要单独确认，不能默默算正常。

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

多个标签的检测用脚本（`canonical` 检查会数数量并判 `fail`），不要只肉眼看第一条。

- 主站：只有一个 canonical，指向自己。
- 一个页面出现多个 canonical 标签 → 模板重复输出，必须修（脚本会判 `fail`）。
- canonical 指向其他主机 → 如果这是备用站、策略是“指主站”，属预期；否则权重被指向外部。
- canonical 指向另一个路径 → 可能是有意的（分页/聚合），确认后再接受。
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
- 用 `verify-deployment.mjs` 时，「实际方法 / 请求头 / 凭据」必须由 `--cors-method` / `--cors-headers` / `--cors-credentials` 显式提供。没提供就只检查 ACAO 和状态码，结果里的 `notChecked` 会写明哪些没执行——不要替用户推断。

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
- 资源检查要写“检查了 N 个 / 共 M 个”，不能写成“全站资源正常”；发生重定向时要附最终地址与最终状态。
- 写清楚实际测试的 URL。预览地址不是生产地址。
