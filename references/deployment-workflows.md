# 部署流程

命令默认在仓库根目录执行。占位符替换成实际值。Windows 用 Git Bash；PowerShell 的差异见最后一节。

## 0. 预检

```bash
node "<技能目录>/scripts/check-env.mjs"
node "<技能目录>/scripts/detect-project.mjs" "$PWD" --human
```

构建前确认：

- 包管理器和锁文件
- 构建命令、输出目录
- 项目要求的 Node / Ruby 版本
- 站点是 SPA、静态多页还是 SSR，以及对应的 `--mode`（`static` / `ssg` / `spa` / `ssr`；SSR 不走静态产物检查，直接验收）
- `_headers` / `_redirects` 是否存在、从哪里复制
- 自定义域名是否已经绑在别处

账号、Token、控制台路径见 `prerequisites.md` 和 `console-paths.md`。

## 1. Pages：Direct Upload

适用：构建必须放在自己的 CI，或两个目标需要不同产物。

```bash
# 首次创建项目
npx wrangler pages project create "<项目名>" --production-branch main

# 用项目自己的命令构建，然后上传
npm ci
npm run build
npx wrangler pages deploy "<输出目录>" --project-name "<项目名>"
```

注意：

- 首次部署会得到 `*.pages.dev` 地址。先在这里验收，再加域名。
- `--branch=<name>` 创建预览部署和分支别名。
- **Direct Upload 之后不能改成 Git 集成**，只能重建项目。
- 拖拽上传上限 1,000 文件，且不能编译 `functions/`；有 Functions 用 Wrangler。
- 生产分支只能通过 API 改（`PATCH /accounts/{id}/pages/projects/{name}`）。

## 2. Pages：Git 集成

控制台 → Workers & Pages → Create application → Pages → Connect to Git。配置：

| 字段 | 常见值 |
|---|---|
| 生产分支 | `main` |
| 构建命令 | `npm run build` / `bundle exec jekyll build` |
| 输出目录 | `dist` / `_site` / `build` |
| 根目录 | 仓库根目录，或 monorepo 的子包 |
| Node 版本 | 默认不对时设 `NODE_VERSION` |

Git 集成在 Cloudflare 的构建环境里跑。如果依赖本地特有的工具链（特定 Ruby、原生库），改用 Direct Upload。

## 3. Workers + Static Assets

纯静态站的最小配置（`wrangler.jsonc`）：

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "my-site",
  "compatibility_date": "2026-11-14",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "404-page"
  }
}
```

- SPA：`"not_found_handling": "single-page-application"`。
- API + 静态资源：加 `"main": "./src/index.ts"`，`"assets": { "binding": "ASSETS", "run_worker_first": ["/api/*"] }`。
- 纯静态：不要 `binding` 和 `main`，不需要 Worker 脚本。
- `_headers` / `_redirects` 放在静态资源目录里，Cloudflare 原生支持。
- 部署：`npx wrangler deploy`。
- 本地预览：`npx wrangler dev`（端口 8787；Pages 是 8788）。

`wrangler.toml` 等价写法：

```toml
name = "my-site"
compatibility_date = "2026-11-14"

