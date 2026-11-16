# 测试结果

## 环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11（win32），PowerShell 7 / cmd |
| Node.js | v24.18.1 |
| Python | 3.13.3（只用于外部格式校验；Windows 默认 GBK 区域设置下需 `python -X utf8`，否则 UTF-8 的 SKILL.md 会报 `UnicodeDecodeError`） |
| git / gh | 可用 |
| wrangler | 未安装 |
| dig | 不可用（Windows 默认没有） |
| Cloudflare 账号 / Token | 本环境没有 |
| 本地 HTTPS 验收夹具 | `tests/fixtures/loopback-tls.mjs` 自签回环证书（仅用于 canonical 协议矩阵，子进程经 `NODE_EXTRA_CA_CERTS` 信任，TLS 校验保持开启） |
| 浏览器（可选差分） | Chrome 157.0.8103.52 / Edge 157.0.4341.46 headless，经 CDP `Runtime.evaluate` 取真实 DOM；仅用于录制/复核 `tests/fixtures/html5-oracle.json` 与可选 `tests/browser-diff.mjs`，默认套件不依赖浏览器 |

## 怎么复现

```bash
node tests/run-tests.mjs     # 742 项，分层覆盖 core 298 / adversarial 276 / boundary 43 / combination 5 / unit 120：识别、套餐与产物、HTML tokenizer、真实 HTTP 验收、CORS、重定向与 SSRF、canonical、3xx、CLI、JSON、链路探针
node tests/check-skill.mjs   # 结构自检，零外部依赖
```

每次运行会在 `tests/.work/<时间戳>/` 下生成夹具，运行完不删除（该目录已 gitignore），避免与本机的安全删除钩子冲突。

链路探针的测试会真的发起多次**未认证**请求到 `https://api.cloudflare.com`（每个 probe 用例一次，不涉及账号、不读 Token）；离线环境仍能跑，只是该 `network` 检查会 `fail`，后续断言不依赖它。

外部格式校验（可选）：WorkBuddy 内置 `skill-creator` 技能里的 `quick_validate.py`。本机这份是 2,229 字节、2026-10-27 的版本，用 Python 3.13.3 执行：

```bash
python -X utf8 <skill-creator>/scripts/quick_validate.py <技能目录>
```

这个脚本不在本仓库里，路径随安装位置变化；换台机器不一定有。在 Windows 默认 GBK 区域设置下必须加 `-X utf8`（脚本用 `Path.read_text()` 按本地编码读 UTF-8 的 `SKILL.md`，会报 `UnicodeDecodeError`），这不是技能本身的问题。所以仓库另带 `tests/check-skill.mjs`，覆盖 frontmatter、name/description 长度、引用路径、绝对路径残留、文件名 ASCII、空目录，**任何人都能复现**。

## 结果

```text
node tests/run-tests.mjs     742/742 通过（分层：core 298 / adversarial 276 / boundary 43 / combination 5 / unit 120）
node tests/check-skill.mjs   通过（SKILL.md 335 行，引用路径 32 个，无绝对路径）
node tests/browser-diff.mjs  115/115 一致（可选开发期：本机 Chrome 157 与本机 Edge 157 分别跑过；无浏览器/Node<22 退出码 2 跳过，不一致退出码 1，180s 超时退出码 3）
quick_validate.py            Skill is valid!（本机一次性结果；脚本在仓库外，见上文可复现性说明）
```

完整输出由测试脚本自动写入 `tests/last-run.txt`（每次 `node tests/run-tests.mjs` 覆盖，报告不再依赖人工复制）。

## 覆盖范围

| # | 合成项目 | 识别结果（实际） | 目标输出 | 验证点 |
|---|---|---|---|---|
| 1 | Vite + React SPA，`base: /repo/`，已有 Pages workflow | `vite/spa`，`dist`，`base=/repo/`；无路由证据时 `spaRouting=unknown` | `candidates=[pages,workers]`，`suggested=null`，`suggestedMode=unknown` | 不再凭框架直接定 Pages，也不默认推荐 spa；要求人工确认路由 |
| 2 | Jekyll 博客，`CNAME=www.example.com` | `jekyll/static`，`_site` | 两者皆可 | 双构建场景仍给候选 |
| 3 | Vite + Supabase，`.env.example` | `vite/spa`，键名识别，无 CF 后端 | 两者皆可 | 不假设要迁后端 |
| 4 | Hono + `wrangler.toml`（`main` + `assets` + D1） | `hono/api`，`./public` | `workers`，`confidence=high` | 依据写进 `target.basis` |
| 5 | Express + sharp + puppeteer + better-sqlite3 + `fs` + `setInterval` | `express/api` | `assess` | 硬阻断，拒绝硬迁 |
| 6 | Next.js SSR | `nextjs/ssr`，`.next` | `workers` | 静态资源风险提示 |
| 7 | pnpm monorepo，`apps/web` + `apps/api` | `monorepo=true`，2 个子应用 | 候选 | 风险里点名两个子包 |
| 8 | 同时有 `pnpm-lock.yaml` 和 `package-lock.json` | 2 个锁文件 | 包管理器降为 `inferred` | 不把推测当确认 |
| 9 | 动态 Vite 配置（函数 + `loadEnv`） | `basePath` 标 `unknown` | 候选 | 风险提示构建后核对产物 |
| 10 | 两个 `index.html`（site / docs） | 2 个入口，框架 unknown | `undetermined` | 要求确认站点根，不猜 |
| 11 | 有 `functions/` 的静态站 | `vite/spa`，`functionsDir=true` | `pages`，`medium` | 已按 Pages Functions 组织，不因“全栈”改推 Workers |
| 12 | Next.js + Prisma + Drizzle + Neon HTTP | `nextjs/ssr`，`suggestedMode=ssr` | `workers` | 运行时依赖只标「待核对」、Neon HTTP 交互式事务提示，不把待核对写成不可行 |
| 13 | 只有 `wrangler.jsonc`（JSON 键值 + 注释）的 Workers 静态资源站 | `assets.directory=./public`，`name` / `compatibility_date` 可读，无 `main` | `workers`，`high` | JSONC 字段解析；显式 Wrangler 输出目录优先且证据为 `confirmed`；不误报「输出目录未知」 |
| 14 | Vite 配置里注释掉 `base` / `outDir`，workflow 里只有注释掉的 Pages action | `base=/real/`，`dist-real`，`githubPages.configured=false` | 候选 | 注释不生效；YAML 注释不误判 Pages |
| 15 | Next 配置注释掉 `output: "export"` | `nextjs/ssr` | `workers` | 注释不改变 SSR 判定 |
| 16 | wrangler.jsonc 注释里放错误的 name/directory/main，另有真实 `assets.directory` | `name=real-wrangler`，`./public`，`hasMain=false` | `workers` | JSONC 注释不生效；顶层字段结构化读取（不被 DO binding 的 name 抢） |
| 17 | wrangler.toml 注释掉 name/main | `name=real-toml`，`hasMain=false`，`[assets] directory=./public` | `workers` | TOML 注释剥离 + section-aware 读取 |
| 18 | `scripts.start = "node --inspect src/index.js"` | `serverEntry=src/index.js` | — | 启动参数不被当成入口 |
| 19 | Nuxt 配置 `ssr:false`（注释里有 `ssr:true`） | `nuxt/static` | 静态/Workers | 注释噪声 + ssr:false 判定 |
| 20 | 无 package.json，只有 `public/index.html` | `static-html`，`outputDir=public` | 静态 | public 目录也参与 HTML 入口发现 |
| 21 | Vite + `HashRouter` | `vite/spa`，`spaRouting=hash` | `suggestedMode=static` | HashRouter 未知路径 404 正常，提示补 404.html；不误套 spa |
| 22 | Vite + `BrowserRouter` | `vite/spa`，`spaRouting=history` | `suggestedMode=spa` | history 路由需要显式 fallback；提示 _redirects/not_found_handling |
| 23 | Vue/webpack 风格 history（HTML 在 public/，无根 index） | `static`，`spaRouting=history` | `suggestedMode=spa` | 路由识别不能只看 kind=spa |
| 24 | Vue Router 3 默认 hash | `static-html`，`spaRouting=hash` | `suggestedMode=static` | 无显式 history 时按 Vue Router 3 默认 hash |
| 25 | HashRouter 在深层 `src/pages/...` | `spaRouting=hash` | `suggestedMode=static` | 路由扫描深度覆盖嵌套源码 |
| 26 | 字符串/注释里只出现 "HashRouter" | `spaRouting=unknown` | `suggestedMode=unknown`（要求人工确认） | 字符串字面量和注释不产生确定性推荐 |
| 27 | 真实 HashRouter + 字符串里的 BrowserRouter | `spaRouting=hash` | `suggestedMode=static` | 字符串噪声不推翻真实路由 |
| 28 | Vue Router 3 显式 `mode:"history"` | `spaRouting=history` | `suggestedMode=spa` | 显式 history 不被 Vue3 默认 hash 覆盖 |
| 29 | 源码 HashRouter + `dist-web/` 里陈旧 BrowserRouter/长驻代码 | `spaRouting=hash` | `suggestedMode=static` | 构建产物目录不进入源码路由/长驻扫描 |
| 30 | 同时存在真实 HashRouter 与 BrowserRouter | `spaRouting=mixed` | `suggestedMode=unknown` | 证据冲突时不给确定性模式，要求人工确认 |

### 构建产物

| 产物 | 断言 |
|---|---|
| 完整产物（index + 404 + `_headers` + 坏资源） | 通过但有警告；报告实际检查的资源数；`_headers` 判 `pass`、缺 `_redirects` 判 `skip` |
| 资源引用大小写 / 路径逃逸 | `/Assets/App.css` 与 `../outside.html` 判 `warn`（CDN 区分大小写），`assets/app.css` 能解析 |
| 注释 / script / textarea 里的伪资源引用 | 不参与检查，只统计真实引用（checked=1） |
| 资源引用边界（目录式 URL / 无引号 / srcset / 前后空白 / `%2F` / 导航链接 / canonical） | 目录式 URL 按 `index.html` 找到；无引号与前后空白正确解析；`%2F` 不当作路径分隔符（判坏）；`<a href>` 与 canonical 不算资源 |
| 超过 40 条资源引用 | 只检查前 40 条，detail/JSON 写明 `checked=40 / total=45 / limited=true` |
| 通过 symlink/junction 安装 | 主模块守卫用 realpath 比较，仍真正执行并输出 JSON（不再静默 exit 0） |
| `index.html` 是目录 | 不崩溃、输出 JSON，`index` 检查判 `warn` |
| 无 `404.html` | `static` 警告；`spa` 通过；`--spa` 与 `--mode spa` 等价 |
| 60+ 文件的嵌套产物 | 递归统计 62 个文件；`assets/css/site.css` 能解析 |
| 无 `--dir` + `--mode ssr` | 退出码 0，明确报 `skip`；不假装检查过产物 |
| 套餐边界（纯函数 + CLI） | 默认 Free 20,000；Pages Paid 条件齐全按 100,000、缺 `PAGES_WRANGLER_MAJOR_VERSION=4` / Wrangler v3 不放宽；Workers Paid 在 4.34.0 按 100,000、4.33.0 / 4.9.0 / 只给主版本 `4` 不放宽；Workers Free 仍 20,000；目标未知不放宽；20,001 个文件在 Free 判失败、在 Paid 判通过 |
| 版本号解析与完整比较 | `^4.34.0` 可解析；`4.x` / `abc` / 空串 / 预发布标签一律无法确认；`4.9.0 < 4.34.0`，`4.34 == 4.34.0`，`5.0 > 4.34.0` |
| 从 CI 环境变量 / 项目 `package.json` 取 Wrangler 版本 | 证据可自动读到，无需显式参数；`^4.3.0` 满足 Pages 但不满足 Workers 的 4.34.0 门槛 |
| 非法 `--plan` / `--target` 值、非法版本号 | 非法套餐/目标退出码 2；非法版本号退回 Free 20,000 并说明原因 |

### HTTP 验收（真实服务器，不是 mock）

