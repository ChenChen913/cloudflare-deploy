# cloudflare-deploy

**简体中文** | [English](README.en.md)

一个可复用的 Agent Skill：评估并尽可能把程序项目（静态站、前端、全栈或后端）部署到 Cloudflare Pages 或 Workers；不适用时给出保留外部后端/容器的替代路线。流程是：**先验证链路与可行性** → 识别仓库 → 选产品 → 写计划 → 构建 → 部署到预览 → 用真实 HTTP 请求验收 → 写报告。

> **能力边界**：自动化脚本完整覆盖静态站 / SPA / SSG 的构建检查与 HTTP 验收。SSR / 全栈项目请把本技能当**流程清单**使用：`check-build.mjs` 对它不适用，`verify-deployment.mjs` 只验证 HTTP 层（首页、API、服务端渲染内容）。运行时兼容性、套餐与成本见 `references/runtime-compat.md`；Java/Python/PHP/Ruby/.NET 或前后端混合项目先看 `references/tech-stack-fit.md`，不要假设所有技术栈都能被脚本完整验收。

技能正文使用简体中文。文件名和代码标识符保持 ASCII，是为了跨系统与压缩包兼容；JSON 字段名保持英文，保证脚本可被机器读取。

## 状态

- 格式校验：`quick_validate.py` 通过；仓库自带的 `node tests/check-skill.mjs` 也通过。
- 本地测试：742/742 通过（`node tests/run-tests.mjs`）。
- 真实 Cloudflare 部署：**本自动化测试环境没有执行**（没有账号/Token，Wrangler 未安装）。另一个真实项目的迁移与线上实测经验记录在 `references/migration-guide.md`（带「实测」标注），但那是历史项目的证据，不等于本环境的自动化验证；本地自动化测试也不构成 Cloudflare 账号级部署验证。哪些验证过、哪些没有，见 `tests/results.md`。

## 它能做什么

**第 0 步是熔断，不是可选项**：`scripts/probe.mjs` 先验证账号、网络、权限，`blocked` 就硬停；再用 10 分钟判定技术可行性，不可行就把「换依赖 / 换方案 / 换平台」的代价摆出来。构建连续失败 2 次、或单次 15 分钟无进展也要止损。

