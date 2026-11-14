# cloudflare-deploy

[简体中文](README.md) | **English**

A reusable Agent Skill for deploying GitHub projects to Cloudflare Pages or Workers: **verify the account/network path and technical feasibility first**, then inspect the repo, choose the product, write a plan, build, deploy to a preview, verify with real HTTP requests, and report what was actually tested.

> **Scope**: the scripts fully cover static sites / SPAs / SSG for build checks and HTTP verification. For SSR / full-stack projects, treat this skill as a **workflow checklist**: `check-build.mjs` does not apply, and `verify-deployment.mjs` only checks the HTTP layer (root page, APIs, server-rendered content). Runtime compatibility, plans, and cost: `references/runtime-compat.md`.

The skill body is written in Simplified Chinese. File names and code identifiers stay ASCII for cross-platform compatibility; JSON keys stay English so scripts remain machine-readable.

## Status

- Skill format validated (`quick_validate.py`): valid. Repository check `node tests/check-skill.mjs` also passes.
- Local tests: 198/198 passing (`node tests/run-tests.mjs`).
- Real Cloudflare deployment: **not run in this automated test environment** (no account/token, Wrangler not installed). Migration and live observations from a separate real project are recorded in `references/migration-guide.md` (tagged "measured"), but that is historical evidence, not verification performed by these local tests. Local automation is not the same as account-level deployment verification. See `tests/results.md` for exactly what was and was not verified.

## What it does

**Step 0 is a circuit breaker, not optional**: `scripts/probe.mjs` checks the account / network / permission path and hard-stops on `blocked`; a short feasibility check follows, and an infeasible stack produces "switch dependency / switch approach / switch platform" with costs. Builds also stop after two consecutive failures or 15 minutes without progress.

