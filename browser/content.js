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

    // Custom-scheme-with-fallback: no API tells a page whether a vscode:// link
    // was actually handled. The usual heuristic — did the page lose focus
    // within a short window — is what's used here; it can't tell "VS Code
    // opened but this extension isn't installed" from "it worked" (the OS
    // still switches apps either way), so that one case won't show the
    // fallback. Everything else (VS Code not installed at all) is caught.
    function openInVsCode(ref) {
        if (typeof CF_DEEPLINK === 'undefined') {
            return; // deeplink-config.js failed to load — nothing sensible to do
        }
        const params = new URLSearchParams({
            kind: ref.kind,
            contestId: String(ref.contestId),
            index: ref.index,
            name: ref.name || ''
        });
        if (ref.groupCode) {
            params.set('groupCode', ref.groupCode);
        }
        const uri = `${CF_DEEPLINK.uriPrefix}?${params.toString()}`;

        let handled = false;
        const markHandled = () => {
            handled = true;
        };
        document.addEventListener('visibilitychange', markHandled, { once: true });
        window.addEventListener('blur', markHandled, { once: true });

        window.location.href = uri;

        setTimeout(() => {
            document.removeEventListener('visibilitychange', markHandled);
            window.removeEventListener('blur', markHandled);
            if (!handled) {
                window.open(CF_DEEPLINK.marketplaceUrl, '_blank', 'noopener');
            }
        }, 1500);
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
        btn.addEventListener('click', () => openInVsCode({ ...ref, name: parseProblemName() }));
        document.body.appendChild(btn);
    }

    const ref = parseProblemRef();
    if (ref) {
        injectButton(ref);
    }
})();
