# Codeforces Inline — submit relay (companion Chrome extension)

Codeforces guards the submit form with a Cloudflare **Turnstile** challenge that
a headless POST can't satisfy (see `../LESSONS.md`, 2026-09-04). So the VS Code
extension can't submit on its own. This companion bridges the gap:

```
VS Code "Codeforces: Submit"  ──enqueue──▶  localhost queue (127.0.0.1:<port>, token-guarded)
                                                     │  long-poll
                                                     ▼
                                        this extension's service worker
                                                     │
                            opens the right submit page in your logged-in tab,
                            fills compiler + problem + source, then STOPS
                                                     │
                                                     ▼
                        YOU solve the Turnstile check and click Submit
```

It never clicks Submit and never touches the challenge widget. Verdict polling
still happens in VS Code — it finds your new submission on the status page.

Group contests (`/group/<code>/contest/<id>/submit`) are supported — that's the
whole reason this exists; `cph-submit` doesn't do groups.

## Load it unpacked

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick
   this `browser/` folder.
2. In VS Code run **Codeforces: Relay info (browser submit)**. Copy the port and
   token.
3. Open this extension's **Options** (`chrome://extensions` → Details → Extension
   options) and paste them. Save.
4. Stay signed in to codeforces.com in that Chrome profile.

## Use

1. In VS Code, open a problem's solution file and run **Codeforces: Submit**
   (`Ctrl+Alt+Enter`). Pick a compiler if asked.
2. Chrome jumps to the submit page with everything filled in.
3. Solve the Turnstile check, click **Submit**.
4. VS Code picks up the verdict.

### "Open in VS Code" button

On any Codeforces problem page (contest, gym, group, or problemset) this
companion adds a small **Open in VS Code** button (bottom-right). Clicking it
opens `vscode://<publisher>.<name>/openProblem?...` with that problem's
reference — VS Code scaffolds the file, loads the statement, and focuses the
editor. If nothing handles the link (VS Code, or this extension, isn't
installed) it falls back to the Marketplace listing after ~1.5 s. The
publisher/name are never hardcoded here — see **Packaging**, below.

If nothing happens: run **Codeforces: Check companion** in VS Code — it says
whether the companion is polling, asleep, token-rejected, or absent. Also check
the port/token match, that the VS Code window is open (the relay dies with it),
and the service worker log at `chrome://extensions` → Details → *Inspect views:
service worker*.

Chrome suspends this worker after ~30 s idle (`service worker (inactive)`). That
is expected — a `chrome.alarms` keepalive re-polls every 30 s, and VS Code
retries a blocked read for ~30 s to cover the wake-up. To wake it instantly,
click the **service worker** link on `chrome://extensions`.

## Notes

- **Keep at least one codeforces.com tab open and past the Cloudflare check.**
  Reads try a background service-worker fetch first, but Cloudflare often 403s
  that; the companion then re-runs the fetch inside a real codeforces.com tab. If
  no cleared tab exists it opens one (visible) so you can solve the challenge.
- Filling the source turns Codeforces' rich editor **off** for that tab (uses the
  plain textarea). Toggle it back on by hand if you prefer it.
- The relay listens on `127.0.0.1` only and rejects any request without the
  token, so other pages in your browser can't read your source or queue
  submissions. Treat the token like a password.
- Direct POST is still available in VS Code via the `codeforces.directSubmit`
  setting — only useful when Codeforces isn't enforcing Turnstile.
- The extension and companion exchange a **protocol version** on every
  `/health` check. If they're out of sync (e.g. only one side was updated),
  the companion logs a clear error to its console, reports it back to VS Code
  (`Codeforces: Check companion` shows it), and stops polling until it's
  fixed — never a silent hang.

## Packaging

`node build.js` (or `npm run build:companion` from the repo root) writes a
Chrome-Web-Store-ready zip to `../dist/`. It first needs
`deeplink-config.js`, generated from the root `package.json`'s
`publisher`/`name` (`npm run gen:companion-config`) — `build:companion` runs
that for you. Regenerate it by hand after changing either field.

See `PRIVACY.md` for the per-permission justification the Web Store review
form asks for.
