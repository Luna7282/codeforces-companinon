/* Codeforces Inline submit relay — companion service worker.
 *
 * Long-polls the VS Code extension's localhost queue. When a job arrives it
 * opens the correct submit page (contest / gym / GROUP) in a Codeforces tab
 * and fills the form — compiler, problem index, source. Then it STOPS.
 * The user solves the Turnstile challenge and clicks Submit. This script
 * never clicks Submit and never touches the challenge widget.
 */

// Classic (non-module) service worker — importScripts runs it in this same
// scope, so CF_DEEPLINK (uriBase, marketplaceUrl) becomes available here too,
// same generated file the content-script button uses.
importScripts('deeplink-config.js');

const DEFAULT_PORT = 27121;
// Must match PROTOCOL_VERSION in src/relay.ts. Bumped only when the wire
// protocol changes shape — see LESSONS.md for why a mismatch must be loud,
// not a mysterious silent failure.
const EXPECTED_PROTOCOL_VERSION = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Verbose tracing is off unless the "debug" option is set. Warnings/errors always show.
let DEBUG = false;
chrome.storage.local.get(['debug']).then((s) => {
    DEBUG = !!s.debug;
});
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.debug) DEBUG = !!changes.debug.newValue;
});
const log = (...a) => {
    if (DEBUG) console.log('[cf-relay]', ...a);
};

// Same gate as log(), but also forwards to the relay so it lands in VS Code's
// Codeforces output channel — the service worker's own console isn't visible
// from inside VS Code, and this trace only matters while debugging a specific
// fetch, so it's never retained on the server (see /companion-log in relay.ts).
const report = (...a) => {
    log(...a);
    if (!DEBUG) return;
    config()
        .then(({ port, token }) =>
            fetch(`http://127.0.0.1:${port}/companion-log`, {
                method: 'POST',
                headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: a.map(String).join(' ') })
            })
        )
        .catch(() => {});
};

log('worker eval: script start', new Date().toISOString());

async function config() {
    const s = await chrome.storage.local.get(['port', 'token']);
    return { port: Number(s.port) || DEFAULT_PORT, token: s.token || '' };
}

// Mirror of src/types.ts submitUrl() — GROUP urls included.
function submitUrlFor(job) {
    if (job.kind === 'group') {
        return `https://codeforces.com/group/${job.groupCode}/contest/${job.contestId}/submit`;
    }
    if (job.kind === 'gym') {
        return `https://codeforces.com/gym/${job.contestId}/submit`;
    }
    return `https://codeforces.com/contest/${job.contestId}/submit`;
}

// Runs in the page. Fills the form, submits nothing.
function fillSubmitForm(job) {
    const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
    const setValue = (el, value) => {
        el.value = value;
        fire(el, 'input');
        fire(el, 'change');
    };

    const form =
        [...document.querySelectorAll('form')].find((f) => f.querySelector('select[name="programTypeId"]')) ||
        document.querySelector('form.submit-form');
    if (!form) {
        return { ok: false, reason: 'no submit form on page' };
    }

    // Turn the rich editor off so the plain <textarea name="source"> is what
    // gets submitted, then paste into it.
    const editorToggle =
        form.querySelector('#toggleEditorCheckbox') ||
        [...form.querySelectorAll('input[type="checkbox"]')].find((c) =>
            /editor/i.test((c.closest('div,td,label,span') || {}).textContent || '')
        ) ||
        form.querySelector('input[type="checkbox"]');
    if (editorToggle && !editorToggle.checked) {
        editorToggle.click(); // "Switch off editor"
    }

    const textarea = form.querySelector('textarea[name="source"]');
    if (textarea) {
        setValue(textarea, job.source);
    }
    // Belt and braces if the rich editor is still active in some layout.
    const cm = document.querySelector('.CodeMirror');
    if (cm && cm.CodeMirror) {
        cm.CodeMirror.setValue(job.source);
    }

    const lang = form.querySelector('select[name="programTypeId"]');
    if (lang && job.programTypeId) {
        setValue(lang, String(job.programTypeId));
    }

    const index = form.querySelector('[name="submittedProblemIndex"]');
    if (index && job.index) {
        setValue(index, job.index);
    }

    return {
        ok: true,
        filledSource: Boolean(textarea),
        setLang: lang ? lang.value : null,
        setIndex: index ? index.value : null
    };
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const poll = () => {
            chrome.tabs.get(tabId, (tab) => {
                if (chrome.runtime.lastError || !tab) {
                    return resolve(false);
                }
                if (tab.status === 'complete') {
                    return resolve(true);
                }
                if (Date.now() - started > timeoutMs) {
                    return resolve(false);
                }
                setTimeout(poll, 250);
            });
        };
        poll();
    });
}

