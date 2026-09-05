# Changelog

All notable changes to Codeforces Inline and its companion browser extension.

## [0.2.0] — packaging

### Extension
- Sidebar now browses **Contests, Gym, and a new Problemset (by rating)** entirely through Codeforces' public API — no setup, no companion, works the moment you install.
- Companion is now requested only when you do something that needs it (open a statement, add a group, submit), with a plain-language explanation instead of a raw error.
- A dismissible line at the top of the tree points at setup when the companion isn't connected.
- New **`Codeforces: Setup walkthrough`** command.
- New **`Codeforces: Change workspace folder`** command; the folder prompt no longer appears at activation — only the first time it's actually needed.
- Relay and companion now exchange a **protocol version** on every health check; a mismatched pair reports the exact problem instead of failing silently.
- **Deep link**: `vscode://<publisher>.<name>/openProblem?...` opens a problem, scaffolds the file, and focuses the editor. The URI is generated from `package.json`, never hardcoded (`scripts/gen-companion-config.js`), so publishing later is a config change.

### Companion (`browser/`)
- Added toolbar icons (16/48/128).
- Added an **"Open in VS Code"** button on Codeforces problem pages (`content.js`) that opens the deep link above, with a Marketplace-page fallback if nothing handles it.
- Added `browser/build.js` — builds a Chrome-Web-Store-ready zip (`npm run build:companion`).
- Added `browser/PRIVACY.md` — per-permission justification for the Web Store review form, including the new content script.
- Verbose logging moved behind an options-page toggle (off by default).

### Packaging
- Extension icon, `LICENSE`, `repository`/`bugs` links, keywords, removed the stray `private: true`.
- Switched license from MIT to **GPL-3.0-or-later** (`LICENSE`, `package.json`).
- Fixed `.vscodeignore` — it wasn't excluding generated solution folders or the `dist/` build output, so every previous `.vsix` shipped whatever was in your workspace alongside the extension. Neither was ever published; still, fixed.
- **Placeholders you must fill in before publishing** — see the note at the end of this file.

## [0.1.0] — initial build

First working end-to-end version, built and verified against live Codeforces:

- Browse contests, gyms, and group contests; read statements in a webview.
- Run samples locally with a diffed pass/fail per test, in a **Results panel** (per-test cards, first-diff-line highlight, custom test cases, in-panel compile errors).
- Submit and poll the verdict. Codeforces enforces a Cloudflare Turnstile CAPTCHA on the submit form and blocks this extension's own requests outright (TLS fingerprint) — so submitting and most reads go through a **companion Chrome extension** that fills the form and reads pages from a real logged-in tab; you solve the Turnstile and click Submit yourself.
- Local **attempt + run archive** (`.meta.json`, `attempts/`, `runs/` per problem, judge-agnostic layout) with a dedicated **Archive view** (offline, timeline of every run/submission, read-only source, diff against current file, search/filter) and a **`Codeforces: Stats`** command.
- A picked-once, globally-stored **workspace folder**, with non-destructive migration from an earlier ad hoc layout.

---

## Before publishing

Packaging succeeds today (`vsce package` needs syntactically valid values, not
real ones), but these are placeholders — replace every one before you actually
publish:

- `package.json`: `"publisher": "replace-with-your-publisher-id"` — register one at https://marketplace.visualstudio.com/manage, then update this and re-run `npm run gen:companion-config` (the companion's deep link is derived from it).
- `package.json`: `"repository"` / `"bugs"` URLs — currently `https://github.com/replace-with-your-org/replace-with-your-repo(...)`.
- `media/icon.png` — a placeholder flat mark generated for this pass, not real branding. Replace with real artwork (128×128 PNG minimum).
- Screenshots — marked `<!-- TODO -->` in `README.md`; add real ones from a live run (sidebar+statement+Results panel, and the Archive view).
- After changing the publisher: `npm run gen:companion-config`, then `npm run build:companion` for a fresh companion zip.
