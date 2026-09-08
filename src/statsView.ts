import * as vscode from 'vscode';
import { rebuildIndex, hasArchiveRoot, ArchiveIndexEntry } from './archive';
import { computeStats, Totals } from './scorecard';

/** The whole local archive — every group, gym, and contest. */
export async function showStats(): Promise<void> {
    if (!hasArchiveRoot()) {
        void vscode.window.showWarningMessage(
            'Codeforces: no workspace folder set yet. Run "Codeforces: Change workspace folder".'
        );
        return;
    }
    const index = rebuildIndex(); // fresh — cheap, and always correct
    renderScorecard('Codeforces stats', 'Everything in your local archive', Object.values(index.problems));
}

/** One group, gym, or contest — clicked from the Archive view. Same card, different scope. */
export function showScopeStats(title: string, subtitle: string, entries: ArchiveIndexEntry[]): void {
    renderScorecard(title, subtitle, entries);
}

function renderScorecard(title: string, subtitle: string, entries: ArchiveIndexEntry[]): void {
    const totals = computeStats(entries);
    const panel = vscode.window.createWebviewPanel('codeforcesStats', title, vscode.ViewColumn.Active, {
        enableScripts: false
    });
    panel.webview.html = render(title, subtitle, totals);
}

function esc(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

function bars(rows: [string, number][], max: number): string {
    return rows
        .map(([label, n]) => {
            const pct = Math.round((n / max) * 100);
            return `<div class="bar-row">
        <div class="bar-label">${esc(label)}</div>
        <div class="bar-track"><div class="bar" style="width:${pct}%"></div></div>
        <div class="bar-n">${n}</div>
      </div>`;
        })
        .join('');
}

function verdictBars(rows: [string, number][]): string {
    const max = rows.reduce((m, [, n]) => Math.max(m, n), 1);
    return rows
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
}

function render(title: string, subtitle: string, t: Totals): string {
    const rate = t.attempted ? Math.round((t.solved / t.attempted) * 100) : 0;
    const perSolve = t.solved ? (t.totalAttempts / t.solved).toFixed(1) : '—';

    const tile = (label: string, value: string) =>
        `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;

    const langRows: [string, number][] = t.byLanguage.map(([lang, s]) => [
        `${lang} — ${s.solved}/${s.attempted} solved`,
        s.attempts
    ]);
    const langMax = langRows.reduce((m, [, n]) => Math.max(m, n), 1);
    const showLanguages = t.byLanguage.length > 1 || (t.byLanguage.length === 1 && t.byLanguage[0][0] !== 'Unknown');

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
  h2 { font-size: 0.95rem; margin: 22px 0 8px; }
  h2:first-of-type { margin-top: 0; }
  .bar-row { display: grid; grid-template-columns: 190px 1fr 40px; align-items: center; gap: 10px; margin: 4px 0; }
  .bar-label { font-size: 0.85rem; }
  .bar-track { background: var(--vscode-panel-border); border-radius: 2px; height: 14px; overflow: hidden; }
  .bar { height: 100%; background: var(--vscode-charts-blue, var(--vscode-textLink-foreground)); }
  .bar.ok { background: var(--vscode-testing-iconPassed); }
  .bar.bad { background: var(--vscode-testing-iconFailed); }
  .bar.neutral { background: var(--vscode-descriptionForeground); }
  .bar-n { text-align: right; font-variant-numeric: tabular-nums; font-size: 0.85rem; }
</style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <p class="sub muted">${esc(subtitle)}${
      t.latest ? ` · last submission ${new Date(t.latest).toLocaleDateString()}` : ''
  }</p>
  ${emptyNote}
  <div class="tiles">
    ${tile('problems attempted', String(t.attempted))}
    ${tile('solved', String(t.solved))}
    ${tile('solve rate', `${rate}%`)}
    ${tile('attempts / solve', String(perSolve))}
  </div>
  ${t.byVerdict.length ? `<h2>By verdict — ${t.totalAttempts} attempts</h2>${verdictBars(t.byVerdict)}` : ''}
  ${showLanguages ? `<h2>By language</h2>${bars(langRows, langMax)}` : ''}
</body>
</html>`;
}