1. **识别**：框架、构建命令、输出目录、base path、SPA/SSR/API 类型、GitHub Pages 配置、现有 Wrangler 配置、绑定、环境变量键名、PWA、子应用、锁文件、风险信号；每个关键字段标注 `confirmed` / `inferred` / `unknown`。
2. **选型**：给出 Pages / Workers 候选和置信度，由 DNS、部署方式、未来后端需求决定，不凭框架名拍板。
3. **计划**：写清改动和回滚；DNS、自定义域名、生产密钥、数据库、删除、不可逆配置必须先确认。
4. **构建检查**：部署前按站点模式、套餐和部署目标检查产物。默认 Free 20,000 文件；`--plan paid --target pages` 要 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`，`--plan paid --target workers` 要 Wrangler >= 4.34.0，才按 100,000。目标未知、版本非法或证据不足一律退回 20,000 并给 `warn`；`ssr` 明确报告「不适用」。
5. **部署**：先到 `pages.dev` / `workers.dev` 或预览分支。
6. **验收**：首页（只自动跟随同源重定向，最多 5 次并额外请求最终地址；跨源、协议变化、非 HTTP(S) 目标不请求，只记录并分类；3xx 里只有 301/302/303/307/308 是重定向，304 与其他 3xx 单独分类；只有最终 200 才做内容检查）、按模式判定的 404/回退、资源（HTML 由共享 tokenizer 解析，注释/script/style/textarea/template 内的伪标签不算；只取真实子资源属性，按 `<base href>` / 最终页面 URL 解析；304 不进入重定向链）、响应头、canonical/noindex（href 缺失 / 空值 / 无法解析分别判失败；只统计真正的 `<link rel=canonical>`）、CORS（预检只发送显式提供的方法/请求头，未提供的断言只进 `notChecked`；CORS URL 非 2xx/重定向不判通过）、备用站独立性、DNS、数据、性能，按项目类型选择；`ssr` 额外检查服务端渲染内容（RAWTEXT 不计入可见文本）、单次 TTFB 和 `--api` 接口的状态 / JSON 结构。
7. **报告**：每项写 通过/失败/警告/未验证，不编造没跑过的测试。

## 目录

```text
cloudflare-deploy/
├── SKILL.md                  # 主流程、路由、安全边界
├── README.md                 # 中文版（本文件，默认展示）
├── README.en.md              # 英文版
├── references/
│   ├── prerequisites.md      # 账号、Token、Account ID、Node、Wrangler、R2
│   ├── console-paths.md      # 登录后的控制台路径
│   ├── cross-platform.md     # Windows / macOS / Linux / WSL / 容器 / CI
│   ├── platform-selection.md # Pages vs Workers、额度、价格
│   ├── runtime-compat.md     # 可行性判定、ORM × 运行时、成本、止损线
│   ├── tech-stack-fit.md     # 非 JS/TS 后端、Containers、混合项目的选型与边界
│   ├── deployment-workflows.md
│   ├── pages-runtime.md      # 响应头、重定向、404/SPA、缓存、CORS
│   ├── github-pages-backup.md
│   ├── verification.md
│   ├── troubleshooting.md
│   ├── security.md
│   ├── seo-indexing.md
│   └── migration-guide.md    # 迁移阶段 + Jekyll 实战数据
├── scripts/
│   ├── probe.mjs             # 第 0 步：链路探针
│   ├── deploy-verdict.mjs    # 探针 --deploy 的可测判定逻辑
│   ├── redirect-policy.mjs  # 重定向同源判定（纯函数，主站与资源共用）
│   ├── net-retry.mjs        # 瞬时网络错误分类（verify 重试用，纯函数）
│   ├── html-scan.mjs         # 共享 HTML tokenizer（注释/RAWTEXT/RCDATA/template、字符引用）
│   ├── config-scan.mjs       # 配置注释/JSONC/TOML 读取（detect-project 用）
│   ├── wrangler-auth.mjs     # 登录态判定的唯一权威（check-env 与 probe 共用）
│   ├── detect-project.mjs
│   ├── check-env.mjs
│   ├── check-build.mjs
│   └── verify-deployment.mjs
├── templates/
│   ├── deployment-plan.md
│   ├── deployment-report.md
│   ├── wrangler.workers.jsonc
│   └── wrangler.pages.toml
├── deployment-notes/
│   ├── hangla-2026-11-14.md  # 真实项目部署记录（Cloudflare Pages Direct Upload）
│   └── assets/hangla-home.png # 部署后的实际页面截图
└── tests/
    ├── run-tests.mjs
    ├── check-skill.mjs      # 结构自检：frontmatter、引用路径、绝对路径
    ├── browser-diff.mjs     # 可选：真实 Chrome/Edge CDP 差分（Node 22+，不参与默认套件）
    ├── fixtures/
    │   ├── loopback-tls.mjs # 本地 HTTPS 验收测试用的自签回环证书（非真实凭据）
    │   └── html5-oracle.json # Chrome/Edge 录制的 HTML5 解析 DOM facts（115 例）
    ├── last-run.txt         # 最近一次测试输出（由测试自动生成）
    └── results.md
