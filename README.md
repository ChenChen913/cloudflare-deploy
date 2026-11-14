# cloudflare-deploy

**简体中文** | [English](README.en.md)

一个可复用的 Agent Skill：把 GitHub 项目部署到 Cloudflare Pages 或 Workers。流程是：**先验证链路与可行性** → 识别仓库 → 选产品 → 写计划 → 构建 → 部署到预览 → 用真实 HTTP 请求验收 → 写报告。

> **能力边界**：自动化脚本完整覆盖静态站 / SPA / SSG 的构建检查与 HTTP 验收。SSR / 全栈项目请把本技能当**流程清单**使用：`check-build.mjs` 对它不适用，`verify-deployment.mjs` 只验证 HTTP 层（首页、API、服务端渲染内容）。运行时兼容性、套餐与成本见 `references/runtime-compat.md`。

技能正文使用简体中文。文件名和代码标识符保持 ASCII，是为了跨系统与压缩包兼容；JSON 字段名保持英文，保证脚本可被机器读取。

## 状态

- 格式校验：`quick_validate.py` 通过；仓库自带的 `node tests/check-skill.mjs` 也通过。
- 本地测试：198/198 通过（`node tests/run-tests.mjs`）。
- 真实 Cloudflare 部署：**本自动化测试环境没有执行**（没有账号/Token，Wrangler 未安装）。另一个真实项目的迁移与线上实测经验记录在 `references/migration-guide.md`（带「实测」标注），但那是历史项目的证据，不等于本环境的自动化验证；本地自动化测试也不构成 Cloudflare 账号级部署验证。哪些验证过、哪些没有，见 `tests/results.md`。

## 它能做什么

**第 0 步是熔断，不是可选项**：`scripts/probe.mjs` 先验证账号、网络、权限，`blocked` 就硬停；再用 10 分钟判定技术可行性，不可行就把「换依赖 / 换方案 / 换平台」的代价摆出来。构建连续失败 2 次、或单次 15 分钟无进展也要止损。

1. **识别**：框架、构建命令、输出目录、base path、SPA/SSR/API 类型、GitHub Pages 配置、现有 Wrangler 配置、绑定、环境变量键名、PWA、子应用、锁文件、风险信号；每个关键字段标注 `confirmed` / `inferred` / `unknown`。
2. **选型**：给出 Pages / Workers 候选和置信度，由 DNS、部署方式、未来后端需求决定，不凭框架名拍板。
3. **计划**：写清改动和回滚；DNS、自定义域名、生产密钥、数据库、删除、不可逆配置必须先确认。
4. **构建检查**：部署前按站点模式、套餐和部署目标检查产物。默认 Free 20,000 文件；`--plan paid --target pages` 要 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`，`--plan paid --target workers` 要 Wrangler >= 4.34.0，才按 100,000。目标未知、版本非法或证据不足一律退回 20,000 并给 `warn`；`ssr` 明确报告「不适用」。
5. **部署**：先到 `pages.dev` / `workers.dev` 或预览分支。
6. **验收**：首页（只自动跟随同源重定向；跨源、协议变化、非 HTTP(S) 目标不请求，只记录并分类）、按模式判定的 404/回退、资源（3xx 跟随同源到最终 2xx，跨主机记录并告警）、响应头、canonical/noindex、CORS（预检按 Fetch 规范处理 `*` / 凭据 / 安全列表方法；简单请求的凭据模式只由 `--cors-credentials` 声明）、备用站独立性、DNS、数据、性能，按项目类型选择；`ssr` 额外检查服务端渲染内容、单次 TTFB 和 `--api` 接口的状态 / JSON 结构。
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
│   ├── detect-project.mjs
│   ├── check-env.mjs
│   ├── check-build.mjs
│   └── verify-deployment.mjs
├── templates/
│   ├── deployment-plan.md
│   ├── deployment-report.md
│   ├── wrangler.workers.jsonc
│   └── wrangler.pages.toml
└── tests/
    ├── run-tests.mjs
    ├── check-skill.mjs      # 结构自检：frontmatter、引用路径、绝对路径
    ├── last-run.txt         # 最近一次测试输出
    └── results.md
```

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
| Docker | 只有用 Containers | `docker info`（Containers 还必须 Workers Paid） |
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

Agent 先运行 `scripts/probe.mjs` 和 `scripts/check-env.mjs`（两者都用退出码表达结论），再运行 `scripts/detect-project.mjs`，只读当前任务需要的 reference，填 `templates/deployment-plan.md`，部署到预览，运行 `scripts/verify-deployment.mjs`，最后填 `templates/deployment-report.md`。

## 脚本

零依赖、只读的 Node 18+ ESM（部署本身仍建议 Node 22+）：

```bash
node scripts/probe.mjs                         # 第 0 步：0 ready / 1 limited / 2 blocked
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs                     # 0 可部署 / 1 不可部署 / 2 不可构建
node scripts/check-build.mjs --dir dist --mode static [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0]   # 或 ssg / spa；ssr 报 skip
node scripts/verify-deployment.mjs --url https://site.example.com --mode static --json
```

`--mode` 决定 404 的判定：`static` / `ssg` 要求未知路径 404；`spa` 要求返回 app shell；`ssr` 通常 404，返回 200 只报警告。构建检查和验收必须用同一个值。

