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
- Statement images use root-relative `src` on some pages and are already
  absolute on others (e.g. served from an `espresso.codeforces.com` CDN
  subdomain) — rewrite only applies to the root-relative case, verified both
  paths against a real statement.

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

A `vscode://<publisher>.<name>/...` URI opens a specific problem in the
editor directly from a companion-injected button on a Codeforces problem
page. The publisher/name pair is never hardcoded in the companion's code —
a small script reads them out of the packaging manifest and generates a
small config file the companion's button script reads at runtime, so
changing the publisher id is a regeneration step, not a code edit. Verified
that the generated URI actually changes when the publisher value changes,
and that the button's URL-building and the editor-side URL-parsing agree on
every field via a standalone round-trip check.

There is no page-script API that reports whether a custom URI scheme was
actually handled by anything. The usual heuristic — did the page lose focus
within a short window after navigating to the link; if not, treat it as
unhandled and fall back to a plain web listing page — is what's used here.
Known limitation: if the target application is installed but this specific
extension isn't, the OS still switches applications (losing focus), which
this heuristic reads as "handled" even though nothing happened. Every
"open in app" web button that uses this pattern shares the same limitation;
there isn't a fix available from a web page alone.

## Open items

- Actual password login against live Codeforces from the extension's own
  Node-based HTTP layer remains unverified while Cloudflare's request block
  is active — it can only be exercised once that's not the case, or via the
  companion-relay read path instead (which is the default now regardless).
- Whether the exact combination of `sourceCodeConfirmed` / `contestId` /
  the computed `_tta` value is fully accepted by Codeforces beyond getting
  past validation can only be confirmed once a submission actually clears
  Turnstile end to end from this tool.