async function deliver(job) {
    const url = submitUrlFor(job);
    const cfTabs = await chrome.tabs.query({ url: 'https://codeforces.com/*' });
    let tabId;
    if (cfTabs.length > 0) {
        tabId = cfTabs[0].id;
        await chrome.tabs.update(tabId, { url, active: true });
        await chrome.windows.update(cfTabs[0].windowId, { focused: true });
    } else {
        const created = await chrome.tabs.create({ url, active: true });
        tabId = created.id;
    }
    await waitForTabComplete(tabId);
    await sleep(500);
    const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        func: fillSubmitForm,
        args: [job]
    });
    log('filled', job.kind, job.contestId, job.index, res && res.result);

    // Watch the submit tab (detached — must not block the poll loop) so a
    // Codeforces rejection (span.error) or a successful navigation is reported
    // back and VS Code can stop waiting.
    watchSubmitOutcome(tabId, job.id).catch((e) => console.warn('[cf-relay] submit watch failed', e));
}

async function reportSubmitOutcome(jobId, outcome, message) {
    const { port, token } = await config();
    await fetch(`http://127.0.0.1:${port}/submit-result`, {
        method: 'POST',
        headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: jobId, outcome, message: message || '' })
    }).catch(() => {});
    log('submit outcome', jobId, outcome, message || '');
}

async function watchSubmitOutcome(tabId, jobId) {
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
        await sleep(3000);
        let probe;
        try {
            const [inj] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const spans = [...document.querySelectorAll('span.error')];
                    const shown = spans.find(
                        (s) => s.textContent.trim() && s.offsetParent !== null
                    );
                    return {
                        href: location.href,
                        error: shown ? shown.textContent.replace(/\s+/g, ' ').trim() : ''
                    };
                }
            });
            probe = inj && inj.result;
        } catch {
            probe = null; // tab closed
        }
        if (!probe) {
            return reportSubmitOutcome(jobId, 'gone');
        }
        if (probe.error) {
            return reportSubmitOutcome(jobId, 'error', probe.error);
        }
        if (!/\/submit(\?|#|$)/.test(probe.href)) {
            return reportSubmitOutcome(jobId, 'submitted'); // navigated away = accepted
        }
    }
}

const isCloudflareChallenge = (status, body) =>
    (status === 403 || status === 503) &&
    /Just a moment|cf[-_]chl|cf-browser-verification|Enable JavaScript and cookies/i.test(body || '');

// Defensive fallback, not the fix for the bug this was written to chase (see
// LESSONS.md, "Session lost to a direct Node fetch" — the real cause was that
// the extension's own reads never reached the companion at all, since the SW
// fetch here already carries the session fine). Kept in case a signed-out
// page ever does slip through this path for some other reason: same tab
// retry a Cloudflare challenge gets, since a signed-out result is a normal
// 200 and can't be caught by status code the way a Cloudflare block is. Same
// header marker src/session.ts's Session.findHandle() uses.
const looksSignedOut = (status, body) =>
    status >= 200 &&
    status < 400 &&
    /X-Csrf-Token|class="lang-chooser"|id="pageContent"/i.test(body || '') &&
    !/href="\/profile\//i.test(body || '');

// codeforces.com itself, or any of its subdomains (statement images live on
// espresso.codeforces.com — see LESSONS.md, "Statement images").
function isAllowedCodeforcesUrl(url) {
    try {
        const h = new URL(url).hostname;
        return h === 'codeforces.com' || h.endsWith('.codeforces.com');
    } catch {
        return false;
    }
}

function arrayBufferToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

