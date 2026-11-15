# 技术栈适配与落地方案

> 用途：接手一个“非纯静态”的项目时，先判断它在 Cloudflare 上大概走哪条路，避免把前端部署当成整个项目部署。  
> 定位：**选型清单，不是全自动能力承诺**。脚本完整覆盖静态站/SPA/SSG；其他技术栈需要按项目确认，不能因为文档写了就认为已经验证。  
> 建议输出：路线结论 + 阻塞项 + 代价 + 待确认问题 + 未验证项；不要复述整张表，也不要把“先给初判”变成连续盘问。  
> 核实日期：2026-11；产品/价格会变，执行时以官方页面为准。

## 1. 先分路线

| 项目形态 | 通常可行的路线 | 先别假设的事 |
|---|---|---|
| 纯静态、SSG、SPA | Pages，或 Workers Static Assets | 输出目录、SPA fallback、文件数/单文件限制 |
| JS/TS SSR、全栈 | Workers + 框架适配器；Pages 只适合既有项目/静态导出 | 适配器版本、Node API、图片/ISR、数据库绑定 |
| Python 后端 | 轻量纯 Python 可考虑 Python Workers；需要原生包/线程/大内存则 Containers 或保留外部后端 | C 扩展、线程、128MB、无持久文件系统 |
| Java/JVM 后端 | Containers（Docker 镜像），或保留原后端/反代 | Workers 没有 JVM；Containers 需 Workers Paid，冷启动、临时盘、无自动伸缩 |
| PHP、Ruby、.NET、Elixir 服务 | 通常 Containers 或保留外部后端 | 入站协议、常驻进程、数据库/文件系统、冷启动 |
| Go、Rust 服务 | Rust 有 workers-rs/一等路线；Go/Rust 也可编译 Wasm，但只适合特定场景；普通 HTTP 服务优先 Containers 或外部主机 | 不要因为“可编译 Wasm”就认为 Gin/Axum/ASP.NET 能原样跑；依赖/运行时/网络限制要核对 |
| 前后端分离 | 前端 Pages/Workers，后端 Workers/Python Workers/Containers/外部 API | 两条部署链、CORS、域名、secrets、回滚都要分别处理 |
| CMS、电商、移动端/桌面端 | 前端静态托管 + 原 CMS/SaaS/API；原生包、数据库、后台仍外部 | 不能原样托管 PHP/MySQL 动态站点（PHP 可容器化、MySQL 需外部）；应用商店包/桌面二进制仍外部；Workers/Containers 无原始 TCP/UDP 入站 |

## 2. 非 JS/TS 技术栈的现实边界

- **Java/JVM（Spring Boot、Quarkus、Micronaut、Tomcat、Kotlin/Scala 的 JVM 版等）**：Workers 官方没有 Java/JVM 运行时（Kotlin 可编译 Wasm、Scala 可 Scala.js，但不是普通服务端）。可容器化就评估 Containers；否则保留原服务器，用 Cloudflare 做 DNS/CDN/WAF/反代。Containers 需要 Workers Paid、linux/amd64 镜像；本地构建/推送时才需要 Docker（也可用预构建镜像或 CI）。通常有冷启动，磁盘是临时的，当前没有内置自动伸缩，且容器只能经 Worker 以 HTTP(S) 访问。
- **Python（FastAPI、Django、Flask 等）**：轻量、纯 Python/依赖可 Wasm、能接受 128MB/无线程限制的，可评估 Python Workers；有原生 C 扩展、线程/多进程、大内存、Redis/JMS、长任务，通常用 Containers 或外部后端。Python Workers 不是“完整 CPython 服务器”，不能直接照搬 uvicorn/gunicorn 部署。
- **PHP/Ruby/.NET/Elixir**：Workers 没有对应原生运行时，通常 Containers 或原平台。**Go/Rust**：Rust 有 workers-rs；Go/Rust 也可编译 Wasm，但只适合特定场景，不等于可以把 Gin/Axum/ASP.NET 原样搬上去；普通 HTTP 服务优先 Containers 或外部主机。
- **WordPress/WooCommerce 等动态 CMS**：不要直接往 Workers 塞 PHP。通常保留托管 WordPress + Cloudflare CDN/WAF，或把内容静态化（会丢失搜索、评论、登录、购物车等动态能力）。这类 PHP/MySQL CMS 不原样搬；动态后端可评估 Containers 或保留外部服务。
- **Shopify、Stripe、Supabase、Auth0、Sanity 等 SaaS**：Cloudflare 托管前端或做代理，业务后端/支付/认证仍在 SaaS；不要声称“整个电商/登录系统都部署到 Cloudflare”。
- **移动端、桌面端、游戏**：Cloudflare 最多托管其 Web 产物/API；原生二进制、应用商店、桌面安装包仍外部。Workers/Containers 没有原始 TCP/UDP 入站；Spectrum 可代理传统源站 TCP/UDP，但自定义 TCP/UDP 需 Enterprise+付费附加项。

