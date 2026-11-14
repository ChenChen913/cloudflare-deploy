---
name: cloudflare-deploy
description: 把 GitHub 项目部署或迁移到 Cloudflare Pages / Workers 的端到端技能。当用户要求部署、托管、迁移到 Cloudflare，选择 Pages 还是 Workers，保留 GitHub Pages 作为备用站，检查部署后的页面/路由/静态资源/CORS/索引，或排查 Cloudflare 部署失败时使用。先用链路探针确认账号与网络、判定技术可行性，再只读识别项目并给出部署方案；对不可逆或影响生产的操作先征求确认；部署到预览地址后用真实 HTTP 请求验收，并在报告中区分“已验证 / 失败 / 未验证”。
agent_created: true
---

# Cloudflare 部署

把 GitHub 仓库变成一次**经过验证**的 Cloudflare 部署。顺序是：**先验证链路与可行性** → 只读识别项目 → 选产品 → 写计划 → 部署到预览地址 → 用真实请求验收 → 写报告。前提不成立就停下来，不要靠「先构建一下看看」去发现问题。

> **能力边界（先读这条）**：自动化脚本完整覆盖静态站 / SPA / SSG 的构建检查与 HTTP 验收。SSR / 全栈项目请把本技能当作**流程清单**使用：`check-build.mjs` 对它不适用，`verify-deployment.mjs` 只验证 HTTP 层（首页、API、服务端渲染内容），数据库写入、登录会话、第三方回调仍需专项验证。运行时兼容性、套餐与成本见 `references/runtime-compat.md`。

## 一、先决条件

执行前逐项确认，缺什么就明确告诉用户缺什么，不要假装能部署。

| 条件 | 是否必须 | 怎么检查 | 缺失时怎么办 |
|---|---|---|---|
| Cloudflare 账号 | 必须 | 浏览器登录 `dash.cloudflare.com` | 去 `dash.cloudflare.com/sign-up` 注册；只需邮箱、密码、邮箱验证 |
| 登录态 | 必须 | `npx wrangler whoami` | 本地 `npx wrangler login`；远程/容器用 `--device`；CI 用 API Token |
| Account ID | API Token / CI 必须 | 控制台搜索 “Copy account ID”，或 Workers & Pages → Account Details | 复制后放进 `CLOUDFLARE_ACCOUNT_ID` |
| Node.js | 必须 | `node -v` | 脚本本身最低 Node 18；完整部署建议 **22+**（Wrangler 只支持 Current / Active / Maintenance，22 是当前仍在维护的最老 LTS） |
| Wrangler | 必须 | `npx wrangler --version` | 项目内 `npm i -D wrangler@latest`，或直接用 `npx wrangler` |
| Git | 必须 | `git --version` | 装 Git；Windows 推荐 Git for Windows（自带 Git Bash） |
| 域名 / DNS | 只有绑自定义域名才需要 | 域名的 NS 在哪、是否有 CAA | Pages 的 apex 需要 NS 在 Cloudflare；子域可用外部 CNAME；Workers 必须 NS 在 Cloudflare |
| R2 订阅 | 只有用 R2 才需要 | 控制台 Storage & databases → R2 | 首次使用要走一次 checkout（免费额度也需开通） |
| GitHub CLI | 可选 | `gh --version`、`gh auth status` | 只影响仓库/DNS 自动化，不影响 `wrangler` 部署 |
| Docker | 只有用 Containers | `docker info` | Containers 需要本地构建镜像；没有 Docker 就直接排除该方案 |
| 账号套餐 / 订阅 | 用付费能力时必须 | Manage Account → Billing → Subscriptions | 免费计划不能用 Containers；R2 首次使用需完成一次 checkout |
| 付款方式 | 只有付费功能才需要 | 控制台 Billing | Pages/Workers 免费额度不要求绑卡；Workers Paid、R2 超额等需要 |

Cloudflare 免费计划注册流程只要求邮箱、密码和邮箱验证，官方文档没有要求绑卡。R2 是例外：首次使用需要完成一次订阅 checkout，即使只用免费额度。

