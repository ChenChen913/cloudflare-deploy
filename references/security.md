# 安全与供应链

部署把代码执行从一台机器搬到了 CI 和云账号。新增攻击面是：凭证、第三方 Action、预览地址、构建依赖。

## 1. Cloudflare 凭证

- 用 **API Token**，不要用 Global API Key。
- 最小权限：只给需要的账号和产品（Pages:Edit / Workers Scripts:Edit，按需 KV/D1/R2:Edit）。不要顺手给 Zone:Edit。
- 一个环境一个 Token；CI 只给部署 job，不给构建 job。
- 放 GitHub **environment secret**，不要放仓库级 secret。
- 定期轮换；怀疑泄漏立即撤销。

```bash
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
npx wrangler whoami
```

不要打印 Token 值。`wrangler whoami` 显示账号，不显示密钥。

## 2. GitHub Actions 权限

在 workflow 或 job 上声明最小权限：

```yaml
permissions:
  contents: read
  pages: write       # 只有 Pages 部署需要
  id-token: write    # deploy-pages 的 OIDC 需要
```

Workers 部署通常 `contents: read` 就够。

避免：

- `permissions: write-all`
- `pull_request_target` + checkout PR 代码（fork PR 能拿到 secrets 和写权限）
- 任何分支都能部署生产，且没有环境保护规则

给 `github-pages` environment 加保护规则，只允许默认分支部署生产。

## 3. 第三方 Action 固定版本

`uses: actions/checkout@v4` 指向一个可移动 tag。固定到完整 SHA：

```yaml
- uses: actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955 # v4.3.0
```

- 优先用官方（`actions/*`）或审计过的 Action。
- 用 Dependabot 的 `github-actions` 生态提 PR，不要手动改 tag。
- 检查 `run:` 里有没有 `curl ... | bash` 这种直接执行远程脚本的步骤。

## 4. 密钥

- 仓库级 secret 对所有 workflow 可见；部署凭证用 **environment secret**。
- secret 写入后不能读回；删 commit 不能从历史里移除。**先轮换**。
- `echo`、`set -x`、错误堆栈都可能泄漏；GitHub 的掩码不是万能的（base64、拼接可绕过）。
- 不要提交 `.env`、`.dev.vars`、`node_modules/.cache/wrangler`，或含 Token 的 `cloudflare.config.ts`。
- 构建期变量会进入产物；产物公开，就等于值公开。

## 5. 预览部署

- `https://<hash>.<project>.pages.dev` 默认公开。
- 含后台、测试数据、未发布内容的预览，用 Cloudflare Access 保护。
- `X-Robots-Tag: noindex` 不是访问控制。
- 预览不要连生产数据库。

## 6. 构建供应链

- 有锁文件时用 `npm ci`，不要 `npm install`。
- 提交锁文件。
- 固定运行时（`actions/setup-node` 指定大版本；不要依赖 runner 默认值）。
- Python 用 hash 固定的 requirements。PyPI 重新打包 sdist 会让旧 hash 失效；过渡期保留两个 hash。
- 不要把依赖升级和平台迁移放在同一个 PR。

## 7. 凭证泄漏后的顺序

1. **先撤销/轮换**。
2. 查 Cloudflare Audit Log 和 GitHub Security Log，确认有没有被使用。
3. 看有没有新建 Token、部署、成员、DNS 记录。
4. 再清理历史（`git filter-repo`），并通知所有协作者重新 clone。
5. 复盘：为什么凭证会在那里，是流程问题还是权限过大。

## 检查清单

- [ ] API Token 限定单账号、最小产品权限
- [ ] Token 放 environment secret，不放仓库 secret
- [ ] workflow 显式声明 `permissions`
- [ ] 第三方 Action 固定到 SHA
- [ ] 没有 `pull_request_target` + PR 代码 checkout
- [ ] 生产部署有环境保护规则
- [ ] 预览有保护，或明确接受公开
- [ ] 产物和报告里没有密钥
- [ ] 锁文件已提交并在 CI 使用
- [ ] 轮换路径有记录

## 来源

- GitHub Actions 安全加固：https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Cloudflare API Token：https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
- Cloudflare Access：https://developers.cloudflare.com/cloudflare-one/applications/