```

## 真实部署记录

`deployment-notes/` 只存放**真实项目部署记录**，与自动化测试记录、技能文档分开：

- **真实部署记录**：[hangla 部署记录](deployment-notes/hangla-2026-11-14.md)（Cloudflare Pages Direct Upload；含实际 URL、验收结果、问题与后续完善）。
- **自动化测试记录**：[tests/last-run.txt](tests/last-run.txt) 和 [tests/results.md](tests/results.md)（由本地测试生成/维护，不代表线上部署）。
- **技能文档**：[SKILL.md](SKILL.md)、[references/](references/)（流程、模板和检查规则，部分规则引用 Cloudflare 官方文档，但本身不是部署验证）。

目前有两份真实 **Pages Direct Upload** 经验：hangla 记录和 `references/migration-guide.md` 的 Jekyll 项目；Git 集成、Workers、Containers、Java/Python 后端、其他套餐/项目类型尚未在本仓库记录中验证。不要把 Pages 经验当成对所有 Cloudflare 部署方式都已验证。

## 前提条件

| 条件 | 用在哪 | 怎么查 |
|---|---|---|
| Cloudflare 账号 | 全部 | `dash.cloudflare.com` 注册，验证邮箱 |
| Wrangler 登录 | 部署 | `npx wrangler whoami` |
| Account ID | API Token / CI | Account Home → 搜索 “Copy account ID” |
| Node.js | 脚本最低 18；部署建议 22+ | `node -v` |
| Git | 仓库操作 | `git --version` |
| 域名 / DNS | 只有绑自定义域名 | NS 在哪、CAA 记录 |
| R2 订阅 | 只有用 R2 | Storage & databases → R2 开通 |
| Docker | 只有用 Containers 且本地构建/推送镜像 | `docker info`（可用预构建镜像、CI 或 Workers Builds 构建，不强制本地 Docker；Containers 必须 Workers Paid） |
| 账号套餐 / 订阅 | 用付费能力时 | Manage Account → Billing → Subscriptions |
| GitHub CLI | 可选的仓库自动化 | `gh auth status` |

Wrangler 官方支持 **Windows 11**、**macOS 13.5+**、**Linux glibc 2.35+**。远程 SSH、容器、Codespaces 用 `npx wrangler login --device`；CI 用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`。详见 `references/prerequisites.md` 和 `references/cross-platform.md`。

## 安装

用户级技能目录：

```powershell
# Windows：目录联接，不需要管理员
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.workbuddy\skills\cloudflare-deploy" `
  -Target "C:\path\to\cloudflare-deploy"
```

```bash
# macOS / Linux
ln -s /path/to/cloudflare-deploy ~/.workbuddy/skills/cloudflare-deploy
```

没有链接权限时直接复制目录；改完再复制一次。

## 使用

触发说法：

- 帮我把这个 GitHub 项目部署到 Cloudflare
- 这个项目适合 Pages 还是 Workers
- 检查当前 Cloudflare 部署有没有问题
- 帮我保留 GitHub Pages 作为备用站
- 检查部署后的页面、路由和静态资源
- 帮我修复部署失败

Agent 先运行 `scripts/probe.mjs --repo "$PWD"`（退出码表达链路结论，包含代码托管检查），链路通了再运行 `scripts/detect-project.mjs` 识别项目；构建或部署前运行 `scripts/check-env.mjs`（同样用退出码表达结论），只读当前任务需要的 reference，填 `templates/deployment-plan.md`，部署到预览，运行 `scripts/verify-deployment.mjs`，最后填 `templates/deployment-report.md`。

## 脚本

零依赖的 Node 18+ ESM（部署本身仍建议 Node 22+）；默认只读，`probe.mjs --deploy` 例外（会真实创建并删除临时 Worker，需先征得同意）。`probe.mjs --timeout` 必须是 1..2147483647 的有限正整数（毫秒），空值、非数字、负数、0、小数、超范围值都会在发起任何网络探测前以退出码 2 报中文用法错误：

```bash
node scripts/probe.mjs --repo "$PWD"            # 第 0 步：0 ready / 1 limited / 2 blocked
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs                     # 0 可部署 / 1 不可部署 / 2 不可构建
node scripts/check-build.mjs --dir dist --mode static [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0]   # 或 ssg / spa；ssr 报 skip
node scripts/verify-deployment.mjs --url https://site.example.com --mode static --json [--retries 1]
```

`--mode` 决定 404 的判定：`static` / `ssg` 要求未知路径 404；`spa` 要求返回 app shell；`ssr` 通常 404，返回 200 只报警告。构建检查和验收必须用同一个值。`detect-project` 会识别 HashRouter（建议 static + 404.html）与 BrowserRouter/history 路由（spa + 显式 fallback）；**没有任何路由证据时返回 `unknown`，要求人工确认，不默认推荐 spa**。`verify-deployment` 默认对连接类瞬时错误重试 1 次（`--retries 0..3`）……，HTTP 4xx/5xx、证书/DNS 解析错误和脚本自身单次超时不重试；连接超时/重置可重试。detail 会区分网络失败和 HTTP 断言失败。

`check-build.mjs` 默认按 Free **20,000** 文件检查。Paid **100,000** 的启用条件按部署目标分流：`--target pages` 要 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`（Pages 专属变量）；`--target workers` 要完整版本 **Wrangler >= 4.34.0**（官方 Workers Limits），不需要 Pages 变量。版本按点分数字比较（`4.9.0 < 4.34.0`），`4.x` 等非法版本视为未确认；不传 `--target`、证据不足都退回 20,000 并给 `warn`，结果里写明目标、生效上限与原因。

