# 排障

按顺序定位：**认证 → 构建产物 → 部署结果 → HTTP → 域名 → 缓存**。没定位到层，不要改配置。

## 快速表

| 现象 | 最可能原因 | 修法 | 验证 |
|---|---|---|---|
| `wrangler` 说未认证 | 没登录 / 没 Token | `npx wrangler login`，或设 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | `npx wrangler whoami` |
| 所有路径 404 | 输出目录错 / 产物为空 | 检查产物；设置正确目录 | `curl -I https://site/` |
| 所有路径都返回首页（200） | 缺顶层 `404.html`，Pages 当成 SPA | 加 `404.html`，或只对前端路由做 SPA 回退 | `curl -o /dev/null -w '%{http_code}' https://site/__missing__` |
| 子页面点得开，刷新 404 | 缺 SPA 回退 | Pages 用 `_redirects`：`/* /index.html 200`；Workers 设 `not_found_handling` | 新标签页打开子路由 |
| CSS/JS/图片 404 | 构建 base 是 `/repo/` 或其他前缀 | 用 `base: "/"` 重新构建；用相对路径 | DevTools Network |
| `.html` 链接多一跳 | Pages 把 `.html` 308 到无扩展名 | 接受，或改内链（但 GitHub Pages 可能 404） | `curl -I https://site/page.html` |
| `_headers` 不生效 | 文件不在产物根目录，或响应来自 Functions | 复制进输出目录；Functions 在代码里设头 | `curl -sI` |
| `_redirects` 不生效 | 文件不在产物根目录，或路由被 Functions 接管 | 复制进输出目录；把规则写进函数 | `curl -I https://site/old` |
| 浏览器报 CORS，头看起来正常 | ACAO 重复、`*` 配凭证、缺 `Vary: Origin`、预检没处理 | 修 `_headers`/函数；处理 `OPTIONS` | DevTools Console + `curl -X OPTIONS` |
| 自定义域名 522 | 先加 DNS 后加域名，或 CNAME 错 | 先在 Pages 添加域名，再把 CNAME 指向 `project.pages.dev` | `dig` 后 `curl -I` |
| 自定义域名一直 pending | 证书没签发；CAA 拦了 CA | 检查 CAA 是否允许 Cloudflare 的 CA；等待或重新添加 | `openssl s_client` |
| `github.io` 跳到主站 | GitHub Pages 还挂着自定义域名 | 在 GitHub Pages 设置里移除 | `curl -sI https://owner.github.io/repo/` |
| 备用站 404 | CNAME/项目路径不匹配，或没发布 | 检查 Pages 设置和已发布产物 | 直接访问 + `Server` 头 |
| 部署后还是旧内容 | 自定义域名上的 Cache Rule 或 Service Worker | 清 URL 缓存、收窄规则；升 SW 版本 | 无痕 + `curl -sI` |
| 上传失败 | 文件数 > 20,000 或单文件 > 25 MiB | 大文件放 R2，或裁剪产物 | `check-build.mjs` |
| Pages 构建超时 | 20 分钟限制、工具链太重 | 本地/CI 构建后 Direct Upload | 构建日志 |
| `wrangler deploy` 报名字不匹配 | 控制台 Worker 名 ≠ 配置里的 `name` | 两边改成一致 | 重新部署 |
| D1 查询一段时间后失败 | 日读写额度，或单库 500 MB 上限 | 加索引、批量、升级；看 metrics | D1 错误 + metrics |
| KV 读到旧值 | KV 最终一致（传播最长约 60 秒） | 不要用 KV 做写后读 | 等一会再读 |
| Actions 部署悄悄停了 | 公开仓库 60 天无活动，定时工作流被禁用 | 重新启用；每月检查一次 | `gh api .../actions/workflows` |
| 以后改不了 Pages Git 集成 | 项目是 Direct Upload 创建的 | 只能重建项目；Direct Upload 不可逆 | — |

## 1. 认证与权限

```bash
npx wrangler whoami
gh auth status
```