详细前提、Token 权限、Account ID：`references/prerequisites.md`。

## 二、Cloudflare 登录后的路径

只列部署会用到的，完整版见 `references/console-paths.md`。

| 要做什么 | 控制台路径 |
|---|---|
| 看账号 / 复制 Account ID | Account Home，搜索 “Copy account ID”；或 Workers & Pages → Account Details |
| 创建 API Token | My Profile → API Tokens → Create Token（`dash.cloudflare.com/profile/api-tokens`） |
| 创建 Pages 项目 | Workers & Pages → Create application → Pages → Connect to Git / Drag and drop |
| Pages 构建配置 | 选中项目 → Settings → Builds & deployments / Environment variables |
| Pages 运行时变量与密钥 | 选中项目 → Settings → Variables and Secrets |
| Pages 绑定 KV/D1/R2 | 选中项目 → Settings → Bindings |
| Pages 自定义域名 | 选中项目 → Custom domains → Set up a domain |
| Worker 变量与密钥 | Workers & Pages → 选中 Worker → Settings → Variables and Secrets |
| Worker 自定义域名 | 选中 Worker → Settings → Domains & Routes → Add → Custom Domain |
| R2 | Storage & databases → R2 → Overview |
| D1 | Storage & databases → D1（界面标签可能显示为 D1 SQL Database） |
| DNS | Domains → 选中域名 → DNS → Records |
| 账单 | Manage Account → Billing |

> 控制台菜单会改名。路径以 2026-11 的官方文档为准；找不到时用控制台搜索（`Ctrl/Cmd + K`）搜产品名。

## 三、跨系统差异

**部署结果与操作系统无关，但本地工具链和登录方式有关。**

| 系统 | 官方支持 | 推荐终端 | 登录方式 |
|---|---|---|---|
| Windows | **Windows 11** | Git Bash | `npx wrangler login` 会开浏览器；PowerShell 也能跑，但 `curl` 要写 `curl.exe` |
| macOS | **13.5+** | zsh | `npx wrangler login`，凭证可进 Keychain |
| Linux | glibc **2.35+** | bash/zsh | 有桌面浏览器可 `login`；无头服务器用 `--device` 或 API Token |
| 远程 SSH / 容器 / Codespaces | 取决于底层系统 | bash | `npx wrangler login --device`（不依赖 localhost 回调）；容器也可映射 8976 端口 |
| CI | — | — | **不要 login**，用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |

命令差异：

| 用途 | Git Bash / macOS / Linux | Windows PowerShell |
|---|---|---|
| HTTP | `curl -sI URL` | `curl.exe -sI URL` |
| 过滤 | `grep -i x` | `Select-String -Pattern x` |
| DNS | `dig +short example.com` | `Resolve-DnsName example.com -Type A` |
| 证书 | `openssl s_client ...` | 用 Git Bash 的 `openssl` |
| 循环 | `for i in 1 2 3; do ...; done` | `foreach ($i in 1..3) { ... }` |

路径与文件：

- Wrangler 配置里的 `directory` 用正斜杠 `/`，Windows 也认；不要写 `C:\...` 绝对路径。
- 脚本统一用 `node <脚本>` 执行，不依赖 `chmod +x`，三个系统一致。
- Git 建议 `.gitattributes` 设 `* text=auto eol=lf`，避免 Windows 的 CRLF 影响 shell 脚本。
- Windows 的目录联接（junction）和 macOS/Linux 的符号链接都能把技能目录挂到 `~/.workbuddy/skills/`；没有权限时直接复制目录。

详细矩阵、安装命令、WSL/容器注意事项：`references/cross-platform.md`。

## 四、工作流

### 意图路由

