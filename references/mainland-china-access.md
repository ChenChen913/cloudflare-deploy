# 中国大陆访问风险

核实日期：2026-11-20。默认域名的可达性会随网络、时间和政策变化；本文是决策提示，不是可用性保证。

## 1. 证据标注

| 标注 | 含义 |
|---|---|
| 官方 | 平台文档或定价页明确写出 |
| 需求方资料 | 本次升级提供的 2026 资料 |
| 实测 | 某个日期、某个网络下实际观察到的 |
| 待验证 | 没有实测，或平台没有承诺 |

## 2. 默认域名表现

| 平台 | 默认域名 | 中国大陆访问风险 | 自定义域名能否改善 |
|---|---|---|---|
| Vercel | `*.vercel.app` | 已被 DNS 污染，直接访问通常超时 | 可能改善，但 Vercel 官方不保证中国大陆可用性或性能 |
| GitHub Pages | `*.github.io` | 访问不稳定，部分网络环境不可达 | 可能改善，但不保证 |
| Netlify | `*.netlify.app` | 常无法直接访问 | 可能改善，但不保证 |
| Cloudflare Pages | `*.pages.dev` | 通常可达性更好，但不是中国大陆合规托管 | 可能改善，但不保证 |
| Render | `*.onrender.com` | 未实测，按海外托管默认风险处理 | 未验证 |
| Railway / Fly.io | 平台默认域名 | 未实测 | 未验证 |

不要把“某次能打开”写成“稳定可用”。同一个域名在不同运营商、不同省份、不同时间段可能表现不同。

## 3. 硬提示（目标用户含大陆或未明确时必须输出）

只要目标用户地域包含中国大陆，或用户未明确说“只面向海外”，选型结果必须附带以下提示，不得折叠、省略或只放到报告末尾：

- Vercel 的 `*.vercel.app` 默认域名在中国大陆已被 DNS 污染，直接访问通常超时；绑定自定义域名可能改善，但 Vercel 官方明确不保证中国大陆的可用性或性能。
- GitHub Pages 的 `*.github.io` 在中国大陆访问不稳定，部分网络环境不可达。
- Netlify 的 `*.netlify.app` 同样常无法直接访问。
- Cloudflare Pages 的 `*.pages.dev` 通常可达性更好，但也不是中国大陆合规托管。
- 换自定义域名只能缓解，不能保证稳定；稳定大陆访问需要 ICP 备案 + 国内云 / CDN。

## 4. 两条路线

### 路线 A：海外托管 + 自定义域名

适合：主要用户仍在海外，或大陆用户只是少量、可以接受偶尔不可用。

做法：

1. 选一个默认域名风险相对低的平台，Cloudflare Pages 通常比 Vercel / GitHub Pages / Netlify 默认域名更稳。
2. 绑定自定义域名，启用 HTTPS。
3. 把关键静态资源自托管，减少对 Google Fonts、第三方 CDN、境外统计脚本的依赖。
4. 准备降级方案：关键页面有镜像或备用入口；监控大陆用户的可达性反馈。

必须承认的代价：

- 仍可能被限速、阻断或出现高延迟。
- 自定义域名只缓解默认域名被污染的问题，不改变海外托管在中国大陆的不确定性。
- 不能承诺 SLA。

### 路线 B：ICP 备案 + 国内云 / CDN

适合：大陆用户为主，或业务依赖稳定的大陆访问。

做法：

1. 购买国内云服务器、对象存储或静态托管。
2. 完成 ICP 备案；域名解析到国内云 / CDN。
3. 按国内云的要求做实名、内容合规和安全组配置。
4. 海外用户如果也需要访问，可以保留海外站，或使用 CDN 的多区域能力。

代价：

- 备案需要时间和材料。
- 国内云有实名、内容审核和合规要求。
- 迁移成本和运维责任高于海外静态托管。

## 5. 怎么验证，而不是猜

只读检查，不修改 DNS：

```powershell
# Windows：看解析和状态码（把 URL 换成实际地址）
Resolve-DnsName example.com -Type A
curl.exe -sS -o NUL -w "%{http_code} %{time_total}s`n" https://example.com/
```

```bash
# macOS / Linux
dig +short example.com
curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" https://example.com/
```

更可靠的验证方式：

- 让真实的大陆用户在电信、联通、移动网络各测一次。
- 用多个第三方探测点，记录时间、地区、运营商、状态码和耗时。
- 观察 Search Console / 统计里的地区流量和错误率。
- 不要用一次 `curl` 200 代表“大陆稳定可用”。

## 6. 报告写法

目标用户含大陆时，报告单独用一节“中国大陆访问风险与建议”，至少包含：

1. 默认域名风险：点名 Vercel / GitHub Pages / Netlify / Cloudflare Pages。
2. 是否绑定自定义域名，绑定了哪个域名。
3. 选择路线 A 还是路线 B，以及理由。
4. 已验证的内容和未验证的内容。
5. 不承诺“稳定大陆访问”，除非已经走备案 + 国内云并有实测证据。

## 7. 不要说的话

- “绑定自定义域名就没事了。”
- “Cloudflare Pages 是大陆合规托管。”
- “我这边能打开，所以大陆都能打开。”
- “用了 CDN 就一定稳定。”
- “Vercel 官方保证中国大陆访问。”

## 8. 来源

- Vercel Domains / 中国大陆访问说明：https://vercel.com/docs/domains
- GitHub Pages 文档：https://docs.github.com/en/pages
- Netlify 文档：https://docs.netlify.com/
- Cloudflare Pages 文档：https://developers.cloudflare.com/pages/
- 中国大陆 ICP 备案说明（工信部）：https://beian.miit.gov.cn/