| 场景 | 结果 |
|---|---|
| 静态站 + `static` | 首页/404/canonical/资源全部通过，退出码 0 |
| 同一个静态站 + `spa` | 深链 404 → `warn`（不误判为失败） |
| SPA 服务器 + `spa` | 未知路径 200 + app shell → 通过 |
| SPA 服务器 + `static` | 未知路径 200 → `fail`，退出码 1（这就是原来的冲突点） |
| HEAD 返回 405、GET 返回 200 | 自动用 GET 复核，资源判通过并记录 `method=GET` |
| `--assets-limit 1` | 报告 `checked=1 / total=2 / limited=true` |
| CORS 在独立端口（模拟独立子域） | `--cors-url` 指向 API，显式提供方法/请求头后简单请求与预检都通过 |
| 重复 `Access-Control-Allow-Origin` | 判 `fail` |
| ACAO 与请求来源不匹配 | 判 `fail`（浏览器会拒绝） |
| 重复 canonical 标签 | 判 `fail` |
| 备用站 301 到主站 | 判 `fail` |
| 站点挂在 `/repo/` 子路径 | 未知路径、`index.html`、相对资源都按 `/repo/` 解析，检查通过 |
| SSR 服务器 + `--mode ssr` | 未知路径 404 通过；服务端渲染可见文本通过（`title`、注释、script/style 不计入可见文本）；记录单次 TTFB |
| SSR + `--api /api/health --expect-json` | 2xx + JSON + 内容匹配 → 通过 |
| SSR + `--api /api/broken`（text/plain） | 非 JSON → `fail`，退出码 1 |
| SSR + `--expect-json` 内容不匹配 | → `fail`，退出码 1 |
| `--expect-json` 未配 `--api` | → `warn` |
| SPA 服务器 + `--mode ssr` | 未知路径 200 → 只 `warn`，不判失败 |
| CORS 预检矩阵（10 例） | 允许 Origin + 方法/头/凭据齐全 → `pass`；拒绝 Origin、缺 Allow-Methods、缺实际方法、缺 Allow-Headers、缺实际请求头、缺 ACAC、`*` 配凭据、204 但无 ACAO → `fail`；未提供方法/请求头时不发送 ACRM/ACRH、3 项列入 `notChecked`、结果最多 `warn` |
| CORS 通配符 / 凭据 / 安全列表方法（12 例） | 无凭据 + `Allow-Methods: *` → `pass`；带凭据 + `*` → `fail`（`*` 是字面方法名）；无凭据 + `Allow-Headers: *` 覆盖 `content-type` 但不覆盖 `Authorization` → 后者 `fail`；带凭据显式方法与头 → `pass`；`GET/HEAD/POST` 缺 Allow-Methods 仍 `pass`；`put` 规范化为 `PUT` 后匹配；服务器回小写 `delete` 与 `DELETE` 不匹配 → `fail`；带凭据 + `ACAO: *` 的简单请求 → `fail`，无凭据 → `pass` |
| 资源重定向矩阵（9 例） | 直接 200 → `pass`（chain 1 跳、`finalStatus=200`）；301 同主机跟随到 200 → `pass` 并记录 `redirects`；302 后 404 / 直接 404 / 缺 `Location` / 循环超过 5 跳 / 非 HTTP(S) 目标 → `fail`；跨主机 → `warn` 且记录 `finalUrl` 与 `crossHost`；HEAD 405 → GET 复核仍 `pass` |
| CORS 简单请求凭据矩阵（6 例） | 无凭据 + `ACAO=*` + 有/无 `ACAC` → `pass`；带凭据 + `ACAO=*` → `fail`；带凭据 + 精确 ACAO + `ACAC=true` → `pass`；带凭据 + 精确 ACAO + 缺 ACAC → `fail`；结果带 `credentialsMode`，声明只来自用户 |
| 资源汇总一致性（5 例） | 直接 200 不进 `redirects`；同主机 301 进 `redirects`；跨主机 302 同时进 `redirects` 与 `warnings`，`probed` / `warnings` / `redirects` 三处字段一致；循环进失败记录且仍记为发生过重定向；缺 Location 进失败记录且不进 `redirects` |
| 重定向策略纯函数（8 例） | 相对 Location 同源可跟随；HTTP→HTTPS、HTTPS→HTTP 判跨源并标 `protocolChanged`；端口 / 主机 / `127.0.0.1` 变化判跨源；非 HTTP(S) 协议直接拒绝；空 / 无法解析 Location；始终约束到起始源 |
| 主站重定向矩阵（10 例） | 同源 301→200 → `pass` + `same-origin-verified`；同源 302→404 → `fail` + `same-origin-final-failed`；跨主机 / `127.0.0.1` / HTTP→HTTPS 都 `warn` + `cross-origin-unverified` 且目标服务器零请求；循环 / 无效 Location / 非 HTTP(S) / userinfo Location 各自单独分类；跨主机目标未被请求，不能据此判 `pass` |
| 备用站跳主站（2 例） | 只解析 `hops[].location` 识别跳主站并判 `fail`；跨源目标服务器全程未收到 landing 请求 |
| 主站 / 备用站跳数边界（7 例） | 连续 5 次同源重定向 → 最终 200 判 `pass` + `same-origin-verified`，链 6 跳、服务器收到 6 个链跳请求；最终 404 判 `fail` + `same-origin-final-failed`（不是超限）；第 6 次重定向判 `loop-or-limit`，`limitHop.followed=false`，第 7 个地址零请求；5 次同源后跨源仍 `warn` 且跨源目标零请求；原有循环用例恰好 6 次请求；`--backup` 的 5 次 → 200 判 `pass`、6 次判超限 |
| canonical 协议矩阵（5 例，真实本地 HTTPS 站点） | HTTPS + HTTPS 自身 canonical → `pass`（`sameProtocol/sameHost/samePath` 全 true）；HTTPS + HTTP canonical → `warn` 且 detail 点名「协议不一致」；其他主机 / 其他路径 → 原有 `warn`；多个标签 → 原有 `fail`。全部执行脚本并断言 JSON，不是读代码或匹配文案 |
| canonical href 形态矩阵（6 例，真实本地 HTTP 站点） | 缺少 href → `fail` + `hrefState=missing` + `href=null`；`href=""` → `fail` + `hrefState=empty`；`href="http://"` → `fail` + `hrefState=invalid`；三者都不判指向自身、`sameHost`/`samePath` 不出现。单引号 / 双引号 / 不带引号的合法 href → `pass` + `hrefState=valid` + 三项比较全 true。每个页面由本地服务器真实返回 HTML，断言的是验收脚本输出的 JSON |
| canonical rel 识别矩阵（11 例，真实本地 HTTP 站点） | 真 `<link rel=canonical>`（双引号 / 单引号 / 无引号、href 在 rel 前、`rel="alternate canonical"` 多 token）→ `pass`；`data-rel` / `aria-rel` / `rel="canonicalized"` / 注释中的标签 / `<script>` 字符串里的标签 → `skip`（没有 canonical 标签）；真正的 canonical + 注释中的 canonical → 仍 `pass`，不误判为重复标签。全部执行验收脚本并断言 JSON |
| 3xx 状态分类矩阵：主站（7 例） | 304 → `fail` + `redirectOutcome=not-modified` + `statusClass=not-modified`，hops 只有 1 跳，不报缺少 Location；300 → `warn` + `redirectOutcome=unexpected-3xx`，不判通过；301/302/303/307/308 → 同源跟随到最终 200，`pass` + `same-origin-verified`，首跳 `statusClass=redirect`。全部真实请求本地服务器并断言 JSON |
| 3xx 状态分类矩阵：资源（4 例） | 304 → `assets` 判 `fail`，`redirected=false`，`finalStatus=304`，不进 `redirects`，broken 记录里不出现「缺少 Location」；307 / 308 同主机跟随到最终 200 → `pass` 且进 `redirects`；300 → 只 `warn`、进 `warnings`、不进 `redirects`、不判正常 |
| 3xx 状态分类矩阵：`/index.html`（7 例） | 304 / 300 → 只 `warn`，`statusClass` 分别为 `not-modified` / `unexpected-3xx`，`redirect=false`，不报缺少 Location；301/302/303/307/308 → `pass` + `statusClass=redirect` + `redirect=true` + `redirectKind=same-origin` + `convergesToRoot=true`，`httpStatus` 等于实际状态码 |
| `/index.html` 目标不是站点根（4 例） | 跨源 `https://other.example/` → `warn` + `redirectKind=cross-origin`；`file:///etc/passwd` → `warn` + `unsupported-protocol`；同源 `/somewhere/` → `warn` + `convergesToRoot=false`；301 缺 Location → `warn` + `invalid-location`。四者都不判通过，也不请求目标 |
| 首页资源引用 SSRF 防护（2 例） | 反斜杠伪装的跨源 URL（`\\127.0.0.1:port/ssrf-probe`）解析后不请求，跨源服务器零命中，`ignored` 说明原因；`javascript:` 链接不被当资源探测，退出码 0 |
| 响应头与状态字段（3 例） | `title` / `content-type` / `cache-control` 进 JSON；安全头按数量判 `warn`；`404` / `spa-fallback` / `api` 检查都带真实 `httpStatus` |
| CLI 参数校验（7 例） | 非法 `--api` / `--expect-404` URL、非正 `--timeout`、非正整数 `--assets-limit`、非法 `--backup`、非法 `--retries` → 退出码 2，无半截 JSON（不再崩溃或把 `--assets-limit abc` 当成 0 个资源） |
| verify 网络重试（7 例，本地真实 socket） | 首次连接重置后第二次成功 → root `pass`、attempts=2、服务器命中 2 次；每次重置 → 重试耗尽后 fail + errorKind=network + 无 httpStatus；HTTP 503 不重试（命中 1 次）；脚本自身单次超时不重试；`--retries 0` 关闭重试；正常请求 attempts=1，JSON 带 `retry` 配置 |
| verify SEO 决策（2 例） | 首页无 canonical/meta robots/X-Robots-Tag → `seo` warn，退出码仍 0；canonical 存在时不误报 |
| 探针 CLI `--timeout` 校验（7 类非法输入 + 默认/合法） | 不传时默认 15000 正常执行；合法正整数保持原行为；`abc`、`-1`、`0`、`1.5`、`2147483648`、缺值、空字符串均退出码 2、中文用法错误、无 JSON、无 wrangler/部署调用（fake wrangler 调用日志为空） |
| 备用站 304 / 少见 3xx（2 例） | 304 判 `fail` + `not-modified` 且不写「重定向未完成验证」；300 判 `fail` + `unexpected-3xx`，均不判通过 |
| SPA 回退 304 / 少见 3xx（2 例） | 304 / 300 判 `fail`，不写成重定向式回退，也不判通过 |
| `--expect-json` 结构化比较（7 例） | 键顺序与空白不影响；字段缺失、类型不符、数组长度不符、嵌套数组子集、无效预期 JSON、非法响应 JSON 都给出明确原因 |
| HTML tokenizer（unit 层 + 确定性组合） | 注释 / bogus comment（含 `<!-->`、`<!--->`、`--!>`、`<?...>`、DOCTYPE）/ CDATA / RAWTEXT（script/style/xmp/iframe/noembed/noframes/noscript）/ RCDATA / plaintext / template / SVG、MathML 外域 / foreignObject / 属性值 / 不完整标签 / 重复属性 / 字符引用（缺分号、大小写、windows-1252、NUL）/ `<base href>` / 结束标签游离引号 / 可见文本边界；300 组确定性随机上下文组合只识别真实标签；大量畸形片段线性结束不超时。直接 import `scripts/html-scan.mjs`，不是匹配源码文本 |
| canonical 上下文隔离矩阵（14 例） | 注释 / script / style / textarea / title / iframe / xmp / noembed / noframes / plaintext / template / 属性值 / 不完整标签里的伪 canonical 都判 `skip`；title 文本里的 `<link>` 不产生 canonical 也不破坏 title；真实 + 注释/script/textarea 伪标签组合只算 1 个并判 `pass` |
| 元数据隔离（2 例） | 注释 / script 里的伪 `<title>`、`<meta name=robots>` 不参与识别，真实元素优先 |
| HTML tokenizer 集成（资源） | 注释 / RAWTEXT / RCDATA / 属性值里的伪资源引用零请求；跨源 `<base href>` 下相对引用只记 `ignored`；`<base href>` 决定资源解析基准；`javascript:`/绝对外链不探测；`srcset` 逗号 URL 与预加载 link 正确处理 |
| 外域与 noscript（对抗层） | SVG/MathML 里的伪 canonical 不计数、SVG CDATA 忽略、SVG title 不成为文档 title、foreignObject 内部恢复 HTML；noscript 里的伪 base/canonical 不生效，资源仍按文档 URL 解析；结束标签游离引号不吞后续真实标签 |
| 字符引用与相对 URL（unit） | 命名实体大小写敏感、数字引用缺分号、属性值 no-semicolon 规则、C1 windows-1252、NUL→U+FFFD；根重定向到无尾斜杠路径、`--url` 指向 `.html` 时相对资源按文档 URL 解析 |
| 登录判定本地化/多账号（unit + 集成） | 只输出「已登录」没有邮箱/Account ID → unknown 且不可部署；`not logged in` 不被 `logged in` 子串误判；多账号表格不替用户选 Account ID；已登录 + “no account selected” 仍判 logged-in |
| check-build 与 verify 对齐（互操作层） | `<base href>`、跨源 base、srcset 逗号 URL、顶层大小写、symlink/junction 产物，两个脚本对同一 HTML 结论一致 |
| 首页 500 门控 + 安全头（2 例） | 500 错误页虽然含 title/canonical/script，也不产生 title/canonical 检查（只有 `html: warn`），root 判 fail；两个安全头判 `pass` |
| SPA 回退 fail-closed（2 例） | 未知路径 200 但没有 app shell 标记 → `warn`（不再因「有内容」判 pass）；304/300 判 `fail` |
| `/index.html` 5xx（1 例） | 5xx 判 `fail`，不是静默 warn |
| CORS 预检语义（4 例） | 未提供实际请求头时不发送 ACRH，服务器 403 也不会误判 fail；显式声明 authorization 后 403 判 fail；`Allow-Headers: *` 可覆盖 `Range`；未提供参数时最多 warn |
| CORS 错误响应 / 重定向（2 例） | 简单请求 500 即便带 ACAO 也判 `fail`；301 重定向不判通过、最终响应未验证 |
| 登录判定 fail-closed（5 例） | `whoami` 空输出 / `loggedIn:false` / 执行失败分别判 unknown / logged-out / error；`probe` blocked、`check-env` `warn` 且 `canDeploy=false`；正常登录仍 pass |
| 配置注释噪声（7 例） | Vite / Next / wrangler JSONC / TOML 注释不生效；YAML 注释不误判 Pages；`node --inspect` 取真实入口；`.env` 支持 `export`/小写键；Nuxt `ssr:false` 判静态；`public/index.html` 可发现 |
| 重定向后最终 URL（2 例） | 根 301→`/final/` 后 canonical 按最终 URL 判自身、相对资源解析到 `/final/final.css`；Location 含 userinfo 分类为 `invalid-location` 且不请求 |
| CLI / 模式矩阵（12 例） | 非法 `--url`/`--mode`/`--cors-url`/`--origin`/CORS 参数缺 origin/数值参数 → 退出码 2；`--url` 带 query 保留路径；`ssg` 与 `static` 判定一致；check-build 非法 `--mode` / 缺 `--dir` / 目录不存在都给出正确退出码与 JSON |
| 分层统计 | 每轮输出 `core / boundary / adversarial / combination / unit` 的断言数，防止只堆同类 happy-path 测试 |
| HTML5 状态机：script data（unit/adversarial） | escaped / double-escaped / `</script>` 在不同状态是否关闭 / `-->` 回 data / 未闭合 EOF / `</scriptx>` / `</script =">`；断言 script.content 精确值与后续伪 canonical |
| HTML5 状态机：DOCTYPE（adversarial） | public/system 标识符里的 `>` abrupt 结束（引号不保护）、残余 `<link>` 可能成为真实元素、unclosed quote EOF、bogus DOCTYPE；期望来自 Chrome 实测 |
| HTML5 状态机：SVG/MathML 命名空间栈（adversarial） | 嵌套 svg、foreignObject/desc/title、g 内 title、MathML mi/mtext/mglyph、annotation-xml encoding 两种取值与未编码、annotation-xml 上的 svg、breakout img、`</p>` 结束、HTML 祖先结束标签（div/p/select）、template 隔离、foreignObject 内未闭合 HTML 子元素、关闭后恢复；无状态泄漏 |
| HTML5 状态机：结束标签属性 / EOF 文本（boundary） | 结束标签游离 `=`/引号不吞后续标签（含 RAWTEXT 结束标签）、EOF 不完整开始标签不并入文本、`</` EOF 按文本、可见文本边界 |
| HTML 自闭合语义（adversarial） | `<div/>`/`<span/>`/`<p/>` 在 HTML 内容、foreignObject、MathML 文本集成点中不关闭；`</div>`/`</foreignObject>`/`</mtext>` 的忽略/弹栈；foreign `<g/>`/`<foreignObject/>`/`<mtext/>`/嵌套 `<svg/>` 自闭合生效；template 隔离；breakout 的 HTML 自闭合；资源与 canonical 最终结果 |
| EOF 不完整标签（boundary） | `<link`、未闭合引号、属性名/值一半、`<a href='/x`、`<img src="/x"` EOF 均不产生元素；`</`/`<` 单独 EOF 保留为文本；未闭合 title/script 内容保留；`text <link ...` 只保留文本 |
| 外域结束标签 scope / 丢弃标签 / select（adversarial） | 外域结束标签回退 HTML 在 table/object/marquee/applet/select/caption/td 等 scope 边界停止；tr/td/th/thead/tbody/tfoot/caption/colgroup/html/head/body/frame/basefont/bgsound 不进入祖先栈；嵌套 select/input 关闭 select；J1-J6 Chrome/Edge oracle |
| 可见文本集成点（adversarial） | 隐藏集成点（SVG title/desc）内的 xmp/textarea/plaintext 不计入；foreignObject 内 CDATA 计入；外域/隐藏集成点里的 `<` 不计入；textarea 可见文本为本地口径 |
| srcset 解析（unit） | 40+ 组：逗号后无空格、data URI、URL 含逗号、尾随逗号、空候选、无 descriptor、畸形/重复/互斥 descriptor（w/h/x 冲突）、`a.png, 2x` 等规范边角 |
| 资源属性白名单（unit） | `src` 仅对 img/script/iframe/embed/video/audio/source/track/input，`poster` 仅 video，`srcset` 仅 img/source；`<div src/poster/srcset>` 不进入资源探测 |
| 浏览器差分（adversarial，默认套件） | `html5-oracle.json` 115 个 Chrome/Edge 真实 DOM facts：HTML 命名空间 canonical 列表、HTML title、script 数量/精确 textContent、HTML img/base 数量；逐项比较本地 tokenizer |
| 浏览器差分（可选，开发期） | `node tests/browser-diff.mjs` 用本机 Chrome/Edge CDP 现场重跑 115 例，并同时报告“fixture 是否过期”和“parser 与浏览器是否一致”；无浏览器/Node<22 时跳过 |
| 组合与随机状态（adversarial） | 四类问题同时出现；300 组确定性状态组合（注释/template/script 三态/DOCTYPE/SVG 外域隐藏 fake；foreignObject/title/desc/mtext/mi 集成点必须识别 fake 为 HTML）+ 旧 300 组 canonical 上下文 fuzz |

