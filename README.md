# Inline for Codeforces

*Unofficial. Not affiliated with, endorsed by, or sponsored by Codeforces.*

Browse contests, gyms, and group contests, read statements, run samples, submit, and keep a searchable local history of every attempt — without leaving VS Code.

<!-- TODO (before publishing): screenshot — sidebar + statement + Results panel side by side -->

## Before you install — read this

**Browsing works with nothing else installed. Opening a problem, viewing a group, and submitting all need a second, free browser extension** (`browser/` in this repo) — that's not a rare case, it's most of what this extension does. Why: Codeforces blocks this extension's own network requests outright, and its submit form has a CAPTCHA only a human in a browser can solve. There's no way around either from inside VS Code. Full detail in **Architecture**, below.

If that's a dealbreaker, this extension isn't for you yet. If it's fine, the companion takes about two minutes to set up — run **`Codeforces: Setup walkthrough`** after installing, or follow **Quick start** below.

## Requirements

- VS Code 1.85+
- Google Chrome (or a Chromium browser that can load an unpacked MV3 extension) — for the companion, needed for anything beyond browsing
- A Codeforces account, if you plan to submit

## Install

1. **This extension** — from the Marketplace (search "Codeforces Inline"), or build it yourself (see **Development**, below).
2. **The companion** — Chrome isn't set up to auto-install this half yet, so it's a manual, one-time "Load unpacked":
   - `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select this repo's `browser/` folder.
   - In VS Code, run **`Codeforces: Relay info`** → copy the port and token.
   - Companion's **Details → Extension options** → paste them → **Save**.
   - Stay signed in to `codeforces.com` in that Chrome profile, with a tab open.

`Codeforces: Setup walkthrough` covers this in the app, with the reasoning. `Codeforces: Check companion` tells you if it's working.

## Quick start

1. Open the **Codeforces** icon in the Activity Bar. The tree populates immediately — **Contests**, **Gym**, **Problemset**, **Groups** — no setup, no login.
2. (Optional, no login needed) Set `codeforces.handle` in Settings to see your solved/attempted marks.
3. Click a problem. First time, you're asked for a **workspace folder** — where your solutions and history live; it's global, not per-project.
4. Write your solution, then `Ctrl+Alt+R` to run the samples in the **Results** panel, or `Ctrl+Alt+Enter` to submit.
5. For groups: `Codeforces: Add group`, paste the group code or its URL.

<!-- TODO (before publishing): screenshot — Results panel with a mix of pass/fail cards -->

## Features

- **Sidebar**: Contests, Gym, Problemset (browse by rating), and your groups, with solve/attempt state and API-backed solved marks.
- **Statement webview** beside your solution file, with samples, limits, and images.
- **Results panel** (below the tree): one card per test — PASS/FAIL badge, runtime, input/expected/actual with the first differing line highlighted. Passing cards collapse; failing ones stay open. Add your own test cases. Compile errors show verbatim, in the panel, not a toast. Submit and watch the verdict from the same panel.
- **Submission compiler** shown in the status bar next to the open problem — click to change it.
- **Local archive of everything you've done** — every run and every submission, including the ones Codeforces refused outright — searchable offline in a dedicated **Archive view** (its own Activity Bar icon): browse by judge → contest/group/gym → problem, a timeline per problem (consecutive identical outcomes collapse into one row), click any entry to reopen that exact source read-only and diff it against your current file.
- **`Codeforces: Stats`** — attempted / solved / solve rate / attempts-per-solve, and a verdict breakdown, from that local history.

<!-- TODO (before publishing): screenshot — Archive view timeline -->

## Commands

| Command | What it does |
| --- | --- |
| `Codeforces: Log in` | Handle + password. Only needed if you plan to skip the companion entirely (rare — see Architecture). |
| `Codeforces: Setup walkthrough` | Explains the companion, Turnstile, and the tab requirement. |
| `Codeforces: Check companion` | Reports whether the companion is polling, asleep, misconfigured, or absent. |
| `Codeforces: Relay info` | Shows the port + token to paste into the companion's options. |
| `Codeforces: Add group` / `Remove group` | Track a group's contests in the sidebar. |
| `Codeforces: Choose submission language` | Reads the real compiler list off a live submit page. |
| `Codeforces: Run sample tests` (`Ctrl+Alt+R`) | Compile + run every sample and custom test. |
| `Codeforces: Submit current file` (`Ctrl+Alt+Enter`) | Submit and watch the verdict. |
| `Codeforces: Stats` | Local attempt/run summary across every problem. |
| `Codeforces: Refresh` | Re-fetch the sidebar and the archive index. |
| `Codeforces: Change workspace folder` | Move your solutions/history to a new folder. |
| `Codeforces: Import session from browser` | Fallback login path for when Cloudflare's check happens to be off. |

`Ctrl+Alt+R` / `Ctrl+Alt+Enter` only fire with an editor focused, and deliberately avoid `Ctrl+Alt+B` / `Ctrl+Alt+S`, which the `cph` extension claims. Rebind them under `codeforces.runTests` / `codeforces.submit` in Keyboard Shortcuts if you like.

## Settings

| Setting | What it does |
| --- | --- |
| `codeforces.handle` | Handle used for solved/attempted marks. Set automatically at login. |
| `codeforces.workspaceRoot` | Root folder for solutions + history. Prompted for on first use; change via `Codeforces: Change workspace folder`. |
| `codeforces.extension` | File extension for new solutions. |
| `codeforces.templatePath` | File copied into every new solution. |
| `codeforces.compileCommand` | Placeholders: `${file}` `${bin}` `${dir}` `${name}`. Empty for interpreted languages. |
| `codeforces.runCommand` | Same placeholders. |
| `codeforces.timeoutMs` | Per-sample time limit. |
| `codeforces.programTypeId` | Compiler id. Set via the language picker / the status-bar chip. |
| `codeforces.groups` | Group codes shown in the tree. |
| `codeforces.contestLimit` | How many contests to list. |
| `codeforces.relayPort` | Localhost port the companion polls (default 27121, bound to 127.0.0.1). |
| `codeforces.directSubmit` | POST straight from the extension instead of via the companion. Only works when Cloudflare's Turnstile isn't enforced. |
| `codeforces.debug` | Verbose relay/command tracing to the Codeforces output channel. Off by default. |
| `codeforces.apiKey` / `apiSecret` | Optional, from `/settings/api`. Only needed for data private to you. Requests are signed and die if your clock is more than 5 minutes off server time. |

## Architecture — why the companion extension is required

With the companion unloaded, browsing and solve marks still work (read-only API). What needs it — opening a statement, listing a group's contests and problems, submitting, and polling a verdict — is forced, not a preference:

1. **Node can't reach Codeforces' HTML at all.** Codeforces runs Cloudflare in a mode that rejects Node's TLS handshake fingerprint *before* the request reaches Codeforces — every HTML route returns a `403 "Just a moment…"`. A valid session cookie does not help; neither does importing `cf_clearance` + the browser User-Agent (tried, still 403 — the block is on the TLS fingerprint, not the cookies). Only `codeforces.com/api/*` is exempt.
2. **A browser *service-worker* fetch isn't a page fetch either.** The companion's background fetch also gets a Cloudflare 403 — it sends `Sec-Fetch-Site: none` and no `Referer`, and Cloudflare scores it as non-browser. So the companion re-runs each read as a real page-context fetch (`chrome.scripting.executeScript`, MAIN world) inside a logged-in `codeforces.com` tab, which sends the right headers and the right TLS. **You must keep one `codeforces.com` tab open that has passed the "Just a moment" check.**
3. **The submit form has a Cloudflare Turnstile CAPTCHA.** There is no way to produce a valid Turnstile token headlessly. The companion opens the submit page and fills in the compiler, problem and source; **you solve the Turnstile and click Submit yourself.** VS Code then finds the new submission and polls the verdict (also via the companion).
4. **Group contests are invisible to the API.** `contest.list` has no group parameter with or without a signed key, so group contest/problem lists are scraped from `/group/<code>/…` — through the companion, per point 1.
5. **Codeforces has no write API.** `/apiHelp` has promised submit methods "soon" for years. Don't wait for it.

The extension runs a token-guarded localhost relay on `127.0.0.1` (`codeforces.relayPort`, default 27121); the companion polls it, and the two sides check a **protocol version** on every health check so an out-of-sync pair fails with a clear message instead of a silent hang. `Codeforces: Relay info` shows the port and token to paste into the companion's options once; `Codeforces: Check companion` reports whether it's connected. Reads are cached hard on disk (statements 30 days, group lists 15 minutes) since each one is a poll round-trip. If Cloudflare's under-attack mode is ever off, `codeforces.directSubmit` posts straight from the extension instead.

See `browser/README.md` for the companion in detail, `browser/PRIVACY.md` for what it does and doesn't send anywhere, and `LESSONS.md` for the full investigation.

### Where the scrapers will break

Statements, the compiler list, group markup and the submit-form fields are parsed from live HTML. When Codeforces changes markup, `Session.findCsrf`, `parseLanguages`, `groupContests`, `problemDetail` or `submit.ts`'s field names break first. [cf-tool](https://github.com/xalanq/cf-tool) does the same in Go; its issue tracker is a good early warning.

Other failure modes:

- **`codeforces.com` tab closed or challenged.** Reads fail with *"Start the companion extension in Chrome…"* / *"open codeforces.com in Chrome, clear the check"*. Open a tab, clear the check.
- **Companion service worker asleep.** Chrome suspends MV3 workers after ~30 s idle; a keepalive alarm wakes it within ~30 s and VS Code retries across that window. `Codeforces: Check companion` confirms.
- **Rate limits.** One request per ~1 s through a single queue; verdict polls are 4 s. Don't lower these during a live contest.
- **Identical submission.** Codeforces refuses a resubmit of unchanged source; the message is surfaced as-is and still recorded as an attempt.

## Local archive layout

Everything lives under your workspace folder, keyed by `{ judge, scope, contestRef, index }` so another judge (LeetCode, AtCoder, …) could slot in beside `codeforces/` without a migration:

```
<root>/
  codeforces/
    group-<code>-<contestId>/  gym-<contestId>/  contest-<contestId>/
      A/
        A.cpp                       current source
        .meta.json                  ref, problem, samples, user tests
        runs/<timestamp>.json       one per local run
        attempts/<timestamp>.json   one per submission
  .archive-index.json               rolled-up index for fast reads
```

`.meta.json` + `attempts/` are the source of truth for the tree's solve state and `Codeforces: Stats` — they hold tries Codeforces refused outright, which `user.status` never shows. Pre-existing `group-*/gym-*/<digits>/` folders and `.cf/*.json` files (an earlier, pre-1.0 layout) are migrated into this layout the first time you point the extension at a folder that has them: copy, verify, then remove the originals (build artifacts like `A.exe` are left where they are).

## Development

```bash
npm install
npm run compile
```

Open the folder in VS Code, press **F5** — a second VS Code window opens with the extension loaded. To install it into your normal VS Code instead:

```bash
npm i -g @vscode/vsce
vsce package                                        # codeforces-inline-<version>.vsix
code --install-extension codeforces-inline-<version>.vsix
npm run build:companion                              # dist/codeforces-inline-companion-<version>.zip
```

`npm run selftest` compiles and runs the checks in `relay.ts` / `archive.ts` / `migrate.ts` over real temp directories and a real HTTP server — no VS Code needed.

### Repo layout

```
src/
  http.ts         cookie jar, 1-req/s queue, Cloudflare detect, companion-fetch fallback
  session.ts      login, csrf, ftaa/bfaa, browser-session import, SecretStorage
  api.ts          read-only API, apiSig signing, caching
  scrape.ts       groups, statements, samples, compiler list (+ disk cache)
  submit.ts       submission POST, verdict polling, latest-submission lookup
  relay.ts        token-guarded localhost queue the companion polls (+ selfTest)
  cache.ts        on-disk read cache
  verdict.ts      shared verdict-string helpers
  archive.ts      judge-agnostic on-disk layout, per-run/attempt records, rolled-up index
  migrate.ts      one-time move from the old layout (+ selfTest)
  files.ts        solution scaffolding, per-problem metadata (ProblemMeta over archive.ts)
  runner.ts       compile, run samples, diff
  statement.ts    statement webview
  resultsView.ts  Results panel (samples, attempts, submit)
  statsView.ts    Codeforces: Stats panel
  archiveView.ts  Archive view — offline browse of every run and submission
  walkthrough.ts  Setup walkthrough webview
  tree.ts         sidebar, local+API solve-state reconciliation
  extension.ts    commands, workspace picker, migration, wiring
browser/          companion Chrome extension (MV3) — see browser/README.md, browser/PRIVACY.md
```

## Privacy

The extension talks to `codeforces.com` and (for the companion pairing) `127.0.0.1` — nothing else, no analytics, no telemetry. Your session lives in VS Code's `SecretStorage`. Full detail, permission-by-permission, in `browser/PRIVACY.md`.

## License

GPL-3.0-or-later — see `LICENSE`. In short, for anyone forking this: if you distribute a modified version, it must also be open source under the GPL.
