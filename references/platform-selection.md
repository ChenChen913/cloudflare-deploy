# 选型：Pages 还是 Workers

核实日期：2026-11-14。价格和额度会变，引用前重新核对官方页面。

## 1. 默认值已经变了

Cloudflare 的 Pages 文档顶部现在写着：

> Workers supports most Pages use cases and offers a broader feature set. It is Cloudflare's primary platform for building applications. Start new projects with Workers.

落到实践：

- **新项目** → 默认推荐 Workers。
- **已有 Pages 且运行正常** → 保留。Pages 仍在支持，官方文档没有强制迁移期限。
- **纯静态站** → Workers 也能托管；Pages 仍然赢在零配置 Git 部署，以及 DNS 不在 Cloudflare 的子域。

不要把“纯静态 → Pages”说成平台规则。它只是一个取舍。

### 1.1 识别脚本给的是候选，不是结论

`detect-project.mjs` 输出的是 `target.candidates` 和 `confidence`，不是“必须用哪个”：

- `confidence: high` 只来自现有 Wrangler 配置（已有 `main`/`assets` → Workers；已有 `pages_build_output_dir` → Pages）或硬阻断；
- `confidence: medium` 是“按项目类型推断”，静态站和 SPA 通常同时给出 `pages` 和 `workers`；
- `confidence: low` 表示没识别出来，先问清楚。

框架名不能单独决定平台。Vite、React、Vue、Jekyll 的产物都是静态资源，两个产品都能托管；真正决定的是下面 1.2 的三个问题。

### 1.2 三个问题定平台

按顺序问，先有答案的优先：

1. **域名的 NS 在不在 Cloudflare？** 不在，又要用 apex 域名 → 基本只能 Pages（Workers 要求 NS 托管；Pages 的子域可用外部 CNAME）。
2. **要不要零配置 `git push`？** 要 → Pages 的 Git 集成更省事；不介意维护 Wrangler 配置 → Workers 也行。
3. **以后要不要 Cloudflare 侧后端？** 要 D1/DO/Queues/Cron → 直接 Workers；后端在 Supabase/自建 API → 只迁前端，Pages 够用。

三个都答不上来时，不要把候选写成结论；在计划里留“待确认”，先部署到预览地址验证。

## 2. 决策表

| 情况 | 推荐 | 原因 |
|---|---|---|
| 已有 Pages，没有阻塞问题 | 留在 Pages | 迁移有成本，用户无感知收益 |
| 新静态站，域名 NS 在 Cloudflare | Workers + Static Assets | 官方默认；以后加 API 不用换平台 |
| 新静态站，DNS 在外部，用子域 | Pages | 外部 CNAME 可用；Workers 要求 NS 在 Cloudflare |
| 新静态站，要零配置 `git push` | Pages | 不用维护 Wrangler 配置 |
| Vite / React / Vue SPA | 两者都可 | Pages 用 `_redirects`；Workers 用 `not_found_handling` |
| 静态前端 + Supabase / Firebase | 两者都可，只迁前端 | 不要默认迁后端 |
| 需要 D1/KV/R2/DO/Queues/Cron | Workers | Pages Functions 能绑 KV/D1/R2，但没有 DO/Queues/Cron 和完整可观测性 |
| Next.js SSR/ISR | Workers + vinext 或 OpenNext | 除非应用允许静态导出 |
| Express/Nest/Fastify API | 运行时兼容则 Workers | 先查原生模块、`fs`、长驻任务 |
| 原生模块、`node:fs`、ffmpeg、Puppeteer | 不适合直接迁 | 保留原主机、用 Containers，或替换依赖 |
| 长驻进程 / WebSocket 服务 | Workers + Durable Objects，或保留原主机 | Workers 是请求级；DO 负责有状态协调 |

## 3. 硬约束

### 域名

- **Pages**：apex 域名必须是 Cloudflare 上的 zone（NS 指向 Cloudflare）。子域可以用外部 DNS 的 CNAME 指向 `<project>.pages.dev`；但必须先在 Pages 里添加域名，再去加 CNAME。顺序反了会 522。
- **Workers**：自定义域名要求域名的 NS 在 Cloudflare；没有外部 CNAME 这条路。
- 有 CAA 记录时，必须允许 Cloudflare 的 CA 签发证书，否则证书申请失败。

这一条经常直接决定选型。推荐之前先问 DNS 托管在哪。

### 静态资源限制（两个产品相同）

| 限制 | Free | Paid |
|---|---|---|
| 单次部署文件数 | 20,000 | 100,000 |
| 单文件大小 | 25 MiB | 25 MiB |
| Pages 自定义域名 / 项目 | 100 | 250（Pro）、500（Business） |
| Pages 构建次数 / 月 | 500，1 并发 | 5,000 / 5（Pro）、20,000 / 20（Business） |
| Pages 构建超时 | 20 分钟 | 20 分钟 |

