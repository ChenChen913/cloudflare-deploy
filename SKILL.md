---
name: cloudflare-deploy
description: 把 GitHub 项目部署或迁移到 Cloudflare Pages / Workers 的端到端技能。当用户要求部署、托管、迁移到 Cloudflare，选择 Pages 还是 Workers，保留 GitHub Pages 作为备用站，检查部署后的页面/路由/静态资源/CORS/索引，或排查 Cloudflare 部署失败时使用。先只读识别项目，再给出部署方案；对不可逆或影响生产的操作先征求确认；部署到预览地址后用真实 HTTP 请求验收，并在报告中区分“已验证 / 失败 / 未验证”。
agent_created: true
---

# Cloudflare 部署

把 GitHub 仓库变成一次**经过验证**的 Cloudflare 部署。不要套模板：先识别项目，再选产品，写计划，部署到预览地址，用真实请求验收，最后写报告。

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

### 0. 判断用户要什么

| 用户意图 | 做什么 |
|---|---|
| “部署到 Cloudflare” / “迁移这个仓库” | 完整流程，第 1–7 步 |
| “Pages 还是 Workers？” | 只做第 1–2 步，给结论，不部署 |
| “检查现有部署” | 第 6 步 + `references/verification.md`，不改文件 |
| “保留 GitHub Pages 备用” | `references/github-pages-backup.md`，再做第 6 步 |
| “部署失败 / 502 / 404 / CORS” | `scripts/check-env.mjs` + `references/troubleshooting.md` |
| “迁数据库 / 后端” | 第 1–3 步；读 `references/platform-selection.md` 和 `references/migration-guide.md`；数据库操作必须确认 |

### 1. 只读识别项目

先解析技能目录（包含本 `SKILL.md` 的文件夹），然后：

```bash
node "<技能目录>/scripts/detect-project.mjs" "$PWD" --human
```

需要精确字段时用 `--json`。脚本会报告：框架、静态/SPA/SSR/API、包管理器、构建命令、输出目录、base path、GitHub Pages 配置、现有 Wrangler 配置、绑定、环境变量键名、PWA、子应用、锁文件、风险、未知项。

三个字段决定你怎么用它的结论：

- `target.candidates`：候选产品，通常两个都列；
- `target.confidence`：`high`（有 Wrangler 配置或硬阻断）、`medium`（按类型推断）、`low`（没识别出来）；
- `evidence.*.confidence`：每个关键字段是 `confirmed`（直接读到）、`inferred`（按默认值推断）还是 `unknown`。

**`suggested` 只是候选建议，不是部署决定。** 只有 `confidence: high` 且依据是现有 Wrangler 配置时，才可以照着做；`medium` 必须结合第 2 步的三个问题再定。

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

但**不要只凭框架名决定**。静态站（含 SPA）Pages 和 Workers 都能托管，真正决定的是三个问题：

1. 域名的 NS 是否在 Cloudflare？（Workers 要求 NS 托管；Pages 的子域可用外部 CNAME）
2. 是否要零配置 `git push` 部署？（Pages 的 Git 集成更省事）
3. 以后是否要 Cloudflare 侧后端（D1/DO/Queues/Cron）？（要就直接 Workers）

给出目标时，说明是哪一两个事实决定的，以及哪个问题你还没确认。

### 3. 写部署计划

填 `templates/deployment-plan.md`。保持一屏以内：当前架构、目标、部署方式、要改的文件、命令、环境变量/密钥、数据/文件/API 影响、GitHub Pages 取舍、风险、回滚。

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

阻断项：Node 缺失/过旧、git 缺失、既没有 wrangler 也没有 `npx`。登录缺失是警告：部署前必须解决，给出准确命令，**不要让用户在聊天里粘贴 Token**。

用项目自己的构建命令，然后检查产物：

```bash
node "<技能目录>/scripts/check-build.mjs" --dir "<输出目录>" --mode "<static|spa|ssg>"
```

**先定站点模式，再构建检查，最后用同一个模式验收。** 中间换模式，前面的结论就作废：

| 模式 | 用在 | 未知路径的期望 |
|---|---|---|
| `static` | 预渲染的多页站 | 404 |
| `ssg` | Hugo / Jekyll / Astro 等生成的静态站 | 404 |
| `spa` | 客户端路由（React/Vue/Vite SPA） | 200 + app shell |

`--spa` 是 `--mode spa` 的旧写法，仍然可用。默认是 `static`，所以 SPA 项目**必须显式传 `--mode spa`**，否则会被当成“缺 404.html”的多页站。

