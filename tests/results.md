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
| 本地 HTTPS 验收夹具 | `tests/fixtures/loopback-tls.mjs` 自签回环证书（仅用于 canonical 协议矩阵，子进程经 `NODE_EXTRA_CA_CERTS` 信任，TLS 校验保持开启） |

## 怎么复现

```bash
node tests/run-tests.mjs     # 210 项：识别、套餐与产物、真实 HTTP 验收、CORS 预检与简单请求、主站/资源重定向、跳数边界与 canonical 协议、JSON 结构、链路探针
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
node tests/run-tests.mjs     210/210 通过
node tests/check-skill.mjs   通过（SKILL.md 323 行，引用路径 27 个，无绝对路径）
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
| 12 | Next.js + Prisma + Drizzle + Neon HTTP | `nextjs/ssr`，`suggestedMode=ssr` | `workers` | 运行时依赖只标「待核对」、Neon HTTP 交互式事务提示，不把待核对写成不可行 |

### 构建产物

| 产物 | 断言 |
|---|---|
| 完整产物（index + 404 + `_headers` + 坏资源） | 通过但有警告；报告实际检查的资源数 |
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
| CORS 在独立端口（模拟独立子域） | `--cors-url` 指向 API 后通过，预检通过 |
| 重复 `Access-Control-Allow-Origin` | 判 `fail` |
| ACAO 与请求来源不匹配 | 判 `fail`（浏览器会拒绝） |
| 重复 canonical 标签 | 判 `fail` |
| 备用站 301 到主站 | 判 `fail` |
| 站点挂在 `/repo/` 子路径 | 未知路径、`index.html`、相对资源都按 `/repo/` 解析，检查通过 |
| SSR 服务器 + `--mode ssr` | 未知路径 404 通过；服务端渲染可见文本 339 字符通过；记录单次 TTFB |
| SSR + `--api /api/health --expect-json` | 2xx + JSON + 内容匹配 → 通过 |
| SSR + `--api /api/broken`（text/plain） | 非 JSON → `fail`，退出码 1 |
| SSR + `--expect-json` 内容不匹配 | → `fail`，退出码 1 |
| `--expect-json` 未配 `--api` | → `warn` |
| SPA 服务器 + `--mode ssr` | 未知路径 200 → 只 `warn`，不判失败 |
| CORS 预检矩阵（10 例） | 允许 Origin + 方法/头/凭据齐全 → `pass`；拒绝 Origin、缺 Allow-Methods、缺实际方法、缺 Allow-Headers、缺实际请求头、缺 ACAC、`*` 配凭据、204 但无 ACAO → `fail`；未提供参数时 3 项列入 `notChecked` |
| CORS 通配符 / 凭据 / 安全列表方法（12 例） | 无凭据 + `Allow-Methods: *` → `pass`；带凭据 + `*` → `fail`（`*` 是字面方法名）；无凭据 + `Allow-Headers: *` 覆盖 `content-type` 但不覆盖 `Authorization` → 后者 `fail`；带凭据显式方法与头 → `pass`；`GET/HEAD/POST` 缺 Allow-Methods 仍 `pass`；`put` 规范化为 `PUT` 后匹配；服务器回小写 `delete` 与 `DELETE` 不匹配 → `fail`；带凭据 + `ACAO: *` 的简单请求 → `fail`，无凭据 → `pass` |
| 资源重定向矩阵（9 例） | 直接 200 → `pass`（chain 1 跳、`finalStatus=200`）；301 同主机跟随到 200 → `pass` 并记录 `redirects`；302 后 404 / 直接 404 / 缺 `Location` / 循环超过 5 跳 / 非 HTTP(S) 目标 → `fail`；跨主机 → `warn` 且记录 `finalUrl` 与 `crossHost`；HEAD 405 → GET 复核仍 `pass` |
| CORS 简单请求凭据矩阵（6 例） | 无凭据 + `ACAO=*` + 有/无 `ACAC` → `pass`；带凭据 + `ACAO=*` → `fail`；带凭据 + 精确 ACAO + `ACAC=true` → `pass`；带凭据 + 精确 ACAO + 缺 ACAC → `fail`；结果带 `credentialsMode`，声明只来自用户 |
| 资源汇总一致性（5 例） | 直接 200 不进 `redirects`；同主机 301 进 `redirects`；跨主机 302 同时进 `redirects` 与 `warnings`，`probed` / `warnings` / `redirects` 三处字段一致；循环进失败记录且仍记为发生过重定向；缺 Location 进失败记录且不进 `redirects` |
| 重定向策略纯函数（8 例） | 相对 Location 同源可跟随；HTTP→HTTPS、HTTPS→HTTP 判跨源并标 `protocolChanged`；端口 / 主机 / `127.0.0.1` 变化判跨源；非 HTTP(S) 协议直接拒绝；空 / 无法解析 Location；始终约束到起始源 |
| 主站重定向矩阵（9 例） | 同源 301→200 → `pass` + `same-origin-verified`；同源 302→404 → `fail` + `same-origin-final-failed`；跨主机 / `127.0.0.1` / HTTP→HTTPS 都 `warn` + `cross-origin-unverified` 且目标服务器零请求；循环 / 无效 Location / 非 HTTP(S) 各自单独分类；跨源目标返回 200 不会给原站点判 `pass` |
| 备用站跳主站（2 例） | 只解析 `hops[].location` 识别跳主站并判 `fail`；跨源目标服务器全程未收到 landing 请求 |
| 主站 / 备用站跳数边界（7 例） | 连续 5 次同源重定向 → 最终 200 判 `pass` + `same-origin-verified`，链 6 跳、服务器收到 6 个链跳请求；最终 404 判 `fail` + `same-origin-final-failed`（不是超限）；第 6 次重定向判 `loop-or-limit`，`limitHop.followed=false`，第 7 个地址零请求；5 次同源后跨源仍 `warn` 且跨源目标零请求；原有循环用例恰好 6 次请求；`--backup` 的 5 次 → 200 判 `pass`、6 次判超限 |
| canonical 协议矩阵（5 例，真实本地 HTTPS 站点） | HTTPS + HTTPS 自身 canonical → `pass`（`sameProtocol/sameHost/samePath` 全 true）；HTTPS + HTTP canonical → `warn` 且 detail 点名「协议不一致」；其他主机 / 其他路径 → 原有 `warn`；多个标签 → 原有 `fail`。全部执行脚本并断言 JSON，不是读代码或匹配文案 |
| `--expect-json` 结构化比较（7 例） | 键顺序与空白不影响；字段缺失、类型不符、数组长度不符、嵌套数组子集、无效预期 JSON、非法响应 JSON 都给出明确原因 |

### 部署探针（纯逻辑 + 本地假 wrangler，不接触真实账号）

| 场景 | 结果 |
|---|---|
| 解析到 URL + HTTP 200 且响应体全等 `ok` | `pass`，`verified=true` |
| 部署成功但输出里没有 URL | `warn`，`verified=false`，绝不 `pass` |
| URL 不可访问 / 非 200 / 200 但内容不匹配 | `fail` |
| 部署命令失败 | `fail` |
| 临时 Worker 清理失败 | 单独 `deploy-cleanup: warn`，不影响 deploy 结论 |
| `--deploy` 端到端（假 wrangler） | 无 URL 不判 pass、清理失败单独记录、`nextSteps` 提示未验证、部署命令失败判 fail |

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
- 资源 3xx 不再算通过：同源按 `MAX_REDIRECTS=5` 跟随并验最终 2xx，跨主机记录最终地址并 `warn`，循环 / 缺 `Location` / 非 HTTP(S) 目标 / 最终 4xx/5xx 判 `fail`；只要收到带有效 Location 的 3xx 就进 `redirects`，`probed` / `warnings` / `redirects` 三处一致，报告保留 `chain` / `finalUrl` / `finalStatus` / `crossHost`。
- 主站、资源、`--backup` 共用同一跳数语义：最多跟随 5 次同源重定向并额外请求最终地址（共最多 6 次请求）；最终地址再返回 3xx 才判 `loop-or-limit`，`limitHop` 留证据且不请求它的目标。测试用服务器收到的路径数证明真的请求了最终地址、没有请求第 7 个地址，并覆盖「5 次后 404 不是超限」「边界处跨源仍不跟随」。
- 主站只自动跟随同源（协议 + 主机 + 端口）重定向；跨源、协议变化（含 HTTP↔HTTPS、HTTPS→HTTP）、非 HTTP(S)、无效 Location、循环都用 `redirectOutcome` 单独分类，跨源标 `warn` + `verified=false`，不请求目标，别的站点返回 200 不会给原站点判 `pass`。
- canonical 指向自身要求协议、主机、规范化路径三者一致；本地 HTTPS 站点上的 `http` canonical 实测判 `warn` 并点名协议不一致，结果带 `sameProtocol` / `sameHost` / `samePath`，跨主机 / 跨路径 / 多标签判定保持原样。
- CORS 预检不把 `OPTIONS` 2xx 当通过；只断言用户显式提供的实际方法 / 请求头 / 凭据，其余写进 `notChecked`。按 Fetch 规范处理 `*` × 凭据、`Authorization` 非通配、`GET/HEAD/POST` 安全列表方法与方法名大小写。简单请求的凭据模式只由 `--cors-credentials` 声明，响应里的 `ACAC: true` 不会把无凭据请求判成带凭据。
- 部署探针把「命令成功」和「线上验证成功」分开，清理失败单独告警。
- 链路探针在 `whoami --json` 调用失败时仍判定为已登录（该 flag 是官方能力，纯文本判定只是跨版本更稳），能从纯文本提取 Account ID；明确未登录时返回 `blocked` + 退出码 2。
- `check-env.mjs` 的退出码与 `canBuild` / `canDeploy` 一致，`--build-only` 只按可构建判定。

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
10. **CORS `hasToken()` 见 `*` 就判通过。** 带凭据时 `Allow-Methods: *` / `Allow-Headers: *` 是字面值，`Authorization` / `Range` 是 non-wildcard header（`*` 永不覆盖），`GET/HEAD/POST` 是 CORS-safelisted method。改为按凭据与方法规范分别判定，简单请求的 `ACAO` 也改用 `--cors-credentials` 判定。原有两个用 `POST` 断言「缺 Allow-Methods 判失败」的测试本身不符合规范，改用 `DELETE` 保留场景，并新增 safelisted 通过用例。
11. **资源 3xx 被默默当成正常。** 旧的「请求失败或 `status >= 400` 才判坏」在 `redirect: "manual"` 下把 301/302/307/308 全算通过。改为独立跟随（同主机按跳数上限，现为主站 / 资源共用的 `MAX_REDIRECTS=5`，见第 15 条）、验证最终 2xx，报告保留重定向链与最终状态；跨主机 `warn`、循环与最终 4xx/5xx `fail`。
12. **主站重定向链会被 3xx 带到任意地址（SSRF 面）。** 旧 `chain()` 无条件解析 Location 并继续请求：`127.0.0.1`、内网 IP、云元数据端点、协议变化、非 HTTP(S) 协议都可能被访问；跨站最终 200 还会让 `root` 判 `pass`；非法 `Location` 会让 `new URL` 抛异常。抽出零依赖纯函数 `scripts/redirect-policy.mjs`，按 `URL.origin`（协议 + 主机 + 端口）判定同源，主站与资源共用；非同源只记录 Location / 状态码 / 链，不请求目标。`root` 用 `redirectOutcome` 分五类，跨源 `warn` + `verified=false`；`backup` 只解析 `hops[].location` 识别跳主站，不为识别而请求主站。
13. **CORS 简单请求把 ACAC 响应头当成请求凭据模式。** 旧判断 `acao === "*" && (acac === "true" || corsCredentials)` 让「无凭据 + ACAO=* + ACAC=true」误判 `fail`，而「带凭据 + 精确 ACAO + 缺 ACAC」反而通过。改为只按 `--cors-credentials` 声明判定：声明带凭据才要求精确 ACAO + `ACAC: true`；预检断言逻辑未改。
14. **跨主机资源重定向没进 `redirects`。** `redirected: chainHops.length > 1` 在跨主机提前返回时链只有 1 跳，导致 `redirected=false`，汇总漏报。改为「3xx + 可解析 Location 即记为重定向」，`redirects` 收录同源与跨源，`probed` / `warnings` / `redirects` 统一同一组字段（原始 / 最终 URL、最终状态、跨主机标记、完整链）。
15. **主站重定向链的跳数边界少一跳。** 旧 `chain()` 用 `for (i = 0; i < max; i++)` 只发 5 次请求，最多跟随 4 次重定向；`probeAsset()` 用 `hop <= MAX_ASSET_REDIRECTS` 发 6 次，两者语义不一致。抽出共用 `MAX_REDIRECTS=5`，主站 / 资源 / `--backup` 都最多跟随 5 次并额外请求最终地址；第 6 次重定向判超限且不请求目标。为保留原循环用例的 `hops.length === 5` 语义，超限时未跟随的那一跳不进 `hops`，改由 `limitHop` 记录（`followed=false`）。跨源判定仍优先于跳数判定。
16. **canonical 只比 host + pathname，漏了协议。** `https` 站点上的 `http` canonical 会被判成「指向自身」。增加 `parsed.protocol === new URL(base).protocol` 检查，三者全一致才 `pass`；主机与路径相同但协议不同时 `warn` 并写明两个协议。路径规范化规则、跨主机 / 跨路径 / 多标签判定均未改动。为能真实以 `https://` 站点执行验收，新增本地自签回环证书夹具（不是真实凭据、TLS 校验保持开启、不需要 openssl 或第三方包）。

## CLI / JSON 兼容性

| 变化 | 性质 | 原因 |
|---|---|---|
| `--plan` / `--wrangler-version` / `--pages-wrangler-major`、`--cors-method` / `--cors-headers` / `--cors-credentials` | 新增可选参数 | 不传时行为与旧版一致（默认 Free 20,000；预检仍用 POST / `content-type,authorization` 作探针但不做断言） |
| `--expect-json` 从「字符串包含」改为「JSON 子集比较」 | **行为变化（必须）** | 字符串包含无法判断 JSON 结构，且会因格式/顺序误判；现在要求合法 JSON，失败时给出字段路径和原因。旧的非 JSON 片段用法不再支持 |
| `cors-preflight` 断言不成立时从 `warn` 变 `fail` | **行为变化（必须）** | 原来只要 OPTIONS 2xx + 有 ACAO 就通过，会把配置错误的接口判成可用 |
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
