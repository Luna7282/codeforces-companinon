# Lessons

Technical findings from building and testing this extension against live
Codeforces, organized by topic. Add to the relevant section when new markup,
API, or platform behavior is discovered; start a new section for a new
subsystem.

## Architecture — why it's built this way

1. **Node cannot fetch Codeforces HTML.** Cloudflare rejects Node/undici's TLS
   fingerprint before the request reaches Codeforces — every HTML route
   returns `403 "Just a moment…"`. Only `/api/*` is exempt.
2. **A valid session cookie doesn't fix it.** Importing `cf_clearance` +
   `JSESSIONID` + the exact browser User-Agent was tried — still
   `403 cloudflare-interstitial`. The block is on the TLS handshake, not the
   cookies.
3. **A browser service-worker fetch also gets 403'd** — no `Referer`,
   `Sec-Fetch-Site: none`. Reads have to run as a real page-context fetch
   (`executeScript`, MAIN world) inside a logged-in `codeforces.com` tab.
   Hence the companion browser extension, and the "keep a cleared tab open"
   requirement.
4. **Submit has a Cloudflare Turnstile CAPTCHA** on the form — no headless
   token is possible. The companion fills the form; a human solves Turnstile
   and clicks Submit.
5. **Groups are scrape-only** (`contest.list` has no group parameter, signed
   or not) and **there is no write API** (`/apiHelp` has promised submit
   "soon" for years — don't plan around it arriving).

Everything below is the detail behind those five points, plus later
subsystems built on top of them.

## Codeforces markup and API quirks

- `contest.list` does not return group contests, with or without a signed API
  key. There is no `group`/`groupId` parameter. Group support is scraping or
  nothing.
- The login form needs `csrf_token`, `action=enter`, `ftaa`, `bfaa`,
  `handleOrEmail`, `password`, `_tta`, `remember`. `ftaa` (18 chars,
  a-z0-9) and `bfaa` (32 hex chars) are generated once and reused for the
  life of the session — cf-tool stores them alongside the cookie jar for the
  same reason.
- The csrf token appears in three places depending on the page:
  `meta[name=X-Csrf-Token]`, a hidden `input[name=csrf_token]`, and an inline
  `csrf='...'` in a script. `findCsrf` tries all three; relying on only one
  is the historical cause of "cannot find csrf" failures in similar tools.
- Sample `<pre>` blocks come in two markups: older pages use `<br>` for line
  breaks, newer ones wrap each line in `<div class="test-example-line">`.
  `preToText` handles both; verified against a real problem statement where
  the sample used the newer div-per-line markup (11 lines, no `<br>`) and
  against one using a plain `<br>`-only block, correctly on both.
- Compiler ids change over time. Reading the `select[name=programTypeId]`
  dropdown off a live submit page avoids hardcoding an id that silently
  becomes wrong. Confirmed against a live page: 53 compilers on
  `/problemset/submit`, 34 on a specific contest's submit page, real
  ids/names in both (`43` GNU GCC C11, `54` G++17 7.3.0, `89` G++20, `91`
  G++23, `65` C# 8, …).
### `groupContests` name bug — every contest showed as "Enter »"

A group's contests page has its contest table as a `<table class="">`
(header `Name | Start | Length`). Each row's first cell is a bare text node
(the contest name) followed by `<br>` and an `<a href="/group/CODE/contest/<id>">Enter »</a>`,
then `<br>` and a "Virtual participation »" link. The original parser
matched `a[href*="/group/CODE/contest/"]`, deduplicated by id, and used the
**anchor's own text** as the name — which is always "Enter »", never the
actual contest title. (The regex anchor `(?:$|[?#])` was already correct — it
rejected the `/virtual` and `/standings` link variants.)

Fix: keep link-based id discovery, but require the link to sit in a table row
with at least two `<td>`s, and take the name from the enclosing `<td>`'s text
nodes directly (`$(el).closest('td').clone().children().remove().end().text().trim()`).
Verified against a real group's contests page: 31 contests recovered with
real names ("Greedy", "Heap", "Binary Trees - II", … "Introduction to
C++").

`groupProblems` needed no fix: a group contest's `table.problems` rows have
four cells `[index-link | name-link + limits | "" | solved-count]`; `cells[0]
a` gives the index, `cells[1] a` (first) gives the name. Verified against an
18-problem contest (indices A–Q including H1/H2), all parsed correctly.
`contestUrl` / `problemUrl` / `submitUrl` all resolve for a group problem.

## Cloudflare and session handling

### Node fetch is blocked outright

`fetch()` from Node — what the extension's HTTP layer uses, and what the VS
Code extension host uses — receives a **403 "Just a moment…" Cloudflare
interstitial** on every `codeforces.com` HTML route (`/enter`, `/contest/*`,
`/group/*`), reproducibly. Only `codeforces.com/api/*` is exempt.

The natural first fix — "open codeforces.com in a browser once, clear the
check, then retry" — does not work for a headless client: the `cf_clearance`
cookie Cloudflare issues is bound to the solving browser's TLS fingerprint +
User-Agent and does not transfer to Node's request stack.

### Browser-session import — tried, confirmed dead end

Built a command that imports `cf_clearance` + `JSESSIONID` + the exact
browser User-Agent into the extension's cookie jar, with `http.ts` sending
that UA verbatim (Cloudflare ties `cf_clearance` to the UA that solved the
challenge). Tested against live Codeforces with a valid, freshly-solved
`cf_clearance` + matching cookies + matching UA. A diagnostic that does a raw
`GET /enter` right after import and classifies the response returned:

```
verdict:        "cloudflare-interstitial"
status:         403
codeforcesHtml: false
bodyHead:       "<!DOCTYPE html><html ...><title>Just a moment...</title> ..."
```

The request never reaches Codeforces — Cloudflare rejects Node's TLS
handshake (JA3/JA4 fingerprint) before the cookie is even considered. A good
cookie set does not help. **Disguising Node's `fetch` as a browser is a dead
end** and shouldn't be retried. The import command is kept anyway — it still
helps on the occasions Codeforces' heightened-scrutiny mode is off, since
then the cookie alone is sufficient and the TLS check isn't applied.

### Fix: route reads through a companion browser extension

Reads and submits share one transport: a companion browser extension that
holds the real session and a real, browser-issued clearance.

- Job queue gained a discriminated type: `SubmitJob | FetchJob`.
- `GET /pending` hands over the head job unchanged; the companion branches on
  `job.type`. A fetch job carries `{ id, type: 'fetch', url }`.
- `POST /result` (token-gated, 8 MB cap, `{ id, status, body }`) resolves the
  pending promise and drops the job — a fetch job has no separate ack; the
  result *is* its completion.
- Companion's fetch handler: `fetch(job.url, {credentials:'include'})`, posts
  `{id, status, body}` back; refuses any non-`https://codeforces.com/` URL.
- The HTTP client gained a **sticky per-session latch**: the first direct
  read that hits a Cloudflare interstitial flips a flag, and every
  subsequent non-API read goes straight to the companion — no repeated
  failed Node request per read.
- `/api/*` always stays on direct Node fetch — that host isn't behind the
  interstitial and it's most of the read volume, so it stays fast.
- "Companion online" = a long-poll is currently held, or `/pending` was hit
  in the last 30 seconds. A fetch request rejects `companion-offline`
  immediately if not, `companion-timeout` after 20 seconds; the client turns
  both into a plain-language message rather than a raw Cloudflare dump.
- Disk cache added since each read now costs a poll round-trip: statement
  pages for 30 days (a finished problem's statement never changes), group
  contest/problem lists for 15 minutes. A manual refresh clears both.
- POST (login, direct submit) still can't ride this path — GET only. Login
  while Cloudflare is in this mode stays impossible from the extension
  itself; the browser-relay submit path already covers submitting. Verdict
  reads (the status page) do go through the companion now, uncached (verdicts
  change).

### A service-worker fetch is not a page fetch, as far as Cloudflare is concerned

Even after the relay chain was proven end-to-end, the companion's own
background `fetch(codeforces.com, {credentials:'include'})` still received a
Cloudflare 403 from inside the browser, with valid session cookies attached.
The service-worker request carries `Sec-Fetch-Site: none` and no `Referer`,
and no document/navigation context; Cloudflare scores that as non-browser
regardless of the underlying TLS stack being genuine Chrome.

Fix: keep the service-worker fetch as the fast path, and on a
Cloudflare-challenge response fall back to a **page-context fetch** —
`chrome.scripting.executeScript` with `world: 'MAIN'`, running
`fetch(url, {credentials:'include'})` literally as page JavaScript, so it
carries the real page origin, cookies, `Referer`, and
`Sec-Fetch-Site: same-origin`. The fallback tries each existing
`codeforces.com` tab first (usually already past the check); if none works,
it opens a visible tab as a last resort so a fresh challenge can be solved.
No new permissions needed (`scripting` + the existing `codeforces.com` host
permission cover it).

Implication: the companion is only fully functional while at least one
`codeforces.com` tab has passed the Cloudflare check. If every path 403s, the
raw 403 is surfaced with a message pointing at that.

### Turnstile is enforced on the submit form

The submit page (both the contest/gym/group forms and the general
`/problemset/submit`) carries a fully-wired Cloudflare Turnstile widget:
`div.cf-turnstile` with a real `data-sitekey`, `data-action=submit_solution`,
`data-cdata`, `data-response-field-name=turnstileToken`, the
`challenges.cloudflare.com/turnstile/v0/api.js` script, and
expired/error/timeout callbacks. A hidden `input[name=turnstileToken]` is
populated by that widget on a real page load.

Confirmed by replaying the submit POST's exact body (fresh page csrf in both
the query-string and header form, live session cookies, correctly computed
`_tta`, every other real form field) **without** `turnstileToken`, sent from
the page's own origin so Cloudflare's Node-fetch block wasn't a confound.
Result: no submission was queued (the target status page's row count didn't
change). The literal server error text wasn't recoverable in that test
environment, so the "enforced" conclusion rests on the non-queued submission
plus the fully-wired widget, not on a captured Codeforces error message —
worth another look if a way to capture that text directly ever presents
itself.

Consequence: headless submit cannot work while Turnstile is enforced.
Submitting was redesigned around a browser relay (see below). A direct-POST
path is kept behind a setting, off by default, for the times Turnstile isn't
enforced.

### `_tta` is computed from a cookie, not a constant

A widely-copied reference implementation hardcodes `_tta` as a constant
string. The real value is a checksum Codeforces computes client-side from the
`39ce7` cookie on every form. Verified the algorithm directly in a browser
session: the computed value matched the live form's `_tta` exactly (an
8-character cookie value produced `189`, matching what the page itself sent).
The extension now computes it, falling back to the old constant only when the
cookie is absent (e.g. a session that hasn't loaded any page yet):

```
e = 0
for n in 0..len-1:
    e = (e + (n+1)*(n+2)*code(s[n])) % 1009
    if n % 3 == 0: e += 1
    if n % 2 == 0: e *= 2
    if n  > 0:     e -= trunc(code(s[trunc(n/2)]) / 2) * (e % 5)
    e = ((e % 1009) + 1009) % 1009
```

### Submit form field cross-check

Live contest/group submit form fields: `csrf_token, ftaa, bfaa, action,
submittedProblemIndex, programTypeId, source, tabSize, sourceFile,
turnstileToken, _tta`. (`/problemset/submit` uses `submittedProblemCode`
instead of `submittedProblemIndex`; the extension only targets
contest/gym/group submit URLs, where `submittedProblemIndex` is correct.)

The extension's submit POST sends `contestId` and `sourceCodeConfirmed="true"`
in addition to the form's own fields — the latter is the "you submitted
exactly the same code before" gate, needed to get through a resubmit
cleanly — computes `_tta` as above, and omits `sourceFile` (an empty file
input in the real form; harmless to omit). It does not and cannot send
`turnstileToken`.

## Relay and companion

### Design

Submitting and most reads now go through a **browser relay** (conceptually
similar to other "submit via your browser" tools, extended here with group-URL
support, which prior art in this space generally lacks):

- A localhost HTTP queue bound to `127.0.0.1`, gated by a random token
  generated at activation and shown by a "relay info" command. Endpoints:
  `GET /pending` (long-polls), `POST /ack`, `POST /result`,
  `POST /submit-result`, `POST /companion-error`, `GET /health`
  (unauthenticated, so the companion can find/verify the server before it
  has a token).
- An unpacked MV3 companion browser extension. Its service worker long-polls
  `/pending`, and for a submit job opens the correct submit URL (contest,
  gym, or **group**) in the user's logged-in tab, fills compiler + problem
  index + source (switching off the rich editor in favor of the plain
  `textarea[name=source]`), then stops. The user solves Turnstile and clicks
  Submit; the companion never clicks it and never touches the challenge
  itself.
- The submit command branches on a direct-vs-relay setting. In relay mode it
  enqueues the job, then discovers the new submission id from the status
  page (the newest row whose problem link matches the submitted problem), so
  the verdict-polling loop needed no changes.

### Auth bugs found on first real use — fixed

A request with a correct token in a standard `Authorization: Bearer` header
was rejected as unauthorized. Two separate bugs, neither the timing-safe
comparison (the length guard ahead of it was already correct):

1. Token extraction only read a custom `X-Relay-Token` header — a standard
   `Authorization: Bearer` header was never inspected, so no token was ever
   seen for that request shape. Fixed to accept `X-Relay-Token`,
   `Authorization: Bearer <token>`, and a raw `Authorization: <token>`.
2. `/health` sat behind the auth gate entirely, so a companion couldn't even
   probe for the server's existence without already having a valid token.
   Moved to before the auth check, unauthenticated, returning
   `{ ok, port, tokenRequired, protocolVersion }`.

Also done in the same pass: the token is persisted across window reloads
instead of regenerated each time; a `companionStatus` of
`online | auth-rejected | offline` is exposed, with a rejected request
stamping a "last rejected" timestamp so "wrong token" can be told apart from
"nothing is polling"; one log line is written per rejected request
(endpoint, token-present, received/expected length, rejection reason); and a
self-test exercises every accepted and rejected auth shape over a real HTTP
server, including the Bearer-header case the earlier ad hoc check had missed
because it only ever exercised the custom header.

### The token still wasn't stable — `globalState` has no cross-window atomicity

The line above ("the token is persisted... instead of regenerated each time")
described the intent, not reality: `globalState.get()` then `.update()` is
two steps with no compare-and-set. This extension activates in every window
(no `workspaceContains` restriction), so two windows opening around the same
time both read "no token yet", each minted their own, and both wrote — last
write wins in storage, but the window that lost the race kept running its
now-orphaned in-memory token until its next reload, when it picked up
whatever the *next* race happened to leave behind. It only takes one such
race, ever, ~to permanently desync two windows' idea of the current token,
which reads as "the token randomly changes every few hours" from the outside.

Fixed by moving the token out of `globalState` and into a file under
`globalStorageUri` (a real path shared by every window on the profile),
written with `fs.writeFileSync(file, candidate, { flag: 'wx' })` — exclusive
create, atomic at the OS level. Whichever window gets there first wins;
every other window, now or on a later reload, reads that same file back
instead of minting its own. Verified with 20 real concurrent processes
racing to create the file: all 20 converged on one token every time, vs. the
old `globalState` approach which had no such guarantee.

Also added: `RelayServer` now takes an `onAuthRejected` callback, fired once
when a poll request starts failing auth after a stretch of not failing
(companion has a stale token). The extension turns that into a one-click
"Codeforces: the companion is using an old relay token. Re-pair it." →
**Relay info** notification, instead of the previous silent failure that
only surfaced if the user thought to run **Check companion** themselves.

### MV3 service-worker suspension looks exactly like a Cloudflare failure

Chrome suspends an idle MV3 service worker after roughly 30 seconds. When the
companion's worker is asleep it stops polling, and shortly after that the
relay reports the companion offline — which used to surface as a generic
"start the companion" / Cloudflare-flavored message even when the companion
was installed, enabled, and correctly configured. This is intermittent and
reads as a Codeforces/network problem every time unless it's specifically
understood to be worker suspension.

What keeps a worker alive: a pending `fetch`, and `chrome.alarms` events.
`setTimeout`/`setInterval` do not — a timer-driven backoff loop just keeps a
half-dead worker that Chrome kills anyway. Fixes:

- The poll loop reconnects the instant a long-poll returns (shortened to 20
  seconds), so there's no idle gap while the relay is reachable. When the
  relay is unreachable or unauthorized, the loop *returns* instead of
  spinning on a timer — the worker is allowed to suspend, and a
  `chrome.alarms` keepalive (the shortest period Chrome allows) revives it.
  The alarm handler is idempotent, so it never starts a second loop.
- On the extension side, a blocked read retries for up to 30 seconds (5
  second cadence) rather than failing on the first miss — long enough for
  the keepalive alarm to wake a suspended worker.
- A dedicated "check companion" command reports one of: polling / token
  rejected / asleep (has connected before, gone quiet) / not running
  (never connected) — the "asleep vs. never connected" distinction matters
  because the fix and the message are different.

### A refused submission looks identical to a broken verdict poller

Codeforces refused a submission with "you have submitted exactly the same
code before" — a red error span on the submit page, with no submission row
ever created. From the extension's side this was indistinguishable from a
genuinely broken verdict poller: the wait loop ran its full multi-minute
budget waiting for a new submission id, then reported a generic "did you
press Submit?" message — which reads as blaming the user for a rejection
they had no way to act on. This came close to triggering an unnecessary
rewrite of an otherwise-working poller before the actual cause was found.

Fix (the verdict poller's transport itself needed no change): after filling
the form, the companion starts a **detached** watcher that polls the submit
tab every few seconds for a visible error span, for navigation away from the
submit URL (meaning accepted), or for the tab closing, and reports whichever
happened to a new endpoint. The wait loop checks for that report on every
tick and, on an error, raises the actual Codeforces message immediately
instead of waiting out the timeout. The watcher is detached specifically so
it can never block the main poll loop; if the MV3 worker suspends mid-watch
the report is simply lost and the extension falls back to the old timeout
behavior.

Verdict and submission-wait poll intervals were also widened (2–3 seconds to
4 seconds) — each poll is a full companion round-trip now, and the tighter
interval was needlessly aggressive for that cost.

### Protocol version pinning

The relay and companion exchange a protocol version on every health check. A
mismatch (only one side updated) makes the companion log an unconditional
console error, report it back to the relay so it's visible on the extension
side too, and stop polling until it's fixed — the intent is that a
mismatched pair fails with a specific, visible message rather than a
silent hang.

### Statement images — broken icon, not a 403 the extension can see

Reported as "the statement panel shows a single broken-image icon" on a
problem with diagrams in its Note section. Investigated by loading the exact
page in a real, logged-in Chrome session rather than guessing:

- `naturalWidth`/`naturalHeight` on the one `<img>` in the statement came
  back 4532x1658 — one wide image with four panels side by side (an ICPC-
  style layout), not four missing images. The Note text's "the second
  image / the third image" refers to panels within it.
- The src was already absolute (`espresso.codeforces.com`, Codeforces's own
  LaTeX/diagram render CDN) — not root-relative, not protocol-relative, so
  the then-current prefix-matching rewrite correctly left it alone. That
  ruled out the rewrite as the cause.
- `curl` against that exact URL got `403` + a "Just a moment..." Cloudflare
  challenge page, **with or without a `Referer` header** — so not hotlink
  protection, the same TLS/bot-fingerprint block already documented for
  `codeforces.com` itself, just on this CDN subdomain too. A blocked
  response comes back `Content-Type: text/html`, which is exactly what
  renders as a browser's broken-image icon in an `<img>` tag — there is no
  403 for the extension to see or branch on, only a content-type mismatch.

Fix: resolve every image `src` shape (root-relative, protocol-relative, bare)
against the page URL with the `URL` constructor instead of prefix-matching,
then fetch each one's bytes and inline as a `data:` URI — same
Cloudflare-fallback pattern as a page fetch (direct attempt first, companion
relay on failure), extended to binary: the fetch-job wire protocol gained a
`binary` flag and a `contentType` field so the companion base64-encodes
instead of mangling bytes through `.text()`, and success is judged by
content type, never status code alone (a blocked response can share a
status with a real one). `host_permissions` broadened from exact-origin
`codeforces.com` to `*.codeforces.com` for this.

Initially skipped a tab-based fallback for images the way the text-fetch path
has one: that fallback works by running `fetch()` inside an already-open
`codeforces.com` tab, same-origin, never hits CORS — but a same-page
`fetch()` to `espresso.codeforces.com` throws a CORS-shaped `TypeError`,
because that's a *different* subdomain (cross-origin). Shipped the
service-worker fetch alone on the (reasonable, but wrong) theory that a
genuine Chrome TLS fingerprint would be enough where curl/Node aren't.

**It wasn't.** Real-world testing showed the companion's own service-worker
fetch *also* gets the 403 + `text/html` challenge on this subdomain — TLS
fingerprint alone doesn't pass Cloudflare's check here, it wants page
context, same as the main site. Three follow-up paths tested by hand, in
order, before writing any more code:

1. **Same-page `<img>` → `canvas` → `toDataURL()`.** The image itself loads
   fine (no CORS on a plain `<img src>`), but `toDataURL()` throws
   `SecurityError: Tainted canvases may not be exported` — confirmed
   `espresso.codeforces.com` sends no CORS headers, so the canvas is tainted
   the moment the image is cross-origin to the page. Ruled out.
2. **Open the image URL as a top-level navigation in a background tab, read
   it back via canvas from inside that tab.** Works: a genuine top-level
   navigation is not challenged (same as visiting any codeforces.com page
   works) — Chrome's native image-viewer page loads the real image. Once
   there, the page *is* espresso.codeforces.com, so the image is same-origin
   to it and `canvas.toDataURL()` succeeds untainted. Confirmed end-to-end:
   4532x1658 image in, a valid `data:image/png;base64,...` out. This is
   what shipped — `chrome.tabs.create({url, active:false})`, wait for
   `status:'complete'`, `chrome.scripting.executeScript` to read the canvas,
   `chrome.tabs.remove` when done.
3. **If that had also failed:** don't inline, and don't leave a bare `<img>`
   pointed at a URL already known to be unreachable either — a broken icon
   with no explanation is worse than an honest one. `problemDetail` replaces
   such an `<img>` with a `.cf-image-unavailable` note plus a plain
   `<a href>` to the original URL; VS Code webviews hand off a plain
   `https://` anchor click to the user's real browser, where the image loads
   fine (it was only ever blocked in the webview's own request contexts, not
   a real browser navigation). This path is exercised by the self-test (one
   fixture URL is made to fail every attempt) even though live testing never
   needed it — path 2 covered the real case.

Two false leads ruled out along the way, each confirmed rather than assumed:
the webview's own CSP (`img-src https://codeforces.com https: data:;`) — the
bare `https:` scheme token already permits any https host, so this was never
the blocker even before inlining; and the statement cache — `clearCache()`
(what **Codeforces: Refresh** already calls) deletes every `.json` file in
the shared disk-cache directory, statements included, verified by writing a
`problemDetail:` entry, clearing, and confirming the read comes back empty.
Refresh already invalidated the stale HTML; what it doesn't do is force an
*already-open* statement panel to re-render, which needs the problem
reopened, not just the tree refreshed. Added a dedicated **Codeforces: Clear
cache** command anyway, since Refresh's cache-clearing effect is otherwise
silent and easy to mistake for "did nothing" — and `codeforces.debug`-gated
logging through the whole `getImageDataUri` path (direct attempt, status/
content-type seen, companion fallback, final inline-or-give-up decision) so
a real failure shows exactly where it breaks instead of needing another
round of hand-testing.

### Two windows, one relay port

The extension activates in every VS Code window, but the relay binds one
shared port (`codeforces.relayPort`, default 27121) — only one window can
ever hold it. Before this fix, the second window's `RelayServer.start()`
rejected with `EADDRINUSE`, and `activate()`'s catch handler treated that
identically to "something unrelated is squatting the port": it warned
"relay could not start... free the port and reload" and set `relay =
undefined` for the rest of that window's life. Reloading a window can never
free a port a *different* window holds, so that window was permanently
stuck until manually closed and reopened after the first one shut down.

Reproduced headlessly rather than by hand with two real windows: two real
`RelayServer` instances (or, easier, the actual currently-running relay from
a real window plus one more `RelayServer.start()` call) both targeting
27121 — confirmed the exact `EADDRINUSE` and the exact misleading message.

Fix: `EADDRINUSE` alone doesn't say *who* holds the port, so it's never
trusted alone — a `GET /health` on that port is checked against our own
`/health` shape (`tokenRequired: true`, a numeric `protocolVersion`) before
deciding anything. If it matches, this is a sibling window of the same
extension, not a failure: that window's relay works, the companion is
paired to it, and this window just remembers the port
(`remoteRelayPort`) instead of discarding all relay state. `checkCompanion`,
`relayInfo`, and the submit path now report *that* accurately ("another VS
Code window is running the relay, on port N") instead of "not running."

Considered making every window's relay fully usable at once (routing jobs
through whichever window owns the port, over a small internal HTTP API) —
correct, but a real new cross-window RPC surface to get right and to test.
Went with the smaller fix instead: the owning window's `deactivate()`
already calls `relay.stop()`, which already frees the port — nothing new
needed there. What was missing was any other window *retrying* after that.
`ensureRelay()` does exactly that, called right before anything that
actually needs the relay (submit, Check companion, Relay info) — so the
next window to need it picks up ownership automatically once the original
owner closes, with no explicit handoff message between windows required.
Only one window's relay ever runs at a time; this doesn't change that, it
just makes the state truthful and self-healing instead of stuck.

### Multiple languages per problem

Requested as "the metadata is currently keyed per source file
(`.cf/<filename>.json`) — move it to per-problem." Checked before building
anything: it already is. `.cf/<filename>.json` is the *pre-migration* layout
`migrate.ts` converts away from; the current one (documented at the top of
this file, under "Local archive") already keys `.meta.json` and
`attempts/`/`runs/` off the *problem directory*, not the filename — two
files in the same folder already shared metadata correctly. The user's
belief traced back to a real bug, though: `activeMeta()`'s "not linked to a
problem" message printed `.cf/${path.basename(where)}` — a path shape that
hasn't existed since the migration — so anyone hitting that message would
reasonably think that's still how it works. Fixed the message; a
`TESTING.md` line had the same stale claim.

So the actual gaps were elsewhere, all downstream of language being a
single **global** setting:

- `codeforces.compileCommand` / `runCommand` were one template each — no way
  to say "C++ compiles like *this*, Python runs like *that*". Replaced with
  `codeforces.languages`, keyed by file extension.
- `codeforces.programTypeId` / `programTypeName` were one global value —
  meaning switching languages for problem B could silently submit problem A
  under the wrong compiler if you hadn't re-picked. Worse, the numeric id
  itself isn't portable between contests (Codeforces renumbers compilers per
  contest), so a *stored* id was never fully correct even for a single
  language — this was a latent bug independent of multi-language support.
  Fixed by never persisting the id at all: only the compiler *name* is
  remembered, per extension, and re-matched against a fresh per-problem
  compiler list every time an id is actually needed.
- Nothing scaffolded a second language's file — picking a different compiler
  just changed a setting. `pickLanguage()` now checks whether the picked
  compiler's inferred extension (`extensionForLanguageName()`, a best-effort
  name→extension table — Codeforces has no API for this) differs from the
  active file's; if so it scaffolds that file (never overwriting one that
  exists, via `ensureSolutionFile`'s existing "only if absent" check) and
  switches focus to it. Same-extension picks just update the remembered
  name — no file churn for "I want a newer G++ standard."
- `RunRecord` had no `language` field (`AttemptRecord` already did) — added
  one, tagged from the active file's extension at run time. Also had the
  fold-identical-runs comparison start checking `language` too, even though
  two different languages sharing byte-identical source is exceedingly
  unlikely — the check was one line and the alternative (a Python run's
  count silently absorbed into a same-source C++ run's history) is a genuine
  correctness bug, however rare, cheap to close off.
- The compiler status-bar item and the Results-panel chip were both plain
  text with a click handler and nothing that read as "this opens a menu" —
  added a trailing chevron to both.
- The Results panel showed the problem and the language, but not *which
  file* — a real gap once a problem can have more than one open at once.
  Added the active file's basename to the header.

## Local archive

### Layout

Everything the user has done is stored under one globally-configured folder,
keyed by `{ judge, scope, groupCode?, contestRef, index }` rather than
assuming a single judge, so a second judge could be added later without a
migration:

```
<root>/
  codeforces/
    group-<code>-<contestId>/  gym-<contestId>/  contest-<contestId>/
      A/
        A.cpp                       current source
        .meta.json                  ref, problem info, samples, user tests
        runs/<timestamp>.json       one per local run
        attempts/<timestamp>.json   one per submission
  .archive-index.json               rolled-up index for fast reads
```

The pre-archive layout (`group-*/gym-*/<digits>/` folders with a `.cf/`
metadata subfolder holding one JSON per problem, attempts inline in an
array) migrates into this layout the first time the tool is pointed at a
folder that has it: every problem is copied and verified before anything is
deleted from the old location, and files that don't look like source (build
artifacts, other tools' cache files) are left untouched rather than guessed
at.

### Run capture and dedup

Every local run — run-all, a single test, or a compile failure — is recorded:
timestamp, the source at that moment, compile output, and per-test outcome
(pass/fail/TLE/RE, runtime, expected, actual). A run whose source is
byte-identical to the immediately preceding one, with the same per-test
outcome, folds into that record as a count + latest-timestamp instead of
writing a new file — otherwise near-identical repeated runs during debugging
would dominate the archive. A change in either source or outcome always
earns a new record.

### Archive view

A dedicated, fully offline view: browse judge → scope → problem → timeline.
A problem's timeline interleaves runs and submissions, newest first;
consecutive entries with the same outcome collapse into one expandable row,
so what's visible by default is where something *changed*. Selecting an
entry opens its exact recorded source read-only, with the outcome (verdict,
or per-test results) shown alongside, and offers a diff against the
problem's current source file. Search (by problem name) and a verdict
filter are available from the view's title bar. Everything here reads only
from local files — no network, no relay — so it works with Codeforces
unreachable.

### Tree solve-state reconciliation

The sidebar's solved/attempted state reconciles two sources: the official
API's status for the configured handle, and the local archive (which is
authoritative for attempts Codeforces refused outright — those never appear
in the API). A local Accepted record or an API "solved" status both count as
solved; any local attempt or an API "attempted" status counts as attempted.
Right after a fresh verdict, the tree also gets a short-lived optimistic
override so the icon repaints immediately rather than waiting for the API's
own status to catch up (which can lag a fresh Accepted by up to a minute).

## Usable without the companion

The read-only public API is not behind the Cloudflare block described above,
so contest, gym, and problemset browsing (plus solved/attempted marks, given
a configured handle) work immediately with no setup and no login. Only
problem statements, group contests, and submitting need the companion
(statements aren't served by the API at all; groups aren't either; submitting
needs a human for the CAPTCHA).

Because of that split, a first-time user could previously browse
successfully and then hit an unexplained wall the moment they opened a
problem. Fixes: the workspace-folder prompt no longer appears at activation,
only the first time a problem is actually opened; a dismissible line appears
at the top of the tree whenever the companion isn't connected, linking to a
setup walkthrough that leads with *why* the companion is needed (it's most
of what the tool does) rather than what already works; and any action that
needs the companion offers that walkthrough instead of a bare error when it
fails for a companion-shaped reason.

## Packaging

- A tool used to package the extension validates the publisher id's shape
  and rejects one that isn't a plausible identifier (rejects
  underscores/uppercase with an explicit error) — a placeholder value used
  before a real publisher is registered needs to be syntactically valid, not
  just obviously a placeholder, or packaging fails outright.
- The `.vscodeignore` file used to decide what ships in a package is entirely
  separate from `.gitignore`, and for a while excluded neither generated
  solution folders nor a build-output folder — meaning every locally-built
  package included whatever local solution/attempt data happened to be
  sitting in the workspace alongside the source. Nothing built that way was
  ever published, but it's exactly the class of bug packaging review exists
  to catch; fixed to mirror the same exclusions as version control.
- With no design tool available, a small hand-rolled PNG encoder (raw pixel
  buffer through the platform's standard compression call, wrapped in PNG
  chunk framing with a table-based CRC32) produced a placeholder icon at the
  sizes both the extension and the companion's toolbar icon need, rasterizing
  the existing vector mark. Explicitly placeholder-quality, not real
  branding — verified by rendering the output back to confirm it's a valid
  image, not just that the encoder didn't throw.
- The companion's packaged form (a zip for browser extension store
  submission) is built with a small from-scratch ZIP writer (uncompressed
  entries — the companion is only a few kilobytes, not worth a library or a
  platform-specific external tool for) rather than a dependency or a shelled-
  out system tool, so the build step has no extra requirements. Verified by
  extracting the output with a standard archive tool and re-parsing the
  extracted manifest.
