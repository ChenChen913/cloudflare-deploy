# 多入口部署的 SEO 与索引

## 1. 两件不同的事

- **可用性**：用户能不能打开。由 DNS、服务器、证书决定。`noindex` 不影响。
- **收录**：搜索引擎要不要列出来。由 canonical、`noindex`、`robots.txt` 决定。

不要用“备用站不收录就没意义”当理由。备用站的职责是可用性，收录是另一个产品决策。

## 2. 入口

| 入口 | 角色 | 推荐策略 |
|---|---|---|
| 自定义域名（没有时用 `pages.dev`） | 主站 | self-canonical，可收录 |
| `project.pages.dev`（有自定义域名时） | 部署验证 / 别名 | `X-Robots-Tag: noindex` |
| `owner.github.io/repo` | 备用站 | `noindex, follow`（或 canonical 指主站） |
| `<hash>.project.pages.dev` | 预览 | 平台自动 noindex；不要当访问控制 |

## 3. 备用站二选一

### 方案 A（推荐）：备用站不收录

- 主站：`<link rel="canonical" href="https://example.com/page/">`。
- 备用站：`<meta name="robots" content="noindex, follow">`。

效果：直接访问正常；备用站不参与搜索竞争；没有两个规范地址。

代价：主站长期宕机时，搜索流量不会转到备用站。

### 方案 B：备用站可收录，但 canonical 指主站

- 主站：self-canonical。
- 备用站：canonical 指主站，不加 `noindex`。

效果：只有一个规范地址；备用站被当作副本。

代价：搜索结果仍指向主站，宕机时不会自动切换。

**不要同时用 `noindex` 和指向别处的 canonical。** 信号冲突，其中一个会被忽略。

## 4. 实现

### Pages 的 `pages.dev`

```text
https://:project.pages.dev/*
  X-Robots-Tag: noindex

https://:version.:project.pages.dev/*
  X-Robots-Tag: noindex
```

只有自定义域名（或其他主机）才是主站时才加。如果 `pages.dev` 就是主站，它必须可收录。

### GitHub Pages

GitHub Pages 不能设响应头，只能把 meta 放进 `<head>`：

```html
<meta name="robots" content="noindex, follow">
```

`robots.txt` 不能代替：它阻止抓取，不会移除已收录的 URL。

### 预览

Pages 会给预览地址自动加 `X-Robots-Tag: noindex`。不要重复配，也不要把它当访问控制。

## 5. 验证

```bash
# 主站 canonical
curl -s https://example.com/ | grep -io '<link[^>]*canonical[^>]*>'

# 备用站 meta robots
curl -s https://owner.github.io/repo/ | grep -io '<meta[^>]*name="robots"[^>]*>'

# pages.dev 响应头
curl -sI https://project.pages.dev/ | grep -i x-robots-tag
```

然后确认：

- 每页只有一个 canonical；
- canonical 主机是预期的主站；
- 备用站只有一个不收录信号；
- sitemap 里的 URL 用规范主机；
- `og:url` 用规范主机。

Google Search Console → 网址检查，才能看到 Google 实际选的 canonical。没查过就标未验证。

## 6. Sitemap 与 robots

- `sitemap.xml` 列规范 URL，不要列 `.html` 重复地址或 `pages.dev`。
- sitemap 是建议，不是索引命令；`noindex` 仍然优先。
- 备用站 `noindex` 时，保留它的 sitemap 无害，但浪费抓取预算；从备用站构建里去掉是合理的。
- 不要在 `robots.txt` 里屏蔽 CSS/JS/资源，爬虫需要它们渲染页面。

## 7. 常见错误

- 两个站都 self-canonical 且可收录 → 信号被拆。
- 把备用站的配置复制到主站，主站也 `noindex`。
- 绑了自定义域名后，canonical 还指向 `pages.dev`。
- 用 `robots.txt` “删除”已经收录的页面。
- 以为预览地址有 `noindex` 就私有。
- 改用干净 URL 后，sitemap 还列着 `/en.html`（轻微：爬虫会跟随 308）。

## 来源

- Pages Headers（noindex 示例）：https://developers.cloudflare.com/pages/configuration/headers/
- Google Search Central：canonical 与 robots meta 的当前文档是权威；构建本技能的环境访问不到，未固定具体链接，引用前先查 Search Central。
