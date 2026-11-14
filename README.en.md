# cloudflare-deploy

[简体中文](README.md) | **English**

A reusable Agent Skill for deploying GitHub projects to Cloudflare Pages or Workers: inspect the repo, choose the product, write a plan, build, deploy to a preview, verify with real HTTP requests, and report what was actually tested.

The skill body is written in Simplified Chinese. File names and code identifiers stay ASCII for cross-platform compatibility; JSON keys stay English so scripts remain machine-readable.

## Status

- Skill format validated (`quick_validate.py`): valid. Repository check `node tests/check-skill.mjs` also passes.
- Local tests: 56/56 passing (`node tests/run-tests.mjs`).
- Real Cloudflare deployment: **not run** here. No Cloudflare account/token, and Wrangler is not installed in this environment. See `tests/results.md` for what was and was not verified.

## What it does

1. **Detects** the framework, build command, output directory, base path, SPA/SSR/API type, GitHub Pages setup, existing Wrangler config, bindings, env keys, PWA, workspaces, lockfiles, and risk signals — tagging each key field `confirmed` / `inferred` / `unknown`.
2. **Proposes** Pages or Workers as candidates with a confidence level; DNS, deployment style, and future backend needs decide, not the framework name.
3. **Plans** the change, with explicit confirmation gates for DNS, custom domains, production secrets, databases, deletions, and irreversible config.
4. **Builds and checks** the artifact against Cloudflare limits for the declared site mode (`static` / `ssg` / `spa`).
5. **Deploys** to `pages.dev` / `workers.dev` or a preview branch.
6. **Verifies** root status, mode-appropriate 404/fallback behavior, assets, headers, canonical/noindex, CORS, backup independence, DNS, data, and performance as applicable.
7. **Reports** every check as pass/fail/warn/unverified. It does not claim a test that was not run.

## Structure

```text
cloudflare-deploy/
├── SKILL.md
├── README.md                 # Chinese (default on GitHub)
├── README.en.md              # English (this file)
├── references/
│   ├── prerequisites.md      # account, token, account ID, Node, Wrangler, R2
│   ├── console-paths.md      # dashboard paths after login
│   ├── cross-platform.md     # Windows / macOS / Linux / WSL / containers / CI
│   ├── platform-selection.md # Pages vs Workers, limits, pricing
│   ├── deployment-workflows.md
│   ├── pages-runtime.md      # headers, redirects, 404/SPA, cache, CORS
│   ├── github-pages-backup.md
│   ├── verification.md
│   ├── troubleshooting.md
│   ├── security.md
│   ├── seo-indexing.md
│   └── migration-guide.md    # phases + Jekyll case study with real data
├── scripts/
│   ├── detect-project.mjs
│   ├── check-env.mjs
│   ├── check-build.mjs
│   └── verify-deployment.mjs
├── templates/
│   ├── deployment-plan.md
│   ├── deployment-report.md
│   ├── wrangler.workers.jsonc
│   └── wrangler.pages.toml
└── tests/
    ├── run-tests.mjs
    ├── check-skill.mjs      # structure: frontmatter, referenced paths, absolute paths
    ├── last-run.txt         # latest test output
    └── results.md
```

## Prerequisites

| Requirement | Needed for | Check |
|---|---|---|
| Cloudflare account | Everything | Sign up at `dash.cloudflare.com`; verify email |
| Wrangler auth | Deploy | `npx wrangler whoami` |
| Account ID | API token / CI | Account Home → search "Copy account ID" |
| Node.js | 18+ for scripts; 22+ for deploys | `node -v` |
| Git | Repo operations | `git --version` |
| Domain / DNS | Custom domain only | NS location, CAA records |
| R2 subscription | R2 only | Storage & databases → R2 checkout |
| GitHub CLI | Optional automation | `gh auth status` |

Wrangler officially supports **Windows 11**, **macOS 13.5+**, and **Linux glibc 2.35+**. For remote SSH, containers, or Codespaces, use `npx wrangler login --device`; for CI, use `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. Details: `references/prerequisites.md` and `references/cross-platform.md`.

## Install

User-level skills directory:

```powershell
# Windows: junction, no admin required
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.workbuddy\skills\cloudflare-deploy" `
  -Target "C:\path\to\cloudflare-deploy"
```

```bash
# macOS / Linux
ln -s /path/to/cloudflare-deploy ~/.workbuddy/skills/cloudflare-deploy
```

If links are unavailable, copy the folder. Re-copy after edits.

## Usage

Trigger phrases include:

- "Deploy this GitHub project to Cloudflare."
- "Should this be Pages or Workers?"
- "Check the current Cloudflare deployment."
- "Keep GitHub Pages as a fallback."
- "Verify pages, routes, and assets after deploy."
- "Fix this failed Cloudflare deploy."

The agent runs `scripts/detect-project.mjs`, reads only the reference needed for the task, fills `templates/deployment-plan.md`, deploys to a preview, runs `scripts/verify-deployment.mjs`, and fills `templates/deployment-report.md`.

## Scripts

Dependency-free, read-only Node 18+ ESM (Node 22+ is still recommended for actual deploys):

```bash
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs
node scripts/check-build.mjs --dir dist --mode static   # or ssg / spa
node scripts/verify-deployment.mjs --url https://site.example.com --mode static --json
```

`--mode` decides the 404 verdict: `static`/`ssg` require a 404 for unknown paths; `spa` requires the app shell. Build check and verification must use the same value.

Backup site plus CORS on a separate API host:

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com \
  --mode static \
  --backup https://owner.github.io/repo/ \
  --origin https://app.example.com \
  --cors-url https://api.example.com/items \
  --json
```

## Tests

```bash
node tests/run-tests.mjs        # 56 checks: detection, artifacts, real HTTP
node tests/check-skill.mjs      # structure check, no external tooling
```

The runner creates eleven synthetic projects (Vite SPA, Jekyll, Vite+Supabase, Hono+D1, heavy Express, Next.js SSR, monorepo, multiple lockfiles, dynamic Vite config, multiple HTML entries, Pages Functions), asserts detector output and confidence levels, checks three artifacts (one of them twice, as static and as SPA), and runs the verifier against local HTTP servers — covering HEAD 405 falling back to GET, SPA vs static 404 semantics, a separate CORS host, duplicate canonical tags, and a backup that 301s to the main site.

These tests prove the scripts work. They do not prove account permissions, DNS, TLS, or platform behavior.

## Design rules

- Progressive disclosure: `SKILL.md` has routing, workflow, and safety gates; details live in `references/`.
- One topic per reference; no duplicated platform explanations.
- Detection is layered: `confirmed` / `inferred` / `unknown`; the target is a candidate, not a verdict.
- One `--mode` is threaded through build check and verification, so 404 verdicts cannot contradict each other.
- Scripts are deterministic and print JSON; human summaries on demand.
- No empty directories or placeholder assets.
- Every report distinguishes verified, failed, and unverified.

## Limitations

- Cannot create a Cloudflare account or complete OAuth for the user.
- Cannot connect Git integration / Workers Builds through the CLI; that is a dashboard/API step.
- DNS, custom domains, production secrets, database migration, and deletions require explicit confirmation.
- No real deployment was performed in this build environment.