### 部署探针（纯逻辑 + 本地假 wrangler，不接触真实账号）

| 场景 | 结果 |
|---|---|
| 解析到 URL + HTTP 200 且响应体全等 `ok` | `pass`，`verified=true` |
| 部署成功但输出里没有 URL | `warn`，`verified=false`，绝不 `pass` |
| URL 不可访问 / 非 200 / 200 但内容不匹配 | `fail` |
| 部署命令失败 | `fail` |
| 临时 Worker 清理失败 | 单独 `deploy-cleanup: warn`，不影响 deploy 结论 |
| 部署命令失败时的清理 | `deploy-cleanup: skip`，提示「未确认成功、如已创建请到控制台核对」，不谎称删除失败 |
| `--deploy` 端到端（假 wrangler） | 无 URL 不判 pass、清理失败单独记录、`nextSteps` 提示未验证、部署命令失败判 fail 且清理为 skip |

## 真实项目探测（只读）

| 项目 | 识别结果 | 解释 |
|---|---|---|
| `3D建模` | `unknown`，目标待定，根目录和一层内没有 `index.html` | 拒绝猜站点根目录；唯一的 HTML 是 `web/island_viewer.html` |
| `网络测试` | `unknown`，目标待定，提示“有 HTML 但没有 index.html” | 指出直接部署目录根会 404 |

## 测试证明了什么