| 用户意图 | 做什么 |
|---|---|
| “部署到 Cloudflare” / “迁移这个仓库” | 完整流程，第 0–7 步 |
| “Pages 还是 Workers？” | 只做第 1–2 步（识别 + 选型），给结论，不部署 |
| “检查现有部署” | 第 6 步 + `references/verification.md`，不改文件 |
| “保留 GitHub Pages 备用” | `references/github-pages-backup.md`，再做第 6 步 |
| “部署失败 / 502 / 404 / CORS” | 先 `scripts/probe.mjs`，再 `scripts/check-env.mjs` + `references/troubleshooting.md` |
| “迁数据库 / 后端” | 第 0–3 步；读 `references/runtime-compat.md`、`platform-selection.md`、`migration-guide.md`；数据库操作必须确认 |

### 0. 链路探针与可行性熔断（先于一切工程动作）

部署任务的第一优先级是**链路通不通**，不是产物对不对。碰到项目文件之前先做：

```bash
node "<技能目录>/scripts/probe.mjs"
```

- 退出码 `0` = ready；`1` = limited（先读 warn，判断缺口是否影响本次目标）；`2` = blocked（**硬停**）。
- blocked 时不要改配置、装适配器或跑构建。给出具体下一步（`npx wrangler login`，或 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）；**不要让用户在聊天里粘贴 Token**。
- `npx wrangler deploy --temporary` 只在未登录时可用，用的是临时账号，**不能验证用户的账号、权限或套餐**，且会过期；它只能证明网络可达。
- `--deploy` 会真实创建并删除一个临时 Worker，属于写操作，**必须先得到用户同意**。**部署命令成功不等于线上验证成功**：必须解析到 URL 并真实请求通过才判 `pass`；没 URL 或 URL 不可访问只会得到 `warn` / `fail`，清理失败也会单独记 `warn`；部署本身失败时没有创建 Worker，清理记为 `skip`，不要写成「删除失败」。没有账号时不要声称已验证部署链路。

接着用 10 分钟做**可行性判定**（只查文档，不写代码）：框架有没有适配器且版本匹配？ORM / 驱动能否跑在 workerd（WASM、原生模块、Node API）？体积和套餐够不够？产出「可行 / 不可行 + 依据」。三问、已知不可行组合、现行额度与成本表见 `references/runtime-compat.md`。

- **判为不可行就立刻决策，不要闷头试**：把「换依赖 / 换方案 / 换平台」的代价摆给用户。「本技术栈目前不适合 Cloudflare」也是合格结论。
- **止损线**：同一构建步骤连续失败 2 次，或单次超过 15 分钟无实质进展 → 停止调优，换构建环境或换方案，并说明原因。
- SSR 项目本地 `wrangler dev` 跑通 ≠ 线上跑通；Windows 本地构建适配器失败时，优先走 Git 集成 / Workers Builds 让平台构建。

### 1. 只读识别项目

先解析技能目录（包含本 `SKILL.md` 的文件夹），然后：

```bash
node "<技能目录>/scripts/detect-project.mjs" "$PWD" --human
```

默认输出 JSON；给 `--human` 得到人类可读摘要。脚本会报告：框架、静态/SPA/SSR/API、包管理器、构建命令、输出目录、base path、GitHub Pages 配置、现有 Wrangler 配置（`wrangler.toml` 与 `wrangler.json/jsonc` 都支持）、绑定、环境变量键名、PWA、子应用、锁文件、风险、未知项。

三个字段决定你怎么用它的结论：

- `target.candidates`：候选产品，通常两个都列；
- `target.confidence`：`high`（有 Wrangler 配置或硬阻断）、`medium`（按类型推断）、`low`（没识别出来）；
- `evidence.*.confidence`：每个关键字段是 `confirmed`（来自 package.json 等明确声明或显式 Wrangler 配置）、`inferred`（按配置文件 / 默认值推断）还是 `unknown`。

**`suggested` 只是候选建议，不是部署决定。** 只有 `confidence: high` 且依据是现有 Wrangler 配置时，才可以照着做；`medium` 必须结合第 2 步的三个问题再定。`project.suggestedMode` 给出建议的验收模式，`risks` 会标出需要核对的 ORM / 驱动 / 原生模块——两者都只是**待核对信号**，不是可行性结论。

同时按需读取：`package.json`、锁文件、框架配置、`.github/workflows/*`、`wrangler.*`、`_headers`、`_redirects`、`CNAME`、`.env.example`。**不要为了识别而安装依赖。**