// Runs a real page-context fetch inside `tabId` (MAIN world → carries the tab's
// origin, cookies, Referer and Sec-Fetch-Site: same-origin — a service-worker
// fetch does not, and Cloudflare treats the SW request as non-browser).
async function runFetchInTab(tabId, url) {
    try {
        const [inj] = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            args: [url],
            func: async (u) => {
                try {
                    const r = await fetch(u, { credentials: 'include', redirect: 'follow' });
                    return { status: r.status, body: await r.text() };
                } catch (e) {
                    return { status: 0, body: String((e && e.message) || e) };
                }
            }
        });
        return inj && inj.result;
    } catch (e) {
        console.warn('[cf-relay] executeScript fetch failed', e);
        return null;
    }
}

// Fallback for when the SW fetch is Cloudflare-challenged: run the fetch from a
// real codeforces.com tab. Prefer an existing (already-cleared) tab; open a
// visible one only as a last resort so the user can solve a fresh challenge.
async function fetchFromCodeforcesTab(url) {
    const tabs = await chrome.tabs.query({ url: 'https://codeforces.com/*' });
    for (const tab of tabs) {
        const r = await runFetchInTab(tab.id, url);
        if (r && r.status && !isCloudflareChallenge(r.status, r.body)) {
            return { ...r, via: 'tab' };
        }
    }
    const created = await chrome.tabs.create({ url: 'https://codeforces.com/', active: true });
    await waitForTabComplete(created.id);
    await sleep(500);
    const r = await runFetchInTab(created.id, url);
    return r ? { ...r, via: 'tab-new' } : null;
}

// Statement-image fallback (see LESSONS.md "Statement images"). Three things
// confirmed by hand, in order, before writing this:
//  1. The service worker's own fetch (which bypasses CORS under
//     host_permissions) also gets Cloudflare-challenged on
//     espresso.codeforces.com — 403, text/html. TLS fingerprint alone isn't
//     enough; Cloudflare wants page context here, same as the main site.
//  2. A same-page `<img>`+canvas read (no fetch, so no CORS on the request
//     itself) DOES load the image, but `canvas.toDataURL()` throws
//     `SecurityError: Tainted canvases may not be exported` — confirmed
//     espresso.codeforces.com sends no CORS headers, so the canvas is
//     tainted the instant the image is cross-origin to the page.
//  3. A genuine top-level navigation to the image URL is NOT challenged
//     (same as visiting any codeforces.com page works) — Chrome's native
//     image-viewer page loads the real image. Once there, the page IS
//     espresso.codeforces.com, so the image is same-origin and
//     `canvas.toDataURL()` succeeds untainted. Confirmed end-to-end by hand:
//     4532x1658 image, valid `data:image/png;base64,...` out.
// So: open the URL in a background tab, read it back via canvas from inside
// that tab, close the tab.
async function fetchImageViaBackgroundTab(url) {
    const tab = await chrome.tabs.create({ url, active: false });
    try {
        await waitForTabComplete(tab.id);
        const [inj] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: async () => {
                const img = document.querySelector('img');
                if (!img) {
                    return { ok: false, error: 'no <img> on the navigated page — not an image response' };
                }
                const deadline = Date.now() + 5000;
                while (!(img.complete && img.naturalWidth > 0) && Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 100));
                }
                if (!(img.complete && img.naturalWidth > 0)) {
                    return { ok: false, error: 'image never finished loading' };
                }
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = img.naturalWidth;
                    canvas.height = img.naturalHeight;
                    canvas.getContext('2d').drawImage(img, 0, 0);
                    const dataUrl = canvas.toDataURL('image/png');
                    return { ok: true, contentType: 'image/png', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
                } catch (e) {
                    return { ok: false, error: `${e.name}: ${e.message}` };
                }
            }
        });
        return (inj && inj.result) || { ok: false, error: 'executeScript returned no result' };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    } finally {
        chrome.tabs.remove(tab.id).catch(() => {});
    }
}

