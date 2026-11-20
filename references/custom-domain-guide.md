# 自定义域名购买与绑定

核实日期：2026-11-20。价格和促销会变，购买前复核注册商页面。

## 1. 先问三个问题

1. **主要面向海外还是中国大陆？**
   - 海外：Cloudflare Registrar（按成本价、DNS 集成）、Porkbun、Namecheap；NameSilo 价格透明、支持支付宝。
   - 中国大陆：腾讯云 / 阿里云购买；提醒解析到海外托管仍可能被限速，稳定大陆访问需要 ICP 备案。
2. **只买域名，还是需要邮箱 / 建站套餐？**
   - 只买域名本身。不要捆绑建站、邮箱、SSL；SSL 由托管平台免费提供。
3. **续费价和隐私保护？**
   - 注意首年低价、续费价；确认隐私保护是否免费。

## 2. 按目标平台绑定

| 目标平台 | 子域 | apex | 顺序 |
|---|---|---|---|
| GitHub Pages | CNAME 到 `<owner>.github.io` | A 记录；仓库内 CNAME 文件 | 先加域名，再改 DNS；启用 Enforce HTTPS |
| Cloudflare Pages | CNAME 到 `<project>.pages.dev` | apex 需 NS 在 Cloudflare | 先在 Pages 项目 Custom domains 添加，再改 DNS |
| Vercel | CNAME 到 Vercel 提示的目标 | A 记录或 nameserver | 按项目 Domains 提示；不要先删旧记录 |
| Netlify | CNAME 到 `<site>.netlify.app` | Netlify DNS / nameserver 或 A 记录 | 自动 TLS；先绑定再切换 |
| Render | CNAME 到 Render 提示的目标 | A 记录 | 按控制台提示；免费 Web Service 会休眠 |

## 3. 切换顺序

1. 提前 24–48 小时降低 TTL。
2. 在目标平台添加自定义域名。
3. 按目标平台提示修改 DNS。
4. 等待证书签发，验证 HTTPS。
5. 保留旧记录到观察期结束。

顺序反了容易出现 522、证书 pending 或流量中断。DNS 变更和域名绑定必须用户确认。

## 4. 常见误区

- “绑定自定义域名就稳定了。” 自定义域名只缓解默认域名被污染，不保证大陆稳定。
- “首年便宜就买。” 看续费价和转移政策。
- “SSL 要另买。” 主流托管平台都提供免费证书。
- “域名注册商必须等于托管商。” 不需要；DNS 可以放在任意支持 CNAME / A / nameserver 的提供商。
- “备案在海外平台也能做。” ICP 备案要求国内接入商和国内云资源，海外托管不适用。

## 5. 与其他文档的关系

- 大陆访问风险：`references/mainland-china-access.md`。
- 免费额度和付费升级：`references/advanced-needs.md`。
- 迁移时 DNS 切换：`references/cross-platform-migration.md`。
