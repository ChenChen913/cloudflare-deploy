---
name: deploy-advisor
description: 把程序项目部署或迁移到 Cloudflare Pages / Workers、GitHub Pages、Vercel、Netlify、Render 的多平台决策与执行技能，也覆盖 Java/Python/PHP/Ruby/.NET、容器或前后端混合项目的路线判断。当用户要求部署、托管、迁移、选择平台，判断项目适合哪个平台，比较 Cloudflare Pages / Workers 或 Vercel / Netlify / Render / GitHub Pages，检查部署后的页面/路由/静态资源/CORS/索引，或排查部署失败时使用。先用链路探针确认账号与网络、判定技术可行性，再只读识别项目，给出部署适配度评估与首选/备选/不推荐建议，并强制提示中国大陆访问风险；对不可逆或影响生产的操作先征求确认；部署到预览地址后用真实 HTTP 请求验收，并在报告中区分“已验证 / 失败 / 未验证”。
agent_created: true
---

# 多平台部署决策与 Cloudflare 执行

把一个程序项目变成一次**经过验证**的部署。顺序是：**先验证链路与可行性** → 只读识别项目 → 部署适配度评估 → 平台筛选 → 选型 → 网络与进阶引导 → 写计划 → 部署到预览地址 → 用真实请求验收 → 迁移检查（如适用）→ 写报告。前提不成立就停下来，不要靠「先构建一下看看」去发现问题。

> **能力边界（先读这条）**：自动化脚本完整覆盖静态站 / SPA / SSG 的构建检查与 HTTP 验收。SSR / 全栈项目请把本技能当作**流程清单**使用：`check-build.mjs` 对它不适用，`verify-deployment.mjs` 只验证 HTTP 层（首页、API、服务端渲染内容），数据库写入、登录会话、第三方回调仍需专项验证。运行时兼容性、套餐与成本见 `references/runtime-compat.md`；**Java/Python/PHP/Ruby/.NET 或前后端混合项目**先在 `references/tech-stack-fit.md` 判断路线，不要假设所有技术栈都能用本技能的脚本完整验收。
>
> 多平台部分提供**适配度评估、候选筛选和大陆访问风险提示**。非 Cloudflare 平台的部署默认输出人工步骤，不声称自动完成；GitHub Pages、Vercel、Netlify、Render 的账号权限、DNS、运行时和数据库仍需按平台官方流程验证。

## 一、先决条件

执行前逐项确认，缺什么就明确告诉用户缺什么，不要假装能部署。

| 条件 | 是否必须 | 怎么检查 | 缺失时怎么办 |
|---|---|---|---|
| Cloudflare 账号 | 必须 | 浏览器登录 `dash.cloudflare.com` | 去 `dash.cloudflare.com/sign-up` 注册；只需邮箱、密码、邮箱验证 |
| 登录态 | 必须 | `npx wrangler whoami` | 本地 `npx wrangler login`（交互式，需在约 2 分钟内完成 Allow；不要挂后台无人值守）；远程/容器用 `--device`；CI 用 API Token |
| Account ID | API Token / CI 必须 | 控制台搜索 “Copy account ID”，或 Workers & Pages → Account Details | 复制后放进 `CLOUDFLARE_ACCOUNT_ID` |
| Node.js | 必须 | `node -v` | 脚本本身最低 Node 18；完整部署建议 **22+**（Wrangler 只支持 Current / Active / Maintenance，22 是当前仍在维护的最老 LTS） |
| Wrangler | 必须 | `npx wrangler --version` | 项目内 `npm i -D wrangler@latest`，或直接用 `npx wrangler` |
| Git | 必须 | `git --version` | 装 Git；Windows 推荐 Git for Windows（自带 Git Bash） |
| 域名 / DNS | 只有绑自定义域名才需要 | 域名的 NS 在哪、是否有 CAA | Pages 的 apex 需要 NS 在 Cloudflare；子域可用外部 CNAME；Workers 必须 NS 在 Cloudflare |
| R2 订阅 | 只有用 R2 才需要 | 控制台 Storage & databases → R2 | 首次使用要走一次 checkout（免费额度也需开通） |
| GitHub CLI | 可选 | `gh --version`、`gh auth status` | 只影响仓库/DNS 自动化，不影响 `wrangler` 部署 |
| Docker | 只有用 Containers 且本地构建/推送镜像 | `docker info` | 可用预构建镜像、CI 或 Workers Builds 构建；只有本地构建/推送才必须有 Docker |
| 账号套餐 / 订阅 | 用付费能力时必须 | Manage Account → Billing → Subscriptions | 免费计划不能用 Containers；R2 首次使用需完成一次 checkout |
| 付款方式 | 只有付费功能才需要 | 控制台 Billing | Pages/Workers 免费额度不要求绑卡；Workers Paid、R2 超额等需要 |

Cloudflare 免费计划注册流程只要求邮箱、密码和邮箱验证，官方文档没有要求绑卡。R2 是例外：首次使用需要完成一次订阅 checkout，即使只用免费额度。

详细前提、Token 权限、Account ID：`references/prerequisites.md`。

非 Cloudflare 平台按需准备账号，不要求一次全部开通：GitHub（GitHub Pages）、Vercel、Netlify、Render。选择哪个平台，先在部署适配度评估里确认；不要为了“都试一遍”注册全部平台。

## 二、控制台路径

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

其他平台的入口：