- Cloudflare 未登录：不要让用户在聊天里发 Token。让用户自己执行 `npx wrangler login`，或在本地/CI 设置 `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
- GitHub 未登录：只影响仓库/DNS 自动化，不影响 `wrangler` 部署。
- Git 集成需要 GitHub 仓库管理员权限，以及开通 Pages 的 Cloudflare 账号。

## 2. 构建产物

```bash
node "<技能目录>/scripts/check-build.mjs" --dir "<输出>" --spa
```

检查：

- 产物根目录有 `index.html`（SSR 除外）；
- 多页站有顶层 `404.html`；
- `_headers` / `_redirects` 在根目录；
- index 引用的资源都存在；
- 文件数和单文件大小；
- 产物里没有 `CNAME`、`.env`、`.git`。

输出目录错了，部署会成功，站点会 404。这是构建配置问题，不是 Cloudflare 问题。

## 3. SPA 与 404

缺 `404.html` 会让 Pages 对未知路径返回 `200` + `/`。这会掩盖坏链接，也可能给爬虫制造无限重复 URL。

- 多页站：保留 `404.html`。
- SPA：用明确的回退，但排除 `/api/*` 和静态目录。
- Workers：显式设置 `not_found_handling`，没有隐式 SPA 检测。

## 4. Base path

现象：页面能开，但 CSS/JS/图片 404；或链接指向 `/repo/...`。

- Vite：`base`
- Next：`basePath` / `assetPrefix`
- Vue CLI：`publicPath`
- Jekyll：`baseurl`
- Hugo：`baseURL`

改完重新构建，不要手改产物 HTML。

## 5. Headers 与 Redirects

- `_headers` / `_redirects` 从**产物根目录**读取，不是仓库根目录。
- `_headers` 规则是叠加的；重复的 `Cache-Control` 或 ACAO 是 bug。
- `_headers` / `_redirects` 不作用于 Functions 响应。
- `_redirects` 首个命中；静态规则必须在动态规则前面。
- 默认状态码 302；永久迁移写 301。

## 6. CORS

按顺序查：

1. 是否只有一个 `Access-Control-Allow-Origin`？
2. 是否是 `*` 同时配了 `Access-Control-Allow-Credentials: true`？无效。
3. 是否有 `Vary: Origin`？
4. `OPTIONS` 是否返回 200/204，且方法/头列表正确？
5. 错误响应是否也带 CORS 头？
6. 上游 API 是否又加了一套 CORS 头？

`curl` 不执行 CORS 判定，最终用浏览器确认。

## 7. 域名与 TLS

- 先在 Pages/Workers 添加域名，再去建 DNS 记录。
- Pages 的 apex 需要 zone 在 Cloudflare；子域可以用外部 CNAME。
- Workers 自定义域名要求 NS 在 Cloudflare。
- CAA 必须允许 Cloudflare 的 CA。
- DNS 改走再改回来，可能让自定义域名处于 inactive，直到重新激活；临时切走用重定向规则，不要改 DNS。

## 8. GitHub Pages 备用站

- `github.io` 301 到自定义域名 = GitHub 侧还挂着自定义域名。
- Actions 发布忽略 `CNAME`，要在 Settings 移除。
- 分支发布用 `CNAME`，确认删除 commit 进了发布分支。
- User site 的自定义域名会被 project sites 继承，移除会影响它们。

## 9. 缓存

- Pages 资源保留到下次部署；单 PoP TTL 约一周。
- 自定义域名上的 Cache Rule 可能在请求到 Pages 之前就返回旧内容。
- Service Worker 是第二层缓存；用无痕并升版本。
- 不要给非哈希文件名加 `immutable`。

## 10. 数据

- D1 日额度是硬失败；看 rows read/written。
- D1 Free 单库 500 MB；一个大表就能撞满。
- KV 最终一致，不要做计数器或写后读。
- R2 浏览器访问需要 CORS，以及 public bucket 或自定义域名。
- 生产迁移必须先备份并得到明确确认。

## 来源

- Pages 调试：https://developers.cloudflare.com/pages/configuration/debugging-pages/
- Pages 已知问题：https://developers.cloudflare.com/pages/platform/known-issues/
- Workers 限制：https://developers.cloudflare.com/workers/platform/limits/
- D1 限制：https://developers.cloudflare.com/d1/platform/limits/