部署前修掉阻断项（输出目录不存在、文件数 > 20,000、单文件 > 25 MiB）。`static`/`ssg` 下缺顶层 `404.html` 是警告但影响很大：Pages 会把整站当成 SPA，验收时未知路径会返回 200。

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
node "<技能目录>/scripts/verify-deployment.mjs" --url "<部署地址>" --mode "<static|spa|ssg>" --json
```

用户要保留备用站时加 `--backup "<github.io 地址>"`；涉及 CORS 时加 `--origin "<前端来源>"`；API 在独立子域时再加 `--cors-url "<接口地址>"`。

`--mode` 必须和第 4 步一致，否则 404 结论会互相矛盾：

- `static`/`ssg`：未知路径**必须** 404。返回 200 判失败（SPA 回退或 rewrite 吞掉了未知路径）。
- `spa`：未知路径**必须** 200 + HTML，且含有 root 容器或入口脚本。返回 404 是警告（深链刷新会断；hash 路由可接受）。

脚本检查：首页状态、模式对应的 404/回退、标题、canonical（重复标签、跨主机、路径不符）、meta robots、同源资源（HEAD 失败会自动用 GET 复核）、响应头、`/index.html` 重定向、可选 CORS、备用站独立性。

同源资源默认只查首页引用的前 20 个（`--assets-limit` 可调）。**报告里要写“检查了 N 个 / 共 M 个”，不能写成“全站资源正常”。**

再按项目类型执行 `references/verification.md` 里的检查。纯静态站不要跑数据库和登录测试。每次修复后重新请求验证；没有新响应，就不能说“已修复”。

### 7. 写报告

填 `templates/deployment-report.md`。包含：部署地址、目标、方式、改动文件、每项检查的 通过/失败/未验证、遗留问题、GitHub Pages 状态、回滚方式。没测过的写 **未验证** 和原因。

## 五、必须遵守的判断

- **前端迁了不等于后端要迁。** 默认只迁前端。
- **新站稳定前不要删 GitHub Pages。**
- **`github.io` 301 到自定义域名，就不是备用站。** 必须直接请求确认。
- **`noindex` 不影响访问。** 不要以“备用站要能用”为理由去掉它。
- **Pages 静态资源默认 `Access-Control-Allow-Origin: *`。** 需要收紧时用 `_headers`；Functions 必须在代码里处理 CORS，包括 `OPTIONS`。
- **缺少 `404.html` 会把 Pages 的未知路径回退到 `/`（200）。** 这对 SPA 是预期，对多页站是故障；先定模式再判断，不要一刀切。
- **同一个站点，模式选错会得出相反结论。** `check-build` 和 `verify-deployment` 必须用同一个 `--mode`，报告里写明用了哪个。
- **`_headers` / `_redirects` 必须在产物根目录**，不是仓库根目录。
- **不要随手加自定义缓存**，除非文件名带内容哈希且用户接受代价。

## 六、失败处理

- **构建失败** → 看真实报错；查 Node 版本、锁文件、框架适配器。不要原样重试。
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
| `references/platform-selection.md` | 选 Pages 还是 Workers、额度、价格、域名限制 |
| `references/deployment-workflows.md` | 构建/部署、Git 与 Direct、环境变量、Jekyll、Next.js |
| `references/pages-runtime.md` | 响应头、重定向、404/SPA、缓存、CORS、Functions |
| `references/github-pages-backup.md` | 保留或验证 GitHub Pages 备用站 |
| `references/verification.md` | 按项目类型的验收清单 |
| `references/troubleshooting.md` | 部署或运行时检查失败 |
| `references/security.md` | Token、Actions 权限、密钥、供应链 |
| `references/seo-indexing.md` | canonical、noindex、sitemap、多入口 |
| `references/migration-guide.md` | 完整方法、阶段、Jekyll 实战数据 |

模板：`templates/deployment-plan.md`、`templates/deployment-report.md`、`templates/wrangler.workers.jsonc`、`templates/wrangler.pages.toml`。

脚本：`scripts/detect-project.mjs`、`check-env.mjs`、`check-build.mjs`、`verify-deployment.mjs`。测试：`tests/run-tests.mjs`；结构自检：`tests/check-skill.mjs`（校验 frontmatter、引用路径、绝对路径残留，不依赖外部工具）。

## 八、输出要求

部署前：一份一分钟能读完的计划。
部署后：一份带 URL、检查表、明确“未验证”项的报告。
不要只回一句“完成了”。