> 结论不用说得太绝对：某项目“不适合直接迁”不等于“永远不能做”。可以给三条路：改依赖/改架构、Containers、保留外部后端。把代价说清楚，让用户选。

## 3. 前后端分离/混合项目

这是最容易误判的一类：仓库里有 `index.html` 或 Vite 配置，不代表整个项目只是静态站。

1. 先问后端在哪：同仓、另一个仓库、Supabase/Firebase、公司服务器、还是还没有？
2. 分别写部署方案：前端产物、后端运行时/容器、数据库/存储/队列依赖、域名/CORS/secrets。
3. 验收也分开：前端 200/资源/深链；后端 API/JSON、登录、数据库、回调、队列/定时任务。
4. 只部署了前端就明确写“后端未部署/未验证”，不要把前端能打开说成项目已上线。

## 4. 选择前要确认的事

先给路线初判，再问最阻塞的 2–3 个问题；其余列为待确认，不必一次问完：

- 运行时/框架/版本？有没有 Dockerfile 或容器化经验？
- 数据库、Redis、对象存储、文件上传在哪里？是否必须常驻/事务/本地盘？
- 有没有 WebSocket、定时任务、队列、长任务、后台 worker？
- 域名是否已有？NS 能否改？有没有 DNSSEC/CAA/邮箱记录？
- 目标用户主要在全球还是中国大陆？是否有境内主体/ICP？
- 预算大致是 $0、域名年费、Workers Paid，还是可以接受 Pro/Business/Enterprise？
- 验收标准是什么？只验收页面，还是必须验证 API/登录/支付/文件/实时？

## 5. 免费、付费、域名（简要）

- **Free 已包含自定义域、CDN、Universal SSL 和基础 WAF**；只有需要 Containers、更高额度或更高档 WAF/SLA 等能力时才升级（Business/Enterprise 有 uptime SLA，Pro 没有）。具体额度/价格看 `platform-selection.md`/`runtime-compat.md`，不要在这里写死。
- **域名**：已有域名通常保留原注册商、只改 NS；没有域名先用 `pages.dev`/`workers.dev` 验证；想买域名可用 Cloudflare Registrar（按成本价，无免费域名）或其他注册商后改 NS。改 NS 前先处理 DNSSEC/CAA/邮箱记录，细节见 `prerequisites.md`。
- **中国大陆**：Cloudflare 全球网络没有中国大陆节点；`pages.dev` 官方说明在中国大陆不可用（[China Network FAQ](https://developers.cloudflare.com/china-network/faq/)；全球 zone 的 Pages 是否可扩展以官方/合同为准）；China Network 需要 Enterprise+ICP+JD Cloud 审核，国内 CDN 需要 ICP。免费版不能承诺大陆流畅，也不要写“加 Cloudflare 就免备案/能翻墙”。

## 6. 自动化边界

- `check-build.mjs`、`verify-deployment.mjs` 主要服务静态站/SPA/SSG 和 HTTP 层；对 Java/Python/PHP/Ruby/.NET/Containers **不构成完整验收**。
- 容器健康、冷启动、数据库、队列、WebSocket、文件持久化、后台任务需要单独验证；没测就写“未验证”。
- 本技能包不内置每种语言的专用脚本；项目侧该做的最小冒烟/健康检查仍按需做，具体命令/版本以项目官方文档和 Cloudflare 官方文档为准。
- 目前有两份真实 Pages 经验（hangla 记录 + `migration-guide.md` 的 Jekyll 项目）；但都不能外推为 Workers/Containers/Java/Python 已验证。

## 7. 官方入口

- Workers 语言/限制：https://developers.cloudflare.com/workers/languages/ ，https://developers.cloudflare.com/workers/platform/limits/
- Python Workers：https://developers.cloudflare.com/workers/languages/python/
- Containers：https://developers.cloudflare.com/containers/
- Pages/Static Assets：https://developers.cloudflare.com/pages/ ，https://developers.cloudflare.com/workers/static-assets/
- 套餐/定价：https://www.cloudflare.com/plans/ ，https://developers.cloudflare.com/workers/platform/pricing/
- Queues 定价：https://developers.cloudflare.com/queues/platform/pricing/
- 域名/Registrar：https://developers.cloudflare.com/registrar/
- 中国网络：https://developers.cloudflare.com/china-network/ ，https://developers.cloudflare.com/china-network/faq/
