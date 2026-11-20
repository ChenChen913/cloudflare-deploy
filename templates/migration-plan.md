# 迁移计划：{{source}} → {{target}}

> 由 `scripts/migration-plan.mjs` 生成或人工填写。只读计划，不执行 DNS、部署或数据库操作。

## 概要

| 项目 | 值 |
|---|---|
| 源平台 / 目标平台 | {{source}} / {{target}} |
| 项目类型 | {{static / ssg / spa / ssr / fullstack}} |
| 验收模式 | {{static / ssg / spa / ssr}} |
| 迁移方式 | {{Git 集成 / CLI / 控制台导入}} |
| 源地址 / 目标预览地址 | {{source_url}} / {{target_preview_url}} |
| 状态 | {{ready / needs_input / blocked}} |

## 迁移前检查

| 检查项 | 状态 | 证据 / 备注 |
|---|---|---|
| 构建命令与输出目录 | {{confirmed / pending / unknown}} | {{build_command}} / {{output_dir}} |
| 环境变量键名 | {{confirmed / pending}} | {{只写键名，不写值}} |
| 自定义域名与 DNS | {{pending / confirmed}} | {{域名、DNS 提供商、CNAME / A / nameserver、TTL}} |
| 重定向 / headers / 平台配置 | {{pending / confirmed}} | {{_redirects / vercel.json / netlify.toml / render.yaml}} |
| 平台特有能力依赖 | {{pending / confirmed}} | {{base path、Forms、Functions、CNAME 文件等}} |
| 回滚保留时长 | {{confirmed}} | 源平台至少保留 7 天；关键业务 2–4 周 |
| 目标平台渲染支持 | {{confirmed / blocked}} | {{矩阵声明支持 / 不支持，需换平台或 Functions}} |
| 目标预览验收 | {{pending}} | 首页、内页、资源、404、重定向、HTTPS、API / SSR |
| 数据库迁移 | {{not_applicable / pending}} | 如涉及，必须单独备份、staging、冻结写入、确认 |

## 双活五步

1. **目标平台预览**：导入同一仓库或用 CLI 部署；先使用目标平台免费子域名。
2. **源平台保持在线**：源站不动，作为回滚目标；不要删除旧分支或旧 DNS。
3. **验收清单**：首页、关键内页、静态资源、404 / SPA 回退、重定向、HTTPS；如有 API / SSR，检查运行时和环境变量键名。
4. **自定义域名切换**：提前 24–48 小时降低 TTL；先在目标平台绑定域名，再改 CNAME / A / nameserver。
5. **观察与停用**：源平台至少保留 7 天；观察流量、错误日志和 Search Console，确认后再停用。

## DNS 切换

| 项 | 值 |
|---|---|
| 需要用户确认 | 是 |
| 切换前 TTL | 24–48 小时 |
| 目标绑定方式 | {{CNAME / A / nameserver}} |
| 旧记录 | 保留到观察期结束 |

## 回滚

- 触发条件：目标站 5xx、关键页面不可用、证书失败、核心接口异常。
- 回滚步骤：恢复 DNS 记录；重新绑定源平台域名；重新启用源平台发布。
- 数据提醒：如涉及数据库，回滚前确认备份、冻结写入和数据一致性。

## 平台提示

- {{源平台特有配置和退出方式}}
- {{目标平台 base path / 重定向 / headers}}
- {{目标平台自定义域名绑定方式}}
- {{平台特有功能替换}}

## 需要确认

- [ ] DNS 记录和 TTL
- [ ] 自定义域名绑定
- [ ] 数据库迁移（如适用）
- [ ] 源平台停用时间
- [ ] 环境变量键名（只提供键名，不提供值）
