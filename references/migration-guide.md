# 迁移方法与 Jekyll 实战记录

这是端到端顺序，以及产出本技能大部分数字的真实项目。平台细节在其它 reference；本文是地图和案例。

## 1. 证据标注

| 标注 | 含义 |
|---|---|
| 官方 | Cloudflare / GitHub 文档或定价页明确写出 |
| 实测 | 某个日期、网络、项目上实际观察到的 |
| 建议 | 取舍，不是平台规则 |
| 待验证 | 文档没写，也没测过 |

不要把“建议”说成“官方”，也不要把一次“实测”说成通用保证。

## 2. 七个阶段

1. **评估**：填项目表（仓库、类型、构建、路由、域名、后端、数据、用户、流量）。
2. **选型**：Pages 还是 Workers，Git 还是 Direct，只迁前端还是连后端。见 `platform-selection.md`。
3. **准备**：备份代码/数据库/文件/环境变量；记录旧 URL 和 DNS TTL；先在 `pages.dev`/`workers.dev` 验证。
4. **迁前端**：base path、SPA 回退、`_headers`、PWA、API 地址。
5. **迁数据**（只在必须时）：staging 导入、数量/校验和、只读验证、冻结写入、切换、旧库只读。
6. **切域名**：降 TTL、绑域名、验证 TLS、需要备用站时移除 GitHub Pages 自定义域名。
7. **观察**：24–72 小时看急性故障，1–4 周看搜索/缓存/长尾。

不要把平台迁移和 schema 变更、依赖升级放在同一个提交里。

## 3. 双构建模式（Jekyll）

项目是一个 Jekyll 个人主页，两个目标。一个产物不能同时服务两边，因为 `site.url` 决定 canonical、`og:url`、hreflang 和 sitemap。

```bash
# GitHub Pages 产物
bundle exec jekyll build                                   # -> _site

# Cloudflare 产物
bundle exec jekyll build \
  --config _config.yml,_config.cloudflare.yml \
  --destination _site_cf                                   # -> _site_cf
```

`_config.cloudflare.yml` 只覆盖：

```yaml
url: "https://chenchen913.pages.dev"
include: ["_headers"]
```

为什么构建两次：只构建一次再复制，Cloudflare 的页面会声明自己是 `github.io` 的副本，canonical 和分享卡片都指向错误的主机。

为什么必须写 `--destination`：两个构建写同一个 `_site` 会静默互相覆盖，CI 全绿，但其中一个站内容是错的。

为什么 `include` 放在 Cloudflare 配置里：Jekyll 合并 `--config` 时数组是整体替换。把 `include: ["_headers"]` 放在 `_config.yml`，`_headers` 也会进 GitHub 产物，变成一个可公开下载的文件（实测：HTTP 200，1,554 字节）。

## 4. 实测数据（2026-10-27 / 2026-11-14）

跳转行为：

| 请求 | 结果 |
|---|---|
| `/` | 200 |
| `/index.html` | 308 → `/` |
| `/en.html` | 308 → `/en` |
| `/en/` | 308 → `/en` |
| `/projects/xxx` | 308 → `/projects/xxx/` |
| `/projects/xxx/?lang=en` | 200，参数保留 |
| 未知路径 | 404 |

域名归一后的产物一致性：

| 页面 | 首页 | 英文页 | 项目详情 | 论文详情 |
|---|---|---|---|---|
| 字节数 | 17,732 | 17,764 | 14,289 | 15,695 |
| 归一后 diff | 空 | 空 | 空 | 空 |

差异只出现在 `canonical`、`og:url`、`og:image`、`hreflang`——正是两次构建刻意区分的地方。

性能：

| 页面 | TTFB | FCP | 传输 |
|---|---|---|---|
| 首页 | 208 ms | 432 ms | 6.2 KB（br） |
| 论文页 | 243 ms | 472 ms | 6.7 KB |

外部依赖：零。KaTeX、highlight.js、pdf.js 全部自托管在 `assets/vendor/`。

> 字节数和时间是历史测量，不是保证。索引策略在采集之后改过，因此仍待复测。

## 5. 踩坑（按代价排序）

### 5.1 `_headers` 在备用站可下载

原因：`include: ["_headers"]` 写在 `_config.yml`，文件被复制进 `_site` 并由 GitHub Pages 提供。修法：把 `include` 移到 `_config.cloudflare.yml`。两边都要验证：GitHub 必须 404，Cloudflare 安全头必须还在。

