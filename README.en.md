# cloudflare-deploy

[简体中文](README.md) | **English**

A reusable Agent Skill for deploying GitHub projects to Cloudflare Pages or Workers: **verify the account/network path and technical feasibility first**, then inspect the repo, choose the product, write a plan, build, deploy to a preview, verify with real HTTP requests, and report what was actually tested.

> **Scope**: the scripts fully cover static sites / SPAs / SSG for build checks and HTTP verification. For SSR / full-stack projects, treat this skill as a **workflow checklist**: `check-build.mjs` does not apply, and `verify-deployment.mjs` only checks the HTTP layer (root page, APIs, server-rendered content). Runtime compatibility, plans, and cost: `references/runtime-compat.md`.

The skill body is written in Simplified Chinese. File names and code identifiers stay ASCII for cross-platform compatibility; JSON keys stay English so scripts remain machine-readable.

## Status

- Skill format validated (`quick_validate.py`): valid. Repository check `node tests/check-skill.mjs` also passes.
- Local tests: 717/717 passing (`node tests/run-tests.mjs`).
- Real Cloudflare deployment: **not run in this automated test environment** (no account/token, Wrangler not installed). Migration and live observations from a separate real project are recorded in `references/migration-guide.md` (tagged "measured"), but that is historical evidence, not verification performed by these local tests. Local automation is not the same as account-level deployment verification. See `tests/results.md` for exactly what was and was not verified.

## What it does

**Step 0 is a circuit breaker, not optional**: `scripts/probe.mjs` checks the account / network / permission path and hard-stops on `blocked`; a short feasibility check follows, and an infeasible stack produces "switch dependency / switch approach / switch platform" with costs. Builds also stop after two consecutive failures or 15 minutes without progress.

