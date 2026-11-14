# 把 GitHub Pages 保留成真正的备用站

目标不是“文件还在 GitHub 上”，而是：**Cloudflare 不可用时，`github.io` 仍然直接返回站点内容，不会 301 跳进已经挂掉的主站。**

## 1. 先分清站点类型

| | User / Organization site | Project site |
|---|---|---|
| 仓库名 | `<owner>.github.io` | 任意仓库 |
| 默认地址 | `https://<owner>.github.io/` | `https://<owner>.github.io/<repo>/` |
| 路径前缀 | 无 | 每个资源和链接都带 `/repo/` |
| 自定义域名 | 可单独设置；**会被名下 project sites 默认继承** | 可单独覆盖 |

两个后果：

- Project site 不能直接复用根路径的产物。要么用正确的 `base` 构建，要么构建两次。
- 移除 user site 的自定义域名，可能影响所有继承它的 project sites。移除前先确认。

## 2. 发布方式决定“移除域名”怎么做

| | 分支发布（Deploy from a branch） | GitHub Actions 发布 |
|---|---|---|
| 自定义域名存哪 | 发布源里的 `CNAME` 文件 | 仓库 Settings / API；**`CNAME` 被忽略** |
| 移除域名 | Settings → Remove，并确认删除 `CNAME` 的 commit | 只在 Settings 移除 |
| 手动删 `CNAME` | 提交后通常能移除 | 没用 |
| 构建限制 | 10 次/小时（软限制） | 不受这条限制 |

所以会出现两种相反的现象：

- Actions 发布：删了 `CNAME`，`github.io` 还是 301。
- 分支发布：Settings 移除后，静态生成器又把 `CNAME` 推回来。

## 3. 301 陷阱

GitHub Pages 会把默认域名 301 到已配置的自定义域名。2026-11-14 实测：

```bash
curl -sI https://sindresorhus.github.io/ | head -n 6
# HTTP/1.1 301 Moved Permanently
# Location: http://sindresorhus.com/
```

迁移后的连锁反应：

1. 自定义域名的 DNS 已指向 Cloudflare。
2. GitHub Pages 里还挂着这个自定义域名。
3. `owner.github.io/repo` → 301 → 自定义域名 → Cloudflare。
4. 所谓“备用站”只是主站的另一个入口。Cloudflare 挂了，它跟着挂。

**要让 `github.io` 成为独立备用站，必须在 GitHub Pages 里移除自定义域名。**

- 分支发布：Settings → Pages → Custom domain → Remove；确认删除 `CNAME` 的 commit 进入了发布分支。
- Actions 发布：只在 Settings 移除；`CNAME` 文件本来就被忽略。
- User site：先确认没有其他 project site 在靠它继承域名。

要明确告诉用户的代价：以后回滚到 GitHub Pages 当主站，需要重新添加自定义域名、等证书、改 DNS。

## 4. 验证，不要推断

```bash
GH=https://owner.github.io/repo

# 1. 必须是 200，不是 301
curl -s -o /dev/null -w '%{http_code}\n' "$GH/"

# 2. 不允许有 Location 指向主站
curl -sIL "$GH/" | grep -i '^location' || echo "no redirect"

# 3. 必须是 GitHub 在服务，不是 Cloudflare
curl -sI "$GH/" | grep -i '^server'
# 期望：Server: GitHub.com

# 4. 未知路径必须 404
curl -s -o /dev/null -w '%{http_code}\n' "$GH/__missing__"

# 5. 子页面和资源必须能取
curl -s -o /dev/null -w '%{http_code}\n' "$GH/some-page.html"
curl -s -o /dev/null -w '%{http_code}\n' "$GH/assets/style.css"
```

第 1 步返回 301、第 2 步看到自定义域名，就说明备用站不独立。

脚本可以自动检查第 1–3 步（根状态、是否跳主站、Server 头）：

```bash
node "<技能目录>/scripts/verify-deployment.mjs" --url "<主站地址>" --backup "$GH" --json
```

第 4–5 步（未知路径必须 404、子页面和资源能取）脚本的 `--backup` 不覆盖，仍需上面的 `curl` 或人工验证。

## 5. 索引策略

先分开两件事：

- **可用性**：人能不能打开。`noindex` 不影响。
- **收录**：搜索引擎要不要列出来。由 canonical / noindex 控制。

推荐的备用站策略：

| 入口 | 策略 |
|---|---|
| 主站自定义域名（没有自定义域名时是 `pages.dev`） | self-canonical，可收录 |
| `project.pages.dev`（有自定义域名时） | `X-Robots-Tag: noindex` |
| `owner.github.io` 备用站 | `<meta name="robots" content="noindex, follow">` |

为什么不两个都收录：两份相同内容都声明自己是 canonical，等于两个规范地址，搜索信号被拆开。

如果业务上必须让备用站被搜到：不要 `noindex`，改为在备用站把 canonical 指向主站。**不要同时用 `noindex` 和指向别处的 canonical**，信号冲突，其中一个会被忽略。

GitHub Pages 不能设响应头，只能把 meta 放进 `<head>`。`robots.txt` 不能代替 `noindex`：它阻止抓取，不阻止已收录的 URL 出现在结果里。

## 6. 会影响备用质量的 GitHub Pages 限制

- 发布站点最大 1 GB。
- 带宽 100 GB/月（软限制）。
- 分支构建 10 次/小时（软限制）；Actions 构建不受此限制。
- 单次部署超时 10 分钟。
- 私有仓库用 Pages 需要 GitHub Pro / Team / Enterprise。
- 不得用于电商、SaaS 等以商业交易为主的站点。

这些限制太紧时，GitHub Pages 只能当临时只读镜像，不能当生产备用站。

## 7. 期望管理

只保留 `github.io` 地址时，备用是 **URL 级**，不是域名级。用户手里的自定义域名链接，在 Cloudflare 挂掉时不会自动跳到 `github.io`。域名级切换要在 DNS 层做，不在这套流程里。

## 来源

- GitHub Pages 站点类型：https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- 发布源：https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site
- 自定义域名：https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site
- GitHub Pages 限制：https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
