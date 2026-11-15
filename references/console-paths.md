# Cloudflare 登录后的控制台路径

菜单名会随控制台改版变化。下表以 2026-11 的官方文档为准；找不到时用 `Ctrl/Cmd + K` 搜索产品名。

## 1. 账号与凭证

| 目标 | 路径 | 直链 |
|---|---|---|
| 登录 / 注册 | `dash.cloudflare.com/login` / `sign-up` | https://dash.cloudflare.com/login |
| Account Home | 左上角账号名 → Account Home | https://dash.cloudflare.com/?to=/:account/home |
| 复制 Account ID | Account Home → 搜索 `Copy account ID`；或 Workers & Pages → Account Details | — |
| 用户 API Token | My Profile → API Tokens → Create Token | https://dash.cloudflare.com/profile/api-tokens |
| 账号级 API Token | Manage Account → API Tokens | — |
| 账单 | Manage Account → Billing | — |
| 成员与权限 | Manage Account → Members | — |
| 审计日志 | Manage Account → Audit Log | — |

## 2. Pages

| 目标 | 路径 |
|---|---|
| 项目列表 | Workers & Pages → 选择 Pages 标签 |
| 新建项目 | Workers & Pages → Create application → Pages → Connect to Git / Drag and drop |
| 项目总览 | Workers & Pages → 选中项目 → Deployments / Metrics |
| 构建命令与输出目录 | 选中项目 → Settings → Builds & deployments |
| 构建环境变量 | 选中项目 → Settings → Environment variables |
| 运行时变量与密钥（Functions） | 选中项目 → Settings → Variables and Secrets |
| KV / D1 / R2 / DO 绑定 | 选中项目 → Settings → Bindings |
| 自定义域名 | 选中项目 → Custom domains → Set up a domain |
| 回滚 | 选中项目 → Deployments → 选中历史部署 → Rollback |
| 删除项目 | 选中项目 → Settings → Delete project |

注意：

- 先在 Pages 里添加自定义域名，再去 DNS 加 CNAME；顺序反了会 522。
- 拖拽上传只支持 1,000 个文件，且不会编译 `functions/`；有 Functions 时用 Wrangler。

## 3. Workers

| 目标 | 路径 |
|---|---|
| Worker 列表 | Workers & Pages → 选择 Workers 标签 |
| 新建 Worker | Workers & Pages → Create application → Workers |
| 变量与密钥 | 选中 Worker → Settings → Variables and Secrets → Add |
| 自定义域名 / 路由 | 选中 Worker → Settings → Domains & Routes → Add → Custom Domain |
| 版本与部署 | 选中 Worker → Deployments / Version History |
| 触发器（Cron） | 选中 Worker → Settings → Triggers |
| 可观测性 | 选中 Worker → Observability / Logs |
| 绑定（KV/D1/R2/DO/Queues） | 选中 Worker → Settings → Bindings |

注意：Custom Domain 要求域名是当前账号下的 active zone；同一个 hostname 不能已有 CNAME。

## 4. 存储与数据库

| 产品 | 路径 | 备注 |
|---|---|---|
| R2 | Storage & databases → R2 → Overview | 首次使用要完成 checkout，免费额度也需开通 |
| D1 | Storage & databases → D1 | 界面标签可能是 “D1 SQL Database” |
| KV | Storage & databases → Workers KV | 命名空间在这里创建 |
| Queues | Workers & Pages → Queues | Free 有每日额度；超出/更高配额需 Workers Paid，以当前官方计划为准 |
| Hyperdrive | Storage & databases → Hyperdrive | 连接外部 Postgres/MySQL |

## 5. 域名与证书

| 目标 | 路径 |
|---|---|
| 添加域名 / 改 NS | Account Home → Domains → Add a domain |
| DNS 记录 | Domains → 选中域名 → DNS → Records |
| Zone ID | 域名 Overview → 页面底部 API 区域 |
| SSL/TLS 证书 | 选中域名 → SSL/TLS → Edge Certificates |
| 重定向规则 | 选中域名 → Rules → Redirect Rules |

## 6. 部署相关的最小路径

一次 Pages 部署，通常只需要：

1. Workers & Pages → Create application → Pages
2. 选中项目 → Settings → Builds & deployments（Git 集成）或直接 `wrangler pages deploy`（Direct Upload）
3. Settings → Variables and Secrets（如有运行时变量）
4. Custom domains（验证通过后再加）
5. Deployments → Rollback（出问题时）

一次 Workers 部署，通常只需要：

1. Workers & Pages → 选中 Worker
2. Settings → Variables and Secrets
3. Settings → Domains & Routes（验证通过后再加）
4. Deployments / Version History（回滚）

## 7. 路径速记

```text
dash.cloudflare.com
├── Account Home                 账号、Account ID、Domains
├── Workers & Pages              Pages / Workers / Queues
│   └── <project>
│       ├── Deployments          部署历史、回滚
│       └── Settings
│           ├── Builds & deployments
│           ├── Environment variables
│           ├── Variables and Secrets
│           ├── Bindings
│           └── Domains & Routes / Custom domains
├── Storage & databases          R2 / D1 / KV / Hyperdrive
├── Manage Account               Billing / Members / Audit Log
└── My Profile                   API Tokens
```

## 来源

- 创建账号：https://developers.cloudflare.com/fundamentals/account/create-account/
- Account ID：https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/
- Pages 构建配置（环境变量路径）：https://developers.cloudflare.com/pages/configuration/build-configuration/
- Pages 绑定（Variables and Secrets 路径）：https://developers.cloudflare.com/pages/functions/bindings/
- Workers 变量与密钥：https://developers.cloudflare.com/workers/configuration/environment-variables/
- Workers 自定义域名：https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- R2 开通：https://developers.cloudflare.com/r2/get-started/
- Queues 定价/免费额度：https://developers.cloudflare.com/queues/platform/pricing/
