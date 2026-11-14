# 部署计划：{{项目名}}

> 依据第 0 步的链路探针、可行性判定和 `detect-project.mjs` 填写。控制在一屏内，不适用的字段删掉。

## 前置结论（第 0 步，先填这个）

| 项 | 结论 |
|---|---|
| 链路探针 | {{ready / limited / blocked}}；**blocked 时本计划不执行** |
| 可行性 | {{可行 / 不可行 + 依据，写明查了哪些官方文档}} |
| 当前套餐 | {{免费 / Workers Paid / 未知}} |
| 成本档 | {{免费 / $5 月起 / 按量}} |
| 不可行时的选项 | {{换依赖 / 换方案 / 换平台 + 各自代价}} |

## 现状

| 项目 | 值 |
|---|---|
| 仓库 | {{repo_url}} |
| 框架 / 类型 | {{framework}} / {{静态、SPA、SSR、API 或全栈}} |
| 站点模式 | {{static / ssg / spa / ssr}}（构建检查和验收共用；ssr 不做产物检查） |
| 包管理器 / 运行时 | {{manager}} / Node {{version}} |
| 构建环境 | {{本地 / Git 集成或 Workers Builds 平台构建}}（Windows + 适配器优先选平台构建） |
| 构建命令 | `{{build_command}}` |
| 输出目录 | `{{output_dir}}` |
| 当前托管 | {{GitHub Pages / 其他 / 无}} |
| 当前域名 / DNS | {{domain}} / {{provider}} |
| 后端 / 数据库 | {{无 / Supabase / API / D1 / ...}} |
| 文件 / 用户 / 认证 | {{...}} |
| PWA / Service Worker | {{有 / 无}} |

## 目标

| 决策 | 值 | 依据 |
|---|---|---|
| Cloudflare 产品 | {{Pages / Workers}} | {{一两个决定性事实}} |
| 部署方式 | {{Git / Direct Upload / wrangler / Workers Builds}} | {{...}} |
| 是否迁后端 | {{否 / 是，范围}} | {{...}} |
| GitHub Pages 备用 | {{保留 / 不保留}} | {{...}} |
| 索引策略 | {{主站 self-canonical，备用站 noindex / 其他}} | {{...}} |

## 改动

| 文件 | 改什么 | 风险 |
|---|---|---|
| {{vite.config.ts}} | {{base: "/"}} | 低 |
| {{_headers}} | {{给 pages.dev 加 noindex}} | 低 |
| {{wrangler.jsonc}} | {{assets + not_found_handling}} | 低 |
| {{...}} | {{...}} | {{...}} |

不要动：{{必须保持原样的文件/workflow}}。

## 命令

```bash
# 安装
{{npm ci}}

# 构建
{{npm run build}}

# 产物检查
node "<技能目录>/scripts/check-build.mjs" --dir "{{输出}}" --mode "{{static|ssg|spa|ssr}}" [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0] [--pages-wrangler-major 4]

# 部署（先预览）
{{npx wrangler pages deploy ... | npx wrangler deploy}}
```

## 环境变量与密钥

| 名称 | 放哪 | 生产 | 预览 |
|---|---|---|---|
| {{API_BASE_URL}} | {{Pages 变量 / Worker 变量}} | {{...}} | {{...}} |
| {{SECRET}} | {{wrangler secret}} | 已设 | 已设 |

绝不提交：`.env`、`.dev.vars`、Token。

## 验收

- [ ] 首页 200 + 标题正确
- [ ] 未知路径符合所选模式（static/ssg 为 404；spa 为 200 + app shell；ssr 通常 404，200 需确认不是 catch-all）
- [ ] SSR 专项：服务端渲染内容、`--api` 接口状态/JSON、数据库读写、登录会话（仅 ssr，人工或专项验证）
- [ ] 同源资源最终 2xx（记录检查数量；3xx 要跟随到最终地址，跨主机单独确认）
- [ ] SPA 深链 + 刷新（如果是 SPA）
- [ ] `_headers` / `_redirects` 生效（如果用了）
- [ ] API / CORS / 登录（如果涉及）
- [ ] CORS 预检：ACAO、Allow-Methods、Allow-Headers、凭据（只按显式提供的 `--cors-*` 断言，未检查项写「未验证」；带凭据时 `*` 不作通配，GET/HEAD/POST 是安全列表方法）
- [ ] 文件数在当前套餐生效上限内（Free 20,000；Paid 100,000 需 `--target pages` 的 Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`，或 `--target workers` 的 Wrangler >= 4.34.0），单文件 ≤ 25 MiB
- [ ] 数据库读写（如果涉及，且已获批准）
- [ ] 备用站 200 且不跳主站（如果保留）
- [ ] canonical / noindex 正确（如果公开）

## 风险与回滚

| 风险 | 概率 | 缓解 |
|---|---|---|
| {{改 base 后资源 404}} | 中 | 先在预览验收再加域名 |
| {{...}} | {{...}} | {{...}} |

止损线：同一构建步骤连续失败 2 次，或单次超过 15 分钟无实质进展 → 停止调优，换构建环境或换方案，并说明原因。

回滚：{{控制台回滚 / revert commit / 重新添加 GitHub 自定义域名 + 改 DNS}}。
回滚耗时：{{...}}。

## 需要确认

只勾选适用项：

- [ ] 生产 DNS
- [ ] GitHub Pages 自定义域名变更
- [ ] 生产密钥
- [ ] 生产数据库
- [ ] 删除旧部署/旧数据
- [ ] 不可逆配置（Pages Direct Upload / 重建项目）
- [ ] 套餐/计费
- [ ] 临时部署探针（`probe.mjs --deploy` 会真实创建并删除一个临时 Worker）
