# Pages 运行时：响应头、重定向、404、缓存、CORS

这些是平台行为，不是偏好。核实日期 2026-11-14。

## 1. 默认响应头

Pages 给静态资源加这些头：

| 响应头 | 值 |
|---|---|
| `Access-Control-Allow-Origin` | `*` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Type` | 按文件推断 |
| `Etag` | 200 响应 |
| `Server` | `cloudflare` |
| `Cf-Ray` | 请求 ID |

条件性添加：

- 资源被压缩：`Cache-Control: no-transform` + `Content-Encoding`
- 可缓存请求（不带 `Authorization` / `Range`）：`Cache-Control: public, max-age=0, must-revalidate`
- 预览 URL：`X-Robots-Tag: noindex`

默认没有：HSTS、`X-Frame-Options`、`Permissions-Policy`、CSP。需要就自己在 `_headers` 里配。

## 2. 干净 URL：`.html` 会被重定向

- `/contact.html` → 重定向到 `/contact`
- `/about/index.html` → 重定向到 `/about/`
- 官方只写 “redirect”；实测状态码是 **308**，query 参数保留。

后果：内链写死 `.html`，在 Cloudflare 上每次多一跳。GitHub Pages 不会把 `about.html` 解析成 `/about`，所以双站通常保留 `.html` 内链、接受 308。不要为了省这一跳，给同一内容再做一条 200 rewrite——那会制造两个可索引地址。

`_redirects` 能否显式覆盖内置 308，本文未验证；要依赖这个行为，先自己测。

## 3. 404 与被当成 SPA

- Pages 从请求路径向上找最近的 `404.html`。
- **没有顶层 `404.html` 时，按 Cloudflare 官方 [Serving Pages](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering) 文档：Pages 把项目当成 SPA**，未匹配路径返回 `/`（官方未写明状态码，实际回退通常 200）。HashRouter 不需要这个回退，建议 static + 顶层 404.html；BrowserRouter/history 路由才需要显式 SPA 回退。默认回退对**缺失的静态资源路径**也会返回 HTML 200，因此“资源 404”不能只看状态码，要看 content-type/内容。

这是最常见的静默故障。永远探一下：

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://site.example.com/__missing__
```

期望 `404`。返回 `200` 说明整站被当成了 SPA。

## 4. 缓存

- 默认 `max-age=0, must-revalidate` + ETag，浏览器会协商，通常拿 304。
- 资源在 CDN 上保留到下次部署；单个数据中心 TTL 约一周，也可能提前消失。
- 官方建议多数情况不要自定义缓存。自定义域名上的 Cache Rule 在 Pages 前面，部署后可能继续发旧内容，也可能干扰重定向/Functions。
- 只给带内容哈希的文件名加长缓存（`app.a1b2c3.js`）：`max-age=31556952, immutable`。

## 5. `_headers`

规则是**叠加**，不是首个命中。所有匹配的块都会应用。

```text
/*
  X-Frame-Options: SAMEORIGIN

/assets/*
  Cache-Control: public, max-age=31536000
```

`/assets/a.png` 同时拿到两个头。

同一个头被设置两次，值用逗号连接：

```text
Cache-Control: public, max-age=604800, public, max-age=0, s-maxage=86400
```

对 `Cache-Control` 这是冲突（RFC 9111 说取第一个值或视为过期）。对 `Access-Control-Allow-Origin` 这是无效值：浏览器不接受多个来源。

用 `!` 先 detach，再设想要的值：

```text
/*
  ! Access-Control-Allow-Origin
  Access-Control-Allow-Origin: https://app.example.com
  Vary: Origin

/assets/*
  Cache-Control: public, max-age=0, s-maxage=86400

/assets/model.bin
  ! Cache-Control
  Cache-Control: public, max-age=604800
```

顺序有讲究：`!` 只能删掉前面规则（和默认头）已经加上的东西。窄规则写在宽规则后面。

限制：

- 100 条规则；每行 2,000 字符（含空格）。
- 一个 `*` splat；每个 `:placeholder` 只能引用一次。
- `_headers` 本身在 Cloudflare 上不会被当静态文件提供。
- **`_headers` 不作用于 Pages Functions 的响应。**
- 如果 `_headers` 被提交并部署到 GitHub Pages，它在那里就是普通可下载文件。含内部注释时不要放进 GitHub 产物。