Monorepo 里如果有多个应用，脚本只会列出 `project.workspaces`；先问清楚部署哪个，不要猜。多个锁文件、多个 `index.html`、动态框架配置都属于“需要人工确认”的情况，脚本会写进 `risks`。

### 2. 选择目标

不确定时读 `references/platform-selection.md`。速查：

- **新项目、域名在 Cloudflare、以后可能加服务端逻辑** → Workers + Static Assets。这是 Cloudflare 官方对新项目的默认建议。
- **新项目、纯静态、想要零配置 git push，或 DNS 不在 Cloudflare** → Pages 更省事（子域可用外部 CNAME）。
- **已有 Pages 且运行正常** → 不迁移。
- **静态前端 + Supabase/Firebase/外部 API** → 只迁前端，后端不动。
- **Next.js SSR/ISR** → Workers + vinext/OpenNext，不能当纯静态上传。
- **原生模块、`node:fs`、长驻进程、运行时不受支持** → 直接说明不适合，建议保留原主机或容器，不要硬迁。
- **SSR / 全栈、ORM、数据库驱动** → 先读 `references/runtime-compat.md` 判可行性，再谈部署方式；硬阻断时给「换依赖 / 换方案 / 换平台」的代价，不要强迁。

但**不要只凭框架名决定**。静态站（含 SPA）Pages 和 Workers 都能托管，真正决定的是三个问题：

1. 域名的 NS 是否在 Cloudflare？（Workers 要求 NS 托管；Pages 的子域可用外部 CNAME）
2. 是否要零配置 `git push` 部署？（Pages 的 Git 集成更省事）
3. 以后是否要 Cloudflare 侧后端（D1/DO/Queues/Cron）？（要就直接 Workers）

给出目标时，说明是哪一两个事实决定的，以及哪个问题你还没确认。**同时给出成本档**（免费 / $5 月起 / 按量计费）和套餐前提：Containers 必须 Workers Paid 加本地 Docker，免费计划直接排除。现行额度查官方 Limits / Pricing 页，不要沿用旧数字；见 `references/runtime-compat.md`。

### 3. 写部署计划

填 `templates/deployment-plan.md`。保持一屏以内：可行性结论、当前架构、目标与成本档、部署方式、构建环境、要改的文件、命令、环境变量/密钥、数据/文件/API 影响、GitHub Pages 取舍、风险、**止损线**、回滚。

低风险且符合用户请求时，可以直接继续。碰到下面任何一项，**停下来问**：

- 正式 DNS 记录或 NS
- GitHub Pages 自定义域名（新增、修改、移除）
- 生产环境密钥或变量
- 生产数据库迁移、覆盖、删除
- 删除旧部署、旧分支、旧数据
- 不可逆配置（Pages Direct Upload、重建项目、改仓库名）
- 套餐/计费变更

问之前用一句话说明后果。例如：移除 GitHub Pages 的自定义域名，才能让 `github.io` 成为独立备用站；代价是回滚时要重新添加域名并等证书。

### 4. 预检与构建

```bash
node "<技能目录>/scripts/check-env.mjs"
```

退出码就是结论：`0` 可部署、`1` 可构建但不可部署、`2` 连构建条件都不满足。**不要忽略非零退出码继续往下走。** 只想本地构建、不打算部署时用 `--build-only`。登录缺失会给出准确命令，**不要让用户在聊天里粘贴 Token**。

用项目自己的构建命令，然后检查产物：

```bash
node "<技能目录>/scripts/check-build.mjs" --dir "<输出目录>" --mode "<static|spa|ssg|ssr>" \
  [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0] [--pages-wrangler-major 4]
```

**先定站点模式，再构建检查，最后用同一个模式验收。** 中间换模式，前面的结论就作废：