- 识别脚本不需要安装依赖，就能读出框架、构建命令、输出目录、base path、GitHub Pages 配置、Wrangler 配置、绑定、环境变量键名、子应用、锁文件和风险信号。
- 每个关键字段带 `confirmed` / `inferred` / `unknown`，推测不会被写成事实。
- 部署目标只给候选；只有现有 Wrangler 配置或硬阻断才会给出高置信度结论。
- 构建检查和验收用同一个 `--mode`，404 结论不会互相矛盾。
- 验收脚本会发真实 HTTP 请求，能区分 SPA 回退、静态 404、重复 ACAO、重复 canonical、假备用站，以及主站 / 资源 3xx 的同源与跨源结果。跨源目标用另一台本地服务器记录请求路径，实测全程零请求。
- `ssr` 模式不会把静态产物检查套到 SSR 项目上；未知路径返回 200 只警告，不误判为失败。
- `--api` 能区分 JSON / 非 JSON / 期望内容不匹配；`--expect-json` 缺 `--api` 会警告。期望值按 JSON 子集比较，字段顺序与空白不影响结论。
- 文件数上限按「套餐 + 部署目标」判定：Pages 需 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`，Workers 需完整版本 Wrangler >= 4.34.0；目标未知、非法版本或证据不足一律退回 Free 20,000 并给 `warn`。
- 资源 3xx 不再算通过：同源按 `MAX_REDIRECTS=5` 跟随并验最终 2xx，跨主机记录目标并 `warn`，循环 / 缺 `Location` / 非 HTTP(S) 目标 / 最终 4xx/5xx 判 `fail`；只要收到带有效 Location 的 3xx 就进 `redirects`，`probed` / `warnings` / `redirects` 三处一致。`finalUrl` 只表示最后真正请求过的地址，未跟随目标在 `redirectTarget`、超限在 `limitReached`，不会再伪造 finalUrl。
- 主站、资源、`--backup` 共用同一跳数语义：最多跟随 5 次同源重定向并额外请求最终地址（共最多 6 次请求）；最终地址再返回 3xx 才判 `loop-or-limit`，`limitHop` 留证据且不请求它的目标。测试用服务器收到的路径数证明真的请求了最终地址、没有请求第 7 个地址，并覆盖「5 次后 404 不是超限」「边界处跨源仍不跟随」。
- 主站只自动跟随同源（协议 + 主机 + 端口）重定向；跨源、协议变化（含 HTTP↔HTTPS、HTTPS→HTTP）、非 HTTP(S)、无效 Location、循环都用 `redirectOutcome` 单独分类，跨源标 `warn` + `verified=false`，不请求目标，别的站点返回 200 不会给原站点判 `pass`。
- canonical 指向自身要求协议、主机、规范化路径三者一致；本地 HTTPS 站点上的 `http` canonical 实测判 `warn` 并点名协议不一致，结果带 `sameProtocol` / `sameHost` / `samePath`，跨主机 / 跨路径 / 多标签判定保持原样。
- CORS 预检不把 `OPTIONS` 2xx 当通过；只断言用户显式提供的实际方法 / 请求头 / 凭据，没提供时不发送 ACRM/ACRH，其余写进 `notChecked`，未提供方法/请求头的预检最多 `warn`。按 Fetch 规范处理 `*` × 凭据、`Authorization` 非通配（Range 可被通配）、`GET/HEAD/POST` 安全列表方法与方法名大小写。简单请求 3xx/4xx/5xx 不判通过；凭据模式只由 `--cors-credentials` 声明，响应里的 `ACAC: true` 不会把无凭据请求判成带凭据。
- 部署探针把「命令成功」和「线上验证成功」分开，清理失败单独告警。
- 链路探针在 `whoami --json` 调用失败时仍能用纯文本判定已登录；登录判定与 `check-env` 共用 `scripts/wrangler-auth.mjs`，是 fail-closed：退出码 0 但空输出 / `loggedIn:false` / 没有邮箱或 Account ID 等正向证据时判 unknown/logged-out，`probe` blocked 且 `canDeploy=false`，不会 fail-open。
- `check-env.mjs` 的退出码与 `canBuild` / `canDeploy` 一致，`--build-only` 只按可构建判定。
- `wrangler.jsonc` / `wrangler.json` 的 JSON 键值能被识别（注释不影响），显式 assets 目录作为输出目录且证据为 `confirmed`；显式 Wrangler 配置优先于框架默认值。
- 首页资源引用先解析再按 origin 过滤：只取真实子资源属性（`src` / `srcset` / `poster` / `<object data>` / `<link href>`；导航链接、canonical、`<base>` 不算），按 `<base href>` / 最终页面 URL 解析；反斜杠伪装的跨源 URL 实测零请求（跨源服务器没有命中），跨源/畸形只进 `ignored`，`javascript:` 等非 HTTP(S) 链接不再把正常站点判成 exit 1。
- `/index.html` 只有同源且目标是站点根才判 `pass`；跨源、非 HTTP(S)、其他路径与缺 Location 都只告警，`convergesToRoot` / `redirectKind` 给出机器可读证据。
- CLI 参数写错（非法 `--api` / `--expect-404` / `--backup` / `--cors-url` / `--url` URL、非法 `--mode`、非正 `--timeout`、非正整数 `--assets-limit`、非法 `--origin`、CORS 参数缺 `--origin`）以退出码 2 结束；`probe.mjs --timeout` 额外要求 1..2147483647 的有限正整数，非法值在发起任何网络探测或 `--deploy` 前退出 2；`--url` 带 query 时保留路径；不再崩溃或把 `--assets-limit abc` 静默当成 0 个资源。
- `404` / `spa-fallback` / `api` 检查都带真实 `httpStatus`；响应头检查只在拿到最终 200 时执行，重定向响应的头不会冒充首页头；TTFB 取最终响应。
- `check-build` 资源存在性按部署产物真实文件名大小写敏感匹配，拒绝 `..` 逃逸；`index.html` 是目录时输出 JSON 而不是崩溃。
- Windows 项目路径含空格时，本地 `.cmd` wrangler 仍能执行，`whoami` 用实际解析到的本地 wrangler；部署失败时清理结论为 `skip`，不谎称删除失败。
- `check-skill.mjs` 对 BOM、YAML 块标量 `description` 与 fenced code 示例不误报，同时代码块之外的失效路径仍会被报告；目录名 ASCII 与运行期目录忽略也已覆盖。
- canonical 标签识别按真正的 `rel` 属性 token 精确匹配：`data-rel`/`aria-rel`、`rel="canonicalized"`、HTML 注释和 `<script>` 里的假标签都不会被误识别；真正标签的属性顺序和三种引号写法不影响结果，注释 + 真实标签也不会误报重复。
- HTML 识别只有一个权威实现 `scripts/html-scan.mjs`：直接单元测试 + 真实 HTTP 集成；注释、RAWTEXT（含 noscript）、RCDATA、plaintext、template、SVG/MathML 外域、属性值、不完整标签、结束标签游离引号里的伪标签都不会被当成元素；`srcset` 逗号 URL、字符引用（缺分号/大小写/windows-1252/NUL）、`<base href>` 都按 HTML 语义处理。300 组确定性随机组合和大量畸形片段验证不变量。
- 相对 URL 按文档 URL 解析（无 base 时不强行补尾斜杠）：根 302→`/noslash` 与 `--url .../subpage.html` 两种真实服务器场景都证明浏览器同款解析；重定向后 canonical/资源/CORS 默认目标都基于最终页面 URL。
- check-build 与 verify 对同一 HTML 的 `<base href>`（含跨源）、srcset、顶层大小写、symlink/junction 产物给出一致结论；测试目录里的 junction 指向 work 内技能副本，不会让备份沿链接递归。
- `tests/last-run.txt` 由测试脚本自动生成，测试计数、分层统计、results.md/README 的最近一次结果不再靠人工同步。
- **HTML5 状态机与真实浏览器一致**：script data 的 escaped/double-escaped、DOCTYPE 标识符里的 `>` abrupt 结束、SVG/MathML 命名空间栈（含 annotation-xml、集成点、breakout、HTML 祖先结束标签、template 隔离、无状态泄漏）、HTML 非空元素的自闭合语义、结束标签属性引号、EOF 不完整标签、srcset 规范边角，都有独立回归；115 个用例的期望来自 Chrome/Edge 真实 DOM facts，而不是本实现自证。**可见文本断言是本地规则（未全部纳入浏览器 fixture）**；EOF 的 `</`/`<` 文本保留、title/script raw text 也由本地断言覆盖，fixture 只存 canonical/title/script/img/base 事实。
- **资源提取不再被非资源属性误导**：`<div src>` 等不会触发探测；srcset 的 URL/data URI/逗号后无空格/畸形 descriptor 按规范处理，不会漏候选或误探测。
- **差分可复现**：默认套件只需 Node + fixture；有浏览器时可用可选脚本现场重跑真实 Chromium 差分，二者分离，不破坏零安装分发。
- 配置读取有独立权威 `scripts/config-scan.mjs`：JS/TOML/JSONC/YAML 注释与字符串不会冒充配置值；JSONC 结构化解析、TOML section、workflow 注释、`node --inspect`、`.env export/小写键`、Nuxt `ssr:false`、`public/index.html` 都有真实夹具。
- 登录判定 fail-closed 且 `check-env` / `probe` 同一权威：没有正向证据时最多 warn/blocked，不允许 `canDeploy`；执行失败与未登录分开报告。
- 根路径同源重定向后，404/API/CORS/`/index.html`/资源/canonical 都基于最终页面 URL；资源/canonical 的相对地址按 `<base href>` 或最终 URL 解析，测试用 `/case/same301/ → /final/` 夹具证明。
- 只有最终 200 才做 HTML 内容检查（500 错误页的 title/canonical/script 不产生结论）；`/index.html` 5xx 判 fail；SPA 回退没有 app shell 标记只 warn。
- 测试自身分层统计（core / boundary / adversarial / combination / unit），并给子进程加超时；check-build 主模块守卫用 realpath，symlink/junction 安装后不再静默 exit 0。

## 没有测试什么

| 项目 | 原因 | 以后怎么验证 |
|---|---|---|
| 真实 Pages/Workers 部署 | 没有 Cloudflare 账号/Token，wrangler 未安装 | `wrangler login` 后部署一个测试项目到预览地址 |
| 自定义域名 + TLS | 没有域名控制权 | 绑定测试子域，`openssl s_client` 检查 |
| 真实站点的证书链 / HSTS / 混合内容 | 本地 HTTPS 服务器用自签回环证书，只是为了让脚本以 `https://` URL 真正跑起来、验证 canonical 协议判定 | 部署后用浏览器和 SSL Labs 等外部工具检查 |
| DNS 切换 | 没有 DNS 权限 | 降低 TTL，切换后用 1.1.1.1 / 8.8.8.8 查询 |
| D1 迁移/读写 | 没有 D1 数据库 | 建测试库，导入后核对行数和写入 |
| GitHub Pages 自定义域名移除 | 没有仓库管理员权限 | 按 `github-pages-backup.md` 操作后 curl `github.io` |
| Search Console canonical | 没有站点权限 | 部署后用“网址检查” |
| GitHub Actions 部署 | 当前环境没有对应仓库/CI | 在测试仓库跑生成的 workflow |
| 链路探针 `--deploy` 的真实写入/删除 | 没有 Cloudflare 账号，且属于写操作 | 获用户同意后在小规模测试账号跑一次，核对临时 Worker 被删除 |
| 真实账号的套餐 / R2 / Containers 可用性 | 没有账号与 Token | 用 API Token 查订阅，或在控制台 Billing 核对 |
| 完整 HTML5 DOM / tree construction | `html-scan.mjs` 是有明确边界的 tokenizer/局部状态机，不是完整 HTML5 parser：不建模隐式闭合、foster parenting、活动格式化元素重建/adoption agency；SVG/MathML 只做命名空间栈（含 annotation-xml encoding 分支），不做完整树构建 | 需要 DOM 级结论时用浏览器或 parse5 等外部工具另行核对；独立一次性随机差分（未纳入仓库）未发现状态机 bug；唯一不一致是已声明的 foster parenting（不建树），另有命名实体子集限制 |
| 全部命名实体 | 只覆盖常用集合；legacy（无分号）实体仅常见子集（`&notit;` 等仍是原文） | 不影响 script/DOCTYPE/命名空间状态机；需要完整实体表时用浏览器或外部库 |
| 真实浏览器 CORS 判定 | 脚本只发 GET/HEAD/OPTIONS 并检查响应头，不执行浏览器同源策略 | 用浏览器 DevTools 或端到端测试确认 |
| 真实用户登录态的多账号/本地化输出 | 假 wrangler 只覆盖常见英文/JSON 形态 | 用真实 `wrangler whoami` 各版本、多账号环境采样 |

## 测试中发现并修复的问题