1. **Detects** the framework, build command, output directory, base path, SPA/SSR/API type, GitHub Pages setup, existing Wrangler config, bindings, env keys, PWA, workspaces, lockfiles, and risk signals — tagging each key field `confirmed` / `inferred` / `unknown`.
2. **Proposes** Pages or Workers as candidates with a confidence level; DNS, deployment style, and future backend needs decide, not the framework name.
3. **Plans** the change, with explicit confirmation gates for DNS, custom domains, production secrets, databases, deletions, and irreversible config.
4. **Builds and checks** the artifact against the site mode, plan, and deployment target. Free is 20,000 files by default; 100,000 requires `--plan paid --target pages` (Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`) or `--plan paid --target workers` (full Wrangler version >= 4.34.0). Unknown target, invalid versions, or missing evidence fall back to 20,000 with a `warn`; `ssr` reports "not applicable".
5. **Deploys** to `pages.dev` / `workers.dev` or a preview branch.
6. **Verifies** root status (only same-origin redirects are followed; cross-origin, protocol changes, and non-HTTP(S) targets are recorded and classified, never requested), mode-appropriate 404/fallback behavior, assets (3xx is followed to a final 2xx on the same origin; cross-host redirects are recorded and warned), headers, canonical/noindex, CORS (preflight follows the Fetch spec for `*` / credentials / safelisted methods; the simple-request credentials mode is declared only via `--cors-credentials`), backup independence, DNS, data, and performance as applicable; `ssr` additionally checks server-rendered content, a single TTFB sample, and `--api` endpoint status / JSON structure.
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
│   ├── runtime-compat.md     # feasibility, ORM x runtime, cost, stop-loss
│   ├── deployment-workflows.md
│   ├── pages-runtime.md      # headers, redirects, 404/SPA, cache, CORS
│   ├── github-pages-backup.md
│   ├── verification.md
│   ├── troubleshooting.md
│   ├── security.md
│   ├── seo-indexing.md
│   └── migration-guide.md    # phases + Jekyll case study with real data
├── scripts/
│   ├── probe.mjs             # Step 0: link probe
│   ├── deploy-verdict.mjs    # testable verdict logic for probe --deploy
│   ├── redirect-policy.mjs  # same-origin redirect policy (pure function, shared)
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
| Docker | Containers only | `docker info` (Containers also require Workers Paid) |
| Account plan / subscription | Paid features | Manage Account → Billing → Subscriptions |
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

The agent first runs `scripts/probe.mjs` and `scripts/check-env.mjs` (both express their verdict through the exit code), then `scripts/detect-project.mjs`, reads only the reference needed for the task, fills `templates/deployment-plan.md`, deploys to a preview, runs `scripts/verify-deployment.mjs`, and fills `templates/deployment-report.md`.

## Scripts

Dependency-free, read-only Node 18+ ESM (Node 22+ is still recommended for actual deploys):

```bash
node scripts/probe.mjs                         # Step 0: 0 ready / 1 limited / 2 blocked
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs                     # 0 deployable / 1 not deployable / 2 not buildable
node scripts/check-build.mjs --dir dist --mode static [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0]   # or ssg / spa; ssr reports skip
node scripts/verify-deployment.mjs --url https://site.example.com --mode static --json
```

`--mode` decides the 404 verdict: `static`/`ssg` require a 404 for unknown paths; `spa` requires the app shell; `ssr` normally expects 404 and only warns on 200. Build check and verification must use the same value.

`check-build.mjs` defaults to the Free **20,000** file limit. The Paid **100,000** limit has different prerequisites per target: `--target pages` needs Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4` (a Pages-only setting), while `--target workers` needs full Wrangler **>= 4.34.0** (official Workers Limits) and no Pages variable. Versions are compared numerically per segment (`4.9.0 < 4.34.0`); `4.x` and prerelease tags are treated as unverified. Omitting `--target` or any missing evidence falls back to 20,000 with a `warn`, and the result records the target, effective limit, and reason.

CORS preflight only asserts what you explicitly pass via `--cors-method` / `--cors-headers` / `--cors-credentials`; everything else is listed in `notChecked`. Per the Fetch spec, `*` is a wildcard only for requests without credentials, `GET`/`HEAD`/`POST` are CORS-safelisted methods, `Authorization` is never covered by `*`, and method names are case-sensitive. **`--cors-credentials` declares the expected request mode**: the script only sends GET / HEAD / OPTIONS and never attaches browser cookies or identity credentials. An `Access-Control-Allow-Credentials: true` response header does not turn a credential-free request into a credentialed one. Only when credentials are explicitly declared does the check require an exact `ACAO` match plus `ACAC: true`.

Both the root chain and asset probes follow only **same-origin** (scheme + host + port, see `scripts/redirect-policy.mjs`) redirects, up to 5 hops, and require a final 2xx. Cross-origin targets, protocol changes (including HTTP ↔ HTTPS), non-HTTP(S) schemes, and missing/unparseable `Location` are never requested — only the Location, status code, and redirect chain are recorded, so verification cannot be sent to `127.0.0.1`, an internal IP, or a cloud metadata endpoint. The root result uses `redirectOutcome` to distinguish same-origin verified, cross-origin target unverified, loop/hop limit, unparseable Location, and unsupported protocol. Any asset 3xx with a parseable `Location` is recorded in `redirects` (no longer inferred from chain length), keeping `probed` / `warnings` / `redirects` consistent. `--expect-json` compares JSON subsets, so key order and whitespace do not matter.

HTTP baseline for SSR / full-stack:

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com --mode ssr \
  --api /api/health --expect-json '{"ok":true}' --json
```

`--expect-json` must be valid JSON and is compared as a **subset** of the response (key order and whitespace are irrelevant; missing fields, value mismatches, and invalid JSON produce explicit reasons). This only verifies the HTTP layer. Database writes, login sessions, third-party callbacks, and cold starts still need dedicated checks.

Backup site plus CORS on a separate API host:

```bash
node scripts/verify-deployment.mjs \
  --url https://site.example.com \
  --mode static \
  --backup https://owner.github.io/repo/ \
  --origin https://app.example.com \
  --cors-url https://api.example.com/items \
  --cors-method POST \
  --cors-headers "content-type,authorization" \
  --json
```

## Tests

```bash
node tests/run-tests.mjs        # 198 checks: detection, plan/artifact limits, real HTTP, CORS preflight + simple requests, root/asset redirects, JSON structure, link probe
node tests/check-skill.mjs      # structure check, no external tooling
```

The runner creates twelve synthetic projects (the list above plus a Prisma/Drizzle + Neon fixture), asserts detector output, confidence levels, verification modes, and runtime-dependency hints; checks three artifacts (one twice, as static and SPA) plus the explicit `ssr` skip; and runs the verifier against thirteen local HTTP servers — covering HEAD 405 falling back to GET, static/SPA/SSR 404 semantics, a separate CORS host, duplicate canonical tags, a backup that 301s to the main site, and `--api` JSON structure / expected-value comparisons.

Regression groups cover: target-aware plan escalation with full version comparison (Pages complete / missing env var, Workers 4.34.0 / 4.33.0 / Free, unknown target, invalid versions, pure-function file-count boundaries without creating 20,000 real files), a CORS preflight matrix (allowed/denied Origin, missing method/header, bad credentials, 204 without ACAO, no inference for absent inputs, wildcard × credentials, Authorization non-wildcard, safelisted methods, method casing), a CORS simple-request credentials matrix (`ACAO=*` × ACAC present/absent × `--cors-credentials` declared or not), a root redirect matrix (same-origin 301→200 / 302→404, cross-host, 127.0.0.1, HTTP→HTTPS, loop, invalid Location, non-HTTP(S) scheme, backup redirecting to the main site), pure redirect-policy cases (including HTTPS→HTTP), asset redirect and aggregate consistency (direct 200, same-host 301, cross-host 302, loop, missing Location, protocol rejection, aligned `probed` / `warnings` / `redirects`), and `--expect-json` structure cases (key order, missing fields, type mismatch, nested arrays, invalid JSON). A second local HTTP server records every request path it receives, proving the verifier never follows cross-origin targets; no real internal IP or cloud metadata endpoint is contacted. A local fake wrangler verifies the link probe does not misreport "not logged in" when `whoami --json` fails, and covers `--deploy` with no URL / failed cleanup / failed deploy; the deploy verdict logic is also unit-tested for URL parsing, HTTP verification, and cleanup warnings.

These tests prove the scripts work. They do not prove account permissions, DNS, TLS, or platform behavior.

## Design rules

- Link first: never continue on `blocked`; feasibility is judged before touching project config, not discovered by building.
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
- For SSR / full-stack, script coverage stops at the HTTP layer; `check-build.mjs` does not apply.
- All automated tests run against local synthetic fixtures; no real Cloudflare deployment was performed here. The real-project case study lives in `references/migration-guide.md` and is a different thing.
