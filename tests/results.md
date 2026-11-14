# 测试结果

## 环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows（win32），Git Bash |
| Node.js | v22.22.2 |
| npm | 11.12.1 |
| git | 可用 |
| gh | 可用 |
| wrangler | 未安装 |
| dig | 不可用（Windows 默认没有） |
| openssl | 可用 |
| Cloudflare 账号 / Token | 本环境没有 |

## 实际执行了什么

```bash
node tests/run-tests.mjs
```

测试会在 `tests/.work` 下创建 6 个合成项目，分别运行 `detect-project.mjs`；再对两个产物运行 `check-build.mjs`；最后启动两个本地 HTTP 服务器，真实运行 `verify-deployment.mjs`。完整输出在 `tests/last-run.txt`。

结果：**23/23 通过**。

```text
通过  Vite：框架/类型 — vite/spa
通过  Vite：输出目录 + base — dist, /repo/
通过  Vite：识别 GitHub Pages
通过  Vite：推荐 Pages — pages
通过  Jekyll：框架/静态 — jekyll/static
通过  Jekyll：_site + CNAME — _site, www.example.com
通过  Jekyll：构建命令 — bundle exec jekyll build
通过  Supabase：SPA + 外部后端
通过  Supabase：环境变量键名 — VITE_SUPABASE_URL,VITE_SUPABASE_ANON_KEY
通过  Supabase：不假设 Cloudflare 后端 — pages
通过  Hono：API + Workers — hono/workers
通过  Hono：D1 绑定 + 资源目录
通过  重依赖：标记为 assess — assess
通过  重依赖：原生依赖风险
通过  重依赖：fs + 长驻进程风险
通过  Next：SSR -> Workers — ssr/workers
通过  Next：静态资源风险
通过  产物：通过但有警告 — 警告=1
通过  产物：发现坏资源
通过  产物：缺 404 被标记 — Pages 会当成 SPA
通过  验收：正常路径通过 — 失败=0
通过  验收：canonical + 404 + 资源
通过  验收：拒绝 301 备用站 — 备用站跳到主站
```

## 场景矩阵

下面的“决策”由技能规则和识别结果推出；**部署结果是模拟的**，没有使用真实 Cloudflare 账号。

| # | 测试项目 | 识别结果（实际） | 目标决策 | 需要确认的门槛 | 部署结果 |
|---|---|---|---|---|---|
| 1 | Vite + React SPA，`base: /repo/`，已有 Pages workflow | `vite/spa`，`dist`，`base=/repo/`，GH Pages 已配置 | Pages（零配置静态，已有 GH Pages） | 预览阶段无；正式域名后续确认 | 模拟：构建 → `check-build` → `wrangler pages deploy`；预期 `/index.html` 308，必须有 `404.html` |
| 2 | Jekyll 博客，`CNAME=www.example.com`，Actions 发布 | `jekyll/static`，`_site`，CNAME，GH Pages | Pages，双构建（GH + CF） | **移除 GitHub Pages 自定义域名**；索引策略 | 模拟：两次 `jekyll build`，`_headers` 只进 CF 产物，备用站验证 200/无跳转 |
| 3 | Vite + Supabase，有 `.env.example` | `vite/spa`，Supabase 键名，无 CF 后端 | 只迁前端到 Pages | Supabase Auth 回调；生产变量 | 模拟：前端部署；后端不动；CORS/OAuth 需验证 |
| 4 | Hono API + `wrangler.toml` + D1 绑定 | `hono/api`，`workers`，D1 绑定，资源目录 `./public` | Workers | **D1 迁移/备份**；生产密钥 | 模拟：`wrangler deploy`；需要行数核对和写入测试 |
| 5 | Express + sharp + puppeteer + better-sqlite3 + `fs` + `setInterval` | `express/api`，目标 `assess`，多个风险标记 | **不适合直接迁** | 无——停下来讨论 | 模拟：不部署；建议保留原主机/容器或替换依赖 |
| 6（附加） | Next.js SSR | `nextjs/ssr`，`.next`，静态资源风险 | Workers + vinext/OpenNext | 依赖/适配器变更；预览构建 | 模拟：先 `npx vinext check`，不直接部署 |

## 真实项目探测（只读）

另外对桌面上两个现有项目做了不部署的探测：

| 项目 | 识别结果 | 解释 |
|---|---|---|
| `3D建模` | `unknown`，目标 `undetermined`，根目录和一层内没有 `index.html` | 正确拒绝猜测站点根目录；唯一的 HTML 是 `web/island_viewer.html` |
| `网络测试` | `unknown`，目标 `undetermined`，提示“有 HTML 但没有 index.html” | 正确指出直接部署目录根会 404 |

这是有意设计：入口不明确时，技能应该问，而不是编造构建/输出路径。

## 测试证明了什么

- 识别脚本不需要安装依赖，就能读出框架、构建命令、输出目录、base path、GitHub Pages 配置、Wrangler 配置、绑定、环境变量键名和风险信号。
- 产物检查能发现缺失的 `404.html`、坏资源引用和限制超限。
- 验收脚本会发真实 HTTP 请求，并正确拒绝“301 到主站”的假备用站。
- 技能能区分“直接部署”“只迁前端”“Workers”“不适合”。

## 没有测试什么

| 项目 | 原因 | 以后怎么验证 |
|---|---|---|
| 真实 Pages/Workers 部署 | 没有 Cloudflare 账号/Token，wrangler 未安装 | `wrangler login` 后部署一个测试项目到预览地址 |
| 自定义域名 + TLS | 没有域名控制权 | 绑定测试子域，`openssl s_client` 检查 |
| DNS 切换 | 没有 DNS 权限 | 降低 TTL，切换后用 1.1.1.1 / 8.8.8.8 查询 |
| D1 迁移/读写 | 没有 D1 数据库 | 建测试库，导入后核对行数和写入 |
| GitHub Pages 自定义域名移除 | 没有仓库管理员权限 | 按 `github-pages-backup.md` 操作后 curl `github.io` |
| Search Console canonical | 没有站点权限 | 部署后用“网址检查” |
| GitHub Actions 部署 | 当前环境没有对应仓库/CI | 在测试仓库跑生成的 workflow |

## 测试中发现的问题

1. `verify-deployment.mjs` 最初漏写 `async`，导致语法错误；已修，备用站 301 测试通过。
2. `detect-project.mjs` 最初把带原生/重依赖的项目直接判成 Workers；现在返回 `assess`，强制停下来评估。
3. `detect-project.mjs` 最初忽略 `wrangler.toml` 里的 `assets.directory`；现在会作为输出目录。
4. `check-build.mjs` 把缺失顶层 `404.html` 当作警告而不是失败。这是有意的（SPA 可以没有），但报告必须点出来，因为 Pages 会把未知路径返回 200。
5. 中文化测试时，源码扫描把 `tests/` 下的测试项目误判成噪声目录，导致 `fs`/长驻进程风险漏报；已改成按“相对项目根目录”判断。
