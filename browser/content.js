/* Codeforces Inline — "Open in VS Code" button.
 *
 * Runs on Codeforces problem pages. Injects a small button that opens
 * vscode://<publisher>.<name>/openProblem?... (see deeplink-config.js, loaded
 * before this file — generated from package.json, never hardcoded here).
 * If nothing handles that URI within a short window, falls back to the
 * Marketplace listing.
 */
(function () {
    'use strict';

    function parseProblemRef() {
        const p = location.pathname;
        let m;
        if ((m = /^\/group\/([^/]+)\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)/.exec(p))) {
            return { kind: 'group', groupCode: m[1], contestId: Number(m[2]), index: m[3] };
        }
        if ((m = /^\/gym\/(\d+)\/problem\/([A-Za-z0-9]+)/.exec(p))) {
            return { kind: 'gym', contestId: Number(m[1]), index: m[2] };
        }
        if ((m = /^\/contest\/(\d+)\/problem\/([A-Za-z0-9]+)/.exec(p))) {
            return { kind: 'contest', contestId: Number(m[1]), index: m[2] };
        }
        if ((m = /^\/problemset\/problem\/(\d+)\/([A-Za-z0-9]+)/.exec(p))) {
            return { kind: 'contest', contestId: Number(m[1]), index: m[2] };
        }
        return null;
    }

    function parseProblemName() {
        const el = document.querySelector('.problem-statement .header .title');
        if (!el) return '';
        // "A. Hello World" -> "Hello World"
        return el.textContent.replace(/^\s*[A-Za-z0-9]+\.\s*/, '').trim();
    }

    // Delegates to the service worker (background.js), which navigates this
    // tab to the vscode:// link and polls the relay for a real ack instead of
    // guessing from focus/visibility — a page losing focus for a Chrome
    // protocol-handoff prompt isn't a reliable "it worked" signal (see
    // LESSONS.md, "Deep link"), and it can't tell a placeholder publisher id
    // apart from a real one either.
    function openInVsCode(ref) {
        if (typeof CF_DEEPLINK === 'undefined') {
            return; // deeplink-config.js failed to load — nothing sensible to do
        }
        chrome.runtime.sendMessage({ type: 'openInVsCode', ref });
    }

    function injectButton(ref) {
        if (document.getElementById('cf-inline-open-btn')) {
            return;
        }
        const btn = document.createElement('button');
        btn.id = 'cf-inline-open-btn';
        btn.type = 'button';
        btn.textContent = 'Open in VS Code';
        btn.title = 'Open this problem in Codeforces Inline';
        btn.style.cssText = [
            'position:fixed', 'right:16px', 'bottom:16px', 'z-index:2147483647',
            'padding:8px 14px', 'background:#0b1220', 'color:#4fd1c5',
            'border:1px solid #4fd1c5', 'border-radius:6px',
            'font:600 13px system-ui,sans-serif', 'cursor:pointer',
            'box-shadow:0 2px 8px rgba(0,0,0,.35)'
        ].join(';');
        btn.addEventListener('click', () => openInVsCode({ type: 'problem', ...ref, name: parseProblemName() }));
        document.body.appendChild(btn);
    }

    const ref = parseProblemRef();
    if (ref) {
        injectButton(ref);
    }
})();