1. **附加字段覆盖检查状态。** `add(id, status, detail, extra)` 先展开 `extra` 再放核心字段，导致 `{status: 200}` 把 `"fail"` 覆盖成数字，`summary.fail` 统计不到，会输出“失败=0”的假结论。已改为核心字段最后写入，并加断言锁住。
2. **Windows 上 `process.exit()` 偶发退出码 3221226505（0xC0000409）。** JSON 已完整输出，进程却以非 0 退出，CI 会误判失败。17 次连跑中复现 2 次；改用 `process.exitCode` 后连跑 3 轮全绿。
3. **未识别框架 + 多个 `index.html` 时没有风险提示。** 之前只在 `static-html` 分支提示；已覆盖 `unknown`。
4. **结构检查把运行期产物当成缺失路径。** `tests/.work` 只在测试运行时存在，已加入忽略列表。
5. **测试夹具目录删除失败会中断整轮测试。** 本机的安全删除钩子把 `fs.rmSync(tests/.work)` 转成回收站操作，文件被占用时抛 `Some operations were aborted`，整套断言直接不执行。改为每次用 `tests/.work/<timestamp>/`，不删旧目录。
6. 早前修复：`verify-deployment.mjs` 漏写 `async`；重依赖项目被误判成 Workers（改为 `assess`）；忽略 `wrangler` 的 `assets.directory`；源码扫描把 `tests/` 误当噪声目录。
7. **`check-env.mjs` 新增的退出码逻辑引用了未定义的 `argv`。** 脚本会先输出 JSON，再抛 `ReferenceError`，因此任何情况都固定以 1 退出；第一次「退出码与结论一致」断言是碰巧通过（`canDeploy=false` 恰好也是 1）。改用 `process.argv`、补 `--build-only` 断言后锁住；同时把 `process.exit()` 换成 `process.exitCode`，避免 Windows 上偶发的 0xC0000409 崩溃码。
8. **探针用 `includes("ok")` 校验响应体。** `"not ok".includes("ok")` 为 `true`，会把错误响应当成部署成功的线上证据。改成 `trim() === "ok"` 全等比较并加断言。另有一条 `nextSteps` 断言的正则与文案不符，属于测试写错，已修正断言而非改产品文案。
9. **Paid 文件数放宽把 Pages 专属条件套到了 Workers。** 旧 `resolvePlan()` 一律要求 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`，且只取主版本号（`4`），无法比较 `4.34.0`。官方 Workers Limits 要求的是 **Wrangler >= 4.34.0**、不需要 Pages 变量。改为按 `--target` 分流 + 点分数字完整比较，目标未知、非法版本、只给主版本都退回 Free。
10. **CORS `hasToken()` 见 `*` 就判通过。** 带凭据时 `Allow-Methods: *` / `Allow-Headers: *` 是字面值，`Authorization`（当时误把 `Range` 也算上，后已修正）是 non-wildcard header（`*` 永不覆盖），`GET/HEAD/POST` 是 CORS-safelisted method。改为按凭据与方法规范分别判定，简单请求的 `ACAO` 也改用 `--cors-credentials` 判定。原有两个用 `POST` 断言「缺 Allow-Methods 判失败」的测试本身不符合规范，改用 `DELETE` 保留场景，并新增 safelisted 通过用例。
11. **资源 3xx 被默默当成正常。** 旧的「请求失败或 `status >= 400` 才判坏」在 `redirect: "manual"` 下把 301/302/307/308 全算通过。改为独立跟随（同主机按跳数上限，现为主站 / 资源共用的 `MAX_REDIRECTS=5`，见第 15 条）、验证最终 2xx，报告保留重定向链与最终状态；跨主机 `warn`、循环与最终 4xx/5xx `fail`。
12. **主站重定向链会被 3xx 带到任意地址（SSRF 面）。** 旧 `chain()` 无条件解析 Location 并继续请求：`127.0.0.1`、内网 IP、云元数据端点、协议变化、非 HTTP(S) 协议都可能被访问；跨站最终 200 还会让 `root` 判 `pass`；非法 `Location` 会让 `new URL` 抛异常。抽出零依赖纯函数 `scripts/redirect-policy.mjs`，按 `URL.origin`（协议 + 主机 + 端口）判定同源，主站与资源共用；非同源只记录 Location / 状态码 / 链，不请求目标。`root` 用 `redirectOutcome` 分五类，跨源 `warn` + `verified=false`；`backup` 只解析 `hops[].location` 识别跳主站，不为识别而请求主站。
13. **CORS 简单请求把 ACAC 响应头当成请求凭据模式。** 旧判断 `acao === "*" && (acac === "true" || corsCredentials)` 让「无凭据 + ACAO=* + ACAC=true」误判 `fail`，而「带凭据 + 精确 ACAO + 缺 ACAC」反而通过。改为只按 `--cors-credentials` 声明判定：声明带凭据才要求精确 ACAO + `ACAC: true`；预检断言逻辑未改。
14. **跨主机资源重定向没进 `redirects`。** `redirected: chainHops.length > 1` 在跨主机提前返回时链只有 1 跳，导致 `redirected=false`，汇总漏报。改为「3xx + 可解析 Location 即记为重定向」，`redirects` 收录同源与跨源，`probed` / `warnings` / `redirects` 统一同一组字段（原始 / 最终 URL、最终状态、跨主机标记、完整链）。
15. **主站重定向链的跳数边界少一跳。** 旧 `chain()` 用 `for (i = 0; i < max; i++)` 只发 5 次请求，最多跟随 4 次重定向；`probeAsset()` 用 `hop <= MAX_ASSET_REDIRECTS` 发 6 次，两者语义不一致。抽出共用 `MAX_REDIRECTS=5`，主站 / 资源 / `--backup` 都最多跟随 5 次并额外请求最终地址；第 6 次重定向判超限且不请求目标。为保留原循环用例的 `hops.length === 5` 语义，超限时未跟随的那一跳不进 `hops`，改由 `limitHop` 记录（`followed=false`）。跨源判定仍优先于跳数判定。
16. **canonical 只比 host + pathname，漏了协议。** `https` 站点上的 `http` canonical 会被判成「指向自身」。增加 `parsed.protocol === new URL(base).protocol` 检查，三者全一致才 `pass`；主机与路径相同但协议不同时 `warn` 并写明两个协议。路径规范化规则、跨主机 / 跨路径 / 多标签判定均未改动。为能真实以 `https://` 站点执行验收，新增本地自签回环证书夹具（不是真实凭据、TLS 校验保持开启、不需要 openssl 或第三方包）。
17. **canonical 空 href 被误判成指向自身。** 旧代码用 `/href\s*=\s*["'][^"']+["']/` 这样的正则取 href，缺失或空值回落成 `""`，`new URL("", base)` 解析成当前站点 URL，于是无效 canonical 被当成 self-canonical；正则还漏掉合法的不带引号属性值。改为属性扫描器 `readHtmlAttr()`，区分 `missing` / `empty` / `valid` / `invalid` 四种 `hrefState`：缺少 href 与空 href 判 `fail` 且不解析；无法解析明确报告、不回退到 base；支持双引号、单引号、不带引号三种合法写法。协议 / 主机 / 路径三项比较与多标签 `fail` 判定未改。
18. **所有 3xx 都被当成重定向。** 主站链、资源探针和 `/index.html` 三处都用 `status >= 300 && status < 400`：304 会去读 Location 并可能被报成「无效重定向」；其他少见 3xx 被默默跟随或判通过；三处规则还各自分叉。`scripts/redirect-policy.mjs` 新增导出 `classifyStatus()`（`success` / `redirect` / `not-modified` / `unexpected-3xx` / `error`），三处共用；只有 301/302/303/307/308 进入既有同源重定向策略，304 立即结束且不因缺 Location 报错，其他 3xx 单独分类、不判通过。修复过程中还发现 `index-redirect` 把 HTTP 状态放进名为 `status` 的附加字段，会被 `add()` 的核心字段覆盖、JSON 里根本读不到，已改为 `httpStatus`（与 `root` / `backup` 一致），测试改为断言 `httpStatus`。
19. **detect-project 读不出 wrangler.json / jsonc。** 字段正则只匹配 TOML 的 `key = "value"`，JSON 的 `"key": "value"` 一个都读不到：name / compatibility_date / assets.directory 全为 null，输出目录误报未知，Workers 静态资源项目拿不到候选目标。改为同时接受两种语法（JSONC 注释不影响按字段取值），并加了 wrangler.jsonc 夹具。
20. **输出目录的值与证据来源矛盾。** `outputDir` 优先框架默认值，evidence 却因存在 Wrangler 配置就标 `confirmed`、来源写成 `assets.directory`。改为显式 Wrangler 配置（pages_build_output_dir / assets.directory）优先，证据来源跟随真实取值。
21. **首页资源引用的跨源过滤是字符串黑名单（SSRF 面 + 误判）。** `\127.0.0.1:port/x` 经 URL 解析会变成协议相对地址，脚本照样发出 HEAD；`javascript:` / `blob:` 链接会被当资源探测，正常站点因此 exit 1。改为先解析再按 protocol + origin 过滤：跨源 / 非 HTTP(S) / 畸形地址只记进 `ignored`、不请求；畸形 URL 不再让脚本崩栈。
22. **`/index.html` 任何可解析 3xx 都判 pass。** 跨源、`file:`、同源但指向 `/elsewhere` 都能过，和主站链的跨源策略矛盾。改为只有「同源 + 目标路径等于站点根」才 `pass`，其余 `warn`，并输出 `convergesToRoot` / `targetPath` / `next`。
23. **`404` / `spa-fallback` / `api` 检查的 HTTP 状态码被覆盖。** 附加字段也叫 `status`，被 `add()` 的核心结论覆盖，JSON 里读不到真实 301/404/200。统一改名 `httpStatus`；响应头检查只在最终 200 时执行，TTFB 改为取最终响应。
24. **`check-build` 的资源存在性判断不可靠。** `fs.existsSync` 在 Windows 上大小写不敏感（`/Assets/App.css` 被当成存在，但 CDN 会 404），还允许 `../outside.html` 逃出产物目录；`index.html` 是目录或目录不可读时直接抛异常、没有 JSON。改为按产物文件集合做大小写敏感匹配、拒绝 `..` 与绝对路径，并对读目录 / 读文件做保护。
25. **Windows 下项目路径含空格会打断本地 wrangler。** check-env / probe 把 `.cmd` 绝对路径直接拼进 shell，`C:\...\My Project\node_modules\.bin\wrangler.cmd` 被 cmd 截断；check-env 的 whoami 还在 PATH 版 wrangler 存在时错误地一律走 `npx`，把「命令执行失败」写成「未登录」。改为按需给命令路径加引号，whoami 用实际解析到的 wrangler，并区分执行失败与未登录。
26. **probe 在部署失败后仍执行 delete 并报清理失败。** 部署命令失败时根本没有创建临时 Worker，删除自然失败，结果却写「未能删除，请手动清理」。改为只在部署成功后清理；部署失败时 `deploy-cleanup` 记 `skip`。
27. **verify 的 CLI 参数不校验。** `--api "http://["` / `--expect-404` 非法 URL 会抛 `TypeError`、拿不到 JSON；`--assets-limit abc` 被当成 0 个资源并判 assets `pass`；`--timeout 0` 让所有请求立即中止并触发 Node 警告。入口统一校验数值与 URL 参数，错误以退出码 2 报用法。
28. **check-skill 的误报与漏报。** 路径 / 链接扫描不剔除 fenced code，合法示例会弄红结构检查；frontmatter 不支持 BOM 与 `|-` / `>-` 块标量；链接标题、目录链接被误报；目录名 ASCII 与 `.work` / `.tmp` 空目录处理不一致。已分别修正，并加了自检用例。
29. **canonical 标签识别用宽松正则。** 旧正则 `<link\b[^>]*\brel\s*=\s*["']?canonical["']?[^>]*>` 会把 `data-rel="canonical"`、`rel="canonicalized"`、HTML 注释里的标签都算成 canonical，甚至把「真实标签 + 注释标签」误判成重复标签。改为先去掉 `<script>` / `<style>` 与 HTML 注释，再用属性扫描器读取真正的 `rel` 属性，并按 HTML 空白分隔 token 精确比较（ASCII 大小写不敏感）；`href` 缺失 / 空值 / 无法解析、协议 / 主机 / 规范化路径比较、多标签 `fail` 判定均未改动。
30. **用多套正则模拟 HTML 解析（根本原因）。** `<title>` 正则、`<meta>` 正则、canonical 标签正则、资源 `src|href` 正则、SSR `/<[^>]+>/` 文本剥离，加上 check-build 的第 6 套资源正则，各自盲区不同。注释、bogus comment、RAWTEXT（script/style/xmp/iframe/noembed/noframes）、RCDATA（title/textarea）、plaintext、template、属性值里的 `>`、不完整标签都会让不同实现给出不同结论。新增零依赖显式状态机 `scripts/html-scan.mjs` 作为唯一权威，`verify-deployment` 与 `check-build` 共用；测试分单元（含 300 组确定性随机组合与畸形大输入）和真实 HTTP 集成两层。
31. **`<base href>` 被忽略，重定向后的解析基准错误。** 根路径 `/` → 同源 `/en/` 后，404/API/CORS/`/index.html`/资源/canonical 仍按初始 `--url` 解析，导致 `/en/assets/app.css` 明明 200 却判失败、canonical `/en/` 被判「另一个路径」。改为根链确定后统一用最终页面 URL 计算站点根；相对 URL 按第一个 `<base href>` 解析，`<base>` 里的相对地址按 HTML 语义基于文档 URL；跨源 `<base>` 下相对引用按跨源处理、不请求。
32. **资源引用规则不明确（导航链接/canonical/绝对同源/忽略语义）。** 旧逻辑把所有 `href/src` 当资源，`<a href>`、canonical href 会被当资源探测导致误 fail；绝对或协议相对引用被静默丢弃、不计 checked/total 也不进 ignored，与文档不符。抽出 `resourceReferences()` 作为唯一规则：只取 `src` / `srcset` / `poster` / `<object data>` / `<link href>`；导航链接、canonical、`<base>` 不算资源；同源绝对地址也探测，跨源/畸形只进 `ignored`。
33. **资源 `finalUrl` 可能指向从未请求的地址。** 跨源/超限时 `finalUrl` 被设成未请求的目标，`finalStatus` 却属于上一跳。改为 `finalUrl` 只表示最后真正请求过的地址，未跟随目标放 `redirectTarget`、超限放 `limitReached`；`probed` / `warnings` / `redirects` 字段一致。
34. **根非 200 时仍做内容检查、TTFB 取第一跳。** 500 错误页的 `<title>`/canonical/script 会产生 `title:pass`、`canonical:pass` 并探测错误页资源，报告可能把错误页当首页证据；`/` → 302 → 200 时 detail 的 ms 是 302 那一跳。改为只有最终 200 才做内容与响应头检查；TTFB/detail 取最终响应；`/index.html` 5xx 判 fail。
35. **SPA 回退 fail-open。** 首页取不到任何 root/入口标记时，旧逻辑用 `body.length > 0` 判 pass，detail 仍写「含有 app shell 标记」。改为用 tokenizer 从首页提取真实 `id=root/app/__next` 与 module 入口脚本，目标页必须命中才 pass；首页没有标记或目标页不匹配只 warn。
36. **CORS 多个判定缺口。** 简单请求完全不看 HTTP 状态码（500 + ACAO 也判 pass）；CORS URL 的 3xx 不分类；预检未提供方法/请求头时凭空发送 `Access-Control-Request-Method: POST` / `Access-Control-Request-Headers: content-type,authorization`，服务器对 authorization 返回 403 就被判 fail，与「没提供的信息不推断」矛盾；`Range` 被错误当成 non-wildcard header；给了 `--cors-*` 却漏 `--origin` 时静默跳过；`--origin` 不校验。现已逐项修正（预检最多 warn、非 2xx/重定向不判通过、Range 可通配、缺 origin 退出码 2、origin 校验）。
37. **Location 含 userinfo 被当成可跟随的同源重定向。** `new URL` 能解析 `http://user:pass@host/`，同源判定通过，但 fetch 会抛 `URL includes credentials`，结果暴露成网络错误且目标未请求。`classifyRedirect()` 现在把带 userinfo 的 Location 分类为 `invalid-location`。
38. **check-build 与 verify 的资源规则分叉 + 静默问题。** 旧 check-build 用另一套正则：导航/目录链接被误报「找不到」，无引号引用漏检，`src` 前导空格不一致，`%2F` 解码后可能假通过，超过 40 条静默只查前 40；通过 symlink/junction 安装时主模块守卫比较 `argv[1]` 与真实路径不一致，脚本静默 exit 0、无 JSON。现与 verify 共用 tokenizer/资源规则，支持目录式 URL、大小写敏感与 `%2F` 保护，detail/JSON 写明 `checked/total/limited`，主模块守卫用 realpath。
39. **detect-project 把注释/字符串当配置。** Vite 注释里的 `base`/`outDir`、Next 注释里的 `output:"export"`、wrangler 注释里的 name/main/directory、workflow 注释里的 Pages action、`node --inspect` 启动参数、`.env` 的 `export`/小写键、`public/index.html`、Nuxt `ssr:false` 都会导致错误识别。新增 `scripts/config-scan.mjs`（JS/TOML/JSONC/YAML 注释与字符串剥离、JSONC 结构化解析、TOML section），并修正入口发现与启动参数提取。
40. **登录判定 fail-open 且两套实现。** check-env 只看 `whoami` 退出码：exit 0 但空输出 / `{"loggedIn":false}` / 不认识的本地化输出都会 `canDeploy=true`；probe 又用另一套英文关键词判定，可能互相矛盾。新增 `scripts/wrangler-auth.mjs` 作为唯一权威：`logged-in` 必须有正向证据（邮箱 / Account ID / 明确登录文本），否则 `unknown` / `logged-out` / `error`，两条命令共用；probe 的 Account ID 提取改为优先「Account ID」列，多个候选时不猜。
41. **部署失败清理文案不可证实。** 部署命令失败时可能已创建 Worker（超时/被杀），旧文案断言「没有创建、无需清理」。现改为 `skip` + 提示到控制台核对；部署 URL 返回 3xx 不再被跟随并当成验证通过；部署失败 detail 会带上执行错误。
42. **测试机制缺少分层与对抗输入。** 之前只有针对性回归，没有 tokenizer 单测、随机组合、属性值 `>`、注释/RAWTEXT/template 矩阵、失败注入和子进程超时；`assert()` 无分层标签，报告只看到总数。现在 `assert()` 带 layer，汇总输出 core/boundary/adversarial/combination/unit 数量；`runVerify`/`detect`/`checkBuild` 加超时，随机组合与畸形大输入进对抗层。
43. **CORS 预检只声明凭据时仍判 pass。** 只给 `--cors-credentials` 时 `checked` 只有 ACAO/ACAC，`Allow-Methods` / `Allow-Headers` 都进 `notChecked`，但 `asserted` 为 true，旧逻辑把它当「已断言」判 `pass`，与「未提供实际方法/请求头的预检最多 warn」矛盾。改为只有 `statusAsserted`（有方法或请求头断言）且状态 2xx 才 pass。同时修正：根路径同源重定向后未显式给 `--cors-url` 时默认 CORS 目标仍用原始 `--url`（现按最终站点根）；`--backup` 与主站同源仍判 pass（现判 fail）；`/index.html` 探测网络失败时静默跳过检查（现 warn 并说明）。
44. **check-build 的三处对齐问题。** (a) 不解析 `<base href>`，同一 HTML 在 check-build 判「找不到」而 verify 判通过；(b) 顶层 `index.html` / `404.html` / `_headers` 用 `fs.existsSync` 判断，Windows 大小写不敏感，`Index.HTML` 会被当成存在（CDN 上 `/` 会 404）；(c) `walk()` 不跟随 symlink/junction，产物链接目录少算文件、20,000 上限会 fail-open。现分别用 `effectiveBaseUrl()`、严格文件名集合、跟随链接 + realpath 防环修复，并补回归。
45. **配置与启动命令的剩余边角。** TOML 多行字符串（`"""`）与 YAML 块标量（`run: |`）里的 `main` / `directory` / `deploy-pages` 文本仍会被当配置；Nuxt 的 `nuxt generate` 没识别为静态、`routeRules` 里的 `ssr:false` 会误判整站静态；`node -r dotenv/config src/server.js` 的入口被取成 `dotenv/config`。已加多行/块标量剥离、`jsTopLevelValue()` 顶层属性读取、`extractNodeEntry()` 参数感知提取，并补夹具。
46. **登录判定的两个小漏洞（方向仍是 fail-closed）。** 多账号 whoami 表格只返回第一个 Account ID（可能查错账号），现多个候选返回 null；`You are logged in … Warning: no account selected` 被「未登录」正则抢先判成 logged-out，现只有「无正向证据」时才采用未登录结论；`not logged in` 也不会再因为包含 `logged in` 子串被当成已登录。测试空转也一并修正：`--assets-limit 1` 让反斜杠跨源引用从未进入探测阶段（现 limit 10 并断言 checked=1），以及「无断言时 OPTIONS 恒 403」的路径补了真实用例。
47. **独立复审又发现 8 类 HTML 边界（第二轮修复）。** (a) `<noscript>` 在脚本启用时是 RAWTEXT，伪 canonical/base 曾被计数；(b) `srcset` 盲拆逗号，`data:`/含逗号 URL 产生伪资源；(c) 同源重定向到无尾斜杠路径后资源基准被强行补 `/`（`/sub` 页面里浏览器请求 `/app.js`，脚本请求 `/sub/app.js`）；(d) 结束标签里的游离引号被当成属性值引号，吞掉后续真实标签；(e) SVG/MathML 外域里的 `<link>`/`<title>`/CDATA 被当成 HTML；(f) 字符引用边界：命名实体大小写、缺分号、C1 windows-1252、属性名以 `=` 开头、NUL 输入；(g) xmp 内容被排除但浏览器会渲染；(h) check-build 对跨源 `<base href>` 与 verify 结论相反。已逐项修复并补单测/真实 HTTP 用例；测试从 405 增到 439。
48. **测试基础设施自身的漂移与递归风险（第二轮修复）。** `tests/last-run.txt` 一直是旧文件、靠人工复制，results/README 却称其为「最近一次结果」；测试在 `.work` 里建指向仓库根的 junction 且不清理，备份/复制会沿链接递归膨胀。现在 run-tests 每次自动以 UTF-8 覆盖 `last-run.txt`；junction 指向 `.work` 内的技能副本，不再形成仓库递归；`runVerify`/`detect`/`checkBuild` 有超时，畸形输入阈值放宽到慢机也稳定。
49. **script data 的 double-escaped 状态未实现（第二轮专项）。** 旧实现用 `findEndTag()` 找第一个 `</script`：`<script><!--<script></script>--></script><link ...>` 会在内层 `</script>` 提前关闭，后面的 script 文本被当成真实 HTML，可能产生伪 canonical；`<!-->` / `<!--->` 也缺少「escaped dash dash 遇 `>` 回 data」的转换。现在 `scanScriptData()` 实现 data / escaped / double-escaped 状态（含 `<!-->`/`<!--->` 回 data、escaped 里的 `</script>` 关闭、double-escaped 里的 `</script>` 只回 escaped、EOF 截断）；期望值来自 Chrome 实测的 script textContent 长度/精确字符串与 HTML canonical（H1/H8 等 fixture）。
50. **DOCTYPE 的 public/system 标识符引号内 `>`：实际浏览器语义是 abrupt 结束，不是保护。** 按 WHATWG tokenizer，引号状态遇到 `>` 会 parse error → force-quirks → 立即 emit DOCTYPE，之后文本重新按 HTML 解析；因此“引号内 `<link ...>` 的 `>`”会把标签前缀吞进 identifier，而紧随其后的 `<link>` **可能真的成为 HTML 元素**（B2/B3/B4、Chrome `--dump-dom`/CDP 实测）。旧实现 `indexOf(">")` 恰好符合该行为；一次“用引号保护 >”的重写反而偏离浏览器，现已回退并用浏览器 facts 锁住（含残余文本、伪 link 是否计数、force-quirks 记录在 case 注释中）。
51. **SVG/MathML 用 depth 计数器无法表达嵌套（第二轮专项重写）。** 旧版 `foreignDepth` + `foreignObjectDepth` 会出现：`<div><svg></div>` 后全文档被当外域（canonical 静默漏检）；foreignObject 内再进 svg 时 link 被当 HTML；`</svg>` 不弹 foreignDepth；math/svg 交叉关闭错配；template 内未闭合 svg 泄漏；集成点判断只看 foreignObject。现改为显式命名空间栈（frame 带 name/ns/integration/kind/htmlStack），并处理：SVG foreignObject/desc/title、SVG g 内 title、MathML mi/mtext 文本集成点与 mglyph/malignmark 例外、annotation-xml encoding 分支（不做 trim，前后空格不算集成点）与 annotation-xml 上的 `<svg>`、breakout 开始标签（只弹到最近集成点/HTML 祖先）、`</p>`/`</br>` breakout、HTML 祖先结束标签、集成点内 HTML 子元素栈（含 special 元素阻止错误结束标签、嵌套 svg 时 HTML 结束标签退出）、template 隔离、CDATA（集成点元素本身仍按外域 tokenizer 识别）、外域结束标签。独立审查用 Chrome 对照确认这些输入现在与浏览器一致。
52. **srcset 旧的 `split(/,(?=\s)/)` 既漏候选又误拆 URL。** 改为按 WHATWG 算法：URL 取到空白（可含逗号/data URI）；URL 以逗号结尾则剥尾逗号且无 descriptor；否则读取 descriptor 到逗号，descriptor tokenizer 处理括号（括号里的空白/逗号属于同一 token，随后按非法丢弃）；descriptor 校验 w/h 为小写单位的非负整数、x 为 valid floating-point（支持指数/`.5`/`-0`），互斥/重复/冲突（w+density、h 无 w）都丢弃候选。`a.png 1x,b.png 2x`、`a.png,b.png 2x`、`data:...`、`a.png, 2x`、`a.png 100w, 200w`、`a.png 1.5x`、`a.png 1.5w`、`a.png (x, 1x), b.png` 等都有测试。
53. **结束标签/EOF 文本的 tokenizer 边界。** 旧 `skipTagToGt()` 用“前一非空白字符是 `=`”判引号，遇到 `</div ="><link>` 会把引号当属性值、吞到 EOF；`<div></div =">...`、`</script =">...` 同理。现在用完整属性状态机（before-attr-name/attr-name/after-name/before-value/quoted/unquoted），`=` 出现在属性名前时只是名字字符；EOF 处不完整开始标签不再并入可见文本，`</`+EOF 按浏览器输出为文本。
54. **资源属性对任意元素生效的误报。** 旧 `resourceReferences()` 把 `<div src>`、`<div poster>`、`<div srcset>` 都当资源，verify 会探测不存在的地址并判 `assets fail`。现在按元素白名单：`src` 仅 img/script/iframe/embed/video/audio/source/track/input（input 还要求 type=image），`poster` 仅 video，`srcset` 仅 img/source；`<image>` 按浏览器别名成 img；`<link href>` 规则不变。
55. **差分测试依赖自证 / 测试无法发现偏差。** 新增 `tests/fixtures/html5-oracle.json`：115 个用例的 HTML 命名空间 canonical/title/script/img/base 事实来自 Chrome 157 + Edge 157 两个真实引擎（CDP `namespaceURI` 过滤；两引擎结果逐字段一致）。默认套件直接对照 fixture（零依赖可复现）；另有 `tests/browser-diff.mjs` 在装有 Chrome/Edge 时现场重跑，并检测 fixture 是否过期。独立审查（一次性，脚本/种子未纳入仓库）另做过一次性的随机浏览器差分（脚本/种子未纳入仓库）：未再发现状态机 bug，唯一不一致是已声明的 foster parenting（不建树）；另有命名实体子集限制（`&notit;` 等）。差分只证明这些边界与 Chromium 一致，不证明完整 tree construction 或真实部署。
56. **HTML 非空元素的自闭合被误当成空元素（第三代专项）。** `trackHtmlChildStart()` 用 `!tag.selfClosing` 决定是否压栈，导致 `<div/>`、`<span/>`、`<p/>` 在 HTML 内容/集成点中不进入祖先栈，产生 canonical/资源漏检或误报。按 HTML 规范，self-closing flag 只对 void 元素和 foreign 元素生效，HTML 非空元素的 `/` 仅报解析错误、元素保持打开。修复后 `<div/>` 等正常压栈，foreign `<g/>`/`<foreignObject/>`/`<mtext/>`/嵌套 `<svg/>` 仍按外域语义自闭合。**判别用例**：SC1-SC5、SC9-SC15 中依赖 HTML 子元素栈的用例，以及 I1-I3/I5-I7；其余自闭合矩阵条目是回归锁定（旧实现也通过），不当作本次修复证据。oracle 期望来自 Chrome+Edge 双引擎一致结果。
57. **EOF 不完整标签：本轮的改动是注释、文档与 oracle/回归锁定，不是策略变更。** `parseStartTag()` 在标签名/属性/引号中遇到 EOF 返回 null、主循环丢弃剩余输入；核对 WHATWG tokenizer：EOF-in-tag 只 emit EOF token，未完成开始标签不会 emit，tree builder 不插入元素、标签字符也不变成文本；`<`/`</` 后直接 EOF 才保留为文本；title/script 的 raw text 保留。该策略在上一版已实现并与浏览器 DOM 等价，本轮补齐 EF1-EF12 浏览器事实、手写 EOF 文本断言和注释/文档说明。**注意**：fixture 只存 canonical/title/script/img/base 四类事实；“`</`/`<` 保留为文本、title/script raw text 保留”由本地断言覆盖，未纳入 fixture。
58. **集成点 HTML 结束规则/外域 template/隐式 p 关闭（独立审查发现并修复）。** (a) `applyHtmlEndRule` 之前边扫边弹，遇到 special 元素时已破坏 HTML 子栈，导致 `</strong>`、`</span>` 等错误结束标签把未闭合 HTML 子元素弹掉，`</foreignObject>` 被误当外域命中；改为非破坏性查找，只有命中同名 HTML 元素才截断栈，special 不匹配直接忽略。(b) 外域元素 `<template>` 的 `</template>` 误触发 HTML template 隔离栈恢复；删除 matched 分支里的 template 处理，HTML template 只由专门分支关闭。(c) 新增 `textVisibleNow()`，避免外域/不渲染集成点里的 `<` 进入可见文本。(d) 用最小 `P_CLOSING_START_TAGS` 近似浏览器隐式关闭 `<p>`，修复 `<p><div>` 后 `</foreignObject>` 被吞导致的 canonical/资源误报（仍不做完整树构建）。I1-I7 oracle（Chrome+Edge）锁定。
59. **外域结束标签回退的 scope 边界与「被浏览器丢弃的开始标签」（独立审查发现并修复）。** (a) `popHtmlAncestor` 用 `lastIndexOf` 跨过 table/object/marquee/applet/select/caption/td 等 scope 边界找同名 HTML 祖先，导致 `<div><table><svg></div><link ...>` 把浏览器中的 SVG link 误判为 HTML canonical；改为复用非破坏性 HTML 结束规则，碰 special/scope 边界即停止。(b) 浏览器在 body 上下文会丢弃的 `tr/td/th/thead/tbody/tfoot/caption/colgroup/html/head/body/frame/basefont/bgsound` 曾被压进 HTML 祖先栈，挡住 `</foreignObject>`，产生假 canonical/资源；现统一不追踪。(c) select 插入模式做最小近似：嵌套 select 关闭旧 select 并忽略 token，input/keygen/textarea 关闭 select 后继续处理，其余标签在 select 内大多忽略。(d) 可见文本修正：隐藏集成点内 xmp/textarea/plaintext 不计入，foreignObject 内 CDATA 计入。J1-J6 oracle（Chrome+Edge）锁定。仍不做完整 table/select/格式化元素建树。
60. **probe.mjs 的 `--timeout` 只做 `Number()` 转换，缺少严格校验。** 空值/非数字会变成 `NaN`，负数/0/小数会进入 `setTimeout`/`AbortSignal.timeout`，超范围值会被 Node 截断或抛 `RangeError`；参数错误还可能先发起网络请求，被误读成网络连接失败。现在在 argv 解析后、任何 fetch/wrangler 调用前校验：只接受 1..2147483647 的有限正整数；非法值输出中文用法错误并以退出码 2 结束，不输出半截 JSON。默认 15000 和合法值行为不变。测试覆盖不传 `--timeout`、合法正整数、`abc`、`-1`、`0`、`1.5`、`2147483648`、缺值、空字符串；用 fake wrangler 的调用日志确认非法参数没有进入 wrangler/部署阶段，并断言耗时短、stderr 不含网络失败措辞。
61. **按真实部署记录补齐的可用性与证据缺口。** (a) `detect-project` 新增 `spaRouting`（hash/history/unknown/mixed），HashRouter 建议 `static` + 404.html，history 路由建议 `spa` + 显式 fallback；**没有路由证据时 `suggestedMode=unknown`，nextSteps/human/risk 都要求人工确认，不默认 spa**；mixed 同样返回 unknown。避免 hash SPA 被误套 spa 后 404 结论相反。(b) `verify-deployment` 对连接类瞬时错误默认重试 1 次（`--retries 0..3`），HTTP 4xx/5xx、证书/DNS 解析错误、脚本自身单次超时不重试；失败项带 `attempts`/`errorKind`，detail 区分网络失败与 HTTP 断言失败。(c) 首页没有 canonical/meta robots/X-Robots-Tag 时新增 `seo` warn，不改退出码；报告模板要求 Cloudflare 与 GitHub Pages 并存时明确 self-canonical 或 noindex。(d) Pages 缺顶层 404.html 的说明补充官方文档依据，并明确“实际回退通常 200、官方未写状态码、缺失静态资源也会回退 HTML”。(e) 文档补充：`canBuild=true` 不验证项目 build、TS 祖先 @types 污染、Wrangler Source commit 取 cwd、Pages 项目名不等于 `*.pages.dev`、浏览器冒烟必须单独做。测试新增 HashRouter/BrowserRouter/Vue/深层/字符串/mixed 路由识别、重试 7 例、SEO 2 例，共 742 项。
62. **真实使用反馈：构建产物配对、产物同一性、代码托管链路。** (a) `detect-project` 不再把条件分支里的 `outDir` 直接配给 `scripts.build`：收集 build 脚本和 outDir 候选，动态/条件配置或存在多个候选时回退到 build/框架默认值，`outputDir` 标 `inferred` 并写入 risk/unknown；hangla 的 `npm run build` + `build:web`/`dist-web` 现在得到 `dist`（inferred）而不是错误的 confirmed。新增 `vite-multi-build` 夹具与断言。(b) `verify-deployment` 新增 `--dist`：从首页 HTML 取同源资源，映射到本地构建目录，比较线上响应体与本地文件的 SHA-256；不一致判 `fail`，映射不到/取不到写 `warn`，结果字段含 `compared`/`mismatched`/`missingLocal`/`unfetched`。测试覆盖一致与篡改两例；报告模板新增“部署产物 = 本轮构建”必填行。(c) `probe.mjs` 新增 `--repo`：检查 git remote + `git ls-remote`（10 秒超时）、打印脱敏代理变量；代码托管失败标 `warn`（不把 Cloudflare API 通误报成整条链路 ready）。Cloudflare API 连接类错误重试 1 次，账号/登录仍 fail-closed。(d) 文档补充 `wrangler login` 交互等待时间、浏览器冒烟最小清单/动画测量陷阱、产物未变时的轻量路径，以及部署记录的“历史快照/需复核”标记。

