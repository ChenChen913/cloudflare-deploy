# 多平台部署决策与迁移升级方案

> 目标仓库：cloudflare-deploy  
> 版本：v2 设计稿  
> 日期：2026-11-20  
> 状态：迭代 1–3 + 第二阶段准确性整改已落地；后续按需扩展  
> 范围：GitHub Pages、Cloudflare Pages、Vercel Hobby、Netlify Free、Render Free 五个核心平台；Cloudflare Workers、Vercel Pro、Railway、Fly.io、Supabase 扩展池

## 0. 结论先行

1. **保留现有底座**：链路探针、只读识别、构建检查、Cloudflare 部署、HTTP 验收脚本全部保留；升级只在识别与选型之间插入决策层，在验收与报告之间插入迁移检查。
2. **新流水线**：probe → 识别仓库 → 部署适配度评估 → 平台能力矩阵筛选 → 选型（首选 / 备选 / 不推荐）→ 网络与进阶需求引导 → 写计划（含回滚）→ 构建 → 部署到预览 → HTTP 验收 → 迁移检查（如适用）→ 写报告。
3. **三步落地**：迭代 1 只做适配度评估与大陆访问风险硬提示；迭代 2 做平台能力矩阵与多平台选型；迭代 3 做迁移引擎与进阶引导。迁移先覆盖 GitHub Pages ↔ Cloudflare Pages ↔ Vercel 三条最高频路径，验证通过后再扩展 Netlify 和 Render。
4. **Cloudflare 路径不变**：现有 Pages / Workers 选型逻辑不重写；静态站免费层仍默认推荐 Cloudflare Pages（静态带宽无限），已有用户不会被改变推荐。
5. **不夸大自动化**：本轮升级不承诺自动部署到 Vercel、Netlify、Render 或 GitHub Pages；这些平台输出人工操作清单，构建检查与 HTTP 验收仍复用现有脚本。脚本不支持时必须给出可执行的人工步骤。
6. **硬规则**：不确认不切 DNS、不绑自定义域名、不迁数据库、不删除旧部署；不读取或写入密钥值，只记录环境变量键名；目标用户含中国大陆或未明确说明时，必须输出完整大陆访问风险提示，不得折叠或省略。

### 0.1 证据标注

| 标注 | 含义 |
|---|---|
| 官方 | 平台文档或定价页明确写出 |
| 需求方资料 | 本次升级需求提供的 2026 免费额度资料；发布前复核官方页面 |
| 建议 | 取舍，不是平台规则 |
| 待验证 | 没有实测，或平台没有承诺 |

平台额度、价格和默认域名风险会变。矩阵数据必须带 `checked_at`，引用前重新核对官方页面；不要把一次实测写成通用保证。

### 0.2 迭代 1 落地记录

- 新增 `select-platform.mjs`：四维适配度评估、候选筛选、首选 / 备选 / 不推荐、大陆风险提示；只读、不访问网络。
- 新增 `mainland-china-access.md`：默认域名表现、硬提示、路线 A / B、验证方法。
- 修改 `SKILL.md`：第 2 步拆成评估、选型、大陆风险、评估脚本、Cloudflare Pages vs Workers。
- 修改部署计划 / 报告模板：加入适配度评估、目标平台、大陆风险段。
- 更新 README 中英文版、`tests/results.md`、`tests/last-run.txt`。
- 测试：759/759 通过；`select-platform.mjs` 覆盖 17 个评估用例（四维组合、排除原因、风险提示、非法参数、目录识别、Supabase 键名推断）。

### 0.3 迭代 2 落地记录

- 新增 `platform-matrix.json`：8 个平台、5 个核心 + 3 个扩展，带 `schema_version`、`checked_at`、`free_tier_limits`、`custom_domain`、`mainland_china_risk`、`migration_notes`、`sources`。
- 新增 `platform-matrix.mjs`：矩阵读取、结构校验、渲染模式筛选、长期运行 / 免费预算策略、首选 / 备选 / 不推荐排序；纯函数、无网络。
- 重构 `select-platform.mjs`：删除内置平台摘要，改为读矩阵；矩阵不可用时退出码 1，输出已得评估和人工核对清单。
- 新增 17 个矩阵测试：加载 / 必填字段 / ID 唯一 / 非法矩阵 / 静态 / SSR / fullstack / 长期运行筛选 / 选型 / 平台详情。
- 更新 SKILL.md、README 中英文版、`tests/results.md`、`tests/last-run.txt`。
- 测试：776/776 通过（core 332 / adversarial 276 / boundary 43 / combination 5 / unit 120）。

### 0.4 迭代 3 落地记录

- 新增 `migration-plan.mjs`：校验 source / target / project_type；生成迁移前检查、双活五步、DNS 确认门、回滚、报告骨架；只读，不执行 DNS / 部署 / 数据库操作。
- 新增 `templates/migration-plan.md`、`templates/migration-report.md`。
- 新增 `cross-platform-migration.md`、`custom-domain-guide.md`、`advanced-needs.md`。
- SKILL.md 增加 6A 迁移检查，并把域名 / 付费 / 后端引导接到 2.x 和参考资料。
- 支持五个平台两两迁移；测试覆盖 GitHub Pages ↔ Cloudflare Pages ↔ Vercel 六条有向路径，以及 Netlify → Render、未知平台、矩阵缺失、同平台拒绝、环境变量键值拒绝。
- 新增 18 个迁移测试；测试总数 794/794（core 350 / adversarial 276 / boundary 43 / combination 5 / unit 120）。

### 0.5 第二阶段准确性整改记录

- 矩阵新增 `cloudflare-workers`、`vercel-pro`，Pages/Workers 与 Hobby/Pro 明确分开；静态站仍默认 Pages，新 SSR / 全栈优先 Workers，已有 Pages 健康不强制迁移。
- 新增 `usage_type`（个人非商业 / 商业 / 未知）和 `--existing`；商业项目不推荐 Vercel Hobby，未知时不擅自认定个人非商业。
- 术语从“四维评分”统一为“四维适配度评估”；不引入数字综合分。
- 迁移状态改为 `provided` / `inferred` / `verified` / `pending` / `blocked` / `not_applicable`；用户提供信息不再标 `confirmed`。
- 大陆风险增加证据等级：官方声明、网络观测、待验证；不伪造实测数据。
- 矩阵新增 `selection_pools`、`commercial_use`、`paid_only`、`render_notes` 等字段，减少硬编码平台列表。
- 测试总数 829/829（core 385 / adversarial 276 / boundary 43 / combination 5 / unit 120）。

---

## 1. 交付物一：修改后的 Skill 正文结构

### 1.1 frontmatter

`name` 暂不改名，仍为 `cloudflare-deploy`。原因是技能目录名、安装链接和现有触发词都依赖它；改名会破坏现有安装，收益只是名字更宽泛。升级后通过扩展 `description` 覆盖多平台触发词。

建议的 `description`：

> 把程序项目部署或迁移到 Cloudflare Pages / Workers、GitHub Pages、Vercel、Netlify、Render 的多平台决策与执行技能。先做链路探针和技术可行性判定，再只读识别项目，给出部署适配度评估与首选 / 备选 / 不推荐建议，并强制提示中国大陆访问风险；支持静态站、SPA、SSG、SSR / 全栈与后端数据库项目的路线判断，以及五个核心平台之间的迁移检查。部署后用真实 HTTP 请求验收，报告中区分已验证 / 失败 / 未验证；DNS、自定义域名、数据库和删除操作必须先确认。

### 1.2 正文目录与要点

| 章节 | 要点 | 改动 |
|---|---|---|
| 开头能力边界 | 自动化脚本仍完整覆盖静态站 / SPA / SSG；SSR / 全栈是流程清单；新增“平台建议不是部署保证”“非 Cloudflare 平台默认人工执行” | 修改 |
| 一、先决条件 | 分两层：通用前提（Node、Git、网络）和平台账号前提；Cloudflare 表保留，其他平台按需展开 | 扩展 |
| 二、登录后的路径 | 保留 Cloudflare 控制台路径；新增其他平台入口表（GitHub、Vercel、Netlify、Render） | 扩展 |
| 三、跨系统差异 | 保持原样；补充非 Cloudflare CLI 的跨系统注意事项 | 小改 |
| 四、工作流 | 0 probe → 1 识别 → 2A 评估 → 2B 矩阵筛选 → 2C 选型 → 2D 网络与进阶引导 → 3 计划 → 4 构建 → 5 部署预览 → 6 验收 → 6A 迁移检查 → 7 报告 | 扩展 |
| 五、必须遵守的判断 | 新增多平台不变量：评估不替代可行性、矩阵数据要复核、迁移必须双活、DNS 必须确认、密钥只记键名 | 扩展 |
| 六、失败处理 | 保留 Cloudflare 分支；新增 Vercel、Netlify、Render、DNS、自定义域名失败分支 | 扩展 |
| 七、参考资料 | 新增大陆访问、域名、进阶需求、跨平台迁移四份 reference，以及迁移计划 / 报告两份模板 | 扩展 |
| 八、输出要求 | 新增适配度评估块、大陆访问风险块、迁移报告块；保留“已验证 / 失败 / 未验证”三段式 | 扩展 |

### 1.3 新流水线的步骤定义

