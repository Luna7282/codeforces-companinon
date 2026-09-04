# Manual end-to-end test — browser relay (reads + submit)

> **All 10 steps were walked end to end against live Codeforces on 2026-09-04**
> (a test handle, a private group, problem *Introduction to C++ / A*),
> companion loaded in Chrome. Reads via the companion, submit filled by the
> companion + Turnstile solved by hand, verdict polled back into VS Code, and the
> attempt recorded to `.cf/`. Re-run this after any change to `browser/`,
> `src/relay.ts`, `src/http.ts`, or the scrapers.

Walk this once after installing the vsix and loading the companion. Each step
says what a pass looks like and the failure you're most likely to hit.

> **Cloudflare is currently blocking the extension's direct requests** (Node TLS
> fingerprint — `LESSONS.md`, 2026-09-04; the browser-session import was tried
> and does not get past it). So **the companion extension is now the transport
> for reads too**, not just submits: sidebar, statements, and verdict polling all
> go through it. That means **steps 1–4 (load + configure the companion) are a
> hard prerequisite for everything below**, and each read is a poll round-trip
> (~1–3 s the first time; statements are then cached on disk for 30 days, group
> lists for 15 min — `Codeforces: Refresh` clears the cache).
>
> If `Codeforces: Log in` or the sidebar ever works directly, Cloudflare's
> under-attack mode is off; the companion path stays dormant until the next
> block.

---

## 1. Load the companion extension unpacked

> ✓ Verified against live Codeforces — 2026-09-04.

- `chrome://extensions` → toggle **Developer mode** on → **Load unpacked** → in
  the dialog, open the **`browser`** subfolder itself
  (`D:\codeforce-extension\cf-vscode\browser`) and select that — not the repo
  root.
- **Working:** a "Codeforces Inline — submit relay" card appears, no errors, and
  *Inspect views: service worker* is a clickable link.
- **Likely failure:** "Manifest file is missing or unreadable / Could not load
  manifest" with a path ending in `cf-vscode` (not `cf-vscode\browser`) — you
  selected the repo root. Re-run Load unpacked and pick the `browser` folder.

## 2. Open the VS Code window that will hold the relay

> ✓ Verified against live Codeforces — 2026-09-04.

- Open this project (or any folder) in the VS Code where the vsix is installed.
- Run **Codeforces: Relay info (browser submit)** from the command palette.
- **Working:** copies `27121:<token>` to the clipboard in one action and shows
  a confirmation toast with the copied string.
- **Likely failure:** "the submit relay is not running" — port 27121 was already
  taken at activation. Set `codeforces.relayPort` to a free port, run
  **Developer: Reload Window**, retry.

## 3. Configure the companion

> ✓ Verified against live Codeforces — 2026-09-04.

- `chrome://extensions` → the relay card → **Details** → **Extension options**.
- Paste the copied `port:token` string into **Paste from Relay info** — it
  splits into the port and token fields below it automatically. **Save** →
  "saved" flashes.
- The token lives in a file under the extension's global storage (not
  `globalState` — see `LESSONS.md`, "the token still wasn't stable"), so it's
  stable across window reloads, VS Code restarts, and extension updates. You
  configure this **once**. If it ever does go stale, VS Code shows a one-click
  re-pair notification instead of a silent failure.
- Quick check from a terminal: `curl http://127.0.0.1:27121/health` →
  `{"ok":true,"port":27121,"tokenRequired":true}` (no token needed for
  `/health`). `curl -H "Authorization: Bearer <token>" .../pending` should
  **not** say `unauthorized`.
- **Likely failure:** token has leading/trailing spaces from the copy — the
  field trims on save, but double-check it matches the toast exactly. A wrong
  token shows in VS Code's **Codeforces** output channel as
  `[relay] REJECT GET /pending … branch=mismatch`.

## 4. Confirm the companion is polling

> ✓ Verified against live Codeforces — 2026-09-04.

- Fastest check: run **Codeforces: Check companion** in VS Code — it reports
  *polling / token rejected / asleep / not running*.
