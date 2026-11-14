# 测试结果

## 环境

| 项目 | 值 |
|---|---|
| 操作系统 | Windows 11（win32），Git Bash |
| Node.js | v22.22.2 |
| Python | 3.13.14（只用于外部格式校验） |
| git / gh | 可用 |
| wrangler | 未安装 |
| dig | 不可用（Windows 默认没有） |
| Cloudflare 账号 / Token | 本环境没有 |

## 怎么复现

```bash
node tests/run-tests.mjs     # 56 项：识别、产物检查、真实 HTTP 验收
node tests/check-skill.mjs   # 结构自检，零外部依赖
```

每次运行会在 `tests/.work/<时间戳>/` 下生成夹具，运行完不删除（该目录已 gitignore），避免与本机的安全删除钩子冲突。

外部格式校验（可选）：WorkBuddy 内置 `skill-creator` 技能里的 `quick_validate.py`。本机这份是 2,229 字节、2026-10-27 的版本，用 Python 3.13.14 执行：

```bash
python <skill-creator>/scripts/quick_validate.py <技能目录>
```

这个脚本不在本仓库里，路径随安装位置变化；换台机器不一定有。所以仓库另带 `tests/check-skill.mjs`，覆盖 frontmatter、name/description 长度、引用路径、绝对路径残留、文件名 ASCII、空目录，**任何人都能复现**。

## 结果

```text
node tests/run-tests.mjs     56/56 通过
node tests/check-skill.mjs   通过（SKILL.md 273 行，引用路径 23 个，无绝对路径）
quick_validate.py            Skill is valid!
```

完整输出在 `tests/last-run.txt`。

## 覆盖范围

| # | 合成项目 | 识别结果（实际） | 目标输出 | 验证点 |
|---|---|---|---|---|
| 1 | Vite + React SPA，`base: /repo/`，已有 Pages workflow | `vite/spa`，`dist`，`base=/repo/` | `candidates=[pages,workers]`，`suggested=null` | 不再凭框架直接定 Pages；输出目录标 `confirmed` |
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
| 11 | 有 `functions/` 的静态站 | `vite/spa`，`functionsDir=true` | `pages`，`medium` | 已按 Pages Functions 组织，不因“全栈”改推 Workers |

### 构建产物

| 产物 | 断言 |
|---|---|
| 完整产物（index + 404 + `_headers` + 坏资源） | 通过但有警告；报告实际检查的资源数 |
| 无 `404.html` | `static` 警告；`spa` 通过；`--spa` 与 `--mode spa` 等价 |
| 60+ 文件的嵌套产物 | 递归统计 62 个文件；`assets/css/site.css` 能解析 |

### HTTP 验收（真实服务器，不是 mock）

| 场景 | 结果 |
|---|---|
| 静态站 + `static` | 首页/404/canonical/资源全部通过，退出码 0 |
| 同一个静态站 + `spa` | 深链 404 → `warn`（不误判为失败） |
| SPA 服务器 + `spa` | 未知路径 200 + app shell → 通过 |
| SPA 服务器 + `static` | 未知路径 200 → `fail`，退出码 1（这就是原来的冲突点） |
| HEAD 返回 405、GET 返回 200 | 自动用 GET 复核，资源判通过并记录 `method=GET` |
| `--assets-limit 1` | 报告 `checked=1 / total=2 / limited=true` |
| CORS 在独立端口（模拟独立子域） | `--cors-url` 指向 API 后通过，预检通过 |
| 重复 `Access-Control-Allow-Origin` | 判 `fail` |
| ACAO 与请求来源不匹配 | 判 `fail`（浏览器会拒绝） |
| 重复 canonical 标签 | 判 `fail` |
| 备用站 301 到主站 | 判 `fail` |
| 站点挂在 `/repo/` 子路径 | 未知路径、`index.html`、相对资源都按 `/repo/` 解析，检查通过 |

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
- 验收脚本会发真实 HTTP 请求，能区分 SPA 回退、静态 404、重复 ACAO、重复 canonical 和假备用站。

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

## 测试中发现并修复的问题

1. **附加字段覆盖检查状态。** `add(id, status, detail, extra)` 先展开 `extra` 再放核心字段，导致 `{status: 200}` 把 `"fail"` 覆盖成数字，`summary.fail` 统计不到，会输出“失败=0”的假结论。已改为核心字段最后写入，并加断言锁住。
2. **Windows 上 `process.exit()` 偶发退出码 3221226505（0xC0000409）。** JSON 已完整输出，进程却以非 0 退出，CI 会误判失败。17 次连跑中复现 2 次；改用 `process.exitCode` 后连跑 3 轮全绿。
3. **未识别框架 + 多个 `index.html` 时没有风险提示。** 之前只在 `static-html` 分支提示；已覆盖 `unknown`。
4. **结构检查把运行期产物当成缺失路径。** `tests/.work` 只在测试运行时存在，已加入忽略列表。
5. **测试夹具目录删除失败会中断整轮测试。** 本机的安全删除钩子把 `fs.rmSync(tests/.work)` 转成回收站操作，文件被占用时抛 `Some operations were aborted`，整套断言直接不执行。改为每次用 `tests/.work/<timestamp>/`，不删旧目录。
6. 早前修复：`verify-deployment.mjs` 漏写 `async`；重依赖项目被误判成 Workers（改为 `assess`）；忽略 `wrangler` 的 `assets.directory`；源码扫描把 `tests/` 误当噪声目录。
