# cloudflare-deploy

一个可复用的 Agent Skill：把 GitHub 项目部署到 Cloudflare Pages 或 Workers。流程是：识别仓库 → 选产品 → 写计划 → 构建 → 部署到预览 → 用真实 HTTP 请求验收 → 写报告。

技能正文使用简体中文。文件名和代码标识符保持 ASCII，是为了跨系统与压缩包兼容；JSON 字段名保持英文，保证脚本可被机器读取。

## 状态

- 格式校验（`quick_validate.py`）：通过。
- 本地测试：23/23 通过（`node tests/run-tests.mjs`）。
- 真实 Cloudflare 部署：**本环境没有执行**。没有 Cloudflare 账号/Token，Wrangler 也未安装。哪些验证过、哪些没有，见 `tests/results.md`。

## 它能做什么

1. **识别**：框架、构建命令、输出目录、base path、SPA/SSR/API 类型、GitHub Pages 配置、现有 Wrangler 配置、绑定、环境变量键名、PWA、风险信号。
2. **选型**：根据事实选 Pages 或 Workers，不套模板。
3. **计划**：写清改动和回滚；DNS、自定义域名、生产密钥、数据库、删除、不可逆配置必须先确认。
4. **构建检查**：部署前检查产物是否符合 Cloudflare 限制。
5. **部署**：先到 `pages.dev` / `workers.dev` 或预览分支。
6. **验收**：首页、404、资源、响应头、canonical/noindex、CORS、备用站独立性、DNS、数据、性能，按项目类型选择。
7. **报告**：每项写 通过/失败/警告/未验证，不编造没跑过的测试。

## 目录

```text
cloudflare-deploy/
├── SKILL.md                  # 主流程、路由、安全边界
├── README.md                 # 英文版
├── README.zh-CN.md           # 中文版（本文件）
├── references/
│   ├── prerequisites.md      # 账号、Token、Account ID、Node、Wrangler、R2
│   ├── console-paths.md      # 登录后的控制台路径
│   ├── cross-platform.md     # Windows / macOS / Linux / WSL / 容器 / CI
│   ├── platform-selection.md # Pages vs Workers、额度、价格
│   ├── deployment-workflows.md
│   ├── pages-runtime.md      # 响应头、重定向、404/SPA、缓存、CORS
│   ├── github-pages-backup.md
│   ├── verification.md
│   ├── troubleshooting.md
│   ├── security.md
│   ├── seo-indexing.md
│   └── migration-guide.md    # 迁移阶段 + Jekyll 实战数据
├── scripts/
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
    └── results.md
```

## 前提条件

| 条件 | 用在哪 | 怎么查 |
|---|---|---|
| Cloudflare 账号 | 全部 | `dash.cloudflare.com` 注册，验证邮箱 |
| Wrangler 登录 | 部署 | `npx wrangler whoami` |
| Account ID | API Token / CI | Account Home → 搜索 “Copy account ID” |
| Node.js 22+ | 构建和 Wrangler | `node -v` |
| Git | 仓库操作 | `git --version` |
| 域名 / DNS | 只有绑自定义域名 | NS 在哪、CAA 记录 |
| R2 订阅 | 只有用 R2 | Storage & databases → R2 开通 |
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

Agent 会运行 `scripts/detect-project.mjs`，只读当前任务需要的 reference，填 `templates/deployment-plan.md`，部署到预览，运行 `scripts/verify-deployment.mjs`，最后填 `templates/deployment-report.md`。

## 脚本

零依赖 Node 18+ ESM，只读：

```bash
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs
node scripts/check-build.mjs --dir dist --spa
node scripts/verify-deployment.mjs --url https://site.example.com --json
```

检查备用站：

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com \
  --backup https://owner.github.io/repo/ \
  --json
```

## 测试

```bash
node tests/run-tests.mjs
```

测试会创建 6 个合成项目（Vite SPA、Jekyll、Vite+Supabase、Hono+D1、重依赖 Express、Next.js SSR），断言识别结果，检查两个产物，并用本地 HTTP 服务器真实运行验收脚本——包括一个 301 到主站的假备用站。

这些测试证明脚本能工作，不证明账号权限、DNS、TLS 或平台行为。

## 设计约束

- 渐进披露：`SKILL.md` 只放路由、流程、安全边界；细节按需读 `references/`。
- 一个 reference 一个主题，不重复解释平台行为。
- 脚本确定性执行并输出 JSON，人类摘要按需输出。
- 不建空目录、不放占位资源。
- 报告必须区分 已验证 / 失败 / 未验证。

## 限制

- 不能替用户注册 Cloudflare 账号或完成 OAuth。
- CLI 不能代替控制台连接 Git 集成 / Workers Builds。
- DNS、自定义域名、生产密钥、数据库迁移、删除操作必须用户确认。
- 本构建环境没有执行真实部署。
