import * as vscode from 'vscode';
import { Problem, ProblemDetail, problemUrl } from './types';

let panel: vscode.WebviewPanel | undefined;

export function showStatement(problem: Problem, detail: ProblemDetail): void {
    const title = `${problem.index}. ${problem.name}`;
    if (!panel) {
        panel = vscode.window.createWebviewPanel('codeforcesStatement', title, vscode.ViewColumn.Beside, {
            enableScripts: true,
            retainContextWhenHidden: true
        });
        panel.onDidDispose(() => (panel = undefined));
    }
    panel.title = title;
    panel.webview.html = render(problem, detail);
    panel.reveal(vscode.ViewColumn.Beside, true);
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);
}

function render(problem: Problem, detail: ProblemDetail): string {
    const limits = [detail.timeLimit, detail.memoryLimit].filter(Boolean).join(' · ');
    const samples = detail.samples
        .map(
            (s, i) => `
      <section class="sample">
        <h3>Sample ${i + 1}</h3>
        <div class="io">
          <div><span class="io-label">Input</span><pre>${escapeHtml(s.input)}</pre></div>
          <div><span class="io-label">Output</span><pre>${escapeHtml(s.output)}</pre></div>
        </div>
      </section>`
        )
        .join('');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               img-src https://codeforces.com https: data:;
               style-src 'unsafe-inline';
               script-src https://cdn.jsdelivr.net 'unsafe-inline';
               font-src https://cdn.jsdelivr.net;" />
<style>
  body {
    font-family: var(--vscode-editor-font-family, system-ui);
    font-size: 14px;
    line-height: 1.6;
    color: var(--vscode-foreground);
    padding: 0 1.4rem 3rem;
    max-width: 72ch;
  }
  header { padding: 1.2rem 0 0.4rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.2rem; font-weight: 600; }
  .limits { color: var(--vscode-descriptionForeground); font-size: 0.85rem; }
  .limits a { color: var(--vscode-textLink-foreground); }
  .problem-statement .header { display: none; }
  .section-title { font-weight: 600; margin-top: 1.4rem; }
  pre {
    background: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.12));
    padding: 0.6rem 0.8rem;
    overflow-x: auto;
    white-space: pre;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85rem;
    margin: 0.3rem 0 0;
  }
  .sample h3 { font-size: 0.95rem; margin: 1.2rem 0 0; font-weight: 600; }
  .io-label { color: var(--vscode-descriptionForeground); font-size: 0.75rem; }
  .io > div + div { margin-top: 0.6rem; }
  img { max-width: 100%; }
  .cf-image-unavailable {
    display: inline-block;
    padding: 0.5rem 0.8rem;
    border: 1px dashed var(--vscode-panel-border);
    border-radius: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85rem;
  }
  .cf-image-unavailable a { color: var(--vscode-textLink-foreground); }
  hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 1.6rem 0; }
</style>
</head>
<body>
  <header>
    <h1>${escapeHtml(problem.index)}. ${escapeHtml(problem.name)}</h1>
    <div class="limits">${escapeHtml(limits)} · <a href="${problemUrl(problem)}">View on Codeforces</a></div>
  </header>
  <article class="problem-statement">${detail.statementHtml}</article>
  <hr />
  ${samples}
  <script>
    window.MathJax = {
      tex: { inlineMath: [['$$$','$$$']], displayMath: [['$$$$$$','$$$$$$']] },
      options: { skipHtmlTags: ['script','noscript','style','textarea','pre'] }
    };
  </script>
  <script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
</body>
</html>`;
}