| 步骤 | 做什么 | 主要输入 | 输出 | 停止条件 |
|---|---|---|---|---|
| 0 链路探针 | 查网络、Git 远端、Cloudflare 登录态；判可行性 | 仓库目录 | ready / limited / blocked | Cloudflare 目标 blocked 硬停；非 Cloudflare 目标按作用域解释 |
| 1 只读识别 | 识别框架、构建、输出目录、站点类型、配置、绑定、环境变量键名、PWA、子应用 | 仓库文件 | 带 confirmed / inferred / unknown 的 JSON | 关键字段 unknown 且无法从文件确认时，先问用户 |
| 2A 适配度评估 | 按渲染模式、后端与数据库、用户地域、预算四维适配度评估 | 识别结果 + 用户回答 | 四维结论 + 候选池 + 排除原因 | 四维不齐不进入选型 |
| 2B 矩阵筛选 | 用平台能力矩阵按 `render_support`、后端、地域、预算筛候选 | 评估结果 + 矩阵 | 候选平台与排除平台 | 矩阵缺失或损坏时降级为人工矩阵 |
| 2C 选型 | 给出首选、备选、不推荐及理由 | 候选平台 | 选型结论 | 首选必须能解释“为什么是它” |
| 2D 网络与进阶引导 | 大陆风险硬提示；域名、付费、后端数据库引导 | 选型结论 + 用户需求 | 风险提示 + 操作入口 | 含大陆或未明确地域时，风险提示不可省略 |
| 3 写计划 | 写目标、改动、命令、环境变量键名、验收、风险、止损线、回滚 | 前序结论 | 一屏内计划 | DNS、域名、密钥、数据库、删除、计费未确认时停下 |
| 4 构建 | 用项目自己的构建命令；检查产物 | 计划 | 构建结果 | 连续失败 2 次或 15 分钟无进展，止损 |
| 5 部署到预览 | Cloudflare 用现有命令；其他平台按官方 Git 集成或 CLI 人工执行 | 构建产物 | 预览 URL | Direct Upload 等不可逆操作先确认 |
| 6 HTTP 验收 | 首页、404 / 回退、资源、响应头、canonical、CORS、API | 预览 URL + 产物 | pass / warn / fail / skip | 同一 `--mode` 贯穿构建与验收 |
| 6A 迁移检查 | 仅迁移场景：双活、目标预览验收、DNS 切换、观察期 | 源平台 + 目标平台 + 预览 | 迁移报告 | 目标预览未通过不切 DNS |
| 7 写报告 | 汇总识别、评估、选型、风险、迁移、验收、回滚 | 全流程证据 | 部署 / 迁移报告 | 没测过的写“未验证” |

保留原步骤编号 0–7，把新增决策层放在第 2 步内部（2A–2D），把迁移检查放在第 6 步之后（6A）。这样现有文档里“第 4 步构建”“第 6 步验收”“第 7 步报告”的交叉引用不需要整体重编号，降低破坏现有流水线的风险。

### 1.4 新增“能力边界”段落

建议放在 SKILL.md 开头现有能力边界之后：

> 本技能现在覆盖“多平台部署决策 + Cloudflare 执行”。自动化脚本仍完整覆盖静态站 / SPA / SSG 的构建检查与 HTTP 验收；SSR / 全栈、Java / Python / PHP / Ruby / .NET、容器与前后端混合项目仍按流程清单使用。平台能力矩阵和迁移模块提供决策、检查清单与报告模板，不替代目标平台的账号权限、DNS、数据库和真实运行时验证。非 Cloudflare 平台的部署默认由用户按官方流程执行；技能负责给出步骤、风险和验收命令，不声称已经自动完成。

### 1.5 新增“必须遵守的判断”

在现有判断列表末尾追加：

- **评估不是可行性结论。** 适配度评估只回答“哪类平台更合适”，不能替代 probe、运行时可行性判定和账号检查。
- **矩阵数据必须带日期。** 引用免费额度前先看 `checked_at`，并复核官方定价页；不要把 2026 年的数字当成永久承诺。
- **候选必须能解释排除。** 排除 GitHub Pages、Netlify 静态托管或 Render 时，要写具体原因（渲染模式、后端、冷启动、地域、预算），不能只写“不推荐”。
- **迁移必须双活。** 目标平台预览未通过验收前，不切 DNS、不删源平台、不改生产域名。
- **DNS 与域名绑定必须确认。** 只输出待执行步骤；没有用户明确确认，不执行任何 DNS 记录变更或自定义域名绑定。
- **密钥只记键名。** 迁移检查、计划、报告里只写环境变量键名和存放位置，不读取、不写入、不回显值。
- **非 Cloudflare 目标不套用 Cloudflare 阻断。** probe 的 Cloudflare API / 登录失败只说明 Cloudflare 路径不可用；网络和 Git 检查仍有效，不能把 Cloudflare 专属失败解释成所有平台都不可部署。
- **现有部署健康时优先不迁移。** 没有明确问题、没有收益、没有验收方案的迁移，结论应是“保留现平台”。
- **不推荐也必须给替代方案。** 每个“不推荐”后面至少跟一个可执行的首选或备选。
- **报告区分证据等级。** 官方、实测、建议、待验证不能混写；没跑过的检查写“未验证”。

---

## 2. 交付物二：新增或修改的选型逻辑段落

以下内容可直接放入 SKILL.md 第 2 步，替换原来只有“Pages vs Workers”的选型段。Cloudflare 内部的 Pages / Workers 判断仍保留，并作为第 2C 步的子决策。

### 2.1 输入：先问四个问题

选型前必须先拿到四个答案；识别脚本能推断的标 `inferred`，不能推断的标 `unknown` 并问用户：

1. **目标用户主要在哪？** 海外 / 含中国大陆 / 未明确。
2. **有没有后端和数据库？** 无 / 轻后端（Serverless、API）/ PostgreSQL + Auth + Storage / 长期运行服务或 Docker。
3. **预算？** 免费优先 / 愿意付费。
4. **现在有没有已部署的站点？** 无 / 有且健康 / 有但有问题。

“未明确”按“含中国大陆”处理，触发风险提示。不要因为用户没说大陆，就默认只面向海外。

### 2.2 维度 A：渲染模式

| 识别结果 | 候选平台 | 必须排除 | 说明 |
|---|---|---|---|
| 纯静态 / SSG / SPA | GitHub Pages、Cloudflare Pages、Vercel Hobby、Netlify Free、Render Free 全部候选 | 无 | 静态站五平台都能托管；差异在带宽、构建、域名和大陆可达性 |
| SSR / 全栈（Next.js、Nuxt、SvelteKit 等） | Vercel、Cloudflare Workers（或 Pages Functions，需适配器）、Render、Railway、Fly.io | GitHub Pages；Netlify 的纯静态托管模式 | GitHub Pages 不能运行服务端代码；Netlify 需要 Functions / Edge 才能承载 SSR，另行评估 |
| 只有 API / 后端服务 | Render Web Service、Railway、Fly.io、Cloudflare Workers | 所有纯静态托管 | 静态平台不能提供长期运行进程 |
| 无法判断 | 不选型 | 无 | 先补识别或问用户，不猜 |

排除原因必须写进报告。例如：“排除 GitHub Pages：项目是 Next.js SSR，需要服务端运行时；GitHub Pages 只托管静态文件。”

注意：Cloudflare Pages 在矩阵里标了 `ssr` / `api`，是因为 Pages Functions 或框架适配器能承载；新 SSR 项目仍按现有 Cloudflare 路径优先 Workers + vinext / OpenNext，Pages 不作为“纯静态上传就能跑 SSR”的方案。

### 2.3 维度 B：后端与数据库

| 后端需求 | 推荐路线 | 前端放哪 | 备注 |
|---|---|---|---|
| 无后端 | 静态托管优先 | 五平台均可 | 不要为了“以后可能用到”提前上后端 |
| 轻后端 / Serverless | Cloudflare Workers / Pages Functions + D1 / KV；Vercel Functions；Netlify Functions | 与函数同平台最省配置 | 先确认运行时兼容性、冷启动和调用额度 |
| PostgreSQL + Auth + Storage | Supabase 作为托管后端 | 任意静态平台 | 前端只迁前端；数据库、Auth、Storage 留在 Supabase |
| 长期运行服务 / Docker | Render Web Service、Railway、Fly.io | 同平台或独立静态站 | Render 免费 Web Service 15 分钟无流量休眠，提前告知冷启动 |
| 中国大陆稳定访问 + 后端 | 国内云 + ICP 备案，或接受海外托管延迟和不稳定 | 国内云 / CDN | 海外平台 + 自定义域名只能缓解，不能保证稳定 |

### 2.4 维度 C：目标用户地域

- **主要海外**：Cloudflare Pages、Vercel、Netlify 都可以；按预算、框架和域名决定。
- **包含中国大陆**：在推荐结果旁强制输出“中国大陆访问风险”硬提示；Vercel 默认域名、GitHub Pages 默认域名、Netlify 默认域名不得写成“稳定可用”。
- **未明确**：按“含中国大陆”处理，输出完整风险提示；用户明确说“只面向海外”后才可省略。

大陆风险提示的最小内容见 2.11，不得折叠、省略或只放在报告末尾。

### 2.5 维度 D：预算与付费意愿

- **免费优先**：首推 Cloudflare Pages。静态带宽无限，免费额度对多数静态站足够。
- **愿意付费**：Cloudflare Workers Paid（$5/月起）或 Vercel Pro（$20/月起）；按项目实际超限项选择，不要默认推荐 Pro。
- **预算未知**：先给免费方案，再给付费升级路径；不要一上来就推荐付费套餐。

### 2.6 评估输出格式

```text
【项目部署适配度】
- 渲染模式：SSG（confirmed）
- 后端需求：无（confirmed）
- 目标用户：含中国大陆（user）
- 预算：免费优先（user）
- 候选平台：Cloudflare Pages / GitHub Pages / Vercel Hobby / Netlify Free / Render Free
- 排除平台：无
- 推荐首选：Cloudflare Pages（免费、静态带宽无限、大陆可达性优于 Vercel 默认域名）
- 备选：GitHub Pages（已有仓库且不需要大陆稳定访问时）
- 不推荐：Vercel 默认域名（大陆访问不稳定，除非绑定自定义域名并接受仍可能被限速）
- 中国大陆访问风险：见下方硬提示
```

每个结论后面尽量带证据等级：`confirmed`、`inferred`、`unknown`、`user`。不要把推断值写成已确认。

### 2.7 平台能力矩阵筛选

评估给出候选池后，用平台能力矩阵做交叉过滤，不要每次把八个平台全部列出来：

1. **先过滤渲染模式**：`render_support` 不包含当前模式的平台直接排除，并写原因。
2. **再过滤后端形态**：纯静态平台不承接长期运行服务；需要 Postgres / Auth / Storage 时，把 Supabase 作为后端候选，而不是要求前端平台自带数据库。
3. **再过滤地域**：含中国大陆时，默认域名风险高的平台降级为备选或不推荐；自定义域名只能缓解，不能保证。
4. **最后按预算排序**：免费优先时 Cloudflare Pages 排前；愿意付费时再比较 Workers Paid、Vercel Pro、Render / Railway 的按量成本。
5. **输出只保留 1 个首选、1–2 个备选、1–2 个不推荐**；其余平台写“本轮未纳入”，不要堆列表。

### 2.8 选型输出：首选 / 备选 / 不推荐

每个平台必须附带五项信息：