| 模式 | 用在 | 未知路径的期望 | 产物检查 |
|---|---|---|---|
| `static` | 预渲染的多页站 | 404 | 适用 |
| `ssg` | Hugo / Jekyll / Astro 等生成的静态站 | 404 | 适用 |
| `spa` | 客户端路由（React/Vue/Vite SPA） | 200 + app shell | 适用，不要求 `404.html` |
| `ssr` | 服务端渲染 / 全栈 | 通常 404；200 要确认不是 catch-all | **不适用**，脚本只报 `skip` |

`--spa` 是 `--mode spa` 的旧写法，仍然可用。默认是 `static`，所以 SPA 项目**必须显式传 `--mode spa`**，否则会被当成“缺 404.html”的多页站。SSR 没有可上传的静态产物目录，不要为了凑检查去建一个空目录。

产物检查的补充规则：资源存在性按产物里的**真实文件名大小写敏感**匹配（Cloudflare 区分大小写，Windows 本地不区分）；`..` 逃逸或绝对路径引用直接判坏。`check-build` 只核对显式参数 / 环境变量 / 项目依赖里的套餐证据，账号套餐和 Pages 项目设置仍需人工确认。

**文件数按套餐 + 部署目标判定**：默认 Free **20,000**。Paid **100,000** 只有显式 `--plan paid` 才考虑，且两套产品的启用条件不同，必须用 `--target` 指明：

| `--target` | 放宽到 100,000 的条件 | 依据 |
|---|---|---|
| `pages` | Wrangler v4 构建 + Pages 项目设置 `PAGES_WRANGLER_MAJOR_VERSION=4` | 官方 Pages Limits；该环境变量是 Pages 专属 |
| `workers` | **Wrangler >= 4.34.0**（完整版本比较），不需要 Pages 环境变量 | 官方 Workers Limits：「To use the increased file count limits in Wrangler, you must use version 4.34.0 or higher」 |
| 不传 / 无法确认 | **不放宽**，仍按 20,000 | 不知道该套用哪套条件 |

证据可来自 `--wrangler-version` / `--pages-wrangler-major`、CI 环境变量或项目 `package.json`；非法版本（`4.x`、预发布标签）和只给主版本 `4` 都**不能**证明 Workers 的 >= 4.34.0。证据不足自动退回 20,000 并给 `warn`，结果里写明生效上限、目标与原因。控制台里的账号套餐与 Pages 项目设置本地看不到，仍需人工确认。详见 `references/platform-selection.md`。

部署前修掉阻断项（输出目录不存在、文件数超过**当前生效上限**、单文件 > 25 MiB）。`static`/`ssg` 下缺顶层 `404.html` 是警告但影响很大：Pages 会把整站当成 SPA，验收时未知路径会返回 200。构建失败按第 0 步的止损线处理，不要原样重试。

### 5. 部署

按目标读 `references/deployment-workflows.md`。默认命令：

```bash
# Pages，预构建产物（Direct Upload）
npx wrangler pages deploy "<输出目录>" --project-name "<项目名>"

# Workers + 静态资源
npx wrangler deploy
```

规则：

