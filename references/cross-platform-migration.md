# 跨平台迁移手册

适用平台：GitHub Pages、Cloudflare Pages、Cloudflare Workers、Vercel Hobby / Pro、Netlify、Render。  
迁移脚本：`scripts/migration-plan.mjs`。它只生成计划、检查清单和报告骨架，不执行 DNS、部署或数据库操作。Cloudflare Pages 与 Workers 是两个独立产品，不能共用一套迁移假设；Vercel Hobby 不能用于商业项目。

## 1. 入口参数

| 参数 | 取值 | 必填 | 说明 |
|---|---|---|---|
| `source` | `github-pages` / `cloudflare-pages` / `cloudflare-workers` / `vercel` / `vercel-pro` / `netlify` / `render` | 是 | 当前部署平台 |
| `target` | 同上 | 是 | 目标平台；不能等于 `source` |
| `project_type` | `static` / `ssg` / `spa` / `ssr` / `fullstack` | 是 | 决定渲染兼容性和验收模式 |

可选：`--build-command`、`--output-dir`、`--env-keys "A,B"`、`--domain`、`--dns-provider`、`--retain-days`。  
`--env-keys` 只接受键名，拒绝 `KEY=value`；脚本不读取、不写入任何密钥值。

## 2. 迁移前检查

逐项输出 `provided` / `inferred` / `verified` / `pending` / `blocked` / `not_applicable`：

- `provided`：用户提供了信息，但尚未验证。
- `inferred`：从项目配置或平台矩阵推断。
- `verified`：实际构建、探测或配置检查通过。
- `pending`：尚未确认。
- `blocked`：存在阻断。
- `not_applicable`：不适用。

用户提供构建命令、输出目录、环境变量键名或域名，只能算 `provided`；不代表构建成功、变量已配置或 DNS 已核实。

1. 源平台构建命令、输出目录。
2. 环境变量键名（只记录键名）。
3. 自定义域名、DNS 提供商、CNAME / A / nameserver、TTL。
4. 重定向、headers、平台配置文件（`_redirects`、`_headers`、`vercel.json`、`netlify.toml`、`render.yaml`）。
5. 平台特有能力依赖（base path、Forms、Functions、CNAME 文件、deploy branch 等）。
6. 源平台保留回滚的时长，至少 7 天。

补充检查：PWA / Service Worker 是否会缓存旧域名；canonical、`og:url`、sitemap 是否写死源域名；API / Auth 回调白名单；第三方统计和 CDN 依赖。

## 3. 双活五步

### Step 1：目标平台预览

导入同一仓库，或用目标平台 CLI 部署；先使用目标平台免费子域名，不碰正式域名。

### Step 2：源平台保持在线

源平台不动，作为回滚目标。不要在第 1 步通过后立刻删除源站、旧分支或旧 DNS。

### Step 3：验收清单

- 首页 200 + 正确标题。
- 关键内页、静态资源、404 / SPA 回退。
- 旧路径重定向、尾斜杠、`/index.html`。
- HTTPS 证书和混合内容。
- 如有 API / SSR：运行时兼容、函数额度、环境变量键名、数据库连接。
- 用 `scripts/verify-deployment.mjs` 和构建检查用同一个 `--mode`。

目标预览未通过，不进入 DNS 切换。

### Step 4：自定义域名切换

1. 提前 24–48 小时降低 DNS TTL。
2. 先在目标平台绑定域名。
3. 再按目标平台提示改 CNAME / A / nameserver。
4. 等待证书签发，验证 HTTPS。
5. DNS 变更前必须用户明确确认；脚本只输出步骤。

### Step 5：观察与停用源平台

源平台至少保留 7 天，关键业务建议 2–4 周。观察流量、错误日志、Search Console、核心接口和第三方回调；确认无异常后再停用。

## 4. 六条高频路径

| 路径 | 关键动作 |
|---|---|
| GitHub Pages → Cloudflare Pages | Cloudflare Dashboard → Workers & Pages → Create application → Pages → Import an existing Git repository；填构建命令和输出目录；Custom domains 绑定后再改 DNS |
| Cloudflare Pages → GitHub Pages | 去除 `_redirects` / `_headers` 依赖；设置 base path；用 404.html 处理回退；deploy branch 发布 |
| GitHub Pages → Vercel | 修正 base path；重定向写 `vercel.json`；按 Vercel 提示迁移域名 |
| Vercel → GitHub Pages | 移除 `vercel.json` 依赖；确认 Hobby 非商业限制不再适用；静态站可迁，SSR 不可迁 |
| Cloudflare Pages → Vercel | `_redirects` 转 `vercel.json`；`_headers` 转 `vercel.json` headers；确认 Functions 替换 |
| Vercel → Cloudflare Pages | `vercel.json` 转 `_redirects` / `_headers`；注意单仓库“源-部署分离”时自动 promote 异常 |
| Cloudflare Pages → Workers | 重新核对 wrangler 配置、Static Assets、SSR 入口和绑定；`_redirects` / `_headers` 不完全等价 |
| Cloudflare Workers → Pages | 确认不再依赖 D1 / DO / Queues / Cron；Pages Functions 不能替代全部 Workers 能力 |
| Vercel Hobby → Pro | 商业项目必须升级；确认计费、团队席位和 Functions 额度 |
| Vercel Pro → Hobby | 仅当确认个人非商业；商业项目不要降级 |

扩展路径：

- 任意平台 → Netlify：仓库根目录创建 `netlify.toml`，不要只依赖面板设置。
- 任意平台 → Render：静态站免费；Web Service 15 分钟无流量休眠；提前告知冷启动。
- 迁移出 GitHub Pages：deploy branch 切到 None 停止发布，保留仓库和回滚能力。
- 迁移出 Vercel：必要时重新导入仓库恢复自动更新。

## 5. 安全门

- **DNS**：必须用户确认；先降 TTL，再改记录；保留旧记录。
- **自定义域名**：必须用户确认；先绑定目标平台，再改 DNS。
- **数据库**：备份、staging 导入、数量 / 校验和、冻结写入、用户确认；不与平台迁移混在一起。
- **删除**：源平台至少保留一周；删除前确认回滚路径和备份。
- **密钥**：只记录键名；不读取、不写入、不回显值。
- **目标预览失败**：停止迁移，保留源平台，不切 DNS；报告写“失败 / 未切换”。

## 6. 报告必须包含

源平台、目标平台、项目类型、检查项状态、验收结果、DNS 变更记录、回滚路径、建议观察期、未验证项。模板：`templates/migration-report.md`。

## 7. 降级

- 迁移脚本不可用：按本文和 `templates/migration-plan.md` 人工执行。
- 平台不在矩阵：输出通用步骤，明确“未纳入自动化检查”。
- 平台 CLI 不可用：优先用官方 Git 集成；仍不可用时保留源平台，不强行迁移。
- DNS 提供商不支持 API：只输出手动记录和验证命令，不尝试自动修改。