| 字段 | 内容 |
|---|---|
| 角色 | 首选 / 备选 / 不推荐 |
| 理由 | 一两个决定性事实，不写空泛评价 |
| 免费额度关键点 | 带宽、构建、项目数、文件数、Functions / 数据库额度 |
| 适合场景 | 一句话 |
| 主要限制 | 一句话；含大陆风险时必须写默认域名风险 |

示例：

```text
首选：Cloudflare Pages
- 理由：纯静态 SSG、免费优先、静态带宽无限；已有 GitHub 仓库可直接接 Git 集成。
- 免费额度：静态带宽无限；500 次构建/月；100 个项目；每站 20,000 文件；每项目 100 个自定义域名。
- 适合：静态站、SPA、SSG 的免费默认。
- 限制：不是中国大陆合规托管；SSR 需要 Functions / 适配器，不能当纯静态上传。

备选：GitHub Pages
- 理由：仓库已经在 GitHub，零额外账号；公开仓库可直接发布。
- 免费额度：公开仓库静态发布；免费 HTTPS；自定义域名。
- 适合：文档、博客、项目主页；不需要大陆稳定访问。
- 限制：只能静态；base path、重定向和响应头能力有限；*.github.io 大陆访问不稳定。

不推荐：Vercel 默认域名
- 理由：目标用户含中国大陆，*.vercel.app 默认域名已被 DNS 污染，直接访问通常超时。
- 替代：Cloudflare Pages，或绑定自定义域名后接受仍可能被限速。
```

### 2.9 Cloudflare 路径的保留方式

平台矩阵只负责“平台层”筛选；只要 Cloudflare 家族入选，就回到现有 `platform-selection.md` 的三问，在 Pages 和 Workers 之间二选一：

1. 域名的 NS 是否在 Cloudflare？
2. 是否要零配置 `git push`？
3. 以后是否要 Cloudflare 侧后端（D1 / DO / Queues / Cron）？

静态站免费层仍默认标 Cloudflare Pages，并在理由里写“静态带宽无限”。不要因为新增了多平台矩阵，就把现有用户从 Pages 推向 Workers 或其他平台。

### 2.10 什么时候应该给出“不迁移”结论

出现以下任一情况，首选结论应是保留现有平台：

- 现有部署健康，没有具体问题，只是“想换新的”。
- 迁移会引入未验证的运行时风险（原生模块、长驻进程、数据库驱动）。
- 目标平台免费额度不够，用户不接受付费。
- 目标平台默认域名在大陆不可用，用户又不愿绑定自定义域名。
- 迁移没有回滚方案，或源平台不能保留至少一周。
- 迁移和 schema 变更、依赖升级混在同一次操作里。

### 2.11 中国大陆访问风险硬提示

只要目标用户地域包含中国大陆，或用户未明确说“只面向海外”，选型输出必须附带以下提示，不得折叠、省略或只放在报告末尾：

- Vercel 的 `*.vercel.app` 默认域名在中国大陆已被 DNS 污染，直接访问通常超时；绑定自定义域名可能改善，但 Vercel 官方明确不保证中国大陆的可用性或性能。
- GitHub Pages 的 `*.github.io` 在中国大陆访问不稳定，部分网络环境不可达。
- Netlify 的 `*.netlify.app` 同样常无法直接访问。
- Cloudflare Pages 的 `*.pages.dev` 通常可达性更好，但也不是中国大陆合规托管。
- 换自定义域名只能缓解，不能保证稳定；稳定大陆访问需要 ICP 备案 + 国内云 / CDN。

报告中单独用一节“中国大陆访问风险与建议”，给出两条路线：

- **路线 A**：接受海外托管 + 自定义域名 + 自托管关键资源，但承认可能被限速或阻断。
- **路线 B**：走 ICP 备案 + 国内云 / CDN，获得稳定大陆访问。

风险提示不能写成“绑定自定义域名就没事”。自定义域名只缓解默认域名被污染的问题，不改变海外托管在中国大陆的不确定性。

---

## 3. 交付物三：平台能力矩阵

### 3.1 核心平台总表

| 平台 | type | render_support | 免费额度关键点（2026 资料） | 自定义域名 | 大陆默认域名风险 | 适合 | 不适合 |
|---|---|---|---|---|---|---|---|
| GitHub Pages | static | static / ssg / spa | 公开仓库静态发布、免费 HTTPS、自定义域名 | 支持；CNAME / A；仓库内 CNAME 文件 | 不稳定，部分网络不可达 | 公开仓库的文档、博客、项目主页 | 敏感交易、商业 SaaS 主站、需要服务端逻辑 |
| Cloudflare Pages | frontend-plus-functions | static / ssg / spa / ssr / api | 无限静态带宽、500 构建/月、100 项目、每站 20,000 文件、100 自定义域名/项目 | 支持；CNAME / nameserver；apex 需 NS 在 Cloudflare | 通常可达性更好，但不是合规托管 | 静态站、SPA、SSG 的免费默认 | 托管 Postgres、常驻 Docker、大陆合规托管 |
| Vercel Hobby | frontend-plus-functions | static / ssg / spa / ssr / api | 100 GB 传输/月、200 项目、6,000 构建分钟/月、100 部署/天；仅个人非商业 | 支持；CNAME / A / nameserver | 默认域名 DNS 污染，通常超时 | Next.js / SSR 低摩擦、海外个人项目 | 商业用途、大陆稳定访问、长期运行服务 |
| Netlify Free | frontend-plus-functions | static / ssg / spa / ssr / api | 300 月度 credits、自定义域名 + SSL、部署预览、Functions | 支持；CNAME / A / nameserver | 默认域名常无法直接访问 | Deploy Previews、Forms / Functions、海外项目 | 大陆稳定访问、长期运行服务或数据库为主 |
| Render Free | fullstack | static / ssg / spa / ssr / api | 免费静态站、Web Service、Postgres、Key Value；Web Service 15 分钟无流量休眠 | 支持；CNAME / A；按控制台提示 | 未实测，按海外托管默认风险处理 | Web Service + Postgres + 静态站一体化起步 | 常驻无冷启动、大陆稳定访问、复杂长连接 |

### 3.2 扩展平台总表

| 平台 | type | render_support | 免费额度关键点 | 自定义域名 | 大陆默认域名风险 | 适合 | 不适合 |
|---|---|---|---|---|---|---|---|
| Railway | fullstack | static / ssg / spa / ssr / api | 按量计费；注册通常有试用额度；长期免费政策以官方为准 | 支持；CNAME；按控制台提示 | 未实测 | Docker、长驻服务、数据库，愿意按量付费 | 完全免费静态站、大陆稳定访问 |
| Fly.io | fullstack | static / ssg / spa / ssr / api | 按量计费；免费额度随政策调整；以官方为准 | 支持；A / AAAA / CNAME；flyctl 管理证书 | 未实测 | 全球边缘部署、Docker、长驻服务 | 零运维静态站、完全免费、大陆合规 |
| Supabase | database-auth | api | 免费 Postgres / Auth / Storage；免费项目长期无活动可能暂停 | API / Auth 自定义域名通常为付费附加；前端域名由前端平台绑定 | 未实测 | Postgres + Auth + Storage 托管后端 | 静态前端托管、大陆合规托管 |

### 3.3 迁移配置对照

| 平台 | base path | 重定向配置 | 响应头配置 | 平台特有配置 | 停用 / 退出 |
|---|---|---|---|---|---|
| GitHub Pages | 项目站默认 `/<repo>/`；绑自定义域后可改为 `/` | 无 `_redirects`；只能用 404.html 或 meta refresh | 不支持自定义响应头 | CNAME 文件、Actions 部署、deploy branch | Source 设为 None，保留仓库和回滚能力 |
| Cloudflare Pages | 按 `/` 生成；从 GitHub Pages 迁入时移除仓库名前缀 | `_redirects` 放产物根目录 | `_headers` 放产物根目录；Functions 在代码里处理 CORS | Git 集成、Direct Upload、Pages Functions、KV / D1 / R2 绑定 | 删除前导出域名和环境变量键名；Direct Upload 不可逆 |
| Vercel | Next.js 用 basePath；从 GitHub Pages 迁入时移除仓库名前缀 | `vercel.json` 的 redirects / rewrites | `vercel.json` 的 headers | Next.js 原生适配、Serverless / Edge Functions、预览部署、自动 promote | 源 / 部署分离时自动 promote 可能异常，必要时重新导入仓库 |
| Netlify | 按 `/` 生成；迁入时移除仓库名前缀 | `netlify.toml` 的 redirects，或产物根目录 `_redirects` | `netlify.toml` 的 headers，或 `_headers` | Deploy Previews、Functions、Forms、Identity、Split Testing | 删除前导出环境变量键名、域名和 Functions 配置 |
| Render | 静态站 publish path 按 `/` 生成 | `render.yaml` 或控制台的 Redirects / Rewrites | `render.yaml` 的 headers（以官方支持为准） | Static Sites、Web Services、Postgres、Key Value、Blueprint | 删除前导出变量键名、磁盘和域名配置；免费 Web Service 会休眠 |
| Railway | 按应用根路径 | 按应用或反向代理配置 | 按应用或反向代理配置 | Docker / Nixpacks、Volumes、数据库模板、按量计费 | 删除前导出变量键名和卷信息 |
| Fly.io | 按应用根路径 | 按应用配置 | 按应用配置 | Docker、Volumes、多区域、flyctl | 删除前导出 secrets 键名和卷信息 |
| Supabase | 不托管前端 | Auth redirect URLs 在控制台配置 | 不适用 | Postgres、Auth、Storage、RLS、Edge Functions | 迁移前导出 schema / RLS / Storage 清单，不要直接删项目 |

### 3.4 对应 JSON 结构

`platform-matrix.json` 是矩阵的唯一数据源。脚本读取它，文档表格由它维护；不要在两个地方各写一套数字。实际文件是 `references/platform-matrix.json`；下面的 JSON 是设计稿示例，字段以文件为准。