CORS 预检只断言显式提供的 `--cors-method` / `--cors-headers` / `--cors-credentials`，其余写进 `notChecked`；按 Fetch 规范，`*` 只在无凭据请求里作通配，`GET/HEAD/POST` 是 CORS-safelisted method，`Authorization` 不被 `*` 覆盖，方法名大小写敏感。**`--cors-credentials` 是用户声明的预期请求模式**：脚本只发 GET / HEAD / OPTIONS，不会真的带浏览器 Cookie 或身份凭据；响应里出现 `Access-Control-Allow-Credentials: true` 也不会把无凭据请求变成带凭据请求。只有显式声明带凭据时，才要求 `ACAO` 精确匹配 Origin 且必须有 `ACAC: true`。

主站与资源都只自动跟随**同源**（协议 + 主机 + 端口，见 `scripts/redirect-policy.mjs`）重定向，共用 `MAX_REDIRECTS=5` 的跳数语义：最多跟随 5 次重定向，并额外请求一次第 5 次重定向指向的最终地址；该地址仍返回 3xx（第 6 次重定向）就判「超出跳数 / 循环」，且不请求它的目标。跨源、协议变化（含 HTTP ↔ HTTPS）、非 HTTP(S) 协议、Location 缺失/含 userinfo/无法解析都不请求目标，只记录 Location / 状态码 / 重定向链，避免把验收请求带去 `127.0.0.1`、内网或云元数据地址。主站结果用 `redirectOutcome` 区分同源验证成功、跨源目标未验证、循环或超跳数、Location 无法解析、协议不受支持、`not-modified`（304）、`unexpected-3xx`，另有 `no-redirect` / `network-error` / `same-origin-final-failed`；超限时 `limitHop` 记录未跟随的那一跳。3xx 里只有 `301/302/303/307/308` 需要读取 Location；304 与其他 3xx 不进入重定向链、不判通过。主站链、资源探针和 `/index.html` 检查共用 `classifyStatus()`。只有最终 **200** 的首页才做内容检查（错误页的 title/canonical 不作为站点证据）；`/index.html` 5xx 判失败。

