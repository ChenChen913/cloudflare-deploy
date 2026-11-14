# 跨系统差异：Windows / macOS / Linux

**结论先说：部署到 Cloudflare 的结果与操作系统无关；不同的是本机工具链、终端语法和登录方式。**

## 1. 官方支持范围

Wrangler 的系统要求（2026-11 官方文档）：

| 系统 | 支持范围 |
|---|---|
| Windows | **Windows 11**（Windows 10 不在官方支持范围） |
| macOS | **13.5+** |
| Linux | 需要 **glibc 2.35+** 的发行版 |

Node.js 分三档：本技能的脚本最低 **18**（零依赖 + 内置 fetch）；完整部署建议 **22+**（当前仍在维护的最老 LTS）；Wrangler 官方只支持 **Current / Active / Maintenance** 三个分支，Node 18/20 已 EOL，奇数版本（23/25）也已结束支持。

Windows 上如果只能用 PowerShell，Wrangler 命令本身可以跑；但本文的验证命令需要按第 3 节替换。

## 2. 登录方式按环境分

| 环境 | 推荐 | 原因 |
|---|---|---|
| Windows 桌面 | `npx wrangler login` | 自动打开默认浏览器，回调 `localhost:8976` |
| macOS 桌面 | `npx wrangler login` | 同上；凭证可存 Keychain |
| Linux 桌面 | `npx wrangler login` | 有浏览器即可 |
| 远程 SSH / 无桌面 Linux | `npx wrangler login --device --browser=false` | 不依赖 localhost 回调，终端给验证码 |
| Docker / 容器 | `--device`，或映射 8976 端口 + `--callback-host=0.0.0.0` | 默认回调在容器内不可达 |
| GitHub Codespaces | `--device` | 端口转发不一定覆盖 8976 |
| CI | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | 官方推荐，不需要交互 |

`--device` 的验证地址是 `https://dash.cloudflare.com/oauth2/device`，验证码 5 分钟内有效。需要较新的 Wrangler；如果命令不认识 `--device`，先升级 Wrangler，或直接用 API Token。

## 3. 终端语法差异

| 用途 | Git Bash / macOS / Linux | Windows PowerShell |
|---|---|---|
| HTTP 请求 | `curl -sI URL` | `curl.exe -sI URL`（写 `curl` 会走 `Invoke-WebRequest` 别名） |
| 过滤输出 | `grep -i pattern` | `Select-String -Pattern pattern` 或 `findstr /i pattern` |
| DNS A 记录 | `dig +short example.com A` | `Resolve-DnsName example.com -Type A` |
| DNS NS | `dig +short example.com NS` | `Resolve-DnsName example.com -Type NS` |
| TTL | `dig example.com` | `Resolve-DnsName example.com -Type A`（输出含 TTL） |
| 证书 | `openssl s_client -connect ...` | 用 Git Bash 的 `openssl` |
| 循环 | `for i in 1 2 3; do ...; done` | `foreach ($i in 1..3) { ... }` |
| 环境变量 | `export FOO=bar` | `$env:FOO = "bar"` |
| 判断命令存在 | `command -v wrangler` | `Get-Command wrangler` |

Windows 最省事的方案是安装 [Git for Windows](https://git-scm.com/download/win)，用 Git Bash 跑本文所有命令；`curl`、`openssl`、`grep`、`sed`、`awk` 都自带。

## 4. 路径与文件

| 问题 | 建议 |
|---|---|
| 路径分隔符 | Wrangler 配置里统一用 `/`，Windows 也认；不要写 `C:\...` 绝对路径 |
| 输出目录 | 用相对路径（`./dist`），在不同系统上都能复现 |
| 大小写 | Linux 区分大小写，Windows/macOS 默认不区分；`Logo.png` 和 `logo.png` 在 Linux 上会 404 |
| 换行符 | 仓库加 `.gitattributes`：`* text=auto eol=lf`，避免 CRLF 影响 shell 脚本 |
| 可执行权限 | 本文脚本用 `node xxx.mjs` 执行，不依赖 `chmod +x`，三个系统一致 |
| 软链接 | macOS/Linux 用 `ln -s`；Windows 用目录联接（junction）或直接复制 |
| 长路径 | Windows 开启长路径支持，避免深层 `node_modules` 报错 |
| 文件监听 | WSL 访问 `/mnt/c` 时文件监听较慢；项目放在 WSL 文件系统内更快 |

## 5. Node 版本管理

| 系统 | 常见方式 |
|---|---|
| Windows | `nvm-windows`、`fnm`、官方安装包 |
| macOS | `nvm`、`fnm`、Homebrew |
| Linux | `nvm`、`fnm`、发行版包管理器 |

项目里有 `.nvmrc` / `.node-version` 时优先按它来；Wrangler 只要求 Current/Active/Maintenance 分支，但项目构建工具可能要求更窄。

## 6. WSL

- WSL2 + Ubuntu 22.04+ 通常满足 glibc 2.35+，可以运行 Wrangler。
- 浏览器在 Windows 侧，WSL 里的 `wrangler login` 可能无法完成 localhost 回调；用 `--device`。
- 项目放在 `/mnt/c/...` 时 I/O 和文件监听较慢；需要频繁构建时放到 `~/projects`。
- 不要在 WSL 和 Windows 两边各装一套依赖后混用同一个 `node_modules`。

## 7. 容器与 CI

容器：

```bash
# 方案 A：设备码，最简单
npx wrangler login --device --browser=false

# 方案 B：映射回调端口
docker run -p 8976:8976 <image>
npx wrangler login --callback-host=0.0.0.0
```

CI：

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
npx wrangler deploy
```

CI 里不要跑 `wrangler login`；它是交互式 OAuth，不适合无头环境。

## 8. 技能目录的安装差异

| 系统 | 命令 |
|---|---|
| Windows | `New-Item -ItemType Junction -Path "$env:USERPROFILE\.workbuddy\skills\cloudflare-deploy" -Target "C:\path\to\cloudflare-deploy"` |
| macOS / Linux | `ln -s /path/to/cloudflare-deploy ~/.workbuddy/skills/cloudflare-deploy` |
| 无权限 | 直接复制目录；修改后重新复制 |

Windows 的 junction 不需要管理员权限；符号链接可能需要开发者模式。

## 9. 哪些差异不影响部署

- Cloudflare 侧的行为（Headers、Redirects、404/SPA、缓存、CORS）与本地系统无关。
- `wrangler pages deploy` / `wrangler deploy` 上传的是同一份产物；Windows 和 Linux 构建出的文件内容应一致（注意大小写和换行）。
- 真正的差异在：能否打开浏览器登录、shell 命令写法、路径大小写、换行符、文件权限。

## 来源

- Wrangler 系统要求：https://developers.cloudflare.com/workers/wrangler/install-and-update/
- Wrangler 登录 / `--device`：https://developers.cloudflare.com/workers/wrangler/commands/general/
- Git for Windows：https://git-scm.com/download/win