// 'fetch' job: GET the URL in the browser and hand the HTML back to the extension.
// Fast path: service-worker fetch. On a Cloudflare challenge, text jobs retry
// from an existing codeforces.com tab (same-origin fetch, no CORS); binary
// (image) jobs retry via fetchImageViaBackgroundTab instead — see the block
// comment above for why the two fallbacks can't share a strategy.
async function handleFetch(port, token, job) {
    let status = 0;
    let body = '';
    let contentType = '';
    let via = 'sw';

    if (!isAllowedCodeforcesUrl(job.url)) {
        body = 'refusing non-codeforces URL: ' + job.url;
    } else if (job.binary) {
        try {
            const r = await fetch(job.url, { credentials: 'include', redirect: 'follow' });
            status = r.status;
            contentType = r.headers.get('content-type') || '';
            if (contentType.startsWith('image/')) {
                body = arrayBufferToBase64(await r.arrayBuffer());
            }
        } catch (e) {
            status = 0;
            contentType = '';
        }
        if (!contentType.startsWith('image/')) {
            log('SW image fetch did not return image bytes; trying a background-tab navigation', job.url, status, contentType);
            const tabRes = await fetchImageViaBackgroundTab(job.url);
            if (tabRes.ok) {
                status = 200;
                contentType = tabRes.contentType;
                body = tabRes.base64;
                via = 'tab-canvas';
            } else {
                log('background-tab image fetch failed', job.url, tabRes.error);
                status = 0;
                body = tabRes.error;
                contentType = '';
            }
        }
    } else {
        const jar = await chrome.cookies.get({ url: 'https://codeforces.com', name: 'JSESSIONID' }).catch(() => null);
        try {
            const r = await fetch(job.url, { credentials: 'include', redirect: 'follow' });
            status = r.status;
            body = await r.text();
        } catch (e) {
            status = 0;
            body = String((e && e.message) || e);
        }
        const challenged = isCloudflareChallenge(status, body);
        const signedOut = !challenged && looksSignedOut(status, body);
        report(
            'SW fetch', job.url, '-> status', status, 'cookieInJar(JSESSIONID)=', Boolean(jar),
            'challenged=', challenged, 'signedOut=', signedOut
        );
        if (challenged || signedOut) {
            report(challenged ? 'SW fetch was Cloudflare-challenged; retrying from a tab' : 'SW fetch lost the session (cookie in jar but page renders signed-out); retrying from a tab');
            const tabRes = await fetchFromCodeforcesTab(job.url);
            if (tabRes) {
                status = tabRes.status;
                body = tabRes.body;
                via = tabRes.via;
                report('tab fetch', job.url, 'via', via, '-> status', status, 'signedOut=', looksSignedOut(status, body));
            }
        }
    }

    await fetch(`http://127.0.0.1:${port}/result`, {
        method: 'POST',
        headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, status, body, contentType })
    }).catch(() => {});
    log('fetched', job.url, 'via', via, '->', status, (body || '').length, job.binary ? `b64 chars (${contentType})` : 'chars');
}

// --- keepalive + poll loop ----------------------------------------------------
// MV3 service workers are suspended after ~30s idle. A pending fetch keeps the
// worker alive, so while the relay answers, pollLoop() never idles: /pending
// long-polls (<25s) and we reconnect the instant it returns. When the relay is
// unreachable we STOP the loop rather than spin on timers holding a half-dead
// worker — the alarm below revives it. Alarms wake a suspended worker; timers
// do not.

const KEEPALIVE_ALARM = 'cf-relay-keepalive';
let polling = false;

// Checks the extension's protocol version against ours. A mismatch is reported
// back (loudly, always — not gated by DEBUG) and polling stops until it's fixed.
async function checkProtocol(port, token) {
    let health;
    try {
        health = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json());
    } catch {
        return true; // relay unreachable — pollOnce reports that on its own
    }
    if (health && health.protocolVersion !== undefined && health.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
        const message =
            `protocol mismatch: companion expects v${EXPECTED_PROTOCOL_VERSION}, extension reports ` +
            `v${health.protocolVersion}. Update the companion (browser/) and the VS Code extension to matching versions.`;
        console.error('[cf-relay]', message);
        await fetch(`http://127.0.0.1:${port}/companion-error`, {
            method: 'POST',
            headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        }).catch(() => {});
        return false;
    }
    return true;
}