```json
{
  "schema_version": 1,
  "checked_at": "2026-11-20",
  "evidence": "需求方提供的 2026 免费额度资料加平台公开文档；引用前复核官方页面",
  "platforms": [
    {
      "id": "github-pages",
      "name": "GitHub Pages",
      "core": true,
      "type": "static",
      "render_support": ["static", "ssg", "spa"],
      "free_tier_key_points": [
        "公开仓库可发布静态站",
        "免费 HTTPS",
        "支持自定义域名"
      ],
      "free_tier_limits": {
        "public_repos": "GitHub Free 下仅公开仓库可发布；私有仓库需付费计划",
        "published_site_size": "1 GB（软限制）",
        "bandwidth": "100 GB/月（软限制）",
        "builds": "10 次/小时（软限制）",
        "custom_domain": "包含"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME", "A"],
        "notes": "子域用 CNAME，apex 用 A；仓库内 CNAME 文件；启用 Enforce HTTPS"
      },
      "mainland_china_risk": {
        "default_subdomain": "unstable",
        "custom_domain_improves": "partial",
        "stable": false,
        "notes": "*.github.io 在中国大陆访问不稳定，部分网络环境不可达"
      },
      "migration_notes": {
        "base_path": "项目站默认 /<repo>/；绑定自定义域后可改为 /；迁移到其他平台时移除仓库名前缀",
        "redirects": "没有 _redirects；只能用 404.html 或 meta refresh，能力有限",
        "headers": "不支持自定义响应头",
        "platform_features": ["GitHub Actions 部署", "CNAME 文件", "deploy branch", "Jekyll 内置构建"],
        "exit": "Settings → Pages → Source 设为 None 停止发布，仓库和回滚能力保留"
      },
      "best_for": "公开仓库的文档、博客、项目主页；已有 GitHub 工作流且不需要大陆稳定访问",
      "not_for": "敏感交易、商业 SaaS 主站、需要服务端逻辑或精细重定向 / 响应头的项目",
      "sources": ["https://docs.github.com/en/pages"]
    },
    {
      "id": "cloudflare-pages",
      "name": "Cloudflare Pages",
      "core": true,
      "type": "frontend-plus-functions",
      "render_support": ["static", "ssg", "spa", "ssr", "api"],
      "free_tier_key_points": [
        "无限静态带宽",
        "500 次构建/月",
        "100 个项目",
        "每站 20,000 文件",
        "每项目 100 个自定义域名"
      ],
      "free_tier_limits": {
        "static_bandwidth": "无限；静态请求不计费",
        "builds_per_month": "500",
        "build_concurrency": "1",
        "build_timeout": "20 分钟",
        "projects": "100",
        "files_per_site": "20000",
        "custom_domains_per_project": "100"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME", "nameserver"],
        "notes": "子域 CNAME 到 <project>.pages.dev；apex 需 NS 在 Cloudflare；先在 Pages 项目 Custom domains 添加，再改 DNS"
      },
      "mainland_china_risk": {
        "default_subdomain": "usually_reachable",
        "custom_domain_improves": "partial",
        "stable": false,
        "notes": "*.pages.dev 通常可达性更好，但不是中国大陆合规托管"
      },
      "migration_notes": {
        "base_path": "产物按 / 生成；从 GitHub Pages 迁入时移除 /<repo>/ 前缀",
        "redirects": "_redirects 放产物根目录；支持常见 301 / 302 / 200 规则",
        "headers": "_headers 放产物根目录；Functions 必须在代码里处理 CORS，包括 OPTIONS",
        "platform_features": ["Git 集成", "Direct Upload", "Pages Functions", "KV / D1 / R2 绑定", "预览分支"],
        "exit": "删除项目前先导出域名和环境变量键名；Direct Upload 不可逆，删除后不能转 Git"
      },
      "best_for": "静态站、SPA、SSG 的免费默认；需要无限静态带宽和较好大陆可达性",
      "not_for": "必须用托管 Postgres 或常驻 Docker 的项目；需要中国大陆合规托管的项目",
      "sources": ["https://developers.cloudflare.com/pages/"]
    },
    {
      "id": "vercel-hobby",
      "name": "Vercel Hobby",
      "core": true,
      "type": "frontend-plus-functions",
      "render_support": ["static", "ssg", "spa", "ssr", "api"],
      "free_tier_key_points": [
        "100 GB 传输/月",
        "200 个项目",
        "6,000 构建分钟/月",
        "100 部署/天",
        "仅个人非商业用途"
      ],
      "free_tier_limits": {
        "transfer": "100 GB/月",
        "projects": "200",
        "build_minutes": "6000/月",
        "deployments": "100/天",
        "commercial_use": "仅个人非商业"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME", "A", "nameserver"],
        "notes": "子域用 CNAME；apex 用 A 或 Vercel 提示的 nameserver；按项目 Domains 提示操作"
      },
      "mainland_china_risk": {
        "default_subdomain": "dns_polluted",
        "custom_domain_improves": "partial",
        "stable": false,
        "notes": "*.vercel.app 默认域名在中国大陆已被 DNS 污染，直接访问通常超时；绑定自定义域名可能改善，但 Vercel 官方不保证中国大陆的可用性或性能"
      },
      "migration_notes": {
        "base_path": "Next.js 用 basePath；从 GitHub Pages 迁入时移除仓库名前缀",
        "redirects": "vercel.json 的 redirects / rewrites；不是 _redirects",
        "headers": "vercel.json 的 headers",
        "platform_features": ["Next.js 原生适配", "Serverless / Edge Functions", "预览部署", "自动 promote"],
        "exit": "单仓库“源-部署分离”时自动 promote 可能异常，必要时重新导入仓库恢复自动更新；删除前导出环境变量键名和域名配置"
      },
      "best_for": "Next.js / SSR 低摩擦、海外个人项目",
      "not_for": "商业用途（Hobby 仅个人非商业）、大陆稳定访问、需要长期运行服务",
      "sources": ["https://vercel.com/docs/limits"]
    },
    {
      "id": "netlify-free",
      "name": "Netlify Free",
      "core": true,
      "type": "frontend-plus-functions",
      "render_support": ["static", "ssg", "spa", "ssr", "api"],
      "free_tier_key_points": [
        "300 月度 credits",
        "自定义域名 + SSL",
        "部署预览",
        "Functions"
      ],
      "free_tier_limits": {
        "credits": "300/月；带宽、构建、Functions 的具体换算以官方定价页为准",
        "custom_domain_ssl": "包含",
        "deploy_previews": "包含",
        "functions": "包含；额度以官方为准"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME", "A", "nameserver"],
        "notes": "子域用 CNAME；apex 用 Netlify DNS / nameserver 或 A 记录；自动 TLS"
      },
      "mainland_china_risk": {
        "default_subdomain": "often_unreachable",
        "custom_domain_improves": "partial",
        "stable": false,
        "notes": "*.netlify.app 在中国大陆常无法直接访问"
      },
      "migration_notes": {
        "base_path": "构建产物按 / 生成；从 GitHub Pages 迁入时移除仓库名前缀",
        "redirects": "仓库根目录 netlify.toml 的 redirects，或产物根目录 _redirects",
        "headers": "netlify.toml 的 headers，或 _headers",
        "platform_features": ["Deploy Previews", "Netlify Functions", "Netlify Forms", "Identity", "Split Testing"],
        "exit": "删除站点前导出环境变量键名、域名和 Functions 配置"
      },
      "best_for": "需要 Deploy Previews、Forms / Functions、简单 Git 工作流的海外项目",
      "not_for": "大陆稳定访问、需要长期运行服务或数据库为主的项目",
      "sources": ["https://docs.netlify.com/"]
    },
    {
      "id": "render-free",
      "name": "Render Free",
      "core": true,
      "type": "fullstack",
      "render_support": ["static", "ssg", "spa", "ssr", "api"],
      "free_tier_key_points": [
        "免费静态站",
        "免费 Web Service",
        "免费 Postgres",
        "免费 Key Value",
        "Web Service 15 分钟无流量休眠"
      ],
      "free_tier_limits": {
        "static_sites": "免费",
        "web_services": "免费；15 分钟无流量休眠，冷启动需要提前告知",
        "postgres": "免费额度；时长和容量限制以官方为准",
        "key_value": "免费额度；限制以官方为准"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME", "A"],
        "notes": "子域用 CNAME；apex 用 A；按控制台提示操作"
      },
      "mainland_china_risk": {
        "default_subdomain": "unknown",
        "custom_domain_improves": "unknown",
        "stable": false,
        "notes": "未实测；按海外托管默认风险处理，不承诺大陆稳定访问"
      },
      "migration_notes": {
        "base_path": "静态站 publish path 按 / 生成",
        "redirects": "render.yaml 或控制台的 Redirects / Rewrites；不是 _redirects",
        "headers": "render.yaml 的 headers（以官方支持为准）",
        "platform_features": ["Static Sites", "Web Services", "Postgres", "Key Value", "Blueprint"],
        "exit": "删除服务前导出环境变量键名、磁盘和域名配置；免费 Web Service 会休眠"
      },
      "best_for": "需要 Web Service + Postgres + 静态站的一体化免费起步；可接受冷启动",
      "not_for": "要求常驻无冷启动、需要稳定大陆访问、需要复杂定时任务或长连接的项目",
      "sources": ["https://render.com/docs/free"]
    },
    {
      "id": "railway",
      "name": "Railway",
      "core": false,
      "type": "fullstack",
      "render_support": ["static", "ssg", "spa", "ssr", "api"],
      "free_tier_key_points": [
        "按量计费",
        "注册通常有试用额度",
        "长期免费政策以官方为准"
      ],
      "free_tier_limits": {
        "free_tier": "不承诺长期免费",
        "billing": "按用量计费"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME"],
        "notes": "按控制台提示绑定自定义域名"
      },
      "mainland_china_risk": {
        "default_subdomain": "unknown",
        "custom_domain_improves": "unknown",
        "stable": false,
        "notes": "未实测；按海外托管默认风险处理"
      },
      "migration_notes": {
        "base_path": "按应用根路径",
        "redirects": "按应用或反向代理配置；没有统一 _redirects",
        "headers": "按应用或反向代理配置",
        "platform_features": ["Docker / Nixpacks", "Volumes", "数据库模板", "按量计费"],
        "exit": "删除项目或服务前导出变量键名和卷信息"
      },
      "best_for": "Docker、长驻服务、数据库，愿意按量付费",
      "not_for": "完全免费静态站、大陆稳定访问",
      "sources": ["https://docs.railway.com/"]
    },
    {
      "id": "fly-io",
      "name": "Fly.io",
      "core": false,
      "type": "fullstack",
      "render_support": ["static", "ssg", "spa", "ssr", "api"],
      "free_tier_key_points": [
        "按量计费",
        "免费额度随政策调整",
        "以官方定价页为准"
      ],
      "free_tier_limits": {
        "free_tier": "不承诺长期免费",
        "billing": "按用量计费"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["A", "AAAA", "CNAME"],
        "notes": "用 flyctl certs 管理证书；按控制台提示配置 DNS"
      },
      "mainland_china_risk": {
        "default_subdomain": "unknown",
        "custom_domain_improves": "unknown",
        "stable": false,
        "notes": "未实测；按海外托管默认风险处理"
      },
      "migration_notes": {
        "base_path": "按应用根路径",
        "redirects": "按应用配置；没有统一 _redirects",
        "headers": "按应用配置",
        "platform_features": ["Docker", "Volumes", "多区域", "flyctl"],
        "exit": "删除应用前导出 secrets 键名和卷信息"
      },
      "best_for": "全球边缘部署、Docker、长驻服务",
      "not_for": "零运维静态站、完全免费、大陆合规",
      "sources": ["https://fly.io/docs/"]
    },
    {
      "id": "supabase",
      "name": "Supabase",
      "core": false,
      "type": "database-auth",
      "render_support": ["api"],
      "free_tier_key_points": [
        "免费 Postgres / Auth / Storage",
        "免费项目长期无活动可能暂停",
        "付费计划解除限制"
      ],
      "free_tier_limits": {
        "database": "免费额度以官方为准",
        "auth": "包含",
        "storage": "包含",
        "inactive_pause": "长期无活动可能暂停"
      },
      "custom_domain": {
        "supported": true,
        "methods": ["CNAME"],
        "notes": "API / Auth 自定义域名通常为付费附加；前端域名由前端托管平台绑定"
      },
      "mainland_china_risk": {
        "default_subdomain": "unknown",
        "custom_domain_improves": "unknown",
        "stable": false,
        "notes": "API 域名可达性未实测；前端仍取决于前端托管平台"
      },
      "migration_notes": {
        "base_path": "不托管前端；前端 base path 由托管平台决定",
        "redirects": "Auth redirect URLs 在 Supabase 控制台配置",
        "headers": "不适用",
        "platform_features": ["Postgres", "Auth", "Storage", "RLS", "Edge Functions"],
        "exit": "迁移前导出 schema / RLS / Storage 清单；不要直接删项目"
      },
      "best_for": "需要托管 Postgres + Auth + Storage，前端部署到任意静态平台",
      "not_for": "静态前端托管（不是它的职责）、中国大陆合规托管",
      "sources": ["https://supabase.com/docs"]
    }
  ]
}
```