HTML 由共享 tokenizer（`scripts/html-scan.mjs`，显式状态机、零依赖）解析：注释、RAWTEXT（script/style/xmp/iframe/noembed/noframes/noscript）、RCDATA（title/textarea）、template 惰性内容、属性值和畸形标签里的伪标签都不会被当成真实 HTML 元素。**HTML 命名空间里的非空元素即使写成 `<div/>`、`<span/>` 也不会关闭**（self-closing 只对 void 元素和 foreign 元素生效）；EOF 处未完成的开始标签按浏览器行为丢弃，不产生元素、也不并入可见文本（`<` / `</` 单独出现仍是文本，script/title 的 raw 文本保留）。**script data 按规范处理 escaped / double-escaped 状态**（`<!--<script></script>-->` 里的第一个 `</script>` 不关闭元素）；**DOCTYPE 的 public/system 标识符里的 `>` 按规范 abrupt 结束 DOCTYPE**（不假装引号能保护；残余文本继续按 HTML 解析）；**SVG/MathML 用显式命名空间栈**处理嵌套 svg、foreignObject/desc/title、MathML 文本集成点、`mglyph`、HTML breakout 标签、CDATA、template 隔离和退出后恢复，而不是用两个 depth 计数器。`verify-deployment` 与 `check-build` 共用同一套资源属性规则；**`srcset` 按 WHATWG 算法拆候选**（URL 里的逗号、data URI、逗号后无空格、尾随逗号、畸形 descriptor 都不会误拆/漏拆）。资源引用只取真实元素上的子资源属性（`src` / `srcset` / `poster` / `<object data>` / `<link href>`；`<a href>` 导航链接、canonical、`<base>` 不算资源），字符引用按 HTML 语义解码；相对地址按 `<base href>`，没有 base 时按文档 URL（与浏览器一致，不强行补尾斜杠）。根路径有同源重定向时，404/API/CORS/`/index.html`/资源/canonical 都基于最终页面 URL。`probed.finalUrl` 只表示最后真正请求过的地址，未跟随的目标在 `redirectTarget` / `limitReached`；跨源、畸形引用只记进 `ignored`，不请求。canonical 只统计真正的 HTML 命名空间 `<link rel="canonical">`（`rel` 按 HTML 空白分隔 token 精确匹配，`data-rel` / `aria-rel` / `canonicalized` 不算），href 缺失 / 空 / 无法解析分别判 `fail`，不会把空值解析成当前站点；协议、主机、规范化路径三者一致才算指向自身。CORS 预检只发送显式提供的 `--cors-method` / `--cors-headers`（没提供就不发 ACRM/ACRH，只断言 ACAO，最多 `warn`）；简单请求的 3xx/4xx/5xx 不判通过；`Allow-Headers: *` 不覆盖 Authorization（Range 可被通配）；`--backup` 与主站同源不构成独立入口。`check-env` 与 `probe` 共用登录判定：`whoami` 退出码 0 但输出没有邮箱 / Account ID / 明确登录文本时判 `unknown`，不允许 `canDeploy`/ready，避免 fail-open。参数写错（非法 `--api` / `--expect-404` / `--backup` / `--cors-url` / `--url`、非正 `--timeout`、非正整数 `--assets-limit`、非法 `--origin`、CORS 参数缺 `--origin`、非法 `--retries`）会以退出码 2 报用法错误。`verify-deployment` 默认对连接类瞬时错误重试 1 次（`--retries 0..3`），HTTP 4xx/5xx、证书/DNS 解析错误和脚本自身单次超时不重试；连接超时/连接重置可重试。detail 区分网络失败与 HTTP 断言失败；canonical / meta robots / X-Robots-Tag 都缺失时额外给 `seo` warn（不改退出码）。Cloudflare Pages 缺少顶层 `404.html` 时按官方行为把未知路径回退到 `/`（官方未写状态码，实际通常 200），该回退对缺失静态资源也生效，所以资源检查不能只看状态码。`--expect-json` 按 JSON 子集比较，与字段顺序和空格无关。

SSR / 全栈的 HTTP 基线：

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com --mode ssr \
  --api /api/health --expect-json '{"ok":true}' --json
```

`--expect-json` 必须是一段合法 JSON，按**子集**与响应比较（字段顺序和空格无关，字段缺失 / 值不符 / 无效 JSON 都会给出原因）。这只能验证 HTTP 层；数据库写入、登录会话、第三方回调、冷启动仍需专项验证。

检查备用站与独立 API 的 CORS：

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com \
  --mode static \
  --backup https://owner.github.io/repo/ \
  --origin https://app.example.com \
  --cors-url https://api.example.com/items \
  --cors-method POST \
  --cors-headers "content-type,authorization" \
  --json
```

## 测试

