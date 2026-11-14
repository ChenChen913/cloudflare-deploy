# 运行时兼容性与可行性

> 一句话：**先判「能不能跑」，再判「怎么部署」。**
> 静态站不需要读这份。SSR / 全栈、带 ORM 或数据库、带原生模块、需要框架适配器的项目，在动 `next.config.*` 之前先读。

`detect-project.mjs` 只会把可疑依赖写进 `risks`，**不会**替你下「可行 / 不可行」的结论。下面的表格是「需要核对什么」的清单，不是「保证能跑」的承诺：官方限制会变，框架适配器版本会变，最终证据必须来自官方现行文档加一次真实的最小验证。

## 0. 第 0 步：先探针，别先改工程

```bash
node "<技能目录>/scripts/probe.mjs"          # 默认只读
```

退出码就是结论：`0` ready、`1` limited（有缺口，先看 warn）、`2` blocked（**停下来**）。blocked 时不要开始改项目配置、装适配器或跑构建。

`--deploy` 会真实创建并删除一个临时 Worker，属于写操作，**必须先得到用户同意**；本仓库没有在真实 Cloudflare 账号上验证过它。**部署命令成功不等于线上验证成功**：必须解析到 URL 并真实请求通过才判 `pass`；没 URL 或 URL 不可访问只会得到 `warn` / `fail`，清理失败单独记 `warn`。

关于 `npx wrangler deploy --temporary`：它只在**未登录**时可用，用的是临时账号，因此**不能验证你的账号、Token 权限、套餐或区域**，而且会过期。它可以用来证明「网络能不能把包送上去」，不能证明「你这个账号能不能部署」。这正是最容易误判的一点。

## 1. 可行性三问（目标 10 分钟，只查文档不写代码）

1. **框架**：有没有官方适配器？版本对不对得上（适配器对 Next.js 等有 peer 约束）？
2. **运行时**：ORM / 数据库驱动能不能跑在 workerd？依赖里有没有 WASM 动态编译、原生 `.node` 模块、被禁用的 Node API？
3. **体积与套餐**：产物会不会超现行限制？需要的服务（Containers、Hyperdrive 等）在你当前的套餐里可不可用？

产出是 **「可行 / 不可行 + 依据」**，不是代码，也不是「先构建一下看看」。

## 2. 已知组合矩阵

「证据」列区分官方硬限制与一次实战观察。实战观察只说明某个版本组合下的现象，**不要当成通用结论**。

| 组合 | 结果 | 证据 | 下一步 |
|---|---|---|---|
| Prisma + 纯 Worker（Hono 等，走 wrangler/esbuild） | 可行 | 官方：Prisma 提供 driver adapter 与 `prisma-client` generator 支持 Workers/D1 | 按官方 driver adapter 配，别照搬 Node 版 `@prisma/client` 用法 |
| Prisma 7 查询编译器（WASM）+ Next.js webpack + Workers | 曾出现硬阻断 | 实战观察：`Wasm code generation disallowed by embedder`；webpack 把 `.wasm` 拆成独立文件，workerd 没有文件系统 | **不能写成「Prisma 不支持 Workers」**；先查当前版本与适配器，再决定换 ORM 或换打包链路 |
| Next.js SSR / ISR + Cloudflare | 需要适配器 | 官方与社区：vinext / `@opennextjs/cloudflare`，不是纯静态上传 | 先核对适配器版本矩阵；`output: 'export'` 才能当静态站 |
| `node:fs` / `createServer` / `setInterval` 常驻 | 不支持 | 官方：workerd 无持久本地文件系统，请求级执行 | 文件迁 R2，定时任务用 Cron / Queues，或保留原主机 |
| 原生模块（`sharp` / `canvas` / `bcrypt` / `argon2` / `better-sqlite3` / `sqlite3`） | 不支持直接加载 | 官方：Workers 不能加载原生 `.node` 扩展 | 换纯 JS 实现、`nodejs_compat` 支持的替代、D1 或外部服务 |
| `pg` / `mysql2` + Workers | 有条件可行 | 官方：需要 `nodejs_compat`；连接数受平台限制 | 配 Hyperdrive，评估冷启动与连接池；不要直接把本地连接串搬上去 |
| Neon HTTP 驱动 + 交互式事务 | 不支持 | 实战观察：HTTP 驱动没有 `db.batch` 之外的交互式事务能力 | 需要事务时改用 WebSocket 驱动（如 `drizzle-orm/neon-serverless`） |
| WASM 运行时动态编译 | 禁止 | 官方：workerd 只接受预编译的 WASM 模块 | 让打包器输出 `?module` 预编译模块，并确认它被打进 bundle 而不是落到磁盘 |
| `serverExternalPackages` 之类「外部化依赖」配置 | 反模式 | 实战观察：适配器会重建 `node_modules` 软链，而 Workers 没有 `node_modules` | Cloudflare 构建时移除，所有依赖打进 bundle |
| OpenNext 类适配器 + 本地 Windows 构建 | 高失败率 | 实战观察：symlink EPERM、构建长时间无进展；适配器对 Windows 支持有限 | **推荐走 Git 集成 / Workers Builds 让平台构建**，不要在 Windows 本地硬扛 |