1. **Detects** the framework, build command, output directory, base path, SPA/SSR/API type, GitHub Pages setup, existing Wrangler config, bindings, env keys, PWA, workspaces, lockfiles, and risk signals — tagging each key field `confirmed` / `inferred` / `unknown`.
2. **Proposes** Pages or Workers as candidates with a confidence level; DNS, deployment style, and future backend needs decide, not the framework name.
3. **Plans** the change, with explicit confirmation gates for DNS, custom domains, production secrets, databases, deletions, and irreversible config.
4. **Builds and checks** the artifact against the site mode, plan, and deployment target. Free is 20,000 files by default; 100,000 requires `--plan paid --target pages` (Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4`) or `--plan paid --target workers` (full Wrangler version >= 4.34.0). Unknown target, invalid versions, or missing evidence fall back to 20,000 with a `warn`; `ssr` reports "not applicable".
5. **Deploys** to `pages.dev` / `workers.dev` or a preview branch.
6. **Verifies** root status (only same-origin redirects are followed, up to 5 redirects plus one request for the final address; cross-origin, protocol changes, and non-HTTP(S) targets are recorded and classified, never requested; only 301/302/303/307/308 count as redirects, while 304 and other 3xx are classified separately; content checks run only for a final 200), mode-appropriate 404/fallback behavior, assets (HTML is parsed by the shared tokenizer: fake tags inside comments/RAWTEXT/RCDATA/template/noscript, script escaped/double-escaped states, malformed DOCTYPE identifiers and SVG/MathML foreign content never count as HTML; subresource attributes are collected element-aware and `srcset` is parsed with the WHATWG algorithm; 304 never enters the redirect chain), headers, canonical/noindex (self-canonical requires matching scheme, host, and normalized path; missing / empty / unparseable hrefs each fail; only real HTML-namespace `<link rel=canonical>` elements count, including links inside HTML integration points), CORS (preflight sends only explicitly provided method/headers, unasserted checks stay in `notChecked`; a CORS URL returning non-2xx/3xx never passes), backup independence, DNS, data, and performance as applicable; `ssr` additionally checks server-rendered content (RAWTEXT excluded from visible text), a single TTFB sample, and `--api` endpoint status / JSON structure.
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
│   ├── html-scan.mjs         # shared HTML tokenizer (comments/RAWTEXT/RCDATA/template, entities)
│   ├── config-scan.mjs       # comment-aware JSONC/TOML config reading (detect-project)
│   ├── wrangler-auth.mjs     # single auth verdict authority (check-env + probe)
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
    ├── browser-diff.mjs     # optional: real Chrome/Edge CDP differential (Node 22+, not in default suite)
    ├── fixtures/
    │   ├── loopback-tls.mjs # self-signed loopback cert for local HTTPS tests (not a real credential)
    │   └── html5-oracle.json # Chrome/Edge-recorded HTML5 DOM facts (115 cases)
    ├── last-run.txt         # latest test output (auto-generated by run-tests)
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

The agent runs `scripts/probe.mjs` first (exit codes express the link verdict); once the link is up it runs `scripts/detect-project.mjs`; before building or deploying it runs `scripts/check-env.mjs` (also exit-code driven), reads only the reference needed for the task, fills `templates/deployment-plan.md`, deploys to a preview, runs `scripts/verify-deployment.mjs`, and fills `templates/deployment-report.md`.

## Scripts

Dependency-free Node 18+ ESM (Node 22+ is still recommended for actual deploys). Read-only by default; `probe.mjs --deploy` is the exception (it creates and deletes a real temporary Worker and needs explicit consent). `probe.mjs --timeout` must be a finite positive integer in 1..2147483647 (milliseconds); empty, non-numeric, negative, zero, fractional, or out-of-range values exit with code 2 and a usage error before any network probe:

```bash
node scripts/probe.mjs                         # Step 0: 0 ready / 1 limited / 2 blocked
node scripts/detect-project.mjs . --human
node scripts/check-env.mjs                     # 0 deployable / 1 not deployable / 2 not buildable
node scripts/check-build.mjs --dir dist --mode static [--plan free|paid] [--target pages|workers] [--wrangler-version 4.34.0]   # or ssg / spa; ssr reports skip
node scripts/verify-deployment.mjs --url https://site.example.com --mode static --json
```

`--mode` decides the 404 verdict: `static`/`ssg` require a 404 for unknown paths; `spa` requires the app shell; `ssr` normally expects 404 and only warns on 200. Build check and verification must use the same value.

`check-build.mjs` defaults to the Free **20,000** file limit. The Paid **100,000** limit has different prerequisites per target: `--target pages` needs Wrangler v4 + `PAGES_WRANGLER_MAJOR_VERSION=4` (a Pages-only setting), while `--target workers` needs full Wrangler **>= 4.34.0** (official Workers Limits) and no Pages variable. Versions are compared numerically per segment (`4.9.0 < 4.34.0`); `4.x` and prerelease tags are treated as unverified. Omitting `--target` or any missing evidence falls back to 20,000 with a `warn`, and the result records the target, effective limit, and reason.

CORS preflight only asserts what you explicitly pass via `--cors-method` / `--cors-headers` / `--cors-credentials`; ACRM/ACRH are not sent unless provided, everything else is listed in `notChecked`, and a preflight without explicit method/header assertions is at most `warn`. A CORS URL returning non-2xx or a redirect never passes. Per the Fetch spec, `*` is a wildcard only for requests without credentials, `GET`/`HEAD`/`POST` are CORS-safelisted methods, `Authorization` is never covered by `*`, and method names are case-sensitive. **`--cors-credentials` declares the expected request mode**: the script only sends GET / HEAD / OPTIONS and never attaches browser cookies or identity credentials. An `Access-Control-Allow-Credentials: true` response header does not turn a credential-free request into a credentialed one. Only when credentials are explicitly declared does the check require an exact `ACAO` match plus `ACAC: true`.

Both the root chain and asset probes follow only **same-origin** (scheme + host + port, see `scripts/redirect-policy.mjs`) redirects and share `MAX_REDIRECTS=5`: up to 5 redirects are followed, plus one extra request for the final address the 5th redirect points to. If that address still returns 3xx (a 6th redirect), the result is `loop-or-limit` and the target is never requested. Cross-origin targets, protocol changes (including HTTP ↔ HTTPS), non-HTTP(S) schemes, and missing/unparseable `Location` are never requested — only the Location, status code, and redirect chain are recorded, so verification cannot be sent to `127.0.0.1`, an internal IP, or a cloud metadata endpoint. A cross-origin redirect at the hop boundary is still classified as cross-origin, never followed. The root result uses `redirectOutcome` to distinguish same-origin verified, cross-origin target unverified, loop/hop limit, unparseable Location, unsupported protocol, `not-modified` (304), and `unexpected-3xx` (uncommon 3xx), plus `no-redirect` / `network-error` / `same-origin-final-failed`; on overflow, the root result's `limitHop` records the unfollowed hop. Any asset 3xx with a parseable `Location` is recorded in `redirects` (no longer inferred from chain length), keeping `probed` / `warnings` / `redirects` consistent. Only `301/302/303/307/308` require reading `Location`; `304 Not Modified` is a cache-validation result, never enters the redirect chain, and is never reported as an invalid redirect for lacking `Location`; other 3xx (300, 305, etc.) are neither followed nor treated as success. The root chain, asset probes, and the `/index.html` check share `classifyStatus()`, and hop records carry `statusClass`. HTML is parsed by the shared tokenizer (`scripts/html-scan.mjs`, zero-dependency explicit state machine): fake tags inside comments, RAWTEXT (script/style/xmp/iframe/noembed/noframes/noscript), RCDATA (title/textarea), template, attribute values and malformed tags never count; **non-void HTML elements written as `<div/>` / `<span/>` stay open** (the self-closing flag only takes effect for void and foreign elements); an incomplete start tag at EOF is discarded like the browser (no element, no tag text in the document; a lone `<` / `</` remains text, and script/title raw text is preserved). Foreign end-tag fallback stops at scope boundaries (table/object/marquee/applet/select), and tree-builder-discarded table/structural tags do not pollute the HTML ancestor stack. Only the final 200 homepage is content-checked. Script data implements escaped/double-escaped states (`<!--<script></script>-->`'s inner `</script>` does not close the element); DOCTYPE public/system identifiers end abruptly at `>` (browser behavior, no fake quote protection); SVG/MathML use an explicit namespace stack (nested SVG, foreignObject/desc/title, MathML text integration points, annotation-xml encoding branches, breakout tags, HTML-ancestor end tags, CDATA, template isolation, no state leaks). Asset references are element-aware: `src` only on img/script/iframe/embed/video/audio/source/track/input (type=image), `poster` only on video, `srcset` only on img/source and parsed with the WHATWG algorithm (commas in URLs/data URIs, no-space separators, trailing commas, malformed descriptors); `<a href>`, canonical and `<base>` are not resources. Character references follow HTML rules (common named entities, numeric references, common semicolon-less legacy entities, CR/CRLF normalization). Relative URLs resolve against `<base href>` or the document URL (no forced trailing slash). After same-origin redirects, 404/API/CORS/`/index.html`/assets/canonical use the final page URL; `probed.finalUrl` is the last actually requested URL, with unfollowed targets in `redirectTarget` / `limitReached`. HTML5 oracle differential: `tests/fixtures/html5-oracle.json` records 115 browser DOM facts (HTML-namespace canonical/title/script/img/base) from real Chrome/Edge; the default suite compares against it, and `node tests/browser-diff.mjs` re-runs a real Chromium differential when a browser is installed (Node 22+, optional). A canonical tag counts as self-canonical only when **scheme + host + normalized path** all match; same host and path but a different scheme (an `http` canonical on an `https` site) is a `warn` that names the protocol mismatch. A canonical `href` that is missing, empty, or unparseable each fails with `hrefState` (`missing` / `empty` / `valid` / `invalid`) and is never resolved against the current site; double-quoted, single-quoted, and unquoted legal attribute values are all supported; only real `<link rel="canonical">` tags are counted — `rel` is matched as HTML-whitespace-separated tokens, so comments, `<script>`/`<style>`, and `data-rel` / `aria-rel` are ignored. Cross-origin or non-HTTP(S) asset references on the homepage (including backslash-disguised cross-origin URLs) are never requested and are recorded in `ignored`; `/index.html` passes only when the redirect is same-origin and targets the site root — cross-origin / non-HTTP(S) / other paths are warnings, not passes. Invalid CLI values (`--api` / `--expect-404` / `--backup` / `--cors-url` / `--url` bad URLs, a non-positive `--timeout`, a non-positive-integer `--assets-limit`, a bad `--origin`, CORS options without `--origin`) exit with code 2 and a usage error instead of emitting partial JSON. CORS preflight sends ACRM/ACRH only when explicitly provided; unprovided assertions stay in `notChecked` and the preflight verdict is at most `warn`; simple requests returning 3xx/4xx/5xx never pass, and only `Authorization` is a non-wildcard header. `check-env` and `probe` share one auth verdict: a `whoami` exit 0 without positive evidence (email / Account ID / explicit logged-in text) is `unknown` and can never deploy. `--expect-json` compares JSON subsets, so key order and whitespace do not matter.

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
node tests/run-tests.mjs        # 717 checks with layer tags (core 284 / adversarial 270 / boundary 40 / combination 5 / unit 118): detection, plan/artifact limits, HTML tokenizer, real HTTP, CORS, redirects/SSRF, canonical, 3xx, CLI, JSON, link probe
node tests/check-skill.mjs      # structure check, no external tooling
node tests/browser-diff.mjs     # optional: real Chrome/Edge parser differential (Node 22+; exit 2 when skipped, 1 on mismatch)
```

The runner creates twenty synthetic projects — Vite SPA, Jekyll, Vite+Supabase, Hono+D1, heavy Express, Next.js SSR, monorepo, multi-lockfile, dynamic Vite config, multiple HTML entries, Pages Functions, Prisma/Drizzle + Neon, wrangler.jsonc, plus comment-noise / public-only / Nuxt ssr:false / `node --inspect` config fixtures — asserts detector output, confidence levels, verification modes, and runtime-dependency hints; checks twelve artifact fixtures (fake refs, directory URLs, `%2F`, comma-in-srcset, cross-origin base, the 40-reference cap, case/symlink handling) plus the explicit `ssr` skip; and runs the verifier against fifteen local HTTP servers plus one local HTTPS server — covering HEAD 405 falling back to GET, static/SPA/SSR 404 semantics, a separate CORS host, duplicate canonical tags, HTML context isolation (comments/RAWTEXT/RCDATA/template/attribute values/SVG/MathML/foreignObject), `<base href>` and post-redirect final URL, the final-200 content gate, 304 / uncommon-3xx classification, cross-origin assets never requested, a backup that 301s to the main site, and `--api` JSON structure / expected-value comparisons. The HTTPS server uses a self-signed loopback cert shipped in `tests/fixtures/loopback-tls.mjs`; the child trusts it via `NODE_EXTRA_CA_CERTS` (TLS verification stays on, no openssl or third-party package), so the canonical scheme matrix runs against a real `https://` site.

HTML5 state-machine regression additionally covers script data escaped/double-escaped/`<!-->` transitions, DOCTYPE public/system identifiers ending abruptly at `>`, the SVG/MathML namespace stack (nested SVG, foreignObject/desc/title, MathML text integration points, mglyph/malignmark, annotation-xml encoding branches, breakout tags, HTML-ancestor end tags, HTML child stacks, CDATA, template isolation), end-tag attribute quotes/EOF text, HTML non-void self-closing semantics, scope-boundary HTML-ancestor fallback, tree-builder-discarded table/structural tags, select insertion mode, visible-text integration points, the WHATWG srcset parser (URLs containing commas, data URIs, no-space separators, trailing commas, malformed/duplicate descriptors), element-aware resource attributes, and deterministic state combinations. `tests/fixtures/html5-oracle.json` records 115 HTML-namespace DOM facts from real Chrome 157 + Edge 157 (canonical/title/script/img/base); the default suite compares against it, and `node tests/browser-diff.mjs` re-runs a live Chromium differential when a browser is present (Node 22+; exits 2 and skips otherwise). This proves those boundaries match Chromium, not full HTML5 tree construction or real deployment.

Regression groups cover: target-aware plan escalation with full version comparison (Pages complete / missing env var, Workers 4.34.0 / 4.33.0 / Free, unknown target, invalid versions, pure-function file-count boundaries without creating 20,000 real files), a CORS preflight matrix (allowed/denied Origin, missing method/header, bad credentials, 204 without ACAO, no inference for absent inputs, wildcard × credentials, Authorization non-wildcard, safelisted methods, method casing), a CORS simple-request credentials matrix (`ACAO=*` × ACAC present/absent × `--cors-credentials` declared or not), a root redirect matrix (same-origin 301→200 / 302→404, cross-host, 127.0.0.1, HTTP→HTTPS, loop, invalid Location, non-HTTP(S) scheme, backup redirecting to the main site), pure redirect-policy cases (including HTTPS→HTTP), asset redirect and aggregate consistency (direct 200, same-host 301, cross-host 302, loop, missing Location, protocol rejection, aligned `probed` / `warnings` / `redirects`), root/backup hop boundaries (5 redirects + final 200 / final 404 / 6th redirect overflow / cross-origin at the boundary / the original loop case, with server hit counts proving the final address really was requested), a canonical scheme matrix (HTTPS site × HTTPS self / HTTP canonical / other host / other path / multiple tags, all executing the verifier and asserting `sameProtocol` and status in its JSON), a canonical `href` form matrix (real HTTP site: missing href / empty string / single quote / double quote / unquoted / unparseable, asserting `hrefState` and the verdict in the verifier JSON), a canonical rel-recognition matrix (`data-rel` / `aria-rel` / `canonicalized` / commented / `<script>` string tags are not recognized; attribute order and multi-token `alternate canonical` are recognized), a 3xx classification matrix (root / assets / `/index.html` × 304 / 300 / 301 / 302 / 303 / 307 / 308, asserting `statusClass`, `httpStatus`, `redirectOutcome`, `redirect`, and the `redirects` aggregate; the existing redirect-loop, cross-origin, and hop-boundary cases keep passing), wrangler.jsonc JSON-key parsing and output-dir precedence, CLI validation (invalid `--api` / `--expect-404` / `--assets-limit` / `--timeout` / `--backup` → exit 2 and no partial JSON), homepage asset-reference SSRF protection (backslash-disguised cross-origin URLs are never requested; `javascript:` is not probed), `/index.html` cross-origin / non-HTTP(S) / other-path redirects not passing, `httpStatus` on `404` / `spa-fallback` / `api` checks, response-header checks (title / content-type / cache-control / security-headers), 304 / uncommon 3xx for backup and SPA fallback, check-build case-sensitive asset matching and `..` escapes, a project path containing spaces, check-skill BOM / block-scalar / fenced-code self-checks, HTML tokenizer unit/adversarial/fuzz cases (comments, bogus comments, CDATA, DOCTYPE, RAWTEXT/RCDATA/plaintext/template, `>` inside attribute values, incomplete tags, duplicate attributes, character references, `<base href>`, visible text); a canonical context-isolation matrix (comment / script / style / textarea / title / iframe / xmp / noembed / noframes / plaintext / template / attribute value / incomplete tag / real-plus-fake); metadata isolation (fake title/meta ignored); asset-reference rules and fake refs (src/srcset/poster/object data/link href; anchors, canonical and base excluded; `<base href>`; cross-origin never requested; `ignored` aggregate); config noise (Vite/Next/wrangler JSONC/TOML/YAML comments, `node --inspect`, `.env` export/lowercase keys, Nuxt ssr:false, public/index discovery); auth fail-closed (empty output / `loggedIn:false` / command failure distinguished); CORS preflight semantics (no inferred ACRM/ACRH, unasserted at most warn, 403 after explicit declaration fails, Authorization-vs-Range wildcard rules), CORS simple requests (500 error, 3xx redirect); the final-200 content gate; SPA fallback fail-closed and `/index.html` 5xx; truthful resource `finalUrl` / `redirectTarget` / `limitReached`; check-build case sensitivity, `..`, `%2F`, directory URLs, the 40-reference cap note, and the symlink main-module guard; CLI/mode matrix; and `--expect-json` structure cases (key order, missing fields, type mismatch, nested arrays, invalid JSON). A second local HTTP server records every request path it receives, proving the verifier never follows cross-origin targets; no real internal IP or cloud metadata endpoint is contacted. A local fake wrangler verifies the link probe does not misreport "not logged in" when `whoami --json` fails, and covers `--deploy` with no URL / failed cleanup / failed deploy; the deploy verdict logic is also unit-tested for URL parsing, HTTP verification, and cleanup warnings.

These tests prove the scripts work. They do not prove account permissions, DNS, TLS, or platform behavior.

## Design rules

- Link first: never continue on `blocked`; feasibility is judged before touching project config, not discovered by building.
- Progressive disclosure: `SKILL.md` has routing, workflow, and safety gates; details live in `references/`.
- One topic per reference; no duplicated platform explanations.
- Detection is layered: `confirmed` / `inferred` / `unknown`; the target is a candidate, not a verdict.
- One `--mode` is threaded through build check and verification, so 404 verdicts cannot contradict each other.
- Scripts are deterministic and print JSON; human summaries on demand.
- One authority per rule: HTML in `scripts/html-scan.mjs`, config in `scripts/config-scan.mjs`, auth in `scripts/wrangler-auth.mjs`, 3xx classification in `scripts/redirect-policy.mjs`, resource attributes in `resourceReferences()`. Callers must not re-implement the same rule.
- Fail closed: missing evidence is not a pass. Auth, SPA fallback, CORS preflight, and resource references are at most `warn` when unverifiable.
- No empty directories or placeholder assets.
- Every report distinguishes verified, failed, and unverified.
- No runtime HTML-parser dependency (such as parse5): the skill is distributed as a copyable folder run by plain `node`, with no package.json / `npm install` step. `html-scan.mjs` is an explicit state machine covering comments, RAWTEXT/RCDATA/plaintext, template, attribute syntax, and character references; the cost is no full HTML5 tree construction.

## Limitations

- Cannot create a Cloudflare account or complete OAuth for the user.
- Cannot connect Git integration / Workers Builds through the CLI; that is a dashboard/API step.
- DNS, custom domains, production secrets, database migration, and deletions require explicit confirmation.
- For SSR / full-stack, script coverage stops at the HTTP layer; `check-build.mjs` does not apply.
- All automated tests run against local synthetic fixtures; no real Cloudflare deployment was performed here. The real-project case study lives in `references/migration-guide.md` and is a different thing.
- The HTML tokenizer is not a full HTML5 tree builder: implicit end tags, foster parenting, active formatting element reconstruction/adoption agency, and the full foreign-content tree construction are not modelled. SVG/MathML use an explicit namespace stack covering roots, HTML integration points, MathML text integration points, annotation-xml encoding branches, breakout tags and HTML-ancestor end tags; tree-builder-discarded table-internal/structural start tags, select insertion mode, and scope boundaries for HTML-ancestor fallback are approximated; the full annotation-xml/foreign-content tree rules and remaining legacy named entities are not implemented (only a common subset of semicolon-less legacy entities). DOCTYPE only guarantees token boundaries; force-quirks/compatMode is not exposed. Use a browser for DOM-level certainty. An independent one-off randomized browser differential (harness not committed) found no further state-machine bug; the only mismatch was the declared foster-parenting limitation, plus the documented entity-subset limitation.