| 平台 | 入口 | 备注 |
|---|---|---|
| GitHub Pages | 仓库 Settings → Pages | 选 Source / branch；自定义域名在 Pages 设置里绑定 |
| Vercel | `vercel.com/new` 或 Git 集成 | 导入仓库，框架自动识别；先看 Hobby 的非商业限制 |
| Netlify | `app.netlify.com` → Add new site | 导入仓库；构建配置优先写 `netlify.toml` |
| Render | `dashboard.render.com` → New | Static Site / Web Service / Blueprint；免费 Web Service 会休眠 |

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
| “部署到 Cloudflare” / “迁移这个仓库” | 完整流程，第 0–7 步；如果项目不是 JS/TS 或前后端混合，第 2 步先读 `references/tech-stack-fit.md` |
| “这个项目适合哪个平台 / 多平台怎么选” | 只做第 1–2 步（识别 + 适配度评估 + 选型），给首选 / 备选 / 不推荐，不部署 |
| “部署到 Vercel / Netlify / Render / GitHub Pages” | 第 0–2 步评估选型，再给该平台的人工部署步骤和第 6 步验收；不声称自动部署 |
| “Pages 还是 Workers？” | 只做第 1–2 步；先给平台层结论，再按第 2.5 步的三问定 Cloudflare 产品 |
| “大陆访问不稳定 / 要不要备案” | 第 2.3 步 + `references/mainland-china-access.md`；给两条路线和验证方法 |
| “Java/Python/PHP 项目能部署吗 / 前后端怎么拆” | 只做第 1–2 步；先给路线初判（Workers / Containers / 外部后端），再列阻塞项和未验证项，不承诺自动部署 |
| “检查现有部署” | 第 6 步 + `references/verification.md`，不改文件 |
| “保留 GitHub Pages 备用” | `references/github-pages-backup.md`，再做第 6 步 |
| “部署失败 / 502 / 404 / CORS” | 先 `scripts/probe.mjs`，再 `scripts/check-env.mjs` + `references/troubleshooting.md` |
| “迁数据库 / 后端” | 第 0–3 步；读 `references/runtime-compat.md`、`references/platform-selection.md`、`references/migration-guide.md`、`references/advanced-needs.md`；非 JS/TS 或混合前后端先读 `references/tech-stack-fit.md`；数据库操作必须确认 |
| “迁到 Vercel / Netlify / Render / GitHub Pages” | 第 0–2 步选型 + 6A 迁移检查；用 `migration-plan.mjs` 生成迁移前检查、双活五步、DNS 确认门、回滚和报告骨架 |
| “自定义域名 / 免费额度不够 / 后端数据库怎么放” | 第 2 步 + `references/custom-domain-guide.md` / `references/advanced-needs.md`；只给入口和顺序，不自动购买或升级 |

### 0. 链路探针与可行性熔断（先于一切工程动作）

部署任务的第一优先级是**链路通不通**，不是产物对不对。碰到项目文件之前先做：

```bash
node "<技能目录>/scripts/probe.mjs" --repo "$PWD"
```

- 部署的是 git 仓库时加 `--repo "$PWD"`：探针会额外检查 `git remote` / `git ls-remote`（10 秒超时）并打印脱敏后的 `HTTPS_PROXY` / `NO_PROXY`；代码托管不通时标 `warn`（`limited`），不会让 Cloudflare API 的“通”掩盖 GitHub/GitLab 的不通。Direct Upload/已有产物仍可能部署，所以不直接 blocked。

