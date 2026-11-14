# cloudflare-deploy

A reusable Agent Skill for deploying GitHub projects to Cloudflare Pages or Workers: inspect the repo, choose the product, write a plan, build, deploy to a preview, verify with real HTTP requests, and report what was actually tested.

The skill body is written in Simplified Chinese. File names and code identifiers stay ASCII for cross-platform compatibility; JSON keys stay English so scripts remain machine-readable.

## Status

- Skill format validated (`quick_validate.py`): valid.
- Local tests: 23/23 passing (`node tests/run-tests.mjs`).
- Real Cloudflare deployment: **not run** here. No Cloudflare account/token, and Wrangler is not installed in this environment. See `tests/results.md` for what was and was not verified.

## What it does

1. **Detects** the framework, build command, output directory, base path, SPA/SSR/API type, GitHub Pages setup, existing Wrangler config, bindings, env keys, PWA, and risk signals.
2. **Chooses** Pages or Workers from evidence, not from a fixed template.
3. **Plans** the change, with explicit confirmation gates for DNS, custom domains, production secrets, databases, deletions, and irreversible config.
4. **Builds and checks** the artifact against Cloudflare limits before deploying.
5. **Deploys** to `pages.dev` / `workers.dev` or a preview branch.
6. **Verifies** root status, 404 behavior, assets, headers, canonical/noindex, CORS, backup independence, DNS, data, and performance as applicable.
7. **Reports** every check as pass/fail/warn/unverified. It does not claim a test that was not run.

## Structure

```text
cloudflare-deploy/
├── SKILL.md
├── README.md                 # English (this file)
├── README.zh-CN.md           # Chinese
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
    └── results.md
```

## Prerequisites

| Requirement | Needed for | Check |
|---|---|---|
| Cloudflare account | Everything | Sign up at `dash.cloudflare.com`; verify email |
| Wrangler auth | Deploy | `npx wrangler whoami` |
| Account ID | API token / CI | Account Home → search "Copy account ID" |
| Node.js 22+ | Build and Wrangler | `node -v` |
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

Dependency-free Node 18+ ESM, read-only:

```bash
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs
node scripts/check-build.mjs --dir dist --spa
node scripts/verify-deployment.mjs --url https://site.example.com --json
```

Backup check:

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com \
  --backup https://owner.github.io/repo/ \
  --json
```

## Tests

```bash
node tests/run-tests.mjs
```

The runner creates six synthetic projects (Vite SPA, Jekyll, Vite+Supabase, Hono+D1, heavy Express, Next.js SSR), asserts the detector output, checks two artifacts, and runs the verifier against local HTTP servers — including a backup that 301s to the main site.

These tests prove the scripts work. They do not prove account permissions, DNS, TLS, or platform behavior.

## Design rules

- Progressive disclosure: `SKILL.md` has routing, workflow, and safety gates; details live in `references/`.
- One topic per reference; no duplicated platform explanations.
- Scripts are deterministic and print JSON; human summaries on demand.
- No empty directories or placeholder assets.
- Every report distinguishes verified, failed, and unverified.

## Limitations

- Cannot create a Cloudflare account or complete OAuth for the user.
- Cannot connect Git integration / Workers Builds through the CLI; that is a dashboard/API step.
- DNS, custom domains, production secrets, database migration, and deletions require explicit confirmation.
- No real deployment was performed in this build environment.