- A permission-by-permission justification document was written for the
  companion's store-review privacy form. The two permissions expected to draw
  the most scrutiny — a localhost host permission and a broad
  `codeforces.com` host permission — get the most detail: exactly which port
  and token gate the localhost connection, and that no other host is ever
  contacted.

### Deep link

A `vscode://<publisher>.<name>/...` URI opens VS Code at whatever Codeforces
page the click came from — a problem opens that problem; a contest, gym, or
problemset page reveals it in the Explorer tree; a group page reveals it too,
adding the group first if it wasn't already. Two triggers: a companion-
injected button (problem pages only) and the companion's own toolbar icon
(any codeforces.com page — the button doesn't exist on non-problem pages).
The publisher/name pair is never hardcoded in the companion's code — a small
script reads them out of the packaging manifest and generates a small config
file both the button and the toolbar-icon handler read at runtime, so
changing the publisher id is a regeneration step, not a code edit. Verified
that the generated URI actually changes when the publisher value changes,
and that the companion's URL-building and the extension-side URL-parsing
agree on every field via a standalone round-trip check.

### Focus-loss is not a "did it work" signal — first real use, again

The original fallback heuristic — did the page/window lose focus within a
short window after navigating to the vscode:// link; if not, treat it as
unhandled — read as "unhandled" almost always in practice, not just the one
documented edge case (extension not installed but VS Code is). Chrome's own
"Open Visual Studio Code?" handoff for an unrecognized scheme doesn't
reliably blur the tab or the window, so the fallback (a Marketplace tab)
opened even on a clean, successful launch — and pre-publish, with the
placeholder publisher id, that fallback URL was itself garbage. Silent
success is strictly better than a spurious tab; a heuristic that can't tell
those apart isn't worth keeping.

Fixed by replacing the guess with a real signal: the click carries a random
per-click `ackId`; the extension's URI handler reports it straight to the
relay (`RelayServer.reportDeepLinkAck`, in-process — no HTTP hop needed on
that side) the instant the link lands, before any slow statement fetch; the
companion polls `GET /deeplink-ack?id=` for up to 3s before deciding to show
the Marketplace fallback. The same poll naturally covers "VS Code isn't
running at all" (the fetch itself fails) and "VS Code is running but this
extension isn't" (nothing ever acks) — one mechanism, not two. Bumped
`PROTOCOL_VERSION` since this is a new required endpoint.

## Open items

- Actual password login against live Codeforces from the extension's own
  Node-based HTTP layer remains unverified while Cloudflare's request block
  is active — it can only be exercised once that's not the case, or via the
  companion-relay read path instead (which is the default now regardless).
- Whether the exact combination of `sourceCodeConfirmed` / `contestId` /
  the computed `_tta` value is fully accepted by Codeforces beyond getting
  past validation can only be confirmed once a submission actually clears
  Turnstile end to end from this tool.