- For the service-worker console: tick **Verbose logging** in the companion's
  options first (traces are off by default), then click **Inspect views:
  service worker** on the relay card.
- **Working:** no red errors; with verbose logging, a `/pending` cycle every
  ≤20 s. `chrome://extensions` may show the worker as *(inactive)* between
  cycles — that's normal; a `chrome.alarms` keepalive re-polls it every 30 s.
- **Likely failure:** `Failed to fetch` repeatedly → the VS Code window from
  step 2 is closed, or the port/token don't match. `[cf-relay] poll paused:
  unauthorized` → wrong token. `poll paused: relay-down` → VS Code window
  closed / relay didn't start.
- **Intermittent "companion asleep":** Chrome suspended the MV3 worker after
  ~30 s idle. It self-recovers within ~30 s (keepalive alarm); to force it now,
  click the worker's **service worker** link on `chrome://extensions`. This is
  **not** a Codeforces/Cloudflare problem even though the message can look like
  one — run **Check companion** to confirm.

## 5. Session — you're already signed in via the companion

> ✓ Verified against live Codeforces — 2026-09-04.

The companion fetches with `credentials: 'include'`, so whatever account is
logged into that Chrome profile is the account the extension acts as. **Nothing
to do here** as long as codeforces.com is logged in in Chrome.

**Keep one codeforces.com tab open and past the "Just a moment" check.** The
companion tries a background fetch first; Cloudflare usually 403s that, so it
falls back to fetching inside a real codeforces.com tab. With no cleared tab it
opens one (visible) — solve the challenge there and retry.

- `Codeforces: Log in` (password) and `Codeforces: Import session from browser`
  are only for when Cloudflare's check is off — skip them now.
- Sanity check: the sidebar (step 6) will show your groups and mark solved
  problems, which only works if the companion is authenticated.
- **Likely failure:** sidebar loads but nothing is marked solved / groups you're
  in don't appear → that Chrome profile is signed out or is a different account.
  Log into codeforces.com in the same profile the companion runs in.

## 6. Open a group problem from the sidebar

> ✓ Verified against live Codeforces — 2026-09-04.

- Click the **Codeforces** icon in the Activity Bar. Expand your group → a
  contest → double-click a problem (e.g. *Introduction to C++ → A — Hello
  World*).
- **Working:** after a 1–3 s pause (companion round-trip) a solution file opens
  in column 1 and the statement renders in a webview beside it — limits, samples.
  Re-opening the same problem is instant (disk cache).
- **Likely failure:**
  - `The companion extension is asleep or not responding…` → after a ~30 s
    silent retry the worker still didn't wake. Run **Codeforces: Check
    companion**. If it says *asleep*, click the worker link on
    `chrome://extensions` and retry; if *not running*, redo steps 1–4.
  - `The companion extension is running but its relay token is wrong…` → it's
    polling but every request is 401. Re-run **Codeforces: Relay info**, re-paste
    port + token in the companion options. Confirm in the **Codeforces** output
    channel: `[relay] REJECT … branch=mismatch` (wrong token) vs `branch=bad-length`
    (truncated paste).
  - The open-problem call spins ~30 s before any message → that's the retry
    window waiting for the MV3 worker to wake; normal if the worker had been
    suspended.
  - "No problem statement on that page" → not a member of the group, or the
    contest hasn't started.
  - Contest names all showing as "Enter »" → old build; reinstall the vsix.

## 7. Run the samples

> ✓ Verified against live Codeforces — 2026-09-04.

- With the solution file focused, press `Ctrl+Alt+R` (**Codeforces: Run sample
  tests**) — or run it from the palette. (`Ctrl+Alt+B` belongs to `cph`; ours
  moved to `Ctrl+Alt+R` and only fires with an editor focused.) Put a correct
  solution in the file first — for *Hello World*:
  ```cpp
  #include <bits/stdc++.h>
  int main(){ std::cout << "Hello World"; }
  ```
- **Working:** the **Results** panel (below the problem tree) shows one card per
  sample — spinner while running, then a green PASS badge and the card collapses.
  A failing card stays open with input / expected / actual side by side and the
  first differing line highlighted. Per-card **Run**, a **Run all** button, and an
  **Add test** box (custom cases persist in `.cf/<file>.json`).