```bash
node tests/run-tests.mjs        # 742 项，分层覆盖（core 298 / adversarial 276 / boundary 43 / combination 5 / unit 120）：识别、套餐与产物、HTML tokenizer / HTML5 状态机、真实 HTTP 验收、CORS、重定向与 SSRF、canonical、3xx、CLI、JSON、链路探针
node tests/check-skill.mjs      # 结构自检，不依赖外部工具
node tests/browser-diff.mjs     # 可选：用本机 Chrome/Edge 做真实解析器差分（Node 22+；无浏览器/Node<22 退出码 2 跳过，不一致退出码 1）
```

测试会创建 30 个合成项目（Vite SPA、Vite+HashRouter、Vite+BrowserRouter、Jekyll、Vite+Supabase、Hono+D1、重依赖 Express、Next.js SSR、monorepo、多锁文件、动态 Vite 配置、多 HTML 入口、Pages Functions、Prisma/Drizzle + Neon、wrangler.jsonc、以及「注释噪声 / 只有 public/index.html / Nuxt ssr:false 与 generate / routeRules / node 启动参数」等配置识别夹具），断言识别结果、证据等级、验收模式与运行时依赖提示，检查 12 个构建产物夹具（含伪资源引用、目录式 URL、`%2F`、srcset 逗号、跨源 base、超 40 条引用、大小写/符号链接），并用 16 台本地 HTTP 服务器 + 1 台本地 HTTPS 服务器真实运行验收脚本——覆盖 HEAD 405 转 GET、SPA / 静态 / SSR 三种 404 判定、瞬时网络错误重试（与 HTTP 失败/超时区分）、独立 CORS 域、重复 canonical、SEO 决策提示、HTML 上下文隔离（注释/RAWTEXT/RCDATA/template/属性值/SVG/MathML/foreignObject）、`<base href>` 与重定向后的最终 URL、304 与少见 3xx、跨源资源引用不请求、500 错误页门控、301 假备用站、`--api` 的 JSON 结构与期望值比较。HTTPS 服务器用仓库自带的自签回环证书（`tests/fixtures/loopback-tls.mjs`，子进程经 `NODE_EXTRA_CA_CERTS` 信任，TLS 校验保持开启，不需要 openssl 或第三方包），让 canonical 协议矩阵能真的以 `https://` 站点执行。

专项回归包括：HTML tokenizer 单元 / 对抗 / 随机组合（注释、bogus comment、CDATA、DOCTYPE、RAWTEXT/RCDATA/plaintext/template、属性值含 `>`、不完整标签、重复属性、字符引用、`<base href>`、可见文本）；**HTML5 状态机专项**：script data 的 escaped/double-escaped/`-->` 回 data/EOF、DOCTYPE 标识符里的 `>` 与 abrupt 结束、SVG/MathML 命名空间栈（嵌套 svg、foreignObject/desc/title、MathML 文本集成点、mglyph、breakout、CDATA、template 隔离、退出恢复、无状态泄漏）、`srcset` 的逗号/data URI/尾随逗号/畸形/重复 descriptor，以及四类问题的组合与 300 组确定性状态组合；**浏览器差分**：`tests/fixtures/html5-oracle.json` 记录 Chrome/Edge 真实 DOM facts 的 115 个用例（HTML 命名空间 canonical/title/script/img/base），默认套件直接对照，`browser-diff.mjs` 可在有浏览器时重新录制/校验；**CLI 与网络边界**：HashRouter/BrowserRouter 模式识别、`verify-deployment` 连接类瞬时错误重试（HTTP/超时不重试）、SEO canonical/meta 缺失 warn、Pages 缺 404 官方默认回退；canonical 上下文隔离矩阵（注释 / script / style / textarea / title / iframe / xmp / noembed / noframes / plaintext / template / 属性值 / 不完整标签 / 真实+伪标签组合）；元数据隔离（伪 title/meta 不算）；资源引用规则与伪引用（src/srcset/poster/object data/link href，导航链接与 canonical 排除，`<base href>`、跨源不请求、`ignored` 汇总）；套餐按目标分流与完整版本比较；CORS 预检矩阵；CORS 简单请求；主站重定向矩阵；资源重定向与汇总一致性；跳数边界；canonical 协议 / href 形态 / rel token 矩阵；`<base href>` 与重定向最终 URL 解析；3xx 状态分类矩阵；配置注释噪声；登录判定 fail-closed；SPA 回退 fail-closed 与 `/index.html` 5xx；check-build 大小写 / `..` / `%2F` / 目录式 URL / 40 条上限 / symlink 主模块守卫 / `<base>` 与 srcset；CLI 参数与模式矩阵；`--expect-json` 结构用例。跨源目标用另一台本地 HTTP 服务器记录收到的请求路径，用来证明脚本**没有跟随**，不访问真实内网地址或云厂商元数据地址。本地假 wrangler 覆盖登录态异常、`--deploy` 的无 URL / 清理失败 / 部署失败 / 跳转响应；部署判定的纯逻辑单独测 URL 解析、HTTP 通过与否和清理告警。