## CLI / JSON 兼容性

| 变化 | 性质 | 原因 |
|---|---|---|
| `--plan` / `--wrangler-version` / `--pages-wrangler-major`、`--cors-method` / `--cors-headers` / `--cors-credentials` | 新增可选参数 | 不传时行为与旧版一致（默认 Free 20,000）；预检不再用默认方法/请求头探针（见下方 CORS 行为变化） |
| `verify-deployment --dist <dir>` | 新增可选参数 | 不传时不新增 `artifact` 检查，旧行为不变；传了才比较首页同源资源的 SHA-256，不一致判 `fail` |
| `probe --repo <dir>` | 新增可选参数 | 不传且当前目录不是 git 仓库时只 `skip`；不改变账号/网络检查的 fail-closed 语义，新增代码托管 `warn` 可能让 `limited` |
| `--expect-json` 从「字符串包含」改为「JSON 子集比较」 | **行为变化（必须）** | 字符串包含无法判断 JSON 结构，且会因格式/顺序误判；现在要求合法 JSON，失败时给出字段路径和原因。旧的非 JSON 片段用法不再支持 |
| `cors-preflight` 断言不成立时从 `warn` 变 `fail` | **行为变化（必须）** | 原来只要 OPTIONS 2xx + 有 ACAO 就通过，会把配置错误的接口判成可用 |
| `tests/` 新增 `browser-diff.mjs` + `fixtures/html5-oracle.json` | 新增可选的开发期差分工具 | 默认测试仍是 `node tests/run-tests.mjs` 零依赖；`browser-diff` 需要本机 Chrome/Edge 与 Node 22+（全局 WebSocket），找不到浏览器时退出码 2 跳过。fixture 的期望值来自真实浏览器，不是自制 parser |
| `resourceReferences()` 改为元素白名单；`srcset` 按 WHATWG 算法 | **行为变化（必须）** | 非资源属性（`<div src>` 等）不再被探测；srcset 的 data URI/逗号/畸形 descriptor 不再误拆或漏候选；影响 verify 的 `assets` 与 check-build 的资源检查 |
| `canonical` 的 HTML 命名空间判定扩展 | **行为变化（必须）** | SVG `title`/`desc`/`foreignObject`、MathML `mi`/`mtext`、annotation-xml encoding=text/html 等集成点内部的 `<link>` 在浏览器里是 HTML 元素，必须计数；相反 SVG/MathML 外域里的 `<link>` 不能计数 |
| `check-build.mjs` 新增 `plan` / `summary.fileLimit` / `summary.effectivePlan`；`verify-deployment.mjs` 新增 `corsOptions` / `expectJsonMode` / `jsonComparison` / `expectedJsonError` / `httpStatus` 等字段 | 只增字段，向后兼容 | 原字段名、类型与 `schemaVersion` 保持不变；`expectedFound`、`status`、`checks`、`summary` 均保留原语义 |
| `probe.mjs --deploy` 的 `deploy` 检查新增 `verified` / `http` | 只增字段，向后兼容 | 让「部署成功但没做线上验证」可被机器识别 |
| `check-build.mjs` 把输出 JSON 后的 `process.exit()` 换成 `process.exitCode` + 主模块守卫 | 内部实现 | 规避 Windows 上偶发的 0xC0000409；退出码语义不变。参数校验的早退路径仍用 `process.exit(2)`，在 Windows 连跑 5 次稳定返回 2 |
| `--target pages` 或 `--target workers` | 新增可选参数 | 放宽条件按部署目标分流；非法值退出码 2 |
| `--plan paid` 不带 `--target` 不再放宽到 100,000 | **行为变化（必须）** | Pages 与 Workers 的启用条件不同；无法确认目标时不能擅自套用其中一套。旧调用需补 `--target`，结果里的 `plan.missing` 会写明 |
| `check-build.mjs` 的 `plan` 新增 `target` / `requirement`，`summary` 新增 `target`；`resolvePlan()` 支持 `wranglerVersion` 并保留 `wranglerMajor` | 只增字段，向后兼容 | `declared` / `effective` / `limit` / `basis` / `missing` / `note` 与 `schemaVersion` 不变；`basis` 文案从 `Wrangler v4` 改成实际解析到的版本字符串 |
| `check-build.mjs` 新增导出 `parseVersion` / `compareVersions` | 只增导出 | 供测试直接覆盖边界；`main()` 有主模块守卫，import 不会触发真实检查 |
| `verify-deployment.mjs` 的 `assets` 检查新增 `warnings` / `redirects`，`probed[]` 新增 `chain` / `finalUrl` / `finalStatus` / `crossHost` / `level` / `reason` | 只增字段，但状态语义变化 | 3xx 不再直接算通过：同主机最终 2xx 仍 `pass`、跨主机变 `warn`、最终 4xx/5xx 与循环变 `fail`。`checked` / `total` / `limited` / `broken` / `probed` 保留 |
| `cors-preflight` 的允许判定按 Fetch 规范收紧 | **行为变化（必须）** | `GET/HEAD/POST` 缺 `Allow-Methods` 现在通过（CORS-safelisted）；带凭据的 `*` 现在失败；`Authorization` 不再被 `*` 覆盖；方法名大小写敏感。`issues` 里写明具体哪个响应头不符 |
| `cors` 检查新增 `credentials` 字段 | 只增字段 | 带 `--cors-credentials` 时 `ACAO: *` 判 `fail`，不再只看服务器有没有回 ACAC |
| `root` 检查新增 `redirectOutcome` / `verified` / `redirectTarget` / `httpStatus`，`hops[]` 新增 `redirect` / `next` / `protocolChanged` | 只增字段，但状态语义变化 | 跨源重定向不再跟随、不再判 `pass`；检查状态仍放 `status`，HTTP 状态码改放 `httpStatus`（`status` 会被 `add()` 的核心字段覆盖，不能复用） |
| `assets` 的 `broken` / `warnings` / `redirects` 新增 `redirected` / `crossHost` / `level` | 只增字段，但汇总语义变化 | 跨主机 3xx 现在一定进 `redirects`；`probed[].redirected` 不再由链长度推断 |
| `cors` 检查新增 `credentialsMode` / `credentialsDeclaredByUser` | 只增字段 | **行为变化（必须）**：无凭据 + `ACAO=*` + `ACAC=true` 从 `fail` 变 `pass`；带凭据 + 精确 ACAO + 缺 ACAC 从 `pass` 变 `fail` |
| `scripts/redirect-policy.mjs` | 新增内部纯函数模块（零第三方依赖） | 主站与资源共用同源判定；不新增 CLI 参数、不新增对外功能 |
| `root` 检查新增 `limitHop` | 只增字段，但跳数语义变化 | 最多跟随 5 次同源重定向并额外请求最终地址；第 6 次重定向判 `loop-or-limit`，未跟随那一跳放在 `limitHop`。`hops` 仍表示「已跟随链 + 最终响应」，原有字段与 `schemaVersion` 不变 |
| `canonical` 检查新增 `sameProtocol` | 只增字段，但状态语义变化（必须） | 主机和路径相同但协议不同的 canonical 从 `pass` 变 `warn`，detail 点名协议不一致；`href` / `sameHost` / `samePath` 与路径规范化规则不变 |
| `canonical` 检查新增 `hrefState`（`missing` / `empty` / `valid` / `invalid`），缺失时 `href` 为 `null`；缺 href / 空 href / 无法解析从「可能误判 self」改为明确 `fail` | 只增字段，但状态语义变化（必须） | 空值不再经 `new URL("", base)` 解析成当前站点；`sameProtocol` / `sameHost` / `samePath` 只在 `hrefState=valid` 时出现；支持单引号 / 双引号 / 不带引号三种合法属性值 |
| `root` / `backup` / `assets` 的跳记录 / `index-redirect` 新增 `statusClass`（`success` / `redirect` / `not-modified` / `unexpected-3xx` / `error`） | 只增字段 | 主站链、资源探针、`/index.html` 共用 `classifyStatus()`；304 与少见 3xx 不再被当成重定向 |
| `root.redirectOutcome` 新增 `not-modified` / `unexpected-3xx`；`/index.html` 的 `index-redirect` 新增 `httpStatus` / `statusClass` / `location` / `redirect` / `redirectKind` | 只增字段，但状态语义变化（必须） | 主站 304 判 `fail`、少见 3xx 判 `warn`；`/index.html` 304 不再可能是 `pass`。HTTP 状态码用 `httpStatus`，避免与检查结论 `status` 同名被覆盖 |
| `assets` 汇总对 304 / 少见 3xx 的归类 | 只增语义细化 | 304 进 `broken`（`level=fail`）且不进 `redirects`；少见 3xx 进 `warnings`（`level=warn`）且不进 `redirects` |
| `scripts/redirect-policy.mjs` 新增导出 `REDIRECT_STATUSES` / `classifyStatus()` | 只增导出 | 供主站链、资源探针和 `/index.html` 共用同一 3xx 分类规则；不新增 CLI 参数 |
| `404` / `spa-fallback` / `api` 检查新增 `httpStatus` | 只增字段 | 这些检查的附加字段原来也叫 `status`，会被检查结论覆盖，JSON 里根本读不到真实 HTTP 状态码；`status` 的语义（pass/warn/fail）不变 |
| `index-redirect` 新增 `convergesToRoot` / `targetPath` / `next`，跨源 / 非 HTTP(S) / 其他路径不再判 `pass` | 只增字段，但状态语义变化（必须） | 原来任何可解析 3xx 都判通过；现在只有同源且目标是站点根才通过，其余只告警 |
| `assets` 检查新增 `ignored`；首页引用先解析再按 protocol + origin 过滤 | 只增字段，但请求行为变化（必须） | 伪装成相对地址的跨源 URL 不再被请求；`javascript:` 等非 HTTP(S) 引用不再被当资源探测 |
| `verify-deployment.mjs` 对非法 `--api` / `--expect-404` / `--timeout` / `--assets-limit` / `--backup` 以退出码 2 结束 | **行为变化（必须）** | 原来会崩栈、输出半截 JSON，或把非法 `--assets-limit` 当成 0 个资源判 `pass` |
| `detect-project` 新增 `project.spaRouting`；HashRouter 的 `suggestedMode` 从 `spa` 改为 `static` | 只增字段 + 识别结果修正 | HashRouter 未知路径本来应 404；旧建议会让静态验收与 spa fallback 互相矛盾。history 路由仍建议 `spa` |
| `verify-deployment` 新增 `--retries 0..3`（默认 1）、`retry` 字段、失败项 `attempts`/`errorKind` | **行为变化（默认重试）** | 瞬时连接错误不再直接假失败，但同一 reset 故障的默认退出码/请求数会变；`--retries 0` 可恢复旧行为。HTTP 4xx/5xx、证书/DNS 解析错误、脚本自身单次超时不重试，避免掩盖真实断言 |
| `verify-deployment` 在 canonical/meta robots/X-Robots-Tag 全缺失时新增 `seo` warn | 只增 warn，不改退出码 | 索引策略缺失是公开站点/双站并存的真实风险；不会把“skip”误当通过 |
| `detect-project.mjs` 支持 `wrangler.json` / `wrangler.jsonc` 的 JSON 键值；显式 Wrangler 输出目录优先于框架默认值 | 行为变化 | 旧版只认 TOML，JSON 配置字段全为 null；输出目录现在与实际证据一致 |
| `check-build.mjs` 的资源存在性改为大小写敏感匹配并拒绝 `..` / 绝对路径；读目录 / 读文件异常不再崩栈 | **行为变化（必须）** | Windows 本地大小写不敏感会掩盖部署到 CDN 后的大小写 404；路径逃逸会误判资源存在 |
| `check-env.mjs` 的 Windows 命令加引号、whoami 使用实际解析到的 wrangler；`probe.mjs` 部署失败时 `deploy-cleanup` 记 `skip` | 内部实现 / 状态细化 | 修复含空格项目路径无法执行本地 wrangler、执行失败被写成未登录、没有创建 Worker 却报清理失败 |
| `tests/check-skill.mjs` 忽略 fenced code 示例、支持 BOM 与 YAML 块标量、校验目录名 ASCII、跳过运行期目录 | 内部实现 | 消除结构检查的误报，同时保留代码块外失效路径的检查 |
| `canonical` 识别规则：只统计真正的 `<link rel=canonical>`（`rel` token 精确匹配，忽略注释 / script / style / `data-rel` / `aria-rel`） | **行为变化（必须）** | 旧宽松正则会误识别 `data-rel="canonical"`、`rel="canonicalized"`、注释里的标签，导致 skip 变 pass 或误报重复标签；canonical 的 href / 协议 / 主机 / 路径判定规则不变 |
| 新增内部模块 `scripts/html-scan.mjs` / `scripts/config-scan.mjs` / `scripts/wrangler-auth.mjs` | 只增内部模块（零第三方依赖） | HTML、配置、登录态各自有唯一权威实现；不新增 CLI 参数、不改变分发模型（仍然复制目录 + 纯 `node` 运行） |
| `verify-deployment.mjs` 根路径重定向后的检查基准改为最终 URL；支持 `<base href>` | **行为变化（必须）** | 原来 `/` → `/en/` 后仍按初始 `--url` 检查 404/API/CORS/index/资源/canonical，结果与浏览器不符；现在按最终页面 URL + 第一个 `<base href>` 解析 |
| 只有根最终 200 才做 title/canonical/资源/可见文本检查；`/index.html` 5xx 判 `fail` | **行为变化（必须）** | 4xx/5xx 错误页的 title/canonical 不再冒充站点证据；5xx 不再只给 warn 让整轮 exit 0 |
| 资源引用规则统一为 `resourceReferences()`；新增 `ignored` / `redirectTarget` / `limitReached`，`probed.finalUrl` 语义改为「最后真正请求过的地址」 | **行为变化（必须）** | `<a href>` 导航链接、canonical、`<base>` 不再被当资源；`finalUrl` 不再指向从未请求的地址；跨源/畸形引用只记录不请求 |
| CORS：预检不再发送未提供的方法/请求头，未提供断言时最多 `warn`；简单请求 3xx/4xx/5xx 不判通过；`Range` 可被 `Allow-Headers: *` 覆盖；CORS 参数缺 `--origin` 退出码 2；`--origin` 校验；默认目标按最终站点根 | **行为变化（必须）** | 旧行为会凭空用默认探针导致误判 fail，只声明凭据时又能 pass，且 500 响应 + ACAO 也能 pass；与「没提供的信息不推断」「错误响应不能当通过证据」的文档承诺对齐 |
| `--backup` 与主站同源判 `fail`；`/index.html` 网络失败输出 `warn` | 行为变化 | 同源「备用站」在主站故障时不可用；网络失败静默跳过会让 JSON 里看起来没有这项检查 |
| `check-build.mjs` 解析 `<base href>`；顶层文件名大小写严格；跟随 symlink/junction | **行为变化（必须）** | 与 verify 对同一 HTML 结论一致；Windows 大小写不敏感会掩盖 CDN 404；链接目录不计入会让文件上限与资源检查失真 |
| `check-env.mjs` / `probe.mjs` 登录判定共用 `wrangler-auth.mjs`：新增 `authState`，未知/未登录/执行失败分开；`canDeploy` 只认 `logged-in` | **行为变化（必须）** | 旧 check-env 把 `whoami` 退出码 0 但空输出/`loggedIn:false` 判成已登录（fail-open）；probe 的 Account ID 提取更严格 |
| `check-build.mjs` 资源规则与 verify 统一；目录式 URL、大小写敏感、`%2F` 保护、`checked/total/limited` 提示、realpath 主模块守卫 | **行为变化（必须）** | 导航/目录链接不再误报，无引号引用不再漏检，超 40 条会明示，symlink/junction 安装不再静默不执行 |
| `detect-project.mjs` 先剥离 JS/TOML/JSONC/YAML 注释再读字段；JSONC 结构化解析；`public/index.html` 参与入口发现；`node --inspect` 等参数不当作入口 | 行为变化 | 注释里的 `base`/`main`/`output` 等不再生效；只有 public/index.html 的静态站可识别；启动脚本入口提取更准 |
| `probe.mjs --deploy`：部署 URL 使用 `redirect: "manual"`；部署失败时清理为 `skip` 并提示确认 | 行为变化 | 部署 URL 的 3xx 不能拿别的页面 `ok` 当证据；不再断言「一定没创建 Worker」 |
