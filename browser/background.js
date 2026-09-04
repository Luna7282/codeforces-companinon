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
const EXPECTED_PROTOCOL_VERSION = 1;
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

// 'fetch' job: GET the URL in the browser and hand the HTML back to the extension.
// Fast path: service-worker fetch. On a Cloudflare challenge, retry from a tab.
async function handleFetch(port, token, job) {
    let status = 0;
    let body = '';
    let via = 'sw';

    if (!/^https:\/\/codeforces\.com\//.test(job.url)) {
        body = 'refusing non-codeforces URL: ' + job.url;
    } else {
        try {
            const r = await fetch(job.url, { credentials: 'include', redirect: 'follow' });
            status = r.status;
            body = await r.text();
        } catch (e) {
            status = 0;
            body = String((e && e.message) || e);
        }
        if (isCloudflareChallenge(status, body)) {
            log('SW fetch was Cloudflare-challenged; retrying from a tab');
            const tabRes = await fetchFromCodeforcesTab(job.url);
            if (tabRes) {
                status = tabRes.status;
                body = tabRes.body;
                via = tabRes.via;
            }
        }
    }

    await fetch(`http://127.0.0.1:${port}/result`, {
        method: 'POST',
        headers: { 'X-Relay-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: job.id, status, body })
    }).catch(() => {});
    log('fetched', job.url, 'via', via, '->', status, (body || '').length, 'bytes');
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

// --- toolbar icon: context-aware "open this in VS Code" -----------------------
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

function buildDeepLinkUri(ref) {
    if (typeof CF_DEEPLINK === 'undefined') {
        return null;
    }
    if (ref.type === 'problem') {
        const params = new URLSearchParams({ kind: ref.kind, contestId: String(ref.contestId), index: ref.index });
        if (ref.groupCode) params.set('groupCode', ref.groupCode);
        return `${CF_DEEPLINK.uriBase}/openProblem?${params.toString()}`;
    }
    if (ref.type === 'contest') {
        const params = new URLSearchParams({ kind: ref.kind, contestId: String(ref.contestId) });
        if (ref.groupCode) params.set('groupCode', ref.groupCode);
        return `${CF_DEEPLINK.uriBase}/openContest?${params.toString()}`;
    }
    if (ref.type === 'group') {
        return `${CF_DEEPLINK.uriBase}/openGroup?${new URLSearchParams({ groupCode: ref.groupCode }).toString()}`;
    }
    if (ref.type === 'problemset') {
        return `${CF_DEEPLINK.uriBase}/openProblemset`;
    }
    return null;
}

// Same custom-scheme-with-fallback heuristic as content.js, adapted for a
// service worker (no `document`/`window`): if the OS hands off to VS Code,
// Chrome itself loses focus. Navigating the clicked tab (not a new one) means
// a *handled* link never disturbs the page — Chrome intercepts the scheme
// before committing any navigation, same as the existing in-page button.
async function openInVsCode(tab, uri) {
    let lostFocus = false;
    const onFocusChanged = (windowId) => {
        if (windowId === chrome.windows.WINDOW_ID_NONE) lostFocus = true;
    };
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    try {
        await chrome.tabs.update(tab.id, { url: uri });
        await sleep(1500);
    } finally {
        chrome.windows.onFocusChanged.removeListener(onFocusChanged);
    }
    if (!lostFocus) {
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
    const uri = buildDeepLinkUri(ref);
    if (!uri) {
        return;
    }
    openInVsCode(tab, uri).catch((e) => console.error('[cf-relay] toolbar deep link failed', e));
});