`check-build.mjs` 默认按 Free **20,000** 文件检查。Paid **100,000** 的启用条件按部署目标分流：`--target pages` 要 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`（Pages 专属变量）；`--target workers` 要完整版本 **Wrangler >= 4.34.0**（官方 Workers Limits），不需要 Pages 变量。版本按点分数字比较（`4.9.0 < 4.34.0`），`4.x` 等非法版本视为未确认；不传 `--target`、证据不足都退回 20,000 并给 `warn`，结果里写明目标、生效上限与原因。

CORS 预检只断言显式提供的 `--cors-method` / `--cors-headers` / `--cors-credentials`，其余写进 `notChecked`；按 Fetch 规范，`*` 只在无凭据请求里作通配，`GET/HEAD/POST` 是 CORS-safelisted method，`Authorization` 不被 `*` 覆盖，方法名大小写敏感。**`--cors-credentials` 是用户声明的预期请求模式**：脚本只发 GET / HEAD / OPTIONS，不会真的带浏览器 Cookie 或身份凭据；响应里出现 `Access-Control-Allow-Credentials: true` 也不会把无凭据请求变成带凭据请求。只有显式声明带凭据时，才要求 `ACAO` 精确匹配 Origin 且必须有 `ACAC: true`。

主站与资源都只自动跟随**同源**（协议 + 主机 + 端口，见 `scripts/redirect-policy.mjs`）重定向，最多 5 跳并要求最终 2xx；跨源、协议变化（含 HTTP ↔ HTTPS）、非 HTTP(S) 协议、Location 缺失或无法解析都不请求目标，只记录 Location / 状态码 / 重定向链，避免把验收请求带去 `127.0.0.1`、内网或云元数据地址。主站结果用 `redirectOutcome` 区分同源验证成功、跨源目标未验证、循环或超跳数、Location 无法解析、协议不受支持。资源只要收到带有效 Location 的 3xx 就记进 `redirects`（不再用链长度判断），`probed` / `warnings` / `redirects` 三处一致。`--expect-json` 按 JSON 子集比较，与字段顺序和空格无关。

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
node tests/run-tests.mjs        # 198 项：识别、套餐与产物、真实 HTTP 验收、CORS 预检与简单请求、主站/资源重定向、JSON 结构、链路探针
node tests/check-skill.mjs      # 结构自检，不依赖外部工具
```

测试会创建 12 个合成项目（Vite SPA、Jekyll、Vite+Supabase、Hono+D1、重依赖 Express、Next.js SSR、monorepo、多锁文件、动态 Vite 配置、多 HTML 入口、Pages Functions、Prisma/Drizzle + Neon），断言识别结果、证据等级、验收模式与运行时依赖提示，检查 3 个构建产物（无 404 的产物按 static / spa 各查一次）以及 `ssr` 模式的显式跳过，并用 13 台本地 HTTP 服务器真实运行验收脚本——覆盖 HEAD 405 转 GET、SPA / 静态 / SSR 三种 404 判定、独立 CORS 域、重复 canonical、301 假备用站、`--api` 的 JSON 结构与期望值比较。

专项回归包括：套餐按目标分流与完整版本比较（Pages 条件齐全 / 缺环境变量、Workers 4.34.0 / 4.33.0 / Free、目标未知、非法版本号、纯函数文件数边界，不真造两万个文件）、CORS 预检矩阵（允许/拒绝 Origin、缺方法、缺头、凭据错误、204 但无 ACAO、未提供的检查不推断、通配符 × 凭据、Authorization 非通配、安全列表方法、方法大小写）、CORS 简单请求凭据矩阵（`ACAO=*` × ACAC 有无 × 是否声明 `--cors-credentials`）、主站重定向矩阵（同源 301→200 / 302→404、跨主机、127.0.0.1、HTTP→HTTPS、循环、无效 Location、非 HTTP(S) 协议、备用站跳主站）、重定向策略纯函数（含 HTTPS→HTTP）、资源重定向与汇总一致性（直接 200 / 同主机 301 / 跨主机 302 / 循环 / 缺 Location / 协议拒绝，`probed` / `warnings` / `redirects` 对齐）、`--expect-json` 结构用例（键顺序、字段缺失、类型不符、嵌套数组、无效 JSON）。跨源目标用另一台本地 HTTP 服务器记录收到的请求路径，用来证明脚本**没有跟随**，不访问真实内网地址或云厂商元数据地址。本地假 wrangler 验证链路探针在 `whoami --json` 调用失败时不会误判未登录，并覆盖 `--deploy` 的无 URL / 清理失败 / 部署失败；部署判定的纯逻辑单独测 URL 解析、HTTP 通过与否和清理告警。

这些测试证明脚本能工作，不证明账号权限、DNS、TLS 或平台行为。

## 设计约束

- 链路优先：`blocked` 不往下走；可行性判定在改工程之前，构建不是发现前提问题的手段。
- 渐进披露：`SKILL.md` 只放路由、流程、安全边界；细节按需读 `references/`。
- 一个 reference 一个主题，不重复解释平台行为。
- 识别结果分三层：`confirmed` / `inferred` / `unknown`；部署目标是候选，不是定论。
- 同一个 `--mode` 贯穿构建检查和验收，避免 404 结论互相矛盾。
- 脚本确定性执行并输出 JSON，人类摘要按需输出。
- 不建空目录、不放占位资源。
- 报告必须区分 已验证 / 失败 / 未验证。

## 限制

- 不能替用户注册 Cloudflare 账号或完成 OAuth。
- CLI 不能代替控制台连接 Git 集成 / Workers Builds。
- DNS、自定义域名、生产密钥、数据库迁移、删除操作必须用户确认。
- SSR / 全栈的脚本能力只到 HTTP 层，`check-build.mjs` 对它不适用。
- 本仓库的自动化测试全部在本机跑合成夹具，没有执行真实 Cloudflare 部署；实战记录见 `references/migration-guide.md`，两者不是一回事。