这些测试证明脚本能工作，不证明账号权限、DNS、TLS 或平台行为；HTML5 oracle 用例只证明 tokenizer 在这些边界上与 Chromium 一致，不代表完整 HTML5 tree construction 或真实部署。

## 设计约束

- 链路优先：`blocked` 不往下走；可行性判定在改工程之前，构建不是发现前提问题的手段。
- 渐进披露：`SKILL.md` 只放路由、流程、安全边界；细节按需读 `references/`。
- 一个 reference 一个主题，不重复解释平台行为。
- 识别结果分三层：`confirmed` / `inferred` / `unknown`；部署目标是候选，不是定论。
- 同一个 `--mode` 贯穿构建检查和验收，避免 404 结论互相矛盾。
- 脚本确定性执行并输出 JSON，人类摘要按需输出。
- 解析/判定单一权威：HTML 走 `scripts/html-scan.mjs`，配置走 `scripts/config-scan.mjs`，登录态走 `scripts/wrangler-auth.mjs`，3xx 分类走 `scripts/redirect-policy.mjs`，资源属性规则由 `resourceReferences()` 统一。不在调用方重复实现同类规则。
- 安全失败优先：缺证据不等于通过；登录态、SPA 回退、CORS 预检、资源引用在无法验证时最多 `warn`，不能判 `pass`。
- 不建空目录、不放占位资源。
- 报告必须区分 已验证 / 失败 / 未验证。
- HTML 解析不引入 parse5 等运行期依赖：本技能以「复制目录 + 纯 `node` 运行」分发，没有 package.json / `npm install` 步骤；`html-scan.mjs` 用显式状态机覆盖注释、RAWTEXT/RCDATA/plaintext、template、属性语法与字符引用，代价是不做完整 HTML5 tree construction。

## 限制

- 不能替用户注册 Cloudflare 账号或完成 OAuth。
- CLI 不能代替控制台连接 Git 集成 / Workers Builds。
- DNS、自定义域名、生产密钥、数据库迁移、删除操作必须用户确认。
- SSR / 全栈的脚本能力只到 HTTP 层，`check-build.mjs` 对它不适用。
- 本仓库的自动化测试全部在本机跑合成夹具，没有执行真实 Cloudflare 部署；实战记录见 `references/migration-guide.md`，两者不是一回事。
- HTML tokenizer 不是完整 HTML5 tree builder：不建模隐式闭合、foster parenting、活动格式化元素重建与完整的 foreign content 树构建；SVG/MathML 用显式命名空间栈覆盖根/集成点/MathML 文本集成点/annotation-xml encoding 分支/breakout，但不做其完整树构建；对浏览器会丢弃的 table-internal/structural 开始标签、select 插入模式、HTML 祖先回退的 scope 边界只做最小近似；script data 覆盖 escaped/double-escaped，但仍有历史解析怪癖未覆盖；命名实体只覆盖常用集合（legacy 无分号实体为常见子集）；DOCTYPE 只保证 token 边界，不暴露 force-quirks/compatMode。需要 DOM 级精确结论时人工用浏览器复核。