补充：`@prisma/adapter-pg` 在 Workers 上「理论可行」不等于「这条打包链路可行」。判断依据是**依赖怎么被打进 bundle**，不是 ORM 名字。

## 3. 体积、额度与成本（选型阶段就要给）

现行数值以 2026-11 官方 Limits / Pricing 页为准，别沿用旧文档：

- Worker 脚本大小：**64 MiB（未压缩）**（2026-11 官方 Limits 页）。旧资料里的 3 MB / 10 MB 已过时；以现行页面为准。
- Workers Paid 的子请求上限是 **10,000**，不是 1,000。
- CPU 时间、请求数、并发、D1/R2 免费额度会调整，**查官方现行页面，不要写死在计划里**。

| 方案 | 套餐要求 | 成本档 | 备注 |
|---|---|---|---|
| Pages 静态 / Workers 静态资源 | 免费 | $0 | 多数静态站到这一步就够 |
| Workers + D1 / KV / R2 | 免费额度起 | $0 起，超额按量 | R2 首次使用要走一次订阅 checkout，即使只用免费额度 |
| Workers Paid | 付费订阅 | $5/月 起 | 更高的 CPU / 子请求额度 |
| Containers | **必须 Workers Paid** | $5/月 起 + 用量 | 免费计划不可用；本地还需要 Docker 构建镜像 |
| Hyperdrive | 付费相关 | 查定价页 | 用于加速外部 Postgres，不等于 Cloudflare 托管 Postgres |

**Cloudflare 没有托管 Postgres。** D1 是 SQLite，通过 Workers binding 访问；外部 Postgres 要么保留外部服务，要么换 ORM/数据库。这是「部署前必答」的问题，不是部署后才发现的事。

查自己账号的能力，别猜：

- 套餐 / 订阅：控制台 `Manage Account → Billing → Subscriptions`。
- R2 是否开通：控制台 `Storage & databases → R2`，或 `npx wrangler r2 bucket list`（返回权限/订阅错误即未开通）。
- 账号是谁：`npx wrangler whoami`；Account ID 在 `Account Home` 搜 “Copy account ID”。
- 需要 API 自动化时，用带 `Account Settings`/`Workers Scripts` 读权限的 API Token；Token 只放环境变量，不要写进文件或聊天。

## 4. 构建环境也是选型条件

SSR / 全栈项目的构建常依赖完整 Node 工具链、symlink、原生模块。本地是 Windows、WSL 被策略禁用、或依赖原生模块时，**直接推荐 Git 集成 / Workers Builds 在平台侧构建**，而不是「本地构建 → 上传产物」。

止损线（写进计划，执行时照做）：

> 同一构建步骤连续失败 **2 次**，或单次超过 **15 分钟**没有实质进展 → 停止调优。换构建环境或换方案，并向用户说明，不要继续等。

## 5. 允许「不建议迁移」这个结论

当前提不成立、技术栈与运行时硬冲突、构建环境不可靠时，正确答案是**把选项和代价摆给用户**，不是闷头试到底：

- A. 换 ORM / 驱动（工作量、影响范围）
- B. 换部署方案（套餐、月度成本）
- C. 换平台（保留原主机 / 容器托管）

报告里如实写「本技术栈目前不适合部署到 Cloudflare」及依据，这也是一次合格交付。

## 6. 本地跑通 ≠ 线上跑通

`wrangler dev` 能启动只说明本地链路可用，线上还要面对：

- 真实的 TLS / TCP 出站限制与区域策略；
- Worker 体积上限和打包差异；
- 冷启动、并发与 CPU 限额；
- 本地能连 `127.0.0.1` 的数据库，线上连不到；
- 真实 Secrets 与 bindings 没配齐。

因此报告里必须分开写「本地已验证」「线上已验证」「未验证」。`verify-deployment.mjs --mode ssr --api /api/health` 只能验证 HTTP 层；数据库写入、登录会话、第三方回调仍需按 `references/verification.md` 人工或专项验证。