### 3.5 字段说明

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | ASCII 平台标识，脚本用它做参数和匹配 |
| `name` | string | 是 | 展示名称 |
| `core` | boolean | 是 | 是否五个核心平台之一 |
| `type` | enum | 是 | `static` / `frontend-plus-functions` / `fullstack` / `database-auth` |
| `render_support` | array | 是 | `static` / `ssg` / `spa` / `ssr` / `api` 的子集 |
| `free_tier_key_points` | array | 是 | 免费额度关键点，面向用户展示 |
| `free_tier_limits` | object | 否 | 机器可读的额度字段；数值用字符串保留单位 |
| `custom_domain` | object | 是 | `supported`、`methods`、`notes` |
| `mainland_china_risk` | object | 是 | `default_subdomain`、`custom_domain_improves`、`stable`、`notes` |
| `migration_notes` | object | 是 | `base_path`、`redirects`、`headers`、`platform_features`、`exit` |
| `best_for` | string | 是 | 适用场景一句话 |
| `not_for` | string | 是 | 不适用场景一句话 |
| `sources` | array | 否 | 官方文档或定价页链接 |

`mainland_china_risk.default_subdomain` 建议取值：`dns_polluted`、`often_unreachable`、`unstable`、`usually_reachable`、`unknown`、`not_applicable`。`custom_domain_improves` 建议取值：`partial`、`no`、`unknown`、`not_applicable`。

`render_support` 只表示平台能承载该模式，不表示零配置：Cloudflare Pages、Netlify 的 SSR / API 依赖 Functions / Edge 或框架适配器；Vercel 的 SSR 也依赖框架构建；迁移前必须按目标平台文档验证，不能把“支持”写成“已验证”。

### 3.6 数据维护规则

- `checked_at` 每次复核后更新；超过 6 个月未复核，报告里要写“矩阵数据待复核”。
- 免费额度、价格、默认域名风险以官方页面为准；矩阵只做决策辅助，不做法律或合规承诺。
- 新增平台必须先补 JSON，再改 Markdown 表格；不要只改文档表格。
- `render_support` 不包含的模式不能被脚本选中；如果平台通过 Functions / Edge 支持 SSR，要在 `migration_notes` 或 `best_for` 里写清楚前提。

---

## 4. 交付物四：跨平台迁移模块

### 4.1 入口参数

| 参数 | 取值 | 必填 | 说明 |
|---|---|---|---|
| `source` | `github-pages` / `cloudflare-pages` / `vercel` / `netlify` / `render` | 是 | 当前部署平台 |
| `target` | 同上 | 是 | 目标平台；不能等于 `source` |
| `project_type` | `static` / `ssg` / `spa` / `ssr` / `fullstack` | 是 | 决定渲染兼容性、构建检查和验收模式 |

如果用户没有说清 `project_type`，从识别结果取；识别结果 `unknown` 时先问，不猜。`source` 和 `target` 相同直接拒绝，输出“无需迁移”。

### 4.2 迁移前检查清单

逐项输出状态：`pending` / `confirmed` / `not_applicable` / `blocked`。

| 检查项 | 要记录什么 | 证据要求 |
|---|---|---|
| 构建命令与输出目录 | 源平台实际使用的 build command、publish / output dir | 来自配置或控制台；不确定写 `unknown` |
| 环境变量键名 | 只记录键名和存放位置，不读取值 | 源平台环境变量页、`.env.example`；绝不粘贴值 |
| 自定义域名与 DNS | 当前域名、DNS 提供商、CNAME / A / nameserver、TTL | 只读查询或用户提供；不执行变更 |
| 重定向 / headers / 平台配置 | `_redirects`、`_headers`、`netlify.toml`、`vercel.json`、`render.yaml` 等 | 仓库内文件和源平台设置 |
| 平台特有能力依赖 | GitHub Pages base path、Netlify Forms / Functions、Vercel `vercel.json`、Cloudflare `_headers` 等 | 逐项列出替代方案 |
| 回滚保留时长 | 源平台至少保留一周；关键业务建议 2–4 周 | 写进迁移计划的回滚段 |

补充检查：

- 构建产物是否引用绝对路径、仓库名前缀或平台专属域名。
- 是否有 PWA / Service Worker 缓存旧域名。
- 是否有 API / SSR 运行时依赖、数据库连接、Auth 回调地址。
- 是否有 sitemap、canonical、`og:url` 写死源域名。
- 是否有第三方回调白名单需要新增目标域名。

### 4.3 双活迁移流程

**Step 1：目标平台预览**

在目标平台导入同一仓库，或用官方 CLI 部署；先使用目标平台免费子域名验收，不碰正式域名。

```text
GitHub Pages：推到部署分支或走 Actions
Cloudflare Pages：Git 集成，或 wrangler pages deploy <输出目录> --project-name <项目名>
Vercel：Git 集成，或 vercel CLI
Netlify：Git 集成，或 netlify deploy
Render：Git 集成 / Blueprint
```

**Step 2：源平台保持在线**

源平台不动，作为回滚目标。不要在第 1 步通过后立刻删除源站、旧分支或旧 DNS。

**Step 3：验收清单**

| 检查 | 方法 | 通过标准 |
|---|---|---|
| 首页 | `verify-deployment.mjs --url <目标预览> --mode <模式>` | 200 + 正确标题 |
| 关键内页 | 手工或脚本抽查 | 200，内容不是首页回退 |
| 静态资源 | `--dist <产物>` 做同一性检查 | 首页引用资源 SHA-256 一致 |
| 404 | 未知路径 | static / ssg 为 404；spa 为 app shell |
| 重定向 | 旧路径、尾斜杠、`/index.html` | 同源重定向到正确目标 |
| HTTPS | 证书链、域名 | 有效证书，无混合内容 |
| API / SSR | `--api`、关键接口 | 状态和 JSON 结构符合预期；数据库 / 登录 / 回调另做专项验证 |
| 环境变量 | 目标平台变量键名 | 键名齐全；值不记录 |

构建检查和验收必须用同一个 `--mode`。目标预览未通过，不进入 DNS 切换。

**Step 4：自定义域名切换**

1. 提前 24–48 小时降低 DNS TTL。
2. 按目标平台提示添加 CNAME / A / nameserver。
3. 先绑定域名、再改 DNS；顺序反了容易出现 522 或证书 pending。
4. DNS 变更前必须得到用户明确确认；脚本只输出待执行步骤，不自动改 DNS。
5. 保留旧记录直到观察期结束，便于回滚。

**Step 5：观察与停用源平台**

- 源平台至少保留一周；关键业务建议 2–4 周。
- 观察流量、错误日志、Search Console、核心接口和第三方回调。
- 确认无异常后再停用源平台；停用方式按平台执行（GitHub Pages 把 Source 设为 None，其他平台先导出配置再删除）。
- 停用前再确认一次回滚路径仍然可用。

### 4.4 平台特定迁移提示

| 迁移路径 | 操作提示 |
|---|---|
| GitHub Pages → Cloudflare Pages | Cloudflare Dashboard → Workers & Pages → Create application → Pages → Import an existing Git repository；填写构建命令和输出目录；自定义域名在 Pages 项目 Custom domains 中绑定后再改 DNS |
| GitHub Pages → Vercel | 导入同一仓库；修正 GitHub Pages 需要的 base path；自定义域名按 Vercel 提示的 DNS 记录迁移；重定向放在 `vercel.json` |
| 任意平台 → Netlify | 在仓库根目录创建 `netlify.toml` 管理构建配置，不要只依赖面板设置；重定向和 headers 也写进配置 |
| 任意平台 → Render | 静态站免费；Web Service 15 分钟无流量休眠；如需常驻后端，提前告知冷启动和免费额度限制 |
| 迁移出 Vercel | 注意单仓库“源-部署分离”时自动 promote 可能异常；必要时重新导入仓库恢复自动更新 |
| 迁移出 GitHub Pages | 将 deploy branch 切换为 None 即可停止发布，但保留仓库和回滚能力 |