- 退出码 `0` = ready；`1` = limited（先读 warn，判断缺口是否影响本次目标）；`2` = blocked（**硬停**）。
- blocked 时不要改配置、装适配器或跑构建。给出具体下一步（`npx wrangler login`，或 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`）；**不要让用户在聊天里粘贴 Token**。
- `probe.mjs --timeout` 只接受 1..2147483647 的有限正整数（毫秒）；空值、非数字、负数、0、小数、超范围值会在任何网络探测/`--deploy` 之前以退出码 2 报中文用法错误，不会包装成网络失败。Cloudflare API 探测对连接类瞬时错误重试 1 次；账号/登录判定仍保持 fail-closed，不因重试放宽。
- 登录态判定是 **fail-closed** 的（`check-env` 与 `probe` 共用 `scripts/wrangler-auth.mjs`）：`wrangler whoami` 退出码 0 但输出为空、只有 `loggedIn:false`、或没有邮箱 / Account ID / 明确登录文本时，判「无法确认」而不是已登录；`canDeploy` 不会为 true、`probe` 会 blocked。执行失败与未登录分开报告。
- `npx wrangler deploy --temporary` 只在未登录时可用，用的是临时账号，**不能验证用户的账号、权限或套餐**，且会过期；它只能证明网络可达。
- `--deploy` 会真实创建并删除一个临时 Worker，属于写操作，**必须先得到用户同意**。**部署命令成功不等于线上验证成功**：必须解析到 URL 并真实请求通过才判 `pass`；没 URL 或 URL 不可访问只会得到 `warn` / `fail`，清理失败也会单独记 `warn`；部署本身失败时确认不了是否创建过 Worker，清理记为 `skip` 并提示到控制台核对，不要写成「删除失败」，也不要断言一定没创建。部署 URL 返回 3xx 不算线上验证通过（脚本不跟随）。没有账号时不要声称已验证部署链路。

接着用 10 分钟做**可行性判定**（只查文档，不写代码）：框架有没有适配器且版本匹配？ORM / 驱动能否跑在 workerd（WASM、原生模块、Node API）？体积和套餐够不够？产出「可行 / 不可行 + 依据」。三问、已知不可行组合、现行额度与成本表见 `references/runtime-compat.md`。

- **判为不可行就立刻决策，不要闷头试**：把「换依赖 / 换方案 / 换平台」的代价摆给用户。「本技术栈目前不适合 Cloudflare」也是合格结论。
- **止损线**：同一构建步骤连续失败 2 次，或单次超过 15 分钟无实质进展 → 停止调优，换构建环境或换方案，并说明原因。
- SSR 项目本地 `wrangler dev` 跑通 ≠ 线上跑通；Windows 本地构建适配器失败时，优先走 Git 集成 / Workers Builds 让平台构建。

### 1. 只读识别项目

先解析技能目录（包含本 `SKILL.md` 的文件夹），然后：

```bash
node "<技能目录>/scripts/detect-project.mjs" "$PWD" --human
```

默认输出 JSON；给 `--human` 得到人类可读摘要。脚本会报告：框架、静态/SPA/SSR/API、包管理器、构建命令、输出目录、base path、GitHub Pages 配置、现有 Wrangler 配置（`wrangler.toml` 与 `wrangler.json/jsonc` 都支持）、绑定、环境变量键名、PWA、子应用、锁文件、风险、未知项。存在多个 build 脚本或条件 `outDir` 时，还会输出 `project.buildCandidates` / `project.outputDirCandidates`，把 `outputDir` 标为 `inferred` 并写风险；不要把推断值当 confirmed。

三个字段决定你怎么用它的结论：

- `target.candidates`：候选产品，通常两个都列；
- `target.confidence`：`high`（有 Wrangler 配置或硬阻断）、`medium`（按类型推断）、`low`（没识别出来）；
- `evidence.*.confidence`：每个关键字段是 `confirmed`（来自 package.json 等明确声明或显式 Wrangler 配置）、`inferred`（按配置文件 / 默认值推断）还是 `unknown`。

**`suggested` 只是候选建议，不是部署决定。** 只有 `confidence: high` 且依据是现有 Wrangler 配置时，才可以照着做；`medium` 必须结合第 2 步的三个问题再定。`project.suggestedMode` 给出建议的验收模式，`risks` 会标出需要核对的 ORM / 驱动 / 原生模块——两者都只是**待核对信号**，不是可行性结论。

同时按需读取：`package.json`、锁文件、框架配置、`.github/workflows/*`、`wrangler.*`、`_headers`、`_redirects`、`CNAME`、`.env.example`；非 JS 项目再看 `pom.xml`/`build.gradle*`、`requirements.txt`/`pyproject.toml`、`composer.json`、`Gemfile`、`*.csproj`、`Dockerfile` 等，判断是否存在未识别的前后端。**不要为了识别而安装依赖。**

Monorepo 里如果有多个应用，脚本只会列出 `project.workspaces`；先问清楚部署哪个，不要猜。多个锁文件、多个 `index.html`、动态框架配置都属于“需要人工确认”的情况，脚本会写进 `risks`。

`detect-project.mjs` 的识别范围以 JS/静态生态为主；如果仓库里还有 `pom.xml`/`build.gradle*`、`requirements.txt`/`pyproject.toml`、`composer.json`、`Gemfile`、`*.csproj`、`Dockerfile`，不要因为脚本只报了前端就断定整个项目是静态站——按 `references/tech-stack-fit.md` 先判断后端/容器路线。

### 2. 部署适配度评估与平台选型

选型分两层：先选平台层的首选 / 备选 / 不推荐，再在 Cloudflare 家族内部选 Pages / Workers。先确认：目标用户在哪（海外 / 含大陆 / 未明确）、有没有后端和数据库（无 / Serverless / PostgreSQL + Auth + Storage / 长期运行）、预算（免费 / 付费）、使用性质（个人非商业 / 商业 / 未知）、现有部署平台和是否健康。“未明确”按含大陆处理；`unknown` 要问，不猜。现有部署健康时，首选“保留现平台”。

#### 2.1 四维适配度评估

| 维度 | 结论 |
|---|---|
| A 渲染模式 | 纯静态 / SSG / SPA → 五个核心平台候选；SSR / 全栈 / API → 排除 GitHub Pages 和 Netlify 纯静态托管，优先 Cloudflare Workers / Vercel / Render / Railway / Fly.io；Pages 仅已有 Functions 或明确选择时保留 |
| B 后端与数据库 | 无后端 → 静态优先；PostgreSQL / Auth / Storage → Supabase 后端，前端仍可静态；长期运行 / Docker → Render / Railway / Fly.io |
| C 用户地域 | 海外 → Cloudflare Pages / Vercel / Netlify 均可；含大陆或未明确 → 必须输出大陆风险提示，并标注证据等级 |
| D 预算与使用性质 | 免费优先 → 首推 Cloudflare Pages；愿意付费 → Workers Paid 或 Vercel Pro；商业项目不使用 Vercel Hobby |

排除必须写原因。核心平台固定五个：GitHub Pages、Cloudflare Pages、Vercel Hobby、Netlify Free、Render Free；扩展池按需：Cloudflare Workers、Vercel Pro、Railway、Fly.io、Supabase、国内云 / 备案托管。候选与排除由 `references/platform-matrix.json` 驱动；矩阵字段至少包含 type、render_support、selection_pools、free_tier_key_points、custom_domain、commercial_use、mainland_china_risk、migration_notes、best_for、not_for，引用前看 `checked_at`。**这不是数值评分。** 四维只给判断结果、证据来源和置信度；硬性不兼容、商业使用限制和套餐要求单独标 `blocked` 或明确警告，不能被综合分数掩盖。Cloudflare Pages 与 Workers 是两个独立产品：Pages 是静态托管 + Pages Functions；Workers 是 Workers Static Assets / SSR / API，新 SSR / 全栈优先 Workers。

#### 2.2 选型输出

给出 1 个首选、1–2 个备选、1–2 个不推荐。每个平台附理由、免费额度关键点、适合场景、主要限制；含大陆时再附默认域名风险和证据等级。示例：首选 Cloudflare Pages（免费、静态带宽无限）；备选 GitHub Pages（已有仓库且不需要大陆稳定访问）；不推荐 Vercel Hobby（大陆默认域名风险，且仅个人非商业）。

#### 2.3 中国大陆访问风险

只要目标用户含中国大陆，或未明确说“只面向海外”，必须输出以下提示，不得折叠、省略或只放在报告末尾。以下是网络观测结论，不是平台官方声明；本仓库没有保存大陆实测数据：

- Vercel 的 `*.vercel.app` 默认域名在中国大陆已被 DNS 污染，直接访问通常超时；绑定自定义域名可能改善，但 Vercel 官方明确不保证中国大陆的可用性或性能。
- GitHub Pages 的 `*.github.io` 在中国大陆访问不稳定，部分网络环境不可达。
- Netlify 的 `*.netlify.app` 同样常无法直接访问。
- Cloudflare Pages 的 `*.pages.dev` 通常可达性更好，但也不是中国大陆合规托管。
- 换自定义域名只能缓解，不能保证稳定；稳定大陆访问需要 ICP 备案 + 国内云 / CDN。

报告单独用一节输出路线 A（海外托管 + 自定义域名 + 自托管关键资源，承认可能被限速 / 阻断）和路线 B（ICP 备案 + 国内云 / CDN）。详见 `references/mainland-china-access.md`。

#### 2.4 评估脚本

`node "<技能目录>/scripts/select-platform.mjs" --project "<JSON 或目录>" --audience mainland --budget free --usage personal_noncommercial --existing none --human`

退出码 `0` 有结论、`1` 信息不足或矩阵不可用、`2` 用法错误；只读、不访问网络、不写项目文件。脚本读取平台矩阵；矩阵校验、筛选和排序的纯函数在 `platform-matrix.mjs`。输出包含四维判断、使用性质、现有部署、候选和理由；不是部署保证。商业项目必须传 `--usage commercial`，否则 Hobby 不会被当作首选。

#### 2.5 Cloudflare 家族内部：Pages 还是 Workers

矩阵只负责平台层；Cloudflare 入选后仍按 `references/platform-selection.md` 的三问决定 Pages / Workers：域名 NS 是否在 Cloudflare、是否要零配置 `git push`、以后是否要 Cloudflare 侧后端（D1/DO/Queues/Cron）。新项目、以后可能加服务端逻辑 → Workers；纯静态、要零配置 Git 或 DNS 不在 Cloudflare → Pages；已有 Pages 且正常 → 不迁移；Next.js SSR/ISR → Workers + vinext/OpenNext；原生模块、长驻进程、Java/Python/PHP 等先读 runtime-compat / tech-stack-fit。给出目标时说明决定性事实、未确认项、成本档和套餐前提。域名、付费、后端 / 数据库引导按需读 `references/custom-domain-guide.md` 和 `references/advanced-needs.md`；只给入口和顺序，不自动购买、升级或迁移。

### 3. 写部署计划

填 `templates/deployment-plan.md`。保持一屏以内：可行性结论、当前架构、部署适配度评估、目标平台与成本档、部署方式、构建环境、要改的文件、命令、环境变量/密钥、数据/文件/API 影响、GitHub Pages 取舍、中国大陆访问风险、风险、**止损线**、回滚。

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

退出码就是结论：`0` 可部署、`1` 可构建但不可部署、`2` 连构建条件都不满足。**不要忽略非零退出码继续往下走。** 只想本地构建、不打算部署时用 `--build-only`。`canBuild=true` 只代表 Node/Git/wrangler 等前置条件可用，**不会执行项目自己的 build 命令**。登录缺失会给出准确命令，**不要让用户在聊天里粘贴 Token**。登录判定要求正向证据：`whoami` 退出码 0 但没有邮箱 / Account ID / 明确登录文本时只会给 `warn`（`authState: "unknown"`），不能当成已登录继续部署。

用项目自己的构建命令，然后检查产物：

```bash
node "<技能目录>/scripts/check-build.mjs" --dir "<输出目录>" --mode "<static|spa|ssg|ssr>" \
  [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0] [--pages-wrangler-major 4]
```

**先定站点模式，再构建检查，最后用同一个模式验收。** 中间换模式，前面的结论就作废：

| 模式 | 用在 | 未知路径的期望 | 产物检查 |
|---|---|---|---|
| `static` | 预渲染的多页站；**HashRouter SPA 也用这个** | 404 | 适用 |
| `ssg` | Hugo / Jekyll / Astro 等生成的静态站 | 404 | 适用 |
| `spa` | BrowserRouter / history 路由的客户端 SPA | 200 + app shell | 适用，不要求 `404.html` |
| `ssr` | 服务端渲染 / 全栈 | 通常 404；200 要确认不是 catch-all | **不适用**，脚本只报 `skip` |

`detect-project.mjs` 会从源码识别 HashRouter / BrowserRouter / `createWebHashHistory` / `createWebHistory`：HashRouter 建议 `static`，history 路由建议 `spa`；**没有任何路由证据时 `suggestedMode=unknown`，要求人工确认，不默认推荐 spa**。`--spa` 是 `--mode spa` 的旧写法，仍然可用。默认是 `static`，所以 history 路由 SPA 项目**必须显式传 `--mode spa`**，否则会被当成“缺 404.html”的多页站。SSR 没有可上传的静态产物目录，不要为了凑检查去建一个空目录。

产物检查的补充规则：资源存在性按产物里的**真实文件名大小写敏感**匹配（Cloudflare 区分大小写，Windows 本地不区分；顶层 `index.html` / `404.html` / `_headers` 也按大小写严格判断）；`..` 逃逸判坏；以 `/` 开头的引用按产物根相对路径解析（存在即通过，不是逃逸），相对引用受 `<base href>` 影响；目录式 URL（`/about/`、`/about`）按 `about/index.html` 查找；产物里的 symlink/junction 会跟随并计入。 `check-build` 只核对显式参数 / 环境变量 / 项目依赖里的套餐证据，账号套餐和 Pages 项目设置仍需人工确认。

**文件数按套餐 + 部署目标判定**：默认 Free **20,000**。Paid **100,000** 只有显式 `--plan paid` 才考虑，且两套产品的启用条件不同，必须用 `--target` 指明：

| `--target` | 放宽到 100,000 的条件 | 依据 |
|---|---|---|
| `pages` | Wrangler v4 构建 + Pages 项目设置 `PAGES_WRANGLER_MAJOR_VERSION=4` | 官方 Pages Limits；该环境变量是 Pages 专属 |
| `workers` | **Wrangler >= 4.34.0**（完整版本比较），不需要 Pages 环境变量 | 官方 Workers Limits：「To use the increased file count limits in Wrangler, you must use version 4.34.0 or higher」 |
| 不传 / 无法确认 | **不放宽**，仍按 20,000 | 不知道该套用哪套条件 |

证据可来自 `--wrangler-version` / `--pages-wrangler-major`、CI 环境变量或项目 `package.json`；非法版本（`4.x`、预发布标签）和只给主版本 `4` 都**不能**证明 Workers 的 >= 4.34.0。证据不足自动退回 20,000 并给 `warn`，结果里写明生效上限、目标与原因。控制台里的账号套餐与 Pages 项目设置本地看不到，仍需人工确认。详见 `references/platform-selection.md`。

部署前修掉阻断项（输出目录不存在、文件数超过**当前生效上限**、单文件 > 25 MiB）。`static`/`ssg` 下缺顶层 `404.html` 是警告但影响很大：Cloudflare 官方说明没有顶层 `404.html` 时按 SPA 处理、未知路径返回 `/`（官方未写状态码，实际回退通常 200）；HashRouter 应补 404.html 并用 static 验收，BrowserRouter/history 路由才改用带显式 fallback 的 spa。构建失败按第 0 步的止损线处理，不要原样重试。

### 5. 部署

Cloudflare 目标按本节和 `references/deployment-workflows.md` 执行；Vercel / Netlify / Render / GitHub Pages 按平台官方 Git 集成或 CLI 人工执行，本节命令不适用，也不要声称已经自动部署。

Cloudflare 默认命令：

```bash
# Pages，预构建产物（Direct Upload）
npx wrangler pages deploy "<输出目录>" --project-name "<项目名>"

# Workers + 静态资源
npx wrangler deploy
```

规则：

- 已有脚本/workflow 能正常部署时，复用它。
- **Pages Direct Upload 前先 `cd` 目标项目根目录**，并用 wrangler 输出的实际 `*.pages.dev` 地址验收；项目名不保证等于默认域名（可能带随机后缀）。
- 不要新建第二条部署路径和现有流程打架。
- Pages 的 Direct Upload **不可逆**；在 Git 集成和它之间做选择前先确认。
- Git 集成、Workers Builds 是控制台/API 流程，**不要说 CLI 已经连好仓库**。
- 认证或权限不足时停下来，列出需要什么（`wrangler login`，或 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`；Git 集成需要仓库管理员权限）。

### 6. 验收

```bash
node "<技能目录>/scripts/verify-deployment.mjs" --url "<部署地址>" --mode "<static|spa|ssg|ssr>" --dist "<构建输出目录>" --json
```

静态/SSG/SPA 应尽量加 `--dist "<输出目录>"` 做**产物同一性**检查：脚本比较首页引用资源在线上与本地的 SHA-256；不一致判 `fail`，取不到/映射不到只写 `warn`。没有这项证据，不能声称线上就是本轮构建；部署地址和 commit 只是元数据。如果用户确认产物目录没有变化，可跳过重复构建/`check-build`，但仍必须跑 `verify-deployment --dist`；不要只凭时间或 commit 声称同一性。

用户要保留备用站时加 `--backup "<github.io 地址>"`；涉及 CORS 时加 `--origin "<前端来源>"`；API 在独立子域时再加 `--cors-url "<接口地址>"`。`verify-deployment` 默认对连接类瞬时错误重试 1 次（`--retries 0..3`），HTTP 4xx/5xx、证书/DNS 解析错误和脚本自身单次超时不重试；连接超时/连接重置可重试。detail 会区分“网络连接失败（已重试 N 次）”与 HTTP 断言失败。预检涉及实际方法、请求头或 Cookie 时，显式给 `--cors-method POST`、`--cors-headers "content-type,authorization"`、`--cors-credentials`——**没提供的信息不会被推断**：脚本不会凭默认值发送 `Access-Control-Request-Method/Headers`，对应断言列进 `notChecked`，未提供实际方法/请求头的预检最多 `warn`，不能判通过；同时给 `--cors-*` 却漏 `--origin` 会直接退出码 2。`--cors-credentials` 只是声明「预期请求带凭据」：脚本不会真的发浏览器 Cookie 或身份凭据，响应里的 `ACAC: true` 也不代表请求带凭据，无凭据时 `ACAO: *` 依旧有效；显式声明带凭据时才要求 ACAO 精确匹配 Origin 且必须有 `ACAC: true`。CORS 断言按 Fetch 规范：`*` 只在**无凭据**请求里是通配符，带凭据时是字面值；`GET/HEAD/POST` 是 CORS-safelisted method，不要求出现在 `Allow-Methods` 里；`Authorization` 永远不被 `Allow-Headers: *` 覆盖（`Range` 可以被覆盖）；方法名大小写敏感（已知方法先规范化为大写）。简单请求 3xx/4xx/5xx 不判通过（脚本不跟随 CORS URL 的重定向）。SSR / 全栈额外加 `--api /api/health --expect-json '{"ok":true}'`（`--api` 可重复传）；`--expect-json` 按 **JSON 子集**比较，与字段顺序和空白无关。canonical / meta robots / X-Robots-Tag 全缺失时会多一条 `seo` warn（不改退出码），同时保留备用站时要明确 self-canonical / noindex 策略。

`--mode` 必须和第 4 步一致，否则 404 结论会互相矛盾：

- `static`/`ssg`：未知路径**必须** 404。返回 200 判失败（SPA 回退或 rewrite 吞掉了未知路径）。
- `spa`：未知路径**必须** 200 + HTML，且含有 root 容器或入口脚本。返回 404 是警告（深链刷新会断；hash 路由可接受）。
- `ssr`：未知路径通常 404；返回 200 只给警告，须人工确认是自定义 404 还是 catch-all。额外检查首页服务端渲染的可见文本长度与单次 TTFB——**单次采样不是性能结论**。

脚本检查：首页状态（只自动跟随同源重定向；主站与资源共用 `MAX_REDIRECTS=5`——最多跟随 5 次并额外请求最终地址，第 6 次重定向判超限且主站结果的 `limitHop` 记录未跟随的一跳；跨源、协议变化、非 HTTP(S) 协议、Location 缺失/含 userinfo/无法解析都不请求目标；只有最终 **200** 的首页才做内容检查，错误页的 title/canonical 不作为站点证据；`/index.html` 5xx 判失败）、模式对应的 404/回退（`spa` 回退必须有可识别的 app shell 标记，否则只 `warn`）、标题（只认真实 `<title>`）、canonical（重复标签、跨主机、路径不符、**协议不一致**；三者全一致才算指向自身；**href 缺失 / 空值 / 无法解析分别判失败**，不被解析成当前站点；属性支持引号 / 无引号 / 属性值里的 `>` / 字符引用；只统计真正的 `<link rel=canonical>`——`rel` 按 HTML 空白分隔 token 匹配，注释、RAWTEXT（script/style/xmp/iframe/noembed/noframes/noscript）、RCDATA（title/textarea）、template、SVG/MathML 外域内容、属性值与畸形标签里的伪标签都不算；相对 canonical 按 `<base href>` / 最终页面 URL 解析）、meta robots（真实元素）、同源资源（HTML 与 check-build 共用同一个 tokenizer 和资源属性规则：只取 `src` / `srcset` / `poster` / `<object data>` / `<link href>`，`srcset` 按「逗号 + 空白」拆候选，导航链接、canonical、`<base>` 不算；相对地址按 `<base href>`，没有 base 时按文档 URL（与浏览器一致，不强行补斜杠）；HEAD 失败自动用 GET 复核；3xx 只有 301/302/303/307/308 跟随同源重定向并验最终 2xx，跨主机只记录并标 `warn`；304 不进入重定向链、判失败；`finalUrl` 只表示最后真正请求过的地址，未跟随目标在 `redirectTarget` / `limitReached`；跨源 / 畸形引用只记进 `ignored`，不请求）、响应头、`/index.html` 重定向（只有同源且目标是站点根才判通过；304 / 少见 3xx / 跨源 / 其他路径只告警；5xx 判失败）、可选 CORS（预检只发送显式提供的方法/请求头，未提供的断言只进 `notChecked` 且最多 `warn`；简单请求 3xx/4xx/5xx 不判通过；只有 Authorization 不被 `Allow-Headers: *` 覆盖）、备用站独立性，以及 `--api` 接口的状态 / JSON 类型 / 期望 JSON 子集。三处 3xx 判断共用 `classifyStatus()`，结果带 `statusClass`。

**HTTP 验收不是全栈验收。** `--api` 只证明该接口返回了 JSON 且（给了 `--expect-json` 时）符合期望的 JSON 子集；数据库写入、登录会话、第三方回调、冷启动仍需按 `references/verification.md` 专项验证，没测就写「未验证」。CORS 预检 `notChecked` 里的项同样要写成「未验证」，不要写成「已通过」。

同源资源默认只查首页引用的前 20 个（`--assets-limit` 可调）。资源属性规则与 check-build 共用：`src` 只对 img/script/iframe/embed/video/audio/source/track/input，`poster` 只对 video，`srcset` 只对 img/source（按 WHATWG 算法拆候选，URL 里逗号、data URI、逗号后无空格都正确处理）；`<a href>` 导航链接、canonical、`<base>` 不算资源；相对地址按 `<base href>`，没有 base 时按文档 URL（不强行补尾斜杠），根路径有同源重定向时按最终页面 URL。结果里的 `probed` 保留每个资源的原始地址、`chain` 重定向链、`finalUrl` / `finalStatus` 和 `crossHost`；`finalUrl` 只表示**最后真正请求过**的地址，没跟随的目标在 `redirectTarget`，超限在 `limitReached`。只要收到带有效 Location 的 3xx 就记进 `redirects`（同主机与跨主机都算），`probed` / `warnings` / `redirects` 三处一致。跨源 / 畸形引用（包括反斜杠伪装的跨源 URL）只记进 `ignored`，不请求。重定向、循环、最终 4xx/5xx 都不会被当成正常；**304 不是重定向，也不代表资源可用**，不进入 `redirects` 且判失败。**报告里要写“检查了 N 个 / 共 M 个”，不能写成“全站资源正常”。**

再按项目类型执行 `references/verification.md` 里的检查。纯静态站不要跑数据库和登录测试。每次修复后重新请求验证；没有新响应，就不能说“已修复”。

### 6A. 迁移检查（仅迁移场景）

用 `migration-plan.mjs` 生成迁移前检查、双活五步、DNS 确认门、回滚和报告骨架：`node "<技能目录>/scripts/migration-plan.mjs" --source github-pages --target cloudflare-pages --project-type ssg --human`。目标预览未通过第 6 步验收，不切 DNS、不删源平台；DNS / 自定义域名绑定必须用户确认；只记环境变量键名；数据库迁移单独备份、staging、冻结写入、确认；源平台至少保留一周。详见 `references/cross-platform-migration.md` 和 `templates/migration-report.md`。

### 7. 写报告

填 `templates/deployment-report.md`。包含：部署地址、目标平台、适配度评估、选型理由、中国大陆访问风险（如适用）、迁移路径（如适用）、方式、改动文件、每项检查的 通过/失败/未验证、遗留问题、GitHub Pages 状态、回滚方式。迁移场景可用 `templates/migration-report.md`。没测过的写 **未验证** 和原因。

## 五、必须遵守的判断

- **Cloudflare 链路 blocked 就不往下走。** 环境问题先于工程问题，构建成功不等于能上线。非 Cloudflare 目标只把网络 / Git 失败当作阻断；probe 的 Cloudflare API / 登录失败只说明 Cloudflare 路径不可用，不能解释成所有平台都不可部署。
- **评估不是可行性结论。** 适配度评估只回答“哪类平台更合适”，不能替代 probe、运行时可行性判定和账号检查；`unknown` 要问，不要猜。
- **含大陆或未明确地域时必须输出完整大陆风险提示。** 不得折叠、省略或只放在报告末尾；自定义域名只能缓解，不能保证稳定。
- **不读取、不写入密钥值。** 只记环境变量键名；DNS、自定义域名、数据库和删除操作没有用户确认就不执行。
- **现有部署健康时优先不迁移。** 没有具体问题、没有验收方案、没有回滚方案的迁移，首选结论应是保留现平台。
- **商业项目不得使用 Vercel Hobby。** Hobby 仅个人非商业；商业项目用 Pro 或允许商业用途的平台。Pages 与 Workers 是独立产品，不能把 Pages 的 SSR 理由写成 Workers。
- **迁移先双活。** 目标预览未通过验收，不切 DNS、不删源平台；DNS / 域名 / 数据库 / 删除必须确认。
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
- **canonical 必须协议、主机、规范化路径全部一致才算指向自身。** `https` 页面上写 `http` canonical 判 `warn` 并点名协议不一致，不能算通过；跨主机、跨路径、多个标签的原有判定不变。canonical 的 `href` 缺失、为空或无法解析都判 `fail`（`hrefState` 分别为 `missing` / `empty` / `invalid`），不会被空值回退成当前站点；相对 href 按 `<base href>` / 最终页面 URL 解析。只统计真正的 `<link rel=canonical>`：注释、RAWTEXT/RCDATA、template、畸形标签里的伪标签与 `data-rel`/`aria-rel`/`canonicalized` 都不算。
- **HTML、配置、命令行输出都必须有明确的解析/判定权威。** HTML 用 `scripts/html-scan.mjs`，配置用 `scripts/config-scan.mjs`，登录态用 `scripts/wrangler-auth.mjs`；不允许在调用方再写「标签正则 / 注释扫描 / 字符串包含」来模拟解析，改规则只改权威实现并补回归测试。
- **退出码 0 不等于成功，缺证据不等于通过。** 登录态、部署验证、CORS 预检、SPA 回退、资源引用都按 fail-closed 处理：没有可验证证据时最多 `warn`，不能判 `pass`；`canDeploy`/`ready` 只认正向证据。
- **资源引用只认子资源属性。** `src`（只对 img/script/iframe/embed/video/audio/source/track/input）、`poster`（只对 video）、`srcset`（只对 img/source，按 WHATWG 算法拆候选）、`<object data>`、`<link href>` 才是资源；导航链接、canonical、`<base>` 不探测。`finalUrl` 不能指向从未请求过的地址；跨源目标只记录不请求。
- **HTML 的状态有明确边界，不能靠“看起来像”判断。** HTML 命名空间的非空元素写成 `<div/>` 不会关闭（self-closing 只对 void/foreign 元素生效）；EOF 未完成开始标签按浏览器丢弃，不产生元素也不并入文本；外域结束标签回退 HTML 时会在 table/select 等 scope 边界停止，浏览器丢弃的 table-internal 标签不进入祖先栈。 script data 有 escaped/double-escaped（`<!--<script></script>-->` 内层 `</script>` 不关闭）；DOCTYPE public/system 标识符里的 `>` 按规范 abrupt 结束 DOCTYPE；SVG/MathML 用命名空间栈（foreignObject/desc/title/MathML 文本集成点、annotation-xml、breakout、HTML 祖先结束标签、template 隔离）；集成点内部的 `<link>` 才是 HTML 元素。`tests/fixtures/html5-oracle.json` 用真实 Chrome/Edge DOM facts 锁这些边界，有浏览器时可跑 `node tests/browser-diff.mjs`。
- **缺少 `404.html` 会触发 Pages 的默认 SPA 行为**（官方：按 SPA 处理，未知路径返回 `/`；官方未写状态码，实际通常 200）。这对 BrowserRouter SPA 是预期，对多页站和 HashRouter 是故障；先定模式再判断，不要一刀切。
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
- **非 Cloudflare 平台部署失败** → 按该平台构建日志和官方文档排查；本技能的脚本只做评估和 HTTP 验收，不声称自动部署。不要用 Cloudflare 的 `_headers` / `_redirects` 规则解释其他平台。

## 七、参考资料

只读任务需要的那一份：

| 文件 | 什么时候读 |
|---|---|
| `references/prerequisites.md` | 账号、Token、Account ID、R2 订阅、Node/Wrangler 前提 |
| `references/console-paths.md` | 登录后各功能在控制台的路径 |
| `references/cross-platform.md` | Windows / macOS / Linux / WSL / 容器 / CI 的差异 |
| `references/platform-selection.md` | 选 Pages 还是 Workers、域名限制、Git 集成 |
| `references/platform-matrix.json` | 平台能力矩阵数据源：5 核心 + 5 扩展/计划，带 `checked_at` 和官方来源 |
| `references/mainland-china-access.md` | 中国大陆访问风险、默认域名表现、两条路线、验证方法 |
| `references/cross-platform-migration.md` | 多平台迁移手册、双活五步、平台提示、安全门、报告字段 |
| `references/custom-domain-guide.md` | 域名购买、CNAME / A / nameserver、切换顺序、常见误区 |
| `references/advanced-needs.md` | 免费额度超限、付费选项、后端 / 数据库分层、密钥要求 |
| `references/runtime-compat.md` | **可行性判定**：已知不可行组合、ORM × 运行时、现行额度/成本、构建环境、止损线 |
| `references/tech-stack-fit.md` | 非 JS/TS 后端、Containers、前后端混合、CMS/移动端的技术栈选型与边界（选型清单，不承诺自动验收） |
| `references/deployment-workflows.md` | 构建/部署、Git 与 Direct、环境变量、Jekyll、Next.js |
| `references/pages-runtime.md` | 响应头、重定向、404/SPA、缓存、CORS、Functions |
| `references/github-pages-backup.md` | 保留或验证 GitHub Pages 备用站 |
| `references/verification.md` | 按项目类型的验收清单 |
| `references/troubleshooting.md` | 部署或运行时检查失败 |
| `references/security.md` | Token、Actions 权限、密钥、供应链 |
| `references/seo-indexing.md` | canonical、noindex、sitemap、多入口 |
| `references/migration-guide.md` | 完整方法、阶段、Jekyll 实战数据 |

模板：`templates/deployment-plan.md`、`templates/deployment-report.md`、`templates/migration-plan.md`、`templates/migration-report.md`、`templates/wrangler.workers.jsonc`、`templates/wrangler.pages.toml`。

脚本：`scripts/probe.mjs`（链路探针）、`deploy-verdict.mjs`（探针 `--deploy` 的可测判定逻辑）、`redirect-policy.mjs`（重定向同源判定）、`net-retry.mjs`（瞬时网络错误分类，verify 重试用）、`detect-project.mjs`、`platform-matrix.mjs`（矩阵读取、校验、筛选、排序）、`select-platform.mjs`（适配度评估与多平台初选）、`migration-plan.mjs`（迁移前检查、双活五步、DNS 门、回滚、报告骨架）、`check-env.mjs`、`check-build.mjs`、`verify-deployment.mjs`。测试：`tests/run-tests.mjs`；结构自检：`tests/check-skill.mjs`（校验 frontmatter、引用路径、绝对路径残留，不依赖外部工具）。

## 八、输出要求

部署前：一份一分钟能读完的计划（含可行性结论、适配度评估、目标平台与成本档）。目标用户含中国大陆或未明确时，必须附完整大陆访问风险提示和两条路线。
不可行时：结论 + 依据 + 换依赖 / 换方案 / 换平台的选项与代价，不要伪装成已完成。
部署后：一份带 URL、检查表、明确“未验证”项的报告；迁移场景用 `templates/migration-report.md`，写清检查项状态、DNS 变更、回滚和观察期。
不要只回一句“完成了”。