// One /pending cycle. Returns a reason string; 'handled'/'idle' mean "keep going
// immediately", anything else means "stop, let the alarm retry".
async function pollOnce() {
    const { port, token } = await config();
    if (!token) {
        return 'no-token';
    }
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${port}/pending`, { headers: { 'X-Relay-Token': token } });
    } catch (e) {
        return 'relay-down';
    }
    if (res.status === 401) {
        return 'unauthorized';
    }
    if (res.status === 204) {
        return 'idle'; // long-poll returned empty — reconnect with no gap
    }
    if (res.status !== 200) {
        return 'relay-error';
    }
    const job = await res.json().catch(() => null);
    if (!job || !job.id) {
        return 'idle';
    }
    if (job.type === 'fetch') {
        await handleFetch(port, token, job); // /result is the completion signal; no /ack
        return 'handled';
    }
    try {
        await deliver(job);
    } catch (err) {
        console.warn('[cf-relay] deliver failed', err);
    }
    await fetch(`http://127.0.0.1:${port}/ack`, {
        method: 'POST',
        headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id })
    }).catch(() => {});
    return 'handled';
}

async function pollLoop(trigger) {
    log('pollLoop(' + (trigger || '?') + '): called, polling =', polling);
    if (polling) {
        log('pollLoop: early-return, a loop is already running');
        return; // idempotent: never two loops
    }
    polling = true;
    try {
        const { port, token } = await config();
        if (token && !(await checkProtocol(port, token))) {
            return; // mismatch reported to the extension; wait for a fix + reload
        }
        for (;;) {
            const reason = await pollOnce();
            if (reason === 'handled' || reason === 'idle') {
                continue;
            }
            log('pollLoop: paused on', reason, '— alarm will retry');
            return;
        }
    } catch (e) {
        console.error('[cf-relay] pollLoop: threw', e);
    } finally {
        polling = false;
        log('pollLoop: exited, polling reset to false');
    }
}

log('worker eval: registering listeners');
chrome.runtime.onStartup.addListener(() => pollLoop('onStartup'));
chrome.runtime.onInstalled.addListener(() => pollLoop('onInstalled'));
chrome.alarms.onAlarm.addListener((a) => {
    log('alarm fired:', a.name);
    if (a.name === KEEPALIVE_ALARM) {
        pollLoop('alarm');
    }
});

try {
    chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
    log('worker eval: alarm created (period 1 min)');
} catch (e) {
    console.error('[cf-relay] worker eval: chrome.alarms.create threw', e);
}

// Independent reachability probe — no token, tests host_permission + the socket.
chrome.storage.local.get(['port']).then(({ port }) => {
    const p = Number(port) || DEFAULT_PORT;
    fetch(`http://127.0.0.1:${p}/health`)
        .then((r) => r.json())
        .then((j) => log('worker eval: /health reachable from SW ->', j))
        .catch((e) => log('worker eval: /health NOT reachable from SW ->', String(e)));
});

polling = false; // defensive: never start wedged
log('worker eval: calling pollLoop() now');
pollLoop('startup');
log('worker eval: end of script');

// --- "open this in VS Code": toolbar icon (any page) + in-page button (problem
// pages, content.js) both funnel through here. --------------------------------
// Unlike the in-page button (content.js, problem pages only), the toolbar icon
// fires on any codeforces.com page, so it needs its own URL classification —
// same regexes as content.js's parseProblemRef, extended to contest/gym/group
// overview pages and the problemset.

function classifyCodeforcesUrl(url) {
    let path;
    try {
        path = new URL(url).pathname;
    } catch {
        return null;
    }
    let m;
    if ((m = /^\/group\/([^/]+)\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)/.exec(path))) {
        return { type: 'problem', kind: 'group', groupCode: m[1], contestId: Number(m[2]), index: m[3] };
    }
    if ((m = /^\/gym\/(\d+)\/problem\/([A-Za-z0-9]+)/.exec(path))) {
        return { type: 'problem', kind: 'gym', contestId: Number(m[1]), index: m[2] };
    }
    if ((m = /^\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)/.exec(path))) {
        return { type: 'problem', kind: 'contest', contestId: Number(m[1]), index: m[2] };
    }
    if ((m = /^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/.exec(path))) {
        return { type: 'problem', kind: 'contest', contestId: Number(m[1]), index: m[2] };
    }
    // Non-problem sub-pages of a contest/gym/group (overview, standings, ...) —
    // must be checked after the problem patterns above, before the bare group one.
    if ((m = /^\/group\/([^/]+)\/contest\/(\d+)/.exec(path))) {
        return { type: 'contest', kind: 'group', groupCode: m[1], contestId: Number(m[2]) };
    }
    if ((m = /^\/gym\/(\d+)/.exec(path))) {
        return { type: 'contest', kind: 'gym', contestId: Number(m[1]) };
    }
    if ((m = /^\/contest\/(\d+)/.exec(path))) {
        return { type: 'contest', kind: 'contest', contestId: Number(m[1]) };
    }
    if ((m = /^\/group\/([^/]+)/.exec(path))) {
        return { type: 'group', groupCode: m[1] };
    }
    if (/^\/problemset(\/|$)/.test(path)) {
        return { type: 'problemset' };
    }
    return null;
}