控制台菜单会改名。路径以 2026-11 的官方文档为准；找不到时用控制台搜索（`Ctrl/Cmd + K`）搜产品名。

### 4.5 安全门

- **DNS 变更**：必须用户明确确认；先降 TTL，再改记录；保留旧记录。
- **自定义域名绑定**：必须用户明确确认；先绑定目标平台，再改 DNS。
- **数据库迁移**：必须备份、staging 导入、数量 / 校验和核对、冻结写入、用户确认；不与平台迁移放在同一个提交里。
- **删除操作**：源平台至少保留一周；删除前确认回滚路径、备份和域名归属。
- **密钥**：只记录键名；不读取、不写入、不回显值；迁移报告里也不出现值。
- **目标预览失败**：停止迁移，保留源平台，不切 DNS；报告写“失败 / 未切换”。

### 4.6 迁移报告模板

```markdown
# 迁移报告：{{source}} → {{target}}

## 概要

| 项目 | 值 |
|---|---|
| 仓库 | {{repo_url}} |
| 项目类型 | {{static / ssg / spa / ssr / fullstack}} |
| 源平台 / 目标平台 | {{source}} / {{target}} |
| 源地址 / 目标预览地址 | {{source_url}} / {{target_preview_url}} |
| 迁移方式 | {{Git 集成 / CLI / 控制台导入}} |
| 迁移日期 | {{YYYY-MM-DD}} |
| 当前状态 | {{双活观察 / 已切换 / 已回滚}} |

## 迁移前检查

| 检查项 | 状态 | 证据 / 备注 |
|---|---|---|
| 构建命令与输出目录 | {{confirmed / inferred / unknown}} | {{...}} |
| 环境变量键名 | {{confirmed}} | {{只写键名，不写值}} |
| 自定义域名与 DNS | {{confirmed / pending}} | {{域名、DNS 提供商、CNAME / A / nameserver、TTL}} |
| 重定向 / headers / 平台配置 | {{confirmed}} | {{文件或控制台位置}} |
| 平台特有能力依赖 | {{confirmed / blocked}} | {{替代方案}} |
| 回滚保留时长 | {{confirmed}} | {{源平台至少保留一周}} |

## 双活与验收

| 检查 | 结果 | 证据 |
|---|---|---|
| 首页 | {{通过 / 失败 / 未验证}} | {{GET / -> 状态码、标题}} |
| 关键内页 | {{通过 / 失败 / 未验证}} | {{...}} |
| 静态资源 | {{通过 / 失败 / 未验证}} | {{检查数量、哈希同一性}} |
| 404 / SPA 回退 | {{通过 / 失败 / 未验证}} | {{模式与状态码}} |
| 重定向 | {{通过 / 失败 / 未验证}} | {{路径与目标}} |
| HTTPS | {{通过 / 失败 / 未验证}} | {{证书签发者、到期时间}} |
| API / SSR | {{通过 / 失败 / 未验证}} | {{接口、JSON、数据库 / 登录另测}} |
| 环境变量键名齐全 | {{通过 / 失败 / 未验证}} | {{只列键名}} |

## DNS 变更记录

| 时间 | 记录 | 原值 | 新值 | TTL | 操作人 | 用户确认 |
|---|---|---|---|---|---|---|
| {{...}} | {{CNAME / A / nameserver}} | {{...}} | {{...}} | {{...}} | {{...}} | {{是 / 否}} |

## 回滚路径

- 源平台状态：{{在线 / 已降级 / 已停用}}
- 回滚触发条件：{{目标站 5xx、关键页面不可用、证书失败、核心接口异常}}
- 回滚步骤：{{恢复 DNS 记录 / 重新绑定源平台域名 / 重新启用 deploy branch}}
- 回滚耗时：{{...}}
- 数据影响：{{无 / 需要恢复备份 / 需要冻结写入}}

## 建议观察期

- 急性故障观察：{{24–72 小时}}
- 搜索 / 缓存 / 长尾观察：{{1–4 周}}
- 停用源平台时间：{{不早于观察期结束，且用户确认}}

## 未验证

| 项目 | 原因 |
|---|---|
| {{Search Console}} | {{没有站点权限}} |
| {{生产数据库写入}} | {{等待批准}} |
| {{第三方回调}} | {{需要真实密钥和授权}} |

## 备注

{{下一个人需要知道的：平台项目名、域名、环境变量键名、坑。绝不写密钥值。}}
```

### 4.7 降级路径

- 迁移脚本不可用：用本节的检查清单和报告模板人工执行。
- 目标平台不在矩阵：输出通用迁移步骤（导入仓库、填构建、预览验收、域名切换、观察），并明确“该平台未纳入自动化检查”。
- 平台 CLI 不可用：优先用官方 Git 集成；仍不可用时保留源平台，不强行迁移。
- DNS 提供商不支持 API 或脚本：只输出手动 DNS 记录和验证命令，不尝试自动修改。
- 目标平台预览失败：停止迁移，保留源平台，输出失败证据和回滚路径。

---

## 4A. 进阶需求引导清单

这部分对应技能正文的 2D，按需输出，不要每次都全量展开。

### 4A.1 自定义域名购买引导

用户选择“使用自定义域名”时，先问：

1. **主要面向海外还是中国大陆？**
   - 海外：推荐 Cloudflare Registrar（按成本价、DNS 集成）、Porkbun、Namecheap；NameSilo 价格透明、支持支付宝。
   - 中国大陆：推荐腾讯云 / 阿里云购买；提醒解析到海外托管仍可能被限速，稳定大陆访问需要 ICP 备案。
2. **只买域名，还是需要邮箱 / 建站套餐？** 只买域名本身，不要捆绑建站、邮箱、SSL；SSL 由托管平台免费提供。
3. **续费价和隐私保护？** 注意首年低价、续费价；确认隐私保护是否免费。

然后按目标平台给出 DNS 配置：

| 目标平台 | 子域绑定 | apex 绑定 | 顺序与注意 |
|---|---|---|---|
| GitHub Pages | CNAME 到 `<owner>.github.io` | A 记录；仓库内 CNAME 文件 | 先加域名，再改 DNS；启用 Enforce HTTPS |
| Cloudflare Pages | CNAME 到 `<project>.pages.dev` | apex 需 NS 在 Cloudflare | 先在 Pages 项目 Custom domains 添加，再改 DNS |
| Vercel | CNAME 到 Vercel 提示的目标 | A 记录或 nameserver | 按项目 Domains 提示操作；不要先删旧记录 |
| Netlify | CNAME 到 `<site>.netlify.app` | Netlify DNS / nameserver 或 A 记录 | 自动 TLS；先绑定再切换 |
| Render | CNAME 到 Render 提示的目标 | A 记录 | 按控制台提示；免费 Web Service 会休眠 |

规则：

- 切换前 24–48 小时降低 TTL。
- 先绑定目标平台，再改 DNS；顺序反了容易 522 或证书 pending。
- 保留旧 DNS 记录到观察期结束。
- 自定义域名只缓解大陆默认域名风险，不保证稳定；不要写成“换了域名就没事”。

### 4A.2 高级功能付费引导

按顺序引导，不要一上来推荐 Pro：

1. **先确认超限项**：构建次数、带宽、Functions 调用、文件数、团队席位、数据库容量。
2. **轻度超限先优化**：构建缓存、产物压缩、图片体积、依赖裁剪、静态资源缓存；能优化就不升级。
3. **确实需要付费时再给选项**：
   - Cloudflare Workers Paid：$5/月起，1000 万请求/月，适合 Pages Functions、KV、Durable Objects。
   - Vercel Pro：$20/月起，适合商业用途或超出 Hobby 限制。
   - Netlify / Render：按 credits 或资源计费，适合 Functions、数据库、长期运行服务。
4. **价格会变**：引用前复核官方定价页；不要默认推荐 Pro，先给免费替代方案。

### 4A.3 带后端 / 数据库的项目引导

| 层级 | 方案 | 适用 | 注意 |
|---|---|---|---|
| 轻后端 / Serverless | Cloudflare Workers / Pages Functions + D1 / KV；Vercel Functions；Netlify Functions | 轻量 API、表单、Webhook | 确认运行时兼容、冷启动、调用额度 |
| 标准 PostgreSQL + Auth + Storage | Supabase 托管后端 | 需要关系型数据库、登录、文件存储 | 前端可部署到任意静态平台；只迁前端 |
| 长期运行 / Docker / 全栈 | Render Web Service、Railway、Fly.io | 常驻进程、WebSocket、后台任务 | Render 免费 Web Service 15 分钟无流量休眠 |
| 中国大陆稳定访问 + 后端 | 国内云 + ICP 备案，或接受海外托管延迟 | 大陆用户为主 | 海外平台 + 自定义域名不能保证稳定 |

安全要求：

- 数据库连接字符串、Auth 密钥、Storage 密钥必须通过平台环境变量管理，不能写入仓库。
- 计划和报告只写键名和存放位置，不写值。
- 数据库迁移必须备份、staging 导入、数量 / 校验和核对、冻结写入、用户确认；不与平台迁移混在一起。
- 不要把“前端上线”写成“整个项目上线”；后端、数据库、登录、回调没测就写“未验证”。

---

## 5. 交付物五：需要新增或修改的脚本清单

只列文件名和职责，不写完整代码。

### 5.1 新增脚本

| 文件 | 类型 | 职责 | 迭代 |
|---|---|---|---|
| `platform-matrix.mjs` | 纯逻辑模块 | 读取并校验平台矩阵 JSON；导出按渲染模式、后端、地域、预算过滤和排序的函数；无网络、无写盘 | 2 |
| `select-platform.mjs` | CLI | 组合识别 JSON 与用户回答；输出四维适配度评估、候选平台、首选 / 备选 / 不推荐；支持 `--json` 与 `--human`；退出码 0 成功、1 需补充输入、2 用法错误 | 1（评估）/ 2（完整选型） |
| `migration-plan.mjs` | CLI | 校验 `source`、`target`、`project_type`；生成迁移前检查、双活步骤、回滚段和报告骨架；只读，不执行 DNS / 部署 / 数据库操作 | 3 |

### 5.2 新增数据与模板