- 已有脚本/workflow 能正常部署时，复用它。
- 不要新建第二条部署路径和现有流程打架。
- Pages 的 Direct Upload **不可逆**；在 Git 集成和它之间做选择前先确认。
- Git 集成、Workers Builds 是控制台/API 流程，**不要说 CLI 已经连好仓库**。
- 认证或权限不足时停下来，列出需要什么（`wrangler login`，或 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`；Git 集成需要仓库管理员权限）。

### 6. 验收

```bash
node "<技能目录>/scripts/verify-deployment.mjs" --url "<部署地址>" --mode "<static|spa|ssg|ssr>" --json
```

用户要保留备用站时加 `--backup "<github.io 地址>"`；涉及 CORS 时加 `--origin "<前端来源>"`；API 在独立子域时再加 `--cors-url "<接口地址>"`。预检涉及实际方法、请求头或 Cookie 时，显式给 `--cors-method POST`、`--cors-headers "content-type,authorization"`、`--cors-credentials`——**没提供的信息不会被推断**，对应检查会列进 `notChecked`。`--cors-credentials` 只是声明「预期请求带凭据」：脚本不会真的发浏览器 Cookie 或身份凭据，响应里的 `ACAC: true` 也不代表请求带凭据，无凭据时 `ACAO: *` 依旧有效；显式声明带凭据时才要求 ACAO 精确匹配 Origin 且必须有 `ACAC: true`。CORS 断言按 Fetch 规范：`*` 只在**无凭据**请求里是通配符，带凭据时是字面值；`GET/HEAD/POST` 是 CORS-safelisted method，不要求出现在 `Allow-Methods` 里；`Authorization`/`Range` 永远不被 `Allow-Headers: *` 覆盖；方法名大小写敏感（已知方法先规范化为大写）。SSR / 全栈额外加 `--api /api/health --expect-json '{"ok":true}'`（`--api` 可重复传）；`--expect-json` 按 **JSON 子集**比较，与字段顺序和空白无关。

`--mode` 必须和第 4 步一致，否则 404 结论会互相矛盾：

- `static`/`ssg`：未知路径**必须** 404。返回 200 判失败（SPA 回退或 rewrite 吞掉了未知路径）。
- `spa`：未知路径**必须** 200 + HTML，且含有 root 容器或入口脚本。返回 404 是警告（深链刷新会断；hash 路由可接受）。
- `ssr`：未知路径通常 404；返回 200 只给警告，须人工确认是自定义 404 还是 catch-all。额外检查首页服务端渲染的可见文本长度与单次 TTFB——**单次采样不是性能结论**。

脚本检查：首页状态（只自动跟随同源重定向；主站与资源共用 `MAX_REDIRECTS=5`——最多跟随 5 次并额外请求最终地址，第 6 次重定向判超限且主站结果的 `limitHop` 记录未跟随的一跳；跨源、协议变化、非 HTTP(S) 协议、Location 无法解析都不请求目标，用 `redirectOutcome` 区分「同源验证成功」「跨源目标未验证」「循环或超跳数」「Location 无法解析」「协议不受支持」「`not-modified`（304 不是重定向）」「`unexpected-3xx`（少见 3xx 不判通过）」）、模式对应的 404/回退、标题、canonical（重复标签、跨主机、路径不符、**协议不一致**；三者全一致才算指向自身；**href 缺失 / 空值 / 无法解析分别判失败**，不被解析成当前站点；双引号 / 单引号 / 不带引号三种合法写法都支持）、meta robots、同源资源（HEAD 失败自动用 GET 复核；3xx 只有 301/302/303/307/308 跟随同源重定向并验最终 2xx，跨主机只记录并标 `warn`；304 不进入重定向链、判失败；跨源 / 非 HTTP(S) 引用解析后不请求）、响应头、`/index.html` 重定向（只有同源且目标是站点根才判通过；304 / 少见 3xx / 跨源 / 其他路径只告警）、可选 CORS（含预检的 ACAO / Allow-Methods / Allow-Headers / 凭据）、备用站独立性，以及 `--api` 接口的状态 / JSON 类型 / 期望 JSON 子集。三处 3xx 判断共用 `classifyStatus()`，结果带 `statusClass`。

**HTTP 验收不是全栈验收。** `--api` 只证明该接口返回了 JSON 且（给了 `--expect-json` 时）符合期望的 JSON 子集；数据库写入、登录会话、第三方回调、冷启动仍需按 `references/verification.md` 专项验证，没测就写「未验证」。CORS 预检 `notChecked` 里的项同样要写成「未验证」，不要写成「已通过」。

同源资源默认只查首页引用的前 20 个（`--assets-limit` 可调）。结果里的 `probed` 保留每个资源的原始地址、`chain` 重定向链、`finalUrl` / `finalStatus` 和 `crossHost`；只要收到带有效 Location 的 3xx 就记进 `redirects`（同主机与跨主机都算），`probed` / `warnings` / `redirects` 三处一致。首页里的跨源 / 非 HTTP(S) 引用（包括反斜杠伪装的跨源 URL）解析后不请求，只记进 `ignored`。重定向、循环、最终 4xx/5xx 都不会被当成正常；**304 不是重定向，也不代表资源可用**，不进入 `redirects` 且判失败。**报告里要写“检查了 N 个 / 共 M 个”，不能写成“全站资源正常”。**

再按项目类型执行 `references/verification.md` 里的检查。纯静态站不要跑数据库和登录测试。每次修复后重新请求验证；没有新响应，就不能说“已修复”。

### 7. 写报告

填 `templates/deployment-report.md`。包含：部署地址、目标、方式、改动文件、每项检查的 通过/失败/未验证、遗留问题、GitHub Pages 状态、回滚方式。没测过的写 **未验证** 和原因。

## 五、必须遵守的判断

- **链路 blocked 就不往下走。** 环境问题先于工程问题，构建成功不等于能上线。
- **允许得出「不建议迁移」的结论。** 运行时硬冲突时，给换依赖 / 换方案 / 换平台的代价，别闷头试。
- **本地 `wrangler dev` 跑通 ≠ 线上跑通。** 体积上限、TLS/TCP、冷启动、真实 Secrets、本地数据库都不同。
- **`wrangler deploy --temporary` 用的是临时账号。** 不能验证用户的账号、权限或套餐。
- **额度与价格查官方现行页面。** 旧资料里的 3 MB / 10 MB 脚本上限、1,000 子请求都已过时。
- **前端迁了不等于后端要迁。** 默认只迁前端。
- **新站稳定前不要删 GitHub Pages。**
- **`github.io` 301 到自定义域名，就不是备用站。** 必须直接请求确认。
- **`noindex` 不影响访问。** 不要以“备用站要能用”为理由去掉它。
- **Pages 静态资源默认 `Access-Control-Allow-Origin: *`。** 需要收紧时用 `_headers`；Functions 必须在代码里处理 CORS，包括 `OPTIONS`。`ACAO: *` 是否有效取决于**请求的 credentials mode**，不是服务器有没有回 `ACAC: true`；带凭据时 `ACAO: *` 无效，`Allow-Methods` / `Allow-Headers` 的 `*` 也不是通配符，`Authorization` 必须显式列出。
- **资源返回 3xx 不等于资源可用。** 验收用 `redirect: "manual"`，必须跟随到最终 2xx 才算通过；跨主机重定向要记录最终地址并人工确认，循环要判失败。
- **304 Not Modified 不是重定向。** 它不进入重定向链，也不会因为缺少 Location 被报成无效重定向；主站 304 判失败、`/index.html` 304 不能证明收敛到 `/`、资源 304 判失败且不进 `redirects`。其他少见 3xx（如 300）既不跟随也不判通过，单独分类并交人工确认。
- **验收脚本只自动跟随同源（协议 + 主机 + 端口）重定向。** Location 指向别的主机、别的协议或非 HTTP(S) 协议时不请求目标，只记录并分类，避免把请求带去 `127.0.0.1` / 内网 / 云元数据地址；别的网站返回 200 不能给原始站点判 pass，识别备用站跳主站也只需解析 Location。
- **主站、资源、`--backup` 共用 5 次重定向上限。** 5 次重定向后仍要请求最终地址并验最终状态；只有最终地址再返回 3xx（第 6 次重定向）才判超限。「5 次重定向后 404」是最终状态失败，不是跳数超限；边界处出现跨源重定向仍按跨源分类，不跟随。主站结果的 `limitHop` 记录未跟随的那一跳，资源探针的未跟随跳保留在 `chain` 里。
- **`/index.html` 只有同源且目标是站点根才算收敛。** 跨源、非 HTTP(S)、其他路径的重定向只告警、不判通过，也不请求目标；`httpStatus` 和 `convergesToRoot` / `redirectKind` 给出机器可读证据。
- **验收参数写错直接报用法错误。** `--api` / `--expect-404` 非法 URL、非正 `--timeout`、非正整数 `--assets-limit`、非法 `--backup` 都会以退出码 2 结束，不会输出半截 JSON，也不会静默跳过检查（例如把 `--assets-limit abc` 当成 0 个资源）。
- **canonical 必须协议、主机、规范化路径全部一致才算指向自身。** `https` 页面上写 `http` canonical 判 `warn` 并点名协议不一致，不能算通过；跨主机、跨路径、多个标签的原有判定不变。canonical 的 `href` 缺失、为空或无法解析都判 `fail`（`hrefState` 分别为 `missing` / `empty` / `invalid`），不会被空值回退成当前站点；双引号 / 单引号 / 不带引号三种合法属性值都支持。
- **缺少 `404.html` 会把 Pages 的未知路径回退到 `/`（200）。** 这对 SPA 是预期，对多页站是故障；先定模式再判断，不要一刀切。
- **同一个站点，模式选错会得出相反结论。** `check-build` 和 `verify-deployment` 必须用同一个 `--mode`，报告里写明用了哪个。
- **`_headers` / `_redirects` 必须在产物根目录**，不是仓库根目录。
- **不要随手加自定义缓存**，除非文件名带内容哈希且用户接受代价。

## 六、失败处理

- **构建失败** → 看真实报错；查 Node 版本、锁文件、框架适配器。不要原样重试；连续 2 次或 15 分钟无进展就按止损线换路径（优先 Git 集成 / Workers Builds 在平台构建）。
- **部署失败** → 读 `references/troubleshooting.md`；查认证、项目名、文件限制、账号是否开通 Pages/Workers。
- **所有路径 404** → 输出目录错了或产物为空；检查产物。
- **子页面显示首页** → 缺 `404.html`，或 SPA 回退过宽。
- **静态资源 404** → 构建里写死了 `/repo/`；用 `/` 重新构建。
- **自定义域名 522 / 证书 pending** → 域名没有先在 Pages 添加、DNS 顺序错误、CAA 阻止签发。
- **CORS 报错** → 查重复 ACAO、`*` 配凭证、缺 `Vary: Origin`、Functions 没处理 `OPTIONS`。

## 七、参考资料

只读任务需要的那一份：

| 文件 | 什么时候读 |
|---|---|
| `references/prerequisites.md` | 账号、Token、Account ID、R2 订阅、Node/Wrangler 前提 |
| `references/console-paths.md` | 登录后各功能在控制台的路径 |
| `references/cross-platform.md` | Windows / macOS / Linux / WSL / 容器 / CI 的差异 |
| `references/platform-selection.md` | 选 Pages 还是 Workers、域名限制、Git 集成 |
| `references/runtime-compat.md` | **可行性判定**：已知不可行组合、ORM × 运行时、现行额度/成本、构建环境、止损线 |
| `references/deployment-workflows.md` | 构建/部署、Git 与 Direct、环境变量、Jekyll、Next.js |
| `references/pages-runtime.md` | 响应头、重定向、404/SPA、缓存、CORS、Functions |
| `references/github-pages-backup.md` | 保留或验证 GitHub Pages 备用站 |
| `references/verification.md` | 按项目类型的验收清单 |
| `references/troubleshooting.md` | 部署或运行时检查失败 |
| `references/security.md` | Token、Actions 权限、密钥、供应链 |
| `references/seo-indexing.md` | canonical、noindex、sitemap、多入口 |
| `references/migration-guide.md` | 完整方法、阶段、Jekyll 实战数据 |

模板：`templates/deployment-plan.md`、`templates/deployment-report.md`、`templates/wrangler.workers.jsonc`、`templates/wrangler.pages.toml`。

脚本：`scripts/probe.mjs`（链路探针）、`deploy-verdict.mjs`（探针 `--deploy` 的可测判定逻辑）、`detect-project.mjs`、`check-env.mjs`、`check-build.mjs`、`verify-deployment.mjs`。测试：`tests/run-tests.mjs`；结构自检：`tests/check-skill.mjs`（校验 frontmatter、引用路径、绝对路径残留，不依赖外部工具）。

## 八、输出要求

部署前：一份一分钟能读完的计划（含可行性结论与成本档）。
不可行时：结论 + 依据 + 换依赖 / 换方案 / 换平台的选项与代价，不要伪装成已完成。
部署后：一份带 URL、检查表、明确“未验证”项的报告。
不要只回一句“完成了”。
