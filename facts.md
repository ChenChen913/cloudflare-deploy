# facts.md

> README 的唯一事实来源。A 部分由扫描生成；B 部分必须由项目作者确认。

## A. 可自动提取的事实

1. **项目类型**：Agent Skill + 零依赖 Node.js 脚本；不是 npm 包，没有 `package.json`，没有构建步骤。
2. **主语言 / 运行时**：文档为简体中文；脚本为 Node.js ESM，最低 Node 18，实际部署建议 Node 22+。
3. **安装命令**：没有包管理器安装。把技能目录复制或链接到技能目录，例如 Windows junction 或 macOS/Linux symlink；来源 `README.md` 安装段。
4. **运行命令**（README 中统一写成 `node "$SKILL_DIR/scripts/xxx.mjs"`；`SKILL_DIR` 指向本技能目录，命令在待部署项目目录运行）：
   - `node scripts/probe.mjs --repo "$PWD"`（来源 `SKILL.md` 第 0 步）
   - `node scripts/detect-project.mjs . --human`（来源 `SKILL.md` 第 1 步）
   - `node scripts/select-platform.mjs --project . --audience mainland --budget free --usage personal_noncommercial --existing none --human`（来源 `SKILL.md` 2.4；`--project` 已确认存在）
   - `node scripts/check-env.mjs`（来源 `SKILL.md` 第 4 步）
   - `node scripts/check-build.mjs --dir dist --mode static`（来源 `SKILL.md` 第 4 步）
   - `node scripts/verify-deployment.mjs --url https://example.com --mode static --json`（来源 `SKILL.md` 第 6 步）
   - `node scripts/migration-plan.mjs --source github-pages --target cloudflare-pages --project-type ssg --human`（来源 `SKILL.md` 6A）
5. **测试命令**：`node tests/run-tests.mjs`；结构自检 `node tests/check-skill.mjs`；可选浏览器差分 `node tests/browser-diff.mjs`。
6. **构建命令**：无；脚本直接运行，没有编译或打包步骤。
7. **目录结构**：
   - `scripts/` — 探针、识别、选型、矩阵、迁移、构建检查、HTTP 验收
   - `references/` — 平台能力、迁移、大陆访问、域名、付费、运行时、安全等资料
   - `templates/` — 部署计划、部署报告、迁移计划、迁移报告、Wrangler 模板
   - `tests/` — 自动化测试、结构自检、HTML5 oracle、回环 TLS 夹具
   - `deployment-notes/` — 真实项目部署记录与截图
8. **主要依赖**：无第三方运行期依赖；只使用 Node.js 内置模块。来源：`scripts/*.mjs` 的 import 列表。
9. **环境变量 / 配置项**：
   - `CLOUDFLARE_API_TOKEN` — CI 或非交互式部署认证；来源 `scripts/probe.mjs`、`scripts/check-env.mjs`。
   - `CLOUDFLARE_ACCOUNT_ID` — Cloudflare Account ID；来源同上。
   - `HTTPS_PROXY` / `NO_PROXY` — 链路探针的代理检查；来源 `scripts/probe.mjs`。
   - `PAGES_WRANGLER_MAJOR_VERSION` — Pages 项目设置里启用 Wrangler v4 文件数上限的证据；来源 `scripts/check-build.mjs`。
   - `NODE_EXTRA_CA_CERTS` — 测试子进程信任回环 TLS 证书；来源 `tests/run-tests.mjs`。
   - `CHROME_PATH` / `EDGE_PATH` — 可选浏览器差分；来源 `tests/browser-diff.mjs`。
   - 测试专用 `CF_FAKE_*`、`PROBE_CALL_LOG` 只用于假 wrangler / 探针夹具，不是用户配置。
10. **CLI 子命令 / 退出码**：
    - `probe.mjs`：0 ready / 1 limited / 2 blocked 或用法错误。
    - `select-platform.mjs`：0 有结论 / 1 信息不足或矩阵不可用 / 2 用法错误。
    - `check-env.mjs`：0 可部署 / 1 可构建不可部署 / 2 不可构建。
    - `check-build.mjs`：0 无阻断 / 1 有阻断；`ssr` 模式报 `skip`。
    - `verify-deployment.mjs`：0 通过 / 1 有失败 / 2 用法错误。
    - `migration-plan.mjs`：0 已生成计划 / 1 blocked 或矩阵不可用 / 2 用法错误。
11. **已有文档**：`README.md`、`README.en.md`、`SKILL.md`、`UPGRADE-PLAN.md`、`references/`、`templates/`、`tests/results.md`、`deployment-notes/`。
12. **可复核数字**：
    - 自动化测试：`node tests/run-tests.mjs` → 829/829。
    - 结构自检：`node tests/check-skill.mjs` → 通过；`SKILL.md` 400 行。
    - 平台矩阵：`node -e "const m=require('./references/platform-matrix.json'); console.log(m.platforms.length)"` → 10。
    - 核心平台：同一命令过滤 `core` → 5。
    - 脚本数量：`Get-ChildItem scripts/*.mjs | Measure-Object` → 14。
    - 参考资料数量：`Get-ChildItem references/* -File | Measure-Object` → 19。

## B. 作者确认（2026-11-20）

- **一句话描述**：先判断平台，再部署和验收。
- **为什么做这个项目**：减少选错平台和大陆访问风险；把原来的 Cloudflare 专用流程扩展成多平台决策与迁移流程。
- **目标用户 / 前置知识**：需要部署项目的开发者，以及安装和使用 Agent Skill 的作者 / 使用者；需要会运行 Node 命令、了解 Git 和基本 DNS。
- **与同类方案的差异**：先做四维适配度评估；Pages / Workers 与 Hobby / Pro 明确分开；商业用途限制单独判断；大陆风险标注证据等级；迁移状态区分 provided / inferred / verified；不宣称自动完成真实部署。
- **已知限制 / 明确不做的事**：不做真实多平台部署验证；不做大陆实测；不自动买域名、切 DNS、升级套餐或迁数据库；SSR / 全栈只覆盖识别、选型和部分 HTTP 验收；不读取密钥值。
- **演示素材**：终端实录 + Mermaid 流程图；不使用假截图。
- **目标读者画像**：有静态站 / SPA / SSG / SSR / 全栈项目，正在选平台或准备迁移，关心大陆访问和回滚的人。
- **期望读者读完能做什么**：能运行 probe / detect / select，读懂首选、备选、不推荐和风险提示，并知道下一步要人工确认什么。

## 核对记录

- [x] 命令来自 `SKILL.md` / `README.md`
- [x] 环境变量在脚本或测试中能搜到读取位置
- [x] 目录结构与实际一致
- [x] 数字附可复现命令
- [x] B 部分已由用户确认（2026-11-20）
