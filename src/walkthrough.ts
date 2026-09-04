import * as vscode from 'vscode';

/**
 * Explains the companion browser extension: what needs it, why Codeforces
 * forces it, and how to get it running.
 */
export function showWalkthrough(relayInfo: { running: boolean; port: number } | undefined): void {
    const panel = vscode.window.createWebviewPanel(
        'codeforcesSetup',
        'Codeforces Inline — Setup',
        vscode.ViewColumn.Active,
        { enableScripts: false }
    );
    panel.webview.html = render(relayInfo);
}

function render(relay: { running: boolean; port: number } | undefined): string {
    const relayLine = relay?.running
        ? `The relay is running on <code>127.0.0.1:${relay.port}</code>. Run <b>Codeforces: Relay info</b> for the token.`
        : `The relay isn't running yet — reload the window if that persists.`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family); color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 22px 26px; margin: 0; max-width: 720px; line-height: 1.55;
  }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  h2 { font-size: 1rem; margin: 22px 0 6px; }
  p, li { font-size: 0.9rem; }
  code {
    font-family: var(--vscode-editor-font-family); font-size: 0.85em;
    background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px;
  }
  .muted { color: var(--vscode-descriptionForeground); }
  ol { padding-left: 1.3rem; }
  ol li { margin: 5px 0; }
  .card {
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    padding: 10px 14px; margin: 12px 0; background: var(--vscode-editorWidget-background);
  }
  .ok { color: var(--vscode-testing-iconPassed); }
  .warn { color: var(--vscode-testing-iconFailed); }
  table { border-collapse: collapse; font-size: 0.88rem; margin-top: 6px; }
  td { border-top: 1px solid var(--vscode-panel-border); padding: 5px 12px 5px 0; vertical-align: top; }
</style>
</head>
<body>
  <h1>Setting up Codeforces Inline</h1>
  <p class="muted">Short version: <b>you need this.</b> Opening a problem, viewing a group, and submitting all require it — that's most of what the extension does.</p>

  <h2>Why a companion browser extension, at all</h2>
  <p>Codeforces runs Cloudflare in a mode that <b>rejects this extension's network requests before they reach the site</b> — it fingerprints the TLS handshake, and a valid login cookie doesn't change that. Only the read-only <code>/api/*</code> is exempt (that's the Contests / Gym / Problemset lists you can already see). Everything else has to run as a real page fetch from a Chrome tab you're already signed in to — the companion extension does that:</p>
  <table>
    <tr><td><b>Problem statements</b></td><td>The API doesn't serve statements at all; they're read from the page.</td></tr>
    <tr><td><b>Group contests</b></td><td>The API has no group support, signed or not.</td></tr>
    <tr><td><b>Submitting</b></td><td>The submit form has a Cloudflare <b>Turnstile</b> CAPTCHA. The companion fills the form; <b>you solve the Turnstile and press Submit yourself</b>. The verdict then polls back here.</td></tr>
  </table>

  <h2>What already works without it</h2>
  <p>Contests, Gym, the Problemset, and your solved / attempted marks (from <code>codeforces.handle</code>, no login needed) — those come from Codeforces' public API, which isn't blocked. The tree is already populated. It's the moment you click a problem that you'll need the steps below.</p>

  <div class="card">
    <b>Keep one <code>codeforces.com</code> tab open</b> that has passed the "Just a moment…" check.
    The companion re-runs each read inside that tab (a background fetch is also blocked). With no cleared
    tab it opens one for you to solve the check in.
  </div>

  <h2>Install the companion</h2>
  <ol>
    <li>In this repo, find the <code>browser/</code> folder.</li>
    <li>Chrome → <code>chrome://extensions</code> → turn on <b>Developer mode</b> → <b>Load unpacked</b> → select the <b>browser/</b> folder.</li>
    <li>In VS Code run <b>Codeforces: Relay info</b> — copy the port and token.</li>
    <li>Chrome → the companion's <b>Details → Extension options</b> → paste the port and token → <b>Save</b>.</li>
    <li>Stay signed in to <code>codeforces.com</code> in that Chrome profile, with a tab open.</li>
  </ol>
  <p class="muted">${relayLine}</p>

  <h2>Check it</h2>
  <p>Run <b>Codeforces: Check companion</b> — it reports <span class="ok">polling</span>, <span class="warn">token rejected</span>, <span class="warn">asleep</span>, or <span class="warn">not running</span>. Chrome suspends the companion after ~30&nbsp;s idle; it wakes itself within ~30&nbsp;s, and reads retry across that window.</p>

  <p class="muted">Full detail: <code>browser/README.md</code> and <code>LESSONS.md</code> in the repo.</p>
</body>
</html>`;
}