| 文件 | 类型 | 职责 | 迭代 |
|---|---|---|---|
| `platform-matrix.json` | 数据 | 平台能力矩阵唯一数据源；含 `schema_version`、`checked_at`、八个平台对象 | 2 |
| `platform-cases.json` | 测试夹具 | 评估、选型、迁移的固定输入输出用例 | 1–3 |
| `mainland-china-access.md` | reference | 中国大陆访问风险、默认域名表现、两条路线、验证方法 | 1 |
| `custom-domain-guide.md` | reference | 域名购买、DNS 绑定、CNAME / A / nameserver、TTL 与证书 | 3 |
| `advanced-needs.md` | reference | 免费额度超限、付费升级、后端 / 数据库分层建议 | 3 |
| `cross-platform-migration.md` | reference | 五平台迁移手册、平台特性替换、双活与回滚 | 3 |
| `migration-plan.md` | template | 迁移计划模板 | 3 |
| `migration-report.md` | template | 迁移报告模板 | 3 |

### 5.3 修改现有文件

| 文件 | 改什么 | 迭代 |
|---|---|---|
| `SKILL.md` | 新增 2A–2D、6A；扩展意图路由、硬规则、参考资料、输出要求；保持 0–7 编号 | 1–3 |
| `deployment-plan.md` | 增加适配度评估、目标平台、大陆风险、迁移路径、回滚保留时长 | 1–2 |
| `deployment-report.md` | 增加识别摘要、评估、选型、大陆风险、迁移路径、进阶引导、下一步建议 | 1–3 |
| `platform-selection.md` | 增加“矩阵层 → Cloudflare 家族层”的说明；保留 Pages / Workers 三问和额度表 | 2 |
| `README.md` | 更新能力边界、目录、使用示例、测试数量 | 1–3 |
| `README.en.md` | 与中文 README 同步 | 1–3 |
| `check-skill.mjs` | 增加矩阵 JSON 字段校验、平台 ID 唯一性、引用路径检查 | 2 |
| `run-tests.mjs` | 增加评估、选型、矩阵、迁移用例 | 1–3 |

### 5.4 可选修改

| 文件 | 改什么 | 说明 |
|---|---|---|
| `probe.mjs` | 增加 `--target` 或 `--scope`，默认行为不变；非 Cloudflare 目标跳过 Cloudflare 专属检查 | 迭代 2 可选；不改也能用 `--json` 的 checks 人工解释 |
| `detect-project.mjs` | 如需要，增加后端信号字段（如 Supabase、Prisma、Drizzle、Dockerfile） | 必须向后兼容；不确定就不改 |

### 5.5 不改动清单

以下文件在本次升级中保持行为不变：

- `probe.mjs`（除非迭代 2 采用可选的 `--target`）
- `detect-project.mjs`（除非增加向后兼容的字段）
- `check-build.mjs`
- `verify-deployment.mjs`
- `deploy-verdict.mjs`
- `redirect-policy.mjs`
- `net-retry.mjs`
- `html-scan.mjs`
- `config-scan.mjs`
- `wrangler-auth.mjs`
- `wrangler.workers.jsonc`
- `wrangler.pages.toml`

非 Cloudflare 平台复用 `check-build.mjs` 检查静态产物、复用 `verify-deployment.mjs` 做 HTTP 验收；但不要把 Cloudflare 的套餐上限、`_headers`、`_redirects` 规则套到其他平台，报告里要写“平台额度未验证”。

### 5.6 退出码与 JSON 约定

| 退出码 | 含义 |
|---|---|
| 0 | 成功，输出完整结论 |
| 1 | 信息不足或降级，需要用户补充输入；仍输出已得到的结果和缺口 |
| 2 | 用法错误（参数非法、平台 ID 不存在、`source` 等于 `target`） |

`--json` 输出稳定字段，建议包含：

```json
{
  "fit": {
    "render_mode": "ssg",
    "backend": "none",
    "audience": "mainland",
    "budget": "free",
    "evidence": { "render_mode": "confirmed", "backend": "confirmed", "audience": "user", "budget": "user" }
  },
  "candidates": ["cloudflare-pages", "github-pages", "vercel-hobby", "netlify-free", "render-free"],
  "excluded": [],
  "selection": {
    "primary": "cloudflare-pages",
    "backup": ["github-pages"],
    "not_recommended": ["vercel-hobby"],
    "reasons": { "cloudflare-pages": "免费、静态带宽无限、大陆可达性优于 Vercel 默认域名" }
  },
  "risk": { "mainland_china": true, "level": "high" },
  "warnings": [],
  "degraded": false
}
```

`--human` 输出面向用户的中文摘要；两种输出必须来自同一份数据，不能各算一套。

### 5.7 降级路径

| 场景 | 降级行为 |
|---|---|
| 矩阵 JSON 缺失或损坏 | `select-platform.mjs` 退出码 1，输出四维适配度评估和人工矩阵检查清单；不阻断 probe 和识别 |
| `select-platform.mjs` 不可用 | 按 SKILL.md 的四个维度和矩阵表格人工评估；报告里写“未使用脚本，人工判断” |
| 平台不在矩阵 | 输出通用评估问题（渲染、后端、地域、预算）和人工操作清单；明确“未纳入自动化检查” |
| 识别字段 `unknown` | 先问用户，不猜；报告中保留 `unknown`，不写成 `confirmed` |
| 非 Cloudflare 平台没有 CLI / 自动化 | 用官方 Git 集成或控制台人工执行；复用 `verify-deployment.mjs` 做 HTTP 验收 |
| 迁移脚本不可用 | 用迁移模板人工执行；保留源平台，不切 DNS |
| `probe.mjs` 因 Cloudflare 账号失败 | 读取 `checks` 区分失败项；非 Cloudflare 目标只把网络 / Git 失败当作阻断，Cloudflare 专属失败写“当前目标不适用” |

---

## 6. 交付物六：三个迭代的实施顺序与验收标准

### 6.1 迭代 1：适配度评估 + 网络风险硬提示

**目标**：先让用户看到“这个项目适合哪类平台”和“大陆访问有什么风险”，不改部署脚本，风险最低。

**范围**：

- 新增 `select-platform.mjs` 的评估模式：四维适配度评估、候选池、排除原因；暂不依赖完整矩阵。
- 新增 `mainland-china-access.md`。
- 修改 `SKILL.md` 的 2A、2D 和输出要求。
- 修改 `deployment-report.md`、`deployment-plan.md`，加入评估与风险段。
- 新增评估测试用例。

**不做**：不接平台能力矩阵、不做多平台排序、不做迁移、不改 `probe.mjs`、`detect-project.mjs`、`check-build.mjs`、`verify-deployment.mjs`。

**验收标准**：

1. 纯静态 / SSG / SPA 项目输出五个核心平台候选，且不误排除 GitHub Pages。
2. SSR / 全栈项目排除 GitHub Pages，并写明“不能运行服务端代码”；Netlify 静态托管被排除或标注“需 Functions / Edge 另行评估”。
3. 后端为“需要 PostgreSQL / Auth / Storage”时，输出 Supabase 作为后端推荐，前端仍给静态平台候选。
4. 后端为“长期运行 / Docker”时，输出 Render / Railway / Fly.io，且静态平台不被列为首选。
5. 目标用户为“含中国大陆”或“未明确”时，输出完整大陆风险提示；用户明确“只面向海外”时可省略。
6. 免费优先时 Cloudflare Pages 排首选；愿意付费时列出 Cloudflare Workers Paid 或 Vercel Pro，不默认推荐 Pro。
7. 现有测试全部通过；新增评估用例覆盖四维组合、unknown 输入和排除原因。
8. `SKILL.md` 结构检查通过；现有脚本无行为变更。

**验证方式**：

```text
node run-tests.mjs
node check-skill.mjs
```

再用至少四个固定用例手工核对：静态 + 免费 + 含大陆；SSG + 海外；Next.js SSR + 免费；Docker + 付费。

**回滚**：删除新增评估脚本和 reference，恢复 SKILL.md / 模板；现有流水线未改动，回滚不影响部署。

### 6.2 迭代 2：平台能力矩阵 + 多平台选型

**目标**：把“五平台 + 三扩展”的能力矩阵变成可读、可查、可筛选的数据，选型从“二选一”升级为“首选 / 备选 / 不推荐”。

**范围**：

- 新增 `platform-matrix.json`、`platform-matrix.mjs`。
- 扩展 `select-platform.mjs`：矩阵过滤、排序、首选 / 备选 / 不推荐。
- 修改 `platform-selection.md`，说明矩阵层与 Cloudflare 家族层的关系。
- 修改计划 / 报告模板，加入平台矩阵依据和免费额度关键点。
- 更新 README 中英文版。
- 可选：给 `probe.mjs` 增加非 Cloudflare 目标的作用域参数，默认行为不变。

**不做**：不做迁移引擎、不做域名购买引导、不做付费引导的完整清单（只保留关键额度）。

**验收标准**：

1. 矩阵 JSON 通过结构校验：八个平台、必填字段齐全、平台 ID 唯一、`render_support` 取值合法、`checked_at` 存在。
2. 脚本能按渲染模式过滤：GitHub Pages 不会出现在 SSR / 全栈候选中；Supabase 不会被当成前端托管平台。
3. 静态 + 免费 + 含大陆：首选 Cloudflare Pages，备选 GitHub Pages，Vercel 默认域名列入不推荐并写 DNS 污染原因。
4. 静态 + 海外 + 免费：Cloudflare Pages、Vercel、Netlify 均可作为候选；排序能解释带宽 / 构建 / 预览差异。
5. SSR + Next.js：首选 Vercel 或 Cloudflare Workers（按适配器可行性），GitHub Pages 被排除；Render 作为备选。
6. PostgreSQL / Auth / Storage：Supabase 作为后端推荐；前端仍可选静态平台；Render 作为一体化备选。
7. Docker / 长期运行：Render / Railway / Fly.io 进入候选；静态平台不被列为首选。
8. 商业用途 + Vercel Hobby：标注“仅个人非商业”，不推荐 Hobby。
9. 现有 Cloudflare Pages / Workers 选型路径不变；静态免费层仍默认 Cloudflare Pages。
10. 现有测试全部通过；新增矩阵过滤、排序、排除原因用例；README 与矩阵表格一致。

**验证方式**：

```text
node run-tests.mjs
node check-skill.mjs
```

再人工核对矩阵表格与 JSON 的关键字段是否一致，特别是免费额度、默认域名风险和自定义域名方式。

