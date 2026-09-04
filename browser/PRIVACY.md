# Privacy practices — Codeforces Inline relay

For the Chrome Web Store's "Privacy practices" tab. This extension talks to
exactly two hosts and nothing else: **`127.0.0.1`** (the paired VS Code
extension, on the port you configure) and **`codeforces.com`**. It has no
analytics, no third-party requests, no remote config, and stores nothing
outside your machine. See `../LESSONS.md` for the full background on why it exists.

## Single purpose

Codeforces blocks the VS Code extension's own network requests (a Cloudflare
TLS-fingerprint check, and a Turnstile CAPTCHA on the submit form — neither
passable headlessly). This extension reads Codeforces pages and fills the
submit form **from a real, already-logged-in browser tab**, and hands the
result to the VS Code extension over localhost. It does not submit anything
by itself — you always complete the Cloudflare challenge and click Submit
yourself.

## Permission justification

### `host_permissions: http://127.0.0.1/*` — will draw review scrutiny

This is the pairing channel to the user's own VS Code extension, nothing
else. Concretely:

- The extension only ever connects to the **port the user typed into its own
  options page** (`chrome.storage.local`), which the user copied from the VS
  Code command **"Codeforces: Relay info"** on their own machine.
- Every request carries a random token, also copied from that same VS Code
  command, that the local relay generates on startup and checks with a
  constant-time comparison — a page on some other site cannot guess it, and a
  wrong token is rejected with `401`.
- No wildcard or remote host is contacted over this permission; `127.0.0.1`
  resolves only to the user's own machine, never to a server we operate.
- There is no way to declare "loopback, this specific port only" in a Chrome
  extension manifest — a full host_permission for `127.0.0.1` is the closest
  available grant, scoped down entirely by the token at the application
  layer.

### `host_permissions: https://codeforces.com/*` — will also draw scrutiny

Needed to read Codeforces pages (statements, group listings, the submit form,
the status page) as a normal logged-in request, and to fill the submit form.
No other site is ever navigated to or read. The extension does not modify,
delete, or exfiltrate anything from the user's Codeforces account beyond
what the user's own VS Code extension explicitly requested (a specific URL to
read, or a specific submission to fill in) — see `scripting` below for the
one thing it writes.

### `scripting`

Used for two things, both confined to `codeforces.com` tabs:

1. Injecting a same-page `fetch` (MAIN world) to read a Codeforces page when
   the extension's own background fetch is Cloudflare-blocked — this makes
   the request look like an ordinary page fetch (correct `Referer`,
   `Sec-Fetch-Site`), which a background service-worker fetch cannot.
2. Filling the submit form's compiler, problem index, and source fields, and
   watching for Codeforces' own error text after the user submits. It never
   clicks Submit and never touches the Turnstile widget.

### `tabs`

Used to find an existing `codeforces.com` tab to reuse (so we don't spawn a
new one for every action) and to open/focus one when none exists. We read
tab URLs only to recognise "is this a codeforces.com tab", not browsing
history in general.

### `storage`

Holds exactly three values, all set by the user on the extension's own
options page: the relay port, the relay token, and a debug-logging toggle.
Local to the browser profile (`chrome.storage.local`); nothing syncs, nothing
leaves the machine.

### `alarms`

Chrome suspends an idle MV3 service worker after ~30 s. A periodic alarm (the
Chrome-enforced minimum interval, 1 minute) wakes it so it keeps polling the
local relay. No data is read or sent by the alarm itself — it only calls the
existing poll function.

### Content script (auto-injected on Codeforces problem pages)

`content.js` runs only on `codeforces.com` problem-page URLs (declared
explicitly in the manifest's `content_scripts.matches` — not a blanket
`<all_urls>` or even a blanket `codeforces.com/*`). It reads the page's own
URL and problem title to build the deep-link target, and adds one small
"Open in VS Code" button to the page. It does not read page content beyond
the problem title, does not modify the page otherwise, and sends nothing over
the network itself — clicking the button navigates the tab to a `vscode://`
link (handled by the OS/VS Code, not this extension) or, if nothing handles
it, opens the Marketplace listing in a new tab.

## Data collected

None. No analytics SDK, no error reporting service, no remote logging. The
only network destinations are the two hosts above, and the only persisted
data is the three `storage` values a user typed in themselves.
