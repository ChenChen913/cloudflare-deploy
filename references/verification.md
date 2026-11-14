# 验收

验收只回答一件事：**我们实际观察到了什么？** 状态码是证据，部署命令的退出码不是。

## 1. 按项目类型选检查项

| 检查 | 纯静态 | SPA | Jekyll/博客 | 静态 + Supabase | API + 数据库 |
|---|---|---|---|---|---|
| 首页 200 + 标题 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 未知路径 404 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 同源资源 | 必须 | 必须 | 必须 | 必须 | 必须 |
| SPA 深链 + 刷新 | — | 必须 | — | 必须 | — |
| 旧 `.html` 链接 | — | — | 必须 | — | — |
| `_headers` / `_redirects` 生效 | 用了就查 | 用了就查 | 用了就查 | 用了就查 | 用了就查 |
| API 状态/JSON | — | — | — | 只读 | 必须 |
| CORS + 凭证 | — | — | — | 必须 | 必须 |
| 登录/会话 | — | — | — | 必须 | 必须 |
| 数据库读写 | — | — | — | — | 必须 |
| PWA 安装/离线 | — | 有 PWA 就查 | 有 PWA 就查 | 有 PWA 就查 | — |
| 备用站独立性 | 用户要求就查 | 同左 | 同左 | 同左 | 同左 |
| canonical/noindex | 公开站就查 | 同左 | 同左 | 同左 | 同左 |

纯静态站不要跑数据库测试。项目没有 manifest / service worker，就不要声称验证了 PWA。

## 2. 自动基线

```bash
node "<技能目录>/scripts/verify-deployment.mjs" --url "<地址>" --json
```

带备用站和 CORS：

```bash
node "<技能目录>/scripts/verify-deployment.mjs" \
  --url "https://site.example.com" \
  --backup "https://owner.github.io/repo/" \
  --origin "https://app.example.com" \
  --json
```

脚本输出 `pass`、`warn`、`fail`、`skip`。`fail` 是阻断项；`warn` 要读清楚再决定是否接受。

## 3. 脚本做不到的人工检查

### 3.1 SPA 深链

新标签页直接打开子路由，刷新，再用浏览器前进/后退。不能只看地址栏，要确认标题和主内容都变了。

### 3.2 Service Worker / PWA

用全新配置或无痕窗口：

1. 首次访问：SW 注册；
2. 刷新：页面受 SW 控制；
3. 跳到子页：没有变成首页；
4. 断网：有合理的离线页；
5. 发新版本：旧缓存没有一直生效。

### 3.3 登录与 Cookie

- 登录、刷新、退出、再刷新；
- 未登录访问受保护页面；
- 检查 `Domain`、`Path`、`SameSite`、`Secure`；
- 跨站 Cookie 需要 `SameSite=None; Secure`，并且要接受浏览器对第三方 Cookie 的限制。

### 3.4 API

- 状态码、Content-Type、JSON 结构；
- 超时和错误响应；
- 旧客户端兼容；
- CORS 预检（`OPTIONS`）和带凭证请求；
- 响应体里没有密钥。

## 4. 怎么读 HTTP 证据

### 状态码

- `/` 至少 200。
- 未知路径必须 404。返回 200 说明 SPA 回退或 rewrite 把所有路径都吞了。
- Pages 上 `/index.html` 跳 `/`（301/308）是正常的。
- 自定义域名 5xx、但 `pages.dev` 正常，通常是 DNS/证书/zone 配置，不是构建。

### 响应头

```bash
curl -sI https://site.example.com/ | grep -iE 'server|cache-control|x-robots-tag|strict-transport|x-frame|content-security|referrer'
```

- `Server: cloudflare` 说明请求到了 Cloudflare。
- 有自定义域名时，`pages.dev` 上的 `X-Robots-Tag: noindex` 是预期。
- 缺安全头是警告，不是部署失败。
- `Cache-Control: max-age=0, must-revalidate` 是 Pages 默认；非哈希资源配长缓存是 bug。

### Canonical

```bash
curl -s https://site.example.com/ | grep -io '<link[^>]*canonical[^>]*>'
```

- 主站：只有一个 canonical，指向自己。
- 备用站：要么 `noindex`，要么 canonical 指主站，不能同时。
- 两个 self-canonical 主机 = 两个规范地址。改策略，不是改标签。

Search Console 的“网址检查”才能看到 Google 实际选择的 canonical。没人检查之前，标为未验证。

### CORS

```bash
# 简单请求
curl -sI -H 'Origin: https://app.example.com' https://site.example.com/data.json \
  | grep -iE 'access-control-|vary'

# ACAO 值数量，必须是 1
curl -sI -H 'Origin: https://app.example.com' https://site.example.com/data.json \
  | grep -ci '^access-control-allow-origin:'

# 预检
curl -s -o /dev/null -D - -X OPTIONS \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,authorization' \
  https://api.example.com/items
```

`curl` 只显示头，不执行浏览器的 CORS 判定。最终以 DevTools → Network 的失败请求和 Console 报错为准。

### DNS

```bash
dig +short example.com A
dig +short example.com NS
dig @1.1.1.1 +short example.com
dig @8.8.8.8 +short example.com
```

PowerShell：

```powershell
Resolve-DnsName example.com -Type A
Resolve-DnsName example.com -Type NS
```

证书：

```bash
openssl s_client -connect example.com:443 -servername example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

### 备用站

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://owner.github.io/repo/
curl -sIL https://owner.github.io/repo/ | grep -i '^location' || echo "no redirect"
curl -sI https://owner.github.io/repo/ | grep -i '^server'
```

期望 `200`、没有指向主站的 `Location`、`Server: GitHub.com`。301 到自定义域名 = 备用站不独立。

### 数据

先比数量，再比指纹，再抽样：

```sql
SELECT COUNT(*) FROM users;
SELECT COUNT(*), SUM(LENGTH(COALESCE(name,''))) FROM users;
SELECT id, name, email, created_at FROM users ORDER BY id LIMIT 20 OFFSET 1000;
```

然后写一次：插入 → 读 → 更新 → 删除。检查自增 ID、唯一索引、时间戳/时区、布尔值、`NULL` 与空字符串。

### 性能

```bash
for i in 1 2 3 4 5; do
  curl --noproxy '*' -s -o /dev/null -w '%{time_starttransfer}\n' https://site.example.com/
done | sort -n | sed -n '3p'
```

记录 TTFB 中位数、LCP、首屏请求数、总传输。比较时同一网络、同一时段、同一视口。单次 Lighthouse 分数不是对比。

### 部署链路

```bash
gh run list --workflow=deploy.yml --limit 5
gh api repos/{owner}/{repo}/actions/workflows --jq '.workflows[] | {name, state}'
git log -1 --format='commit: %cI'
```

- 最近一次成功部署的时间必须 ≥ 最近一次内容提交。
- `state` 必须是 `active`；`disabled_inactivity` 表示公开仓库 60 天无活动后定时工作流被禁用。
- 定时任务要覆盖安装 + 构建，不能只 ping URL。

## 5. 报告规则

- 每项写 `通过`、`失败`、`警告` 或 `未验证`。
- `未验证` 要写原因（没账号、没数据库权限、用户拒绝、超出范围）。
- 只看了响应头，不能写“CORS 正常”。
- 只看了 DNS，不能写“备用站正常”。
- 写清楚实际测试的 URL。预览地址不是生产地址。