### 5.2 `.html` vs 无扩展名

GitHub Pages 不认 `en.html` 的 `/en`；Cloudflare 把 `en.html` 308 到 `/en`。选项：

| 方案 | 结果 |
|---|---|
| 用 `_redirects` 让 `.html` 返回 200 | 否掉：同一内容两个 200 地址 |
| 内链改无扩展名 | 否掉：GitHub Pages 404 |
| 保留 `.html`，接受 308 | 采用 |

### 5.3 sitemap 里有 `/en.html`

爬虫会跟随 308 到 `/en`。轻微。修它需要给 `en.html` 设特定 permalink，会破坏 GitHub 侧，所以没改。

### 5.4 `curl` 假阴性

本机代理截断大响应：同一页面多次返回 5,846 B、17,732 B 或空。

- 状态码和跳转链用 `curl`；
- 内容用浏览器（Playwright 取 `response.body()`）；
- 两站一致性用归一域名后的 diff。

### 5.5 部署链路断了两周

现象：推送成功、HEAD 变了、线上不动、没有报错。

原因：runner 默认 Python 升到 3.14，PyYAML 6.0.2 只有 cp313 wheel，pip 回退到 sdist；PyPI 重新打包过该 sdist（文件名大小写和 hash 都变了），而 `requirements-ci.txt` 固定的是旧 hash。`--require-hashes` 失败，安装中断，构建和部署全部 skipped。

为什么持续两周：定时任务只跑链接检查；真正构建部署的 job 在 `schedule` 触发时是 skip 的。静态站又长期没有 push，故障不会自己暴露。

修法：保留两个真实 sdist hash；`actions/setup-python` 固定 3.13；让定时任务也跑依赖安装和数据校验，变成部署链路的哨兵。

教训：监控要覆盖真实部署路径，不能只检查“站点能打开”。

### 5.6 Jekyll 特有

| 现象 | 原因 | 修法 |
|---|---|---|
| `Liquid syntax error` | 根目录 `.md` 里有 Liquid 示例 | 加进 `exclude` |
| 从 exclude 移除但文件还在 | Jekyll 照样解析 | 文件增删和 exclude 增删放在同一个提交 |
| 未知路径返回 200 | `404.html` 被 exclude，Pages 当成 SPA | 探一个不存在的路径 |

## 6. 监控与回滚

- `deploy.yml` 红 → 这次改动没上线，线上还是旧的。
- `uptime-check.yml` 红 → 线上现在就是坏的。
- GitHub 只在**公开仓库**、且只对 **`schedule` 触发**的 workflow 执行“60 天无活动自动禁用”。push 触发的部署不受影响。真正的失效模式是“哨兵停了，但部署还在跑”。
- Pages 控制台回滚只回滚 Cloudflare 一侧，且是临时的。revert commit 会让两个目标一起退，并重新触发 CI。
- 回到 GitHub Pages 当主站，需要重新添加自定义域名并等证书，不只是改 DNS。

## 7. 成本（本项目）

- Pages Free：500 次构建/月，1 并发。
- 本项目用 Direct Upload：一个 CI job 里两次 `jekyll build`，一次 `wrangler pages deploy`。
- 每天 2–3 次 push，约 60–90 次/月。
- Direct Upload 不进入构建环境，实践中不计入构建额度；但定价页没有明文，标为待验证。即使按“每次部署计 1 次”的保守口径，也远低于 500。

## 8. 索引策略状态

原决策（“两站都 self-canonical，GitHub Pages 不加 noindex”）是错的：把收录和可用性混为一谈。

正确策略：主站 self-canonical 可收录；备用站 `noindex, follow` 但可访问；只有自定义域名是主站时，`pages.dev` 才 noindex。

**状态（2026-11-14）：未实施。** 本文的策略已经改，但那个 Jekyll 仓库不在当前工作区，改动和复测都没做。待办：

- [ ] 只给 GitHub 产物注入 robots meta；
- [ ] 决定是否去掉 GitHub 侧 sitemap；
- [ ] 验证备用站返回 `noindex`；
- [ ] 验证主站 canonical 指向自己；
- [ ] 接受两站 diff 多出一行 `robots`。

本文是自包含的：配置、数据、踩坑记录都写在这里，不依赖技能目录之外的任何文件。技能装到别的机器、别的目录，照样能读。
