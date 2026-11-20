# 进阶需求：付费额度与后端数据库

## 1. 免费额度超限

先确认具体超限项，再决定是否升级：

| 超限项 | 先做什么 | 再考虑 |
|---|---|---|
| 构建次数 | 减少无效构建、合并提交、缓存依赖 | 升级套餐或改用本地构建 + 上传产物 |
| 带宽 | 压缩图片、拆分大文件、加缓存 | 换带宽更宽松的平台或升级 |
| Functions 调用 | 减少冷启动、缓存响应、合并接口 | Serverless 付费额度 |
| 文件数 | 清理未使用资源、拆子站 | Cloudflare Pages / Workers 付费上限 |
| 团队席位 | 只邀请必要成员 | 团队套餐 |

轻度超限优先优化，不要直接升级。

## 2. 付费选项

| 平台 | 起步价 | 适合 |
|---|---|---|
| Cloudflare Workers Paid | $5/月起，1000 万请求/月 | Pages Functions、KV、Durable Objects、Workers |
| Vercel Pro | $20/月起 | 商业用途、超出 Hobby 限制、团队协作 |
| Netlify | 按 credits / 资源计费 | Functions、Forms、部署预览 |
| Render | 按资源计费 | Web Service、Postgres、长期运行服务 |
| Railway / Fly.io | 按量计费 | Docker、长驻服务、数据库 |

价格会变，引用前复核官方定价页。不要默认推荐 Pro；先给免费替代方案，再给付费方案。

Vercel Hobby 仅个人非商业；商业项目不能使用 Hobby，必须升级到 Pro 或改用其他允许商业用途的平台。Cloudflare Pages 与 Workers 是独立产品，付费额度和运行时限制不能混用。

## 3. 后端与数据库分层

| 层级 | 方案 | 适合 | 注意 |
|---|---|---|---|
| 轻后端 / Serverless | Cloudflare Workers / Pages Functions + D1 / KV；Vercel Functions；Netlify Functions | 轻量 API、表单、Webhook | 运行时兼容、冷启动、调用额度 |
| 标准 PostgreSQL + Auth + Storage | Supabase 托管后端 | 关系型数据库、登录、文件存储 | 前端可部署到任意静态平台；只迁前端 |
| 长期运行 / Docker / 全栈 | Render Web Service、Railway、Fly.io | 常驻进程、WebSocket、后台任务 | Render 免费 Web Service 15 分钟无流量休眠 |
| 中国大陆稳定访问 + 后端 | 国内云 + ICP 备案，或接受海外托管延迟 | 大陆用户为主 | 海外平台 + 自定义域名不能保证稳定 |

## 4. 安全要求

- 数据库连接字符串、Auth 密钥、Storage 密钥必须通过平台环境变量管理，不能写入仓库。
- 计划和报告只写键名和存放位置，不写值。
- 数据库迁移必须备份、staging 导入、数量 / 校验和核对、冻结写入、用户确认。
- 不要把“前端上线”写成“整个项目上线”；后端、数据库、登录、回调没测就写“未验证”。

## 5. 相关文档

- 平台矩阵：`references/platform-matrix.json`。
- 大陆访问：`references/mainland-china-access.md`。
- 域名购买：`references/custom-domain-guide.md`。
- 迁移：`references/cross-platform-migration.md`。