**回滚**：保留矩阵作为纯文档，`select-platform.mjs` 退回迭代 1 的评估模式；不删除现有 Cloudflare 选型逻辑。

### 6.3 迭代 3：迁移引擎 + 进阶引导清单

**目标**：支持 GitHub Pages、Cloudflare Pages、Vercel、Netlify、Render 任意两两迁移；先做 GitHub Pages ↔ Cloudflare Pages ↔ Vercel 三条最高频路径，验证通过后再扩展 Netlify 和 Render。

**范围**：

- 新增 `migration-plan.mjs`、迁移计划 / 报告模板、跨平台迁移 reference。
- 新增 `custom-domain-guide.md`、`advanced-needs.md`。
- 修改 `SKILL.md` 的 2D、6A、失败处理和参考资料。
- 修改部署报告，加入迁移路径和进阶引导。
- 新增迁移测试用例。

**不做**：不自动执行 DNS 变更、不自动绑定自定义域名、不自动迁数据库、不自动删除源平台。

**验收标准**：

1. GitHub Pages → Cloudflare Pages、Cloudflare Pages → GitHub Pages、GitHub Pages → Vercel、Vercel → GitHub Pages、Cloudflare Pages → Vercel、Vercel → Cloudflare Pages 六条有向路径都能生成完整检查清单和报告骨架。
2. 迁移前检查包含：构建命令 / 输出目录、环境变量键名、自定义域名与 DNS、重定向 / headers / 平台配置、平台特性依赖、回滚保留时长。
3. 每条路径都输出双活五步和回滚段；DNS 切换标注“待用户确认”，不自动执行。
4. 目标预览未通过 `verify-deployment.mjs` 时，报告写“失败 / 未切换”，不写“已迁移”。
5. `source` 等于 `target` 时退出码 2；不支持的平台输出人工清单，不静默失败。
6. 环境变量只出现键名；任何输出、报告、日志都不包含值。
7. 平台特定提示覆盖：GitHub Pages → Cloudflare Pages、GitHub Pages → Vercel、任意平台 → Netlify、任意平台 → Render、迁移出 Vercel、迁移出 GitHub Pages。
8. 进阶引导覆盖：域名购买、免费额度超限、付费升级、后端 / 数据库分层、大陆合规路线。
9. 现有测试全部通过；新增六条路径、同平台拒绝、未知平台、缺参数、DNS 安全门用例。
10. Netlify / Render 路径在第一阶段验证通过后加入，复用同一模板和验收标准。

**验证方式**：

```text
node run-tests.mjs
node check-skill.mjs
```

人工走一遍 GitHub Pages → Cloudflare Pages 的 dry-run：只生成计划，不执行部署和 DNS；确认报告包含检查项状态、验收结果、DNS 变更记录、回滚路径、建议观察期。

**回滚**：删除迁移脚本、模板和 reference，恢复 SKILL.md / 报告模板；现有 Cloudflare 迁移指南和部署流水线不受影响。

### 6.4 硬约束

| 约束 | 落地方式 |
|---|---|
| 不删除、不破坏现有 probe、识别、构建、部署、HTTP 验收脚本 | 新增决策层放在脚本之外；现有脚本只做可选、向后兼容的扩展 |
| 未确认不执行 DNS 切换、自定义域名绑定、数据库迁移、删除操作 | 迁移模块只输出待执行步骤；安全门写在 4.5 |
| 不读取、不写入用户密钥值 | 只记录环境变量键名和存放位置；报告、日志、JSON 输出都不含值 |
| 所有新增模块必须有降级路径 | 4.7 与 5.7 覆盖迁移、矩阵、评估、平台不支持和 CLI 不可用 |
| 保持 Skill 正文简体中文、文件名和标识符 ASCII、JSON 字段英文 | 新增 reference 用中文正文，文件名用 ASCII，矩阵 JSON 字段用英文 |
| 保持 Cloudflare 路径为静态免费层默认推荐 | 矩阵只做平台层筛选；Cloudflare 家族仍走现有 Pages / Workers 三问 |

### 6.5 总体验收

| 项 | 标准 |
|---|---|
| 现有功能 | probe、识别、构建、部署、验收脚本行为不变；现有测试全绿 |
| 新增决策 | 四维适配度评估、矩阵筛选、首选 / 备选 / 不推荐均有机器可读 JSON 和中文摘要 |
| 大陆风险 | 含大陆或未明确地域时，完整提示必现；不折叠、不省略 |
| 迁移安全 | DNS / 域名 / 数据库 / 删除操作全部有确认门；源平台保留至少一周 |
| 文档 | SKILL.md 保持简体中文；文件名 ASCII；JSON 字段英文；SKILL.md 尽量控制在 400 行内，细节放 reference |
| 数据 | 矩阵带 `checked_at` 和官方来源；额度数字可追溯 |
| 降级 | 脚本缺失、平台不支持、CLI 不可用时，至少有人工操作清单 |
| 隐私 | 不读取、不写入、不回显任何密钥值；报告只出现键名 |

### 6.6 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| SKILL.md 变长 | 触发技能时上下文变重 | 正文只放路由、硬规则和输出格式；矩阵、迁移细节放 reference |
| 免费额度过期 | 推荐依据失真 | `checked_at` + 官方来源 + 报告写“待复核” |
| 多平台承诺过强 | 用户以为技能能自动部署所有平台 | 能力边界明确写“非 Cloudflare 默认人工执行”，脚本不支持时给清单 |
| probe 的 Cloudflare 阻断误伤非 CF 目标 | 用户被错误拦住 | 用 `checks` 区分失败项；迭代 2 可选 `--target`；报告中说明作用域 |
| 迁移 DNS 操作出错 | 站点不可用 | 双活、降 TTL、先绑后切、保留源平台一周、用户确认 |
| 平台控制台改名 | 操作路径失效 | 注明以 2026-11 官方文档为准，提供控制台搜索方式 |
| 选型列表过长 | 用户无法决策 | 只输出 1 首选、1–2 备选、1–2 不推荐；其余写“本轮未纳入” |
| 矩阵与文档不一致 | 决策依据冲突 | 以 JSON 为唯一数据源，测试校验表格关键字段 |

---

## 7. 附录：最终报告结构

部署报告和迁移报告都沿用“已验证 / 失败 / 警告 / 未验证”的证据体系。部署报告新增以下小节：

1. **项目识别摘要**：沿用现有格式，保留 `confirmed` / `inferred` / `unknown`。
2. **部署适配度评估**：四维结论、候选池、排除原因。
3. **选型建议**：首选 / 备选 / 不推荐，每项附理由、免费额度关键点、适合场景、主要限制。
4. **中国大陆访问风险与建议**：目标用户含大陆或未明确时强制输出；给出路线 A（海外托管 + 自定义域名 + 自托管关键资源，承认可能限速 / 阻断）和路线 B（ICP 备案 + 国内云 / CDN）。
5. **迁移路径**：如用户已有部署，写源平台、目标平台、迁移前检查、双活验收、DNS 变更记录、回滚路径、建议观察期。
6. **进阶需求引导**：域名、付费、后端 / 数据库，按需输出。
7. **下一步建议**：按“必须处理 / 建议处理 / 可选优化”三档，每项附一句理由和操作入口。

原有验收表、未验证表、遗留问题、回滚、备注继续保留。

## 8. 附录：意图路由

| 用户意图 | 路由 |
|---|---|
| “部署到 Cloudflare” / “迁移这个仓库” | 完整流程；Cloudflare 路径优先，2C 后回到 Pages / Workers 三问 |
| “部署到 Vercel / Netlify / Render / GitHub Pages” | 0–2D + 人工部署步骤 + 6 验收；不声称自动部署 |
| “这个项目适合哪个平台” | 0–2C；只给评估和选型，不部署 |
| “从 X 迁到 Y” | 0–2C + 6A 迁移模块；先做目标预览，再切 DNS |
| “自定义域名怎么买 / 怎么绑” | 2D + `custom-domain-guide.md`；输出购买、DNS、证书步骤 |
| “免费额度不够 / 要不要升级” | 2D + `advanced-needs.md`；先优化，再给付费方案 |
| “有后端 / 数据库怎么部署” | 2B + `advanced-needs.md`；区分 Serverless、Supabase、长期运行 |
| “大陆访问不稳定” | 2D + `mainland-china-access.md`；输出两条路线和验证方法 |
| “检查现有部署” | 第 6 步 + `verification.md`；不改文件 |
| “部署失败 / 502 / 404 / CORS” | probe + 现有 troubleshooting；按平台补充失败分支 |

## 9. 附录：测试用例清单

**适配度评估与选型**

- 静态 / SSG / SPA × 五平台候选。
- SSR / 全栈排除 GitHub Pages 和 Netlify 纯静态托管。
- 无后端、Supabase、Docker 三种后端形态。
- 海外、含大陆、未明确三种地域。
- 免费、付费、未知三种预算。
- 关键字段 `unknown` 时必须要求补充输入，不猜。
- 静态免费 → Cloudflare Pages 首选。
- 大陆 → 风险提示必现，Vercel 默认域名不推荐。
- 商业用途 → Vercel Hobby 不推荐。
- 现有部署健康 → 不迁移结论。

**矩阵**

- 八个平台必填字段齐全。
- 平台 ID 唯一，`render_support` 取值合法。
- JSON 与 Markdown 表格关键字段一致。
- `checked_at` 存在，来源链接存在。

**迁移**

- GitHub Pages ↔ Cloudflare Pages、GitHub Pages ↔ Vercel、Cloudflare Pages ↔ Vercel 六条有向路径。
- 同平台 `source = target` 退出码 2。
- 未知平台输出人工清单。
- `project_type` 缺失或非法时退出码 2。
- 环境变量只出现键名。
- DNS 变更标记“待确认”，不自动执行。
- 目标预览失败时报告写“未切换”。
- 回滚段、观察期、DNS 变更记录必现。

**回归**

- 现有 probe、识别、构建、部署、HTTP 验收测试全绿。
- `check-skill.mjs` 通过。
- 现有 Cloudflare Pages / Workers 选型路径不变。

---

## 10. 实施顺序一句话总结

先让用户“看懂适配度和大陆风险”（迭代 1），再让用户“选对平台”（迭代 2），最后让用户“安全迁移”（迭代 3）。每一步都保留现有 Cloudflare 流水线，先加决策层，再加数据层，最后加迁移层。