## 6. `_redirects`

**首个命中生效。** 同一个 source 有多条规则时，最上面的赢。

```text
/old-page            /new-page                301
/blog/:year/:slug    /posts/:year/:slug       301
/legacy/*            /archive/:splat          301
/app/*               /app/index.html          200
```

- 2,000 条静态 + 100 条动态；每行 1,000 字符。
- 静态规则必须写在动态规则前面。
- 默认状态码 **302**；永久迁移要显式写 `301`。
- 支持 301/302/303/307/308；不支持按国家、语言、Cookie 条件跳转。
- proxy（200）只应用第一条：`/a /b 200` + `/b /c 200`，请求 `/a` 只渲染 `/b`，不会继续到 `/c`。
- 不支持代理外部域名。
- proxy 会制造重复内容；真要用，在 `_headers` 里补 `Link: <规范地址>; rel="canonical"`。
- **`_redirects` 不作用于 Pages Functions 的响应。**

## 7. CORS

### 静态资源

Pages 默认 `Access-Control-Allow-Origin: *`。任何站点都能 `fetch()` 你的静态 JSON、字体、图片、wasm。它不带凭证。

收紧：

```text
/data/*
  ! Access-Control-Allow-Origin
  Access-Control-Allow-Origin: https://app.example.com
  Vary: Origin
```

验证只有一个 ACAO 值。多个值无效。

### 带凭证

跨源请求要带 Cookie 或 `Authorization` 时：

- `Access-Control-Allow-Origin` 必须是具体来源，不能是 `*`。
- `Access-Control-Allow-Credentials: true`。
- `Vary: Origin`。
- 前端 `credentials: "include"`。
- Cookie 在跨站场景要 `SameSite=None; Secure`。
- `*` + 凭证会被浏览器拒绝：`Allow-Methods` / `Allow-Headers` 的 `*` 也只在**无凭据**请求里是通配符，带凭据时必须像下面示例那样显式列出；`Authorization` / `Range` 是 non-wildcard header，任何情况下都不被 `*` 覆盖。
- `GET` / `HEAD` / `POST` 是 CORS-safelisted method，不要求列在 `Allow-Methods` 里；其他方法必须显式列出，且方法名大小写敏感。

### Pages Functions

`_headers` / `_redirects` 不生效。必须在函数响应里返回 CORS 头，包括 `OPTIONS`：

```ts
const ALLOWED = new Set(["https://app.example.com"]);

function cors(origin: string): Headers {
  const h = new Headers({
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (ALLOWED.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
    h.set("Access-Control-Allow-Credentials", "true");
  }
  return h;
}

export const onRequest: PagesFunction = async (ctx) => {
  const corsHeaders = cors(ctx.request.headers.get("Origin") ?? "");
  if (ctx.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  const res = await ctx.next();
  const out = new Response(res.body, res);
  corsHeaders.forEach((v, k) => out.headers.set(k, v));
  return out;
};
```

如果函数反向代理的上游 API 自己也返回 CORS 头，先删掉上游的再加自己的，否则会出现重复值。错误响应也要带 CORS 头，否则浏览器只报 CORS 错误，看不到真正的 500。

## 8. Workers 静态资源的差异

- `_headers` / `_redirects` 在静态资源目录里可用。
- 路由是显式的：`assets.not_found_handling` 取 `"404-page"` 或 `"single-page-application"`。
- 只有没有匹配到静态资源时才跑 Worker 代码，除非设置 `run_worker_first`。
- 只有 Worker 需要读取静态资源时才需要 `assets.binding`。
- `npx wrangler dev` 端口 8787；`wrangler pages dev` 是 8788。
- 静态资源请求免费；触发 Worker 的请求按 Workers 计费。

## 来源

- Serving Pages：https://developers.cloudflare.com/pages/configuration/serving-pages/
- Headers：https://developers.cloudflare.com/pages/configuration/headers/
- Redirects：https://developers.cloudflare.com/pages/configuration/redirects/
- Workers Static Assets：https://developers.cloudflare.com/workers/static-assets/
- MDN CORS：https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS
