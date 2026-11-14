# 前提条件

这份技能能跑起来，取决于本机工具链和 Cloudflare 账号状态。缺什么就明确说，不要假设。

## 1. Cloudflare 账号

- 注册地址：`https://dash.cloudflare.com/sign-up`
- 需要：邮箱、密码、邮箱验证。官方注册流程没有要求绑定支付方式。
- 免费计划可以创建 Pages、Workers，并使用各自的免费额度。
- 以下情况需要付款方式或订阅：
  - 升级 Workers Paid（$5/月/账号）
  - 使用 R2（首次要在控制台走一次 checkout，免费额度也需开通）
  - 超出免费额度后继续使用计量产品

检查是否已登录：

```bash
npx wrangler whoami
```

输出会显示账号邮箱和账号 ID。未登录时以非零状态退出。

## 2. 登录方式：三选一

| 场景 | 命令 | 说明 |
|---|---|---|
| 本地桌面 | `npx wrangler login` | 默认自动打开浏览器，OAuth 回调 `localhost:8976` |
| 只想复制链接 | `npx wrangler login --browser=false` | 不自动开浏览器，打印链接 |
| 远程 SSH / 容器 / Codespaces | `npx wrangler login --device` | 使用 OAuth Device Grant，不依赖 localhost 回调；终端会给一个验证码 |
| CI / 完全无头 | 不登录，设置 `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | 官方推荐做法 |

`--device` 仍然会尝试打开浏览器；在纯终端环境加 `--browser=false`。设备码 5 分钟内有效。

容器里如果坚持用回调流程，需要把宿主机的 8976 映射到容器，并加 `--callback-host=0.0.0.0`；否则用 `--device` 更简单。

## 3. API Token

创建路径：

1. 登录控制台
2. **My Profile → API Tokens → Create Token**（直接打开 `https://dash.cloudflare.com/profile/api-tokens`）
3. 选模板或从空白开始
4. 设置权限、账号范围、有效期
5. 创建后**只显示一次**，立即保存到密码管理器或 CI secret

部署所需的最小权限（按实际用到的产品勾选）：

| 产品 | 权限 |
|---|---|
| Pages | Account → Cloudflare Pages → Edit |
| Workers | Account → Workers Scripts → Edit |
| KV（如使用） | Account → Workers KV Storage → Edit |
| D1（如使用） | Account → D1 → Edit |
| R2（如使用） | Account → R2 → Edit |
| 自定义域名自动化（可选） | Zone → DNS → Edit；Zone → Zone → Read |

不要用 Global API Key。不要把 Token 写进 `wrangler.toml`、`.env`、仓库或聊天记录。

验证 Token：

```bash
curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
```

返回 `"status": "active"` 才算有效。

## 4. Account ID

三个入口，任选：

- Account Home → 搜索 `Copy account ID` → 选择结果
- Workers & Pages → 页面底部 **Account Details** → Account ID 旁的复制按钮
- 域名 Overview → 页面底部 **API** 区域 → Account ID

CI 里设置：

```bash
export CLOUDFLARE_ACCOUNT_ID="..."
export CLOUDFLARE_API_TOKEN="..."
```

## 5. 本机工具

| 工具 | 要求 | 检查 |
|---|---|---|
| Node.js | 脚本最低 18；部署建议 22+（Wrangler 只支持 Current / Active / Maintenance） | `node -v` |
| Wrangler | 项目内安装或用 `npx wrangler` | `npx wrangler --version` |
| Git | 任意较新版本 | `git --version` |
| GitHub CLI | 可选，仓库自动化才需要 | `gh --version` / `gh auth status` |

Wrangler 的系统要求（官方）：

- macOS **13.5+**
- Windows **11**
- Linux，glibc **2.35+**

Windows 10 不在官方支持范围内。WSL2 的 Ubuntu 22.04+ 通常满足 glibc 要求，但浏览器登录回调可能不通，优先用 `--device` 或 Token。

安装 Wrangler 的推荐方式是项目内安装：

```bash
npm i -D wrangler@latest
npx wrangler --version
```

不想改 `package.json` 时，直接 `npx wrangler@latest ...`。

## 6. 域名与 DNS

只有绑定自定义域名时才需要：

- **Pages + apex 域名**：域名的 NS 必须在 Cloudflare（作为 zone 接入）。
- **Pages + 子域名**：可以在外部 DNS 建一条 CNAME 指向 `<project>.pages.dev`；但必须先在 Pages 项目里添加域名，再去加 CNAME，否则 522。
- **Workers + 任意自定义域名**：域名的 NS 必须在 Cloudflare。
- 如果域名有 CAA 记录，确认允许 Cloudflare 的 CA 签发证书。

## 7. GitHub 侧

- 仓库读权限（公开仓库不需要额外授权）。
- Git 集成 / Workers Builds 需要仓库管理员在 Cloudflare 控制台完成授权；CLI 不能替代。
- 如果技能要代你创建仓库或改 DNS，才需要 GitHub CLI 登录或额外的 Token。

## 8. 缺条件时的处理

| 缺什么 | 技能应该怎么做 |
|---|---|
| 没账号 | 给注册链接和步骤，停止部署 |
| 没登录 | 给对应系统的 `login` 命令，停止部署 |
| 没 Token / Account ID | 给创建路径和权限表，停止 CI 部署 |
| 没域名 | 先部署到 `pages.dev` / `workers.dev`，不要阻塞 |
| 没 R2 订阅 | 如果项目不需要 R2，跳过；需要就先开通 |
| 没 Git 集成权限 | 用 Direct Upload / `wrangler deploy` 先完成预览，再让管理员接 Git |

## 来源

- 创建账号：https://developers.cloudflare.com/fundamentals/account/create-account/
- 创建 API Token：https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- 查找 Account ID：https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/
- Wrangler 登录与无头：https://developers.cloudflare.com/workers/wrangler/commands/general/
- Wrangler 系统要求：https://developers.cloudflare.com/workers/wrangler/install-and-update/
- R2 开通：https://developers.cloudflare.com/r2/get-started/