- **Likely failure:** `g++: not found` etc. → shows verbatim in a red block in
  the panel (not a toast); set `codeforces.compileCommand`. A wrong-answer card →
  the highlighted diff line points at where output diverges.

## 8. Submit via the relay

> ✓ Verified against live Codeforces — 2026-09-04.

- Press `Ctrl+Alt+Enter` (**Codeforces: Submit current file**) — or the palette.
  (`Ctrl+Alt+S` belongs to `cph`.) Pick a compiler if asked (e.g. *GNU G++17*).
- If nothing happens: the "not linked to a problem" case always prints the reason
  and the path it checked to the **Codeforces** output channel. For the rest of
  the trace (`[submit] invoked`, `[relay] …`), set `codeforces.debug: true` first.
- **Working, in order:**
  1. VS Code toast: `Queued A for browser submit. Switch to Chrome…`
  2. A progress notification: `Waiting for A to be submitted in the browser…`
  3. Chrome comes to the front on the correct submit URL —
     `…/group/<code>/contest/<id>/submit` for a group problem — with the
     compiler set, the problem index set, and your source already in the text
     box (the rich editor is switched off).
  4. Nothing is submitted yet; the Turnstile checkbox is untouched.
- **Likely failure:**
  - "not linked to a Codeforces problem" → the file wasn't opened via step 6.
  - Chrome doesn't navigate → companion not polling (step 4), or no Chrome
    window open at all.
  - Tab opens but the form is empty → Codeforces changed the submit-form field
    names; check the service-worker log for `filledSource:false` and compare
    against `src/submit.ts` / `browser/background.js`.
  - Source box still shows the rich editor → the "Switch off editor" checkbox
    wasn't found; the source may still be set via the CodeMirror fallback —
    verify the code is actually there before submitting.

## 9. Complete the challenge and submit — yourself

> ✓ Verified against live Codeforces — 2026-09-04.

- Solve the Turnstile check in the Chrome tab, click **Submit**.
- **Working:** Codeforces navigates to the submissions/status page and your
  submission appears (In queue → verdict).
- **Likely failure:** red text under the form — read it. "You have submitted
  exactly the same code" → edit a byte and resubmit. A Turnstile error → refresh
  the page, re-fill isn't automatic, so re-run step 8.

## 10. Verdict lands back in VS Code

> ✓ Verified against live Codeforces — 2026-09-04.

- Switch back to VS Code within 5 minutes of clicking Submit.
- **Working:** the progress notification clears; the status bar shows
  `A: <verdict>` (spinner while judging, then `$(pass-filled) A: Accepted` or
  `$(error) A: <verdict>`), clicking it opens the Codeforces output channel; the
  sidebar refreshes solved state.
- **Likely failure:**
  - `No new submission for A showed up within 5 minutes — did you press Submit?`
    → you didn't submit, submitted a different problem, or the companion stopped
    (the status page is read through it too now). Check the `/my` page in the
    browser — if your submission is there but VS Code didn't see it, the
    companion isn't answering.
  - Status bar sticks on `in queue` forever → same: the verdict poll can't reach
    the status page. The submission itself is fine on the site.

---

## What each piece needs

| action | needs companion (steps 1–4) | served by `/api` (direct, always works) |
| --- | --- | --- |
| sidebar: Contests / Gym / Problemset lists, solved marks | — | ✅ |
| sidebar: **group** contests + problem lists | ✅ (cached 15 min) | — |
| open a problem statement | ✅ (cached 30 days) | — |
| run samples | — (fully local) | — |
| submit | ✅ | — |
| verdict watch | ✅ | — |

Nothing is prompted for at activation — the tree populates from `/api/*`
immediately. The companion is offered only when you open a statement, add a
group, or submit. **Codeforces: Setup walkthrough** covers it.

## Direct POST (no relay)

Set `codeforces.directSubmit: true` to skip the relay and POST from the
extension. Only works when Codeforces is **not** enforcing Turnstile on the
submit form — expect it to silently fail (no submission queued) while it is.