[assets]
directory = "./dist"
not_found_handling = "404-page"
```

## 4. Workers Builds（Git）

控制台 → Worker → Settings → Builds → Connect。支持 GitHub、GitLab、Artifacts。

- 控制台里的 Worker 名字必须和 Wrangler 配置里的 `name` 一致，否则构建失败。
- 生产分支构建会创建版本并提升为活跃部署；其他分支创建 Preview。
- 构建日志保留 90 天。
- 仓库没有 Wrangler 配置时，autoconfig 会开一个 PR 补配置。
- Preview 的变量、密钥、绑定和生产分开配置。

## 5. 不同框架

### Vite / React / Vue SPA

```bash
npm ci
npm run build
```

- Cloudflare 上 `base: "/"`。GitHub Pages 的构建常常是 `base: "/repo/"`。
- SPA 回退只覆盖前端路由，不要把 `/api/*` 也回退成 HTML。
- 改 base 后检查 `manifest.webmanifest`、`sw.js`、图标路径。

### Jekyll（双构建）

一个仓库要产出两个不同绝对地址的产物时：

```bash
# GitHub Pages 产物
bundle exec jekyll build                       # -> _site

# Cloudflare 产物
bundle exec jekyll build \
  --config _config.yml,_config.cloudflare.yml \
  --destination _site_cf                       # -> _site_cf
```

`_config.cloudflare.yml` 通常只覆盖：

```yaml
url: "https://project.pages.dev"
include: ["_headers"]
```

规则：

- **必须写 `--destination`。** 两个构建写同一个 `_site` 会静默互相覆盖，CI 全绿但其中一个站是错的。
- Jekyll 合并 `--config` 时数组是整体替换；Cloudflare 配置里的 `include` 不会追加到基础配置。这正是把 `_headers` 挡在 GitHub 产物之外的原因。
- `_headers` 必须复制到产物根目录才生效。
- 如果 GitHub 产物要 `noindex`，只在那次构建里注入 `<meta name="robots" content="noindex, follow">`。

### Next.js

- 先跑兼容性检查：`npx vinext check`。
- 官方路径：vinext on Workers（`vinext init` 后部署）。已有 OpenNext 项目可以继续用 OpenNext。
- 静态导出（`output: "export"`）可以放 Pages 或 Workers 静态资源，但会失去 SSR/ISR/route handlers。
- 不要把 `.next/` 当静态资源上传，它不是可服务的站点。

### 静态前端 + Supabase / Firebase

- 只迁前端。
- 在新域名的 Supabase Auth 里更新 Redirect URLs、RLS 相关假设、允许来源列表。
- `service_role` 密钥只能放服务端；浏览器里只能有 anon key。
- 不要把 `.env` 复制进构建产物。

## 6. 环境变量与密钥

Pages：

```bash
npx wrangler pages secret put API_KEY --project-name "<项目名>"
```

Workers：

```bash
npx wrangler secret put API_KEY
```

- 生产环境和预览环境分开设置。
- 不要提交 `.env`、`.dev.vars`、`node_modules/.cache/wrangler`。
- 构建期变量会打进产物；泄漏后要轮换。
- CI 里优先用 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`，不要做交互式登录。

## 7. GitHub Actions 示例

Pages：

```yaml
permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: github-pages
    steps:
      - uses: actions/checkout@<完整 SHA>        # 固定到 SHA，不要用可移动 tag
      - uses: actions/setup-node@<完整 SHA>
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run build
      - uses: actions/upload-pages-artifact@<完整 SHA>
        with: { path: dist }
      - uses: actions/deploy-pages@<完整 SHA>
```

Workers：

```yaml
permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<完整 SHA>
      - uses: actions/setup-node@<完整 SHA>
        with: { node-version: 22, cache: npm }
      - run: npm ci && npm run build
      - uses: cloudflare/wrangler-action@<完整 SHA>
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

不要用 `pull_request_target` 去 checkout PR 代码。不要给 `write-all`。改 workflow 权限前先读 `security.md`。

## 8. 回滚

| 目标 | 最快 | 持久 |
|---|---|---|
| Pages | 控制台 → Deployments → Rollback（只回滚 Cloudflare 一侧） | revert commit，让 CI 重新部署 |
| Workers | 控制台/版本回滚，或 `wrangler rollback` | revert commit 并重新部署 |

Pages 控制台回滚是临时的：下一次 push 会覆盖。如果回滚意味着回到 GitHub Pages 当主站，还要重新添加自定义域名、等证书、改 DNS，这是另一套多步操作。

## 9. Windows

| 任务 | Git Bash（推荐） | PowerShell |
|---|---|---|
| HTTP | `curl -sI URL` | `curl.exe -sI URL` |
| 过滤 | `grep -i x` | `Select-String -Pattern x` |
| DNS | `dig +short example.com` | `Resolve-DnsName example.com -Type A` |
| 证书 | `openssl s_client ...` | 无原生等价命令；用 Git Bash |
| 循环 | `for i in 1 2 3; do ...; done` | `foreach ($i in 1..3) { ... }` |

`npx wrangler` 在两个 shell 里都能用。`npm ci` 需要锁文件；没有锁文件时只能用 `npm install`，并在报告里注明构建不可复现。

## 来源

- Pages Direct Upload：https://developers.cloudflare.com/pages/get-started/direct-upload/
- Pages Git 集成：https://developers.cloudflare.com/pages/get-started/git-integration/
- Workers Static Assets：https://developers.cloudflare.com/workers/static-assets/
- Workers Builds：https://developers.cloudflare.com/workers/ci-cd/builds/
- Wrangler 配置：https://developers.cloudflare.com/workers/wrangler/configuration/
- Next.js on Workers：https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/