Pages 付费档要启用 100,000 文件，需在项目设置里加 `PAGES_WRANGLER_MAJOR_VERSION=4`。

### Workers 运行时限制

| 限制 | Free | Paid |
|---|---|---|
| 请求 | 100,000/天 | 1,000 万/月，超出 $0.30/百万 |
| 每次调用 CPU | 10 ms | 含 3,000 万 CPU 毫秒，超出 $0.02/百万；单次上限 5 分钟（默认 30 秒） |
| Worker 包大小（未压缩） | 64 MiB | 64 MiB |
| 每次调用子请求 | 50 | 10,000（最高可配到 1,000 万） |
| 每个 Worker 环境变量 | 64 | 128 |
| 每个 isolate 内存 | 128 MB | 128 MB |

静态资源请求在两个产品上都不计费。

### 套餐与成本档（选型时就要给）

| 方案 | 套餐要求 | 成本档 | 备注 |
|---|---|---|---|
| Pages 静态 / Workers 静态资源 | 免费 | $0 | 多数静态站到这一步就够 |
| Workers + D1 / KV / R2 | 免费额度起 | $0 起，超额按量 | R2 首次使用要走一次 checkout |
| Workers Paid | 付费订阅 | $5/月 起 | 更高 CPU / 子请求额度 |
| Containers | **必须 Workers Paid** | $5/月 起 + 用量 | 免费计划不可用；本地还需 Docker 构建镜像 |
| Hyperdrive | 查现行定价页 | 按量 | 加速外部 Postgres，不等于托管 Postgres |

**Cloudflare 没有托管 Postgres**：D1 是 SQLite（Workers binding），外部 PG 要么保留外部服务，要么换数据库。运行时兼容性、ORM × 驱动组合、构建环境与止损线见 `references/runtime-compat.md`。

### 存储免费额度

| 产品 | 免费额度 | 备注 |
|---|---|---|
| KV | 10 万读/天、1,000 写/天、1,000 删/天、1,000 list/天、1 GB | 最终一致 |
| D1 | 500 万行读/天、10 万行写/天、**单库 500 MB**、账号 5 GB、10 个库 | 付费单库 10 GB；单库单线程 |
| R2 | 10 GB-month、100 万 Class A、1,000 万 Class B | 出站免费；IA 有 30 天最短存储期 |
| Hyperdrive | 10 万次查询/天 | 连接现有 Postgres/MySQL |
| Queues | 1 万次操作/天 | 超出需要 Workers Paid |

## 4. 部署方式

| 目标 | Git 集成 | CLI / CI |
|---|---|---|
| Pages | 控制台 Git 集成，按分支预览 | `wrangler pages deploy <dir>`；**Direct Upload 之后不能转 Git** |
| Workers | Workers Builds（GitHub/GitLab/Artifacts），有预览，日志保留 90 天 | `wrangler deploy`；`cf deploy`（beta） |

Pages 的 Direct Upload 和 Workers 的 CLI 可以和现有 Git 流程共存，但只能有一条生产部署路径。不要让两个 workflow 同时部署同一个项目。

## 5. CLI 选择

- **`wrangler`**：本技能默认使用，稳定；`wrangler pages deploy` 仍然只能用它。
- **`cf`**：2026-09-28 进入公测，2,900+ API 命令、`cloudflare.config.ts`、`cf init/dev/build/deploy`、`cf migrate`。官方明确 beta 期间命令、配置和构建输出可能变。不要放进生产 CI。

## 6. 什么时候应该拒绝迁移

出现以下任一情况，要明确说“不适合”，并给替代方案：

- 依赖 Workers 没有对应实现的 Node 原生模块，且无法替换。
- 运行时硬冲突（WASM 运行时动态编译、ORM 打包链路、适配器版本不匹配）——先查 `references/runtime-compat.md`，不要靠反复构建去试。
- 需要持久化本地文件系统或长驻后台进程。
- 数据库不能迁 D1/Hyperdrive，且外部数据库延迟不可接受。
- 域名不能迁 NS，而目标是 Workers。
- 站点超过 20,000 文件或有单文件超过 25 MiB，且用户不接受 R2。
- 用户只是“想用新的”，没有具体问题要解决。

替代方案：保留原主机、用 Cloudflare 做代理/CDN、只迁静态前端。

## 来源

- Pages 概览（官方“新项目从 Workers 起步”原文）：https://developers.cloudflare.com/pages/
- Pages 限制：https://developers.cloudflare.com/pages/platform/limits/
- Workers 限制：https://developers.cloudflare.com/workers/platform/limits/
- Workers 定价：https://developers.cloudflare.com/workers/platform/pricing/
- D1 限制：https://developers.cloudflare.com/d1/platform/limits/
- R2 定价：https://developers.cloudflare.com/r2/pricing/
- Pages 自定义域名：https://developers.cloudflare.com/pages/configuration/custom-domains/
- `cf` 公测公告：https://developers.cloudflare.com/changelog/post/2026-09-28-cloudflare-cli-beta