function buildDeepLinkUri(ref, ackId) {
    if (typeof CF_DEEPLINK === 'undefined') {
        return null;
    }
    let path;
    const params = new URLSearchParams();
    if (ref.type === 'problem') {
        path = '/openProblem';
        params.set('kind', ref.kind);
        params.set('contestId', String(ref.contestId));
        params.set('index', ref.index);
        if (ref.name) params.set('name', ref.name);
        if (ref.groupCode) params.set('groupCode', ref.groupCode);
    } else if (ref.type === 'contest') {
        path = '/openContest';
        params.set('kind', ref.kind);
        params.set('contestId', String(ref.contestId));
        if (ref.groupCode) params.set('groupCode', ref.groupCode);
    } else if (ref.type === 'group') {
        path = '/openGroup';
        params.set('groupCode', ref.groupCode);
    } else if (ref.type === 'problemset') {
        path = '/openProblemset';
    } else {
        return null;
    }
    params.set('ackId', ackId);
    return `${CF_DEEPLINK.uriBase}${path}?${params.toString()}`;
}

// The old heuristic here (and in content.js, before this version) guessed
// success from window/tab focus loss — but Chrome's "Open Visual Studio
// Code?" handoff doesn't reliably blur anything, so it read as "unhandled"
// even on a clean open, popping a spurious (and, pre-publish, broken-URL)
// Marketplace tab every time. Real signal instead: the extension's URI
// handler acks a per-click id straight to the relay the instant it lands
// (see LESSONS.md, "Deep link"), so this polls for that ack rather than
// guessing. No relay reachable at all (VS Code not running) fails the same
// poll, so one mechanism covers "VS Code not installed" and "not running".
const ACK_POLL_INTERVAL_MS = 300;
const ACK_POLL_TIMEOUT_MS = 3000;

async function wasDeepLinkAcked(port, token, ackId) {
    const deadline = Date.now() + ACK_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/deeplink-ack?id=${encodeURIComponent(ackId)}`, {
                headers: { 'X-Relay-Token': token }
            });
            if (res.ok) {
                const j = await res.json();
                if (j && j.acked) return true;
            }
        } catch {
            // relay unreachable — VS Code isn't running; keep polling until the timeout,
            // it may still start (a fresh vscode:// launch takes a moment).
        }
        await sleep(ACK_POLL_INTERVAL_MS);
    }
    return false;
}

async function openInVsCode(tab, ref) {
    const { port, token } = await config();
    const ackId = crypto.randomUUID();
    const uri = buildDeepLinkUri(ref, ackId);
    if (!uri || !tab || !tab.id) {
        return;
    }
    await chrome.tabs.update(tab.id, { url: uri });
    const acked = await wasDeepLinkAcked(port, token, ackId);
    if (!acked) {
        await chrome.tabs.create({ url: CF_DEEPLINK.marketplaceUrl, active: true });
    }
}

chrome.action.onClicked.addListener((tab) => {
    if (!tab || !tab.id || !tab.url) {
        return;
    }
    const ref = classifyCodeforcesUrl(tab.url);
    if (!ref) {
        return; // not a page this can do anything with
    }
    openInVsCode(tab, ref).catch((e) => console.error('[cf-relay] toolbar deep link failed', e));
});

// content.js's "Open in VS Code" button (problem pages) sends its ref here
// instead of navigating/detecting itself, so both entry points share the
// same ack-based success check.
chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== 'openInVsCode' || !sender.tab) {
        return;
    }
    openInVsCode(sender.tab, msg.ref).catch((e) => console.error('[cf-relay] in-page deep link failed', e));
});
