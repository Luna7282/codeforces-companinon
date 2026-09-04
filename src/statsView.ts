import * as vscode from 'vscode';
import * as path from 'path';
import { rebuildIndex, listAttempts, archiveRoot, hasArchiveRoot } from './archive';
import { verdictCategory } from './verdict';

interface Totals {
    attempted: number;
    solved: number;
    totalAttempts: number;
    byVerdict: [string, number][]; // sorted desc
    latest: number;
}

/**
 * Summarise the local attempt history across the whole archive. The `.archive`
 * (local metadata) is the source of truth — it captures tries Codeforces
 * refused outright, which `user.status` never shows.
 */
export async function showStats(_extensionUri: vscode.Uri): Promise<void> {
    if (!hasArchiveRoot()) {
        void vscode.window.showWarningMessage(
            'Codeforces: no workspace folder set yet. Run "Codeforces: Change workspace folder".'
        );
        return;
    }

    const index = rebuildIndex(); // fresh — cheap, and always correct
    let attempted = 0;
    let solved = 0;
    let totalAttempts = 0;
    let latest = 0;
    const counts = new Map<string, number>();

    for (const entry of Object.values(index.problems)) {
        const attempts = listAttempts(path.join(archiveRoot(), entry.dir));
        if (attempts.length === 0) {
            continue;
        }
        attempted++;
        totalAttempts += attempts.length;
        if (entry.solved) {
            solved++;
        }
        for (const a of attempts) {
            const cat = verdictCategory(a.verdict);
            counts.set(cat, (counts.get(cat) ?? 0) + 1);
            if (a.at > latest) {
                latest = a.at;
            }
        }
    }

    const byVerdict = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    const panel = vscode.window.createWebviewPanel(
        'codeforcesStats',
        'Codeforces Stats',
        vscode.ViewColumn.Active,
        { enableScripts: false }
    );
    panel.webview.html = render({ attempted, solved, totalAttempts, byVerdict, latest });
}

function esc(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

function render(t: Totals): string {
    const rate = t.attempted ? Math.round((t.solved / t.attempted) * 100) : 0;
    const perSolve = t.solved ? (t.totalAttempts / t.solved).toFixed(1) : '—';
    const max = t.byVerdict.reduce((m, [, n]) => Math.max(m, n), 1);

    const tile = (label: string, value: string) =>
        `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

    const bars = t.byVerdict
        .map(([cat, n]) => {
            const cls = cat === 'Accepted' ? 'ok' : cat === 'Rejected' || cat === 'Other' ? 'neutral' : 'bad';
            const pct = Math.round((n / max) * 100);
            return `<div class="bar-row">
        <div class="bar-label">${esc(cat)}</div>
        <div class="bar-track"><div class="bar ${cls}" style="width:${pct}%"></div></div>
        <div class="bar-n">${n}</div>
      </div>`;
        })
        .join('');

    const emptyNote = t.attempted
        ? ''
        : `<p class="muted">No attempts recorded yet. Submit a solution and it will show up here.</p>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'" />
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 20px 22px; margin: 0; max-width: 640px;
  }
  h1 { font-size: 1.15rem; margin: 0 0 2px; }
  .muted { color: var(--vscode-descriptionForeground); }
  .sub { margin: 0 0 18px; font-size: 0.85rem; }
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 22px; }
  .tile {
    border: 1px solid var(--vscode-panel-border); border-radius: 4px;
    padding: 10px 12px; background: var(--vscode-editorWidget-background);
  }
  .tile .v { font-size: 1.5rem; font-variant-numeric: tabular-nums; }
  .tile .l { font-size: 0.78rem; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  h2 { font-size: 0.95rem; margin: 0 0 8px; }
  .bar-row { display: grid; grid-template-columns: 140px 1fr 40px; align-items: center; gap: 10px; margin: 4px 0; }
  .bar-label { font-size: 0.85rem; }
  .bar-track { background: var(--vscode-panel-border); border-radius: 2px; height: 14px; overflow: hidden; }
  .bar { height: 100%; }
  .bar.ok { background: var(--vscode-testing-iconPassed); }
  .bar.bad { background: var(--vscode-testing-iconFailed); }
  .bar.neutral { background: var(--vscode-descriptionForeground); }
  .bar-n { text-align: right; font-variant-numeric: tabular-nums; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>Codeforces stats</h1>
  <p class="sub muted">From your local attempt history${
      t.latest ? ` · last submission ${new Date(t.latest).toLocaleDateString()}` : ''
  }</p>
  ${emptyNote}
  <div class="tiles">
    ${tile('problems attempted', String(t.attempted))}
    ${tile('solved', String(t.solved))}
    ${tile('solve rate', `${rate}%`)}
    ${tile('attempts / solve', String(perSolve))}
  </div>
  ${t.byVerdict.length ? `<h2>By verdict — ${t.totalAttempts} attempts</h2>${bars}` : ''}
</body>
</html>`;
}
