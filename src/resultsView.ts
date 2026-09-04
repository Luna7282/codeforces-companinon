import * as vscode from 'vscode';
import { Sample } from './types';
import { TestResult } from './runner';
import { Attempt } from './files';
import { verdictKind } from './verdict';

export interface ResultsActions {
    runAll(): void;
    runOne(index: number): void;
    addTest(input: string, expected: string): void;
    deleteTest(index: number): void;
    submit(): void;
    pickLang(): void;
    showAttemptSource(index: number): void;
}

interface AttemptRow {
    origIndex: number; // index into the stored oldest-first attempts array
    when: string;
    verdict: string;
    kind: 'ok' | 'bad' | 'warn';
    language: string;
    submissionId?: string;
}

interface PanelState {
    problem?: { index: string; name: string; url: string };
    lang?: string;
    sampleCount: number;
    tests: { label: string; input: string; expected: string; custom: boolean }[];
    results: (TestResult | null)[];
    running: boolean[];
    attempts: AttemptRow[]; // newest first
    error?: { title: string; text: string };
    verdict?: { text: string; kind: 'pending' | 'ok' | 'bad' };
    busy: boolean;
}

/**
 * The "Results" webview view (below the problem tree). Holds all render state
 * here and pushes it to the webview; the webview posts back user actions.
 */
export class ResultsViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codeforcesResults';

    private view?: vscode.WebviewView;
    private state: PanelState = {
        sampleCount: 0,
        tests: [],
        results: [],
        running: [],
        attempts: [],
        busy: false
    };

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly actions: ResultsActions
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
        view.webview.html = this.html(view.webview);
        view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        this.push();
    }

    private onMessage(msg: { type: string; index?: number; input?: string; expected?: string }): void {
        switch (msg.type) {
            case 'ready':
                this.push();
                return;
            case 'runAll':
                this.actions.runAll();
                return;
            case 'runOne':
                if (typeof msg.index === 'number') this.actions.runOne(msg.index);
                return;
            case 'addTest':
                this.actions.addTest(msg.input ?? '', msg.expected ?? '');
                return;
            case 'deleteTest':
                if (typeof msg.index === 'number') this.actions.deleteTest(msg.index);
                return;
            case 'submit':
                this.actions.submit();
                return;
            case 'pickLang':
                this.actions.pickLang();
                return;
            case 'showAttemptSource':
                if (typeof msg.index === 'number') this.actions.showAttemptSource(msg.index);
                return;
        }
    }

    // ---- state updates called by extension.ts --------------------------------

    setContext(
        problem: { index: string; name: string; url: string },
        samples: Sample[],
        userTests: Sample[],
        attempts: Attempt[],
        lang: string | undefined
    ): void {
        const tests = [
            ...samples.map((s, i) => ({ label: `Sample ${i + 1}`, input: s.input, expected: s.output, custom: false })),
            ...userTests.map((s, i) => ({ label: `Custom ${i + 1}`, input: s.input, expected: s.output, custom: true }))
        ];
        this.state = {
            problem,
            lang,
            sampleCount: samples.length,
            tests,
            results: tests.map(() => null),
            running: tests.map(() => false),
            attempts: toRows(attempts),
            busy: false
        };
        this.reveal();
        this.push();
    }

    setAttempts(attempts: Attempt[]): void {
        this.state.attempts = toRows(attempts);
        this.push();
    }

    setLang(lang: string | undefined): void {
        this.state.lang = lang;
        this.push();
    }

    /** Replace the test list (add/remove custom tests) while keeping results by index. */
    setTests(samples: Sample[], userTests: Sample[]): void {
        const tests = [
            ...samples.map((s, i) => ({ label: `Sample ${i + 1}`, input: s.input, expected: s.output, custom: false })),
            ...userTests.map((s, i) => ({ label: `Custom ${i + 1}`, input: s.input, expected: s.output, custom: true }))
        ];
        const old = this.state.results;
        this.state.tests = tests;
        this.state.sampleCount = samples.length;
        this.state.results = tests.map((_, i) => old[i] ?? null);
        this.state.running = tests.map(() => false);
        this.push();
    }

    setBusy(busy: boolean): void {
        this.state.busy = busy;
        if (busy) this.state.error = undefined;
        this.push();
    }

    setRunning(indices: number[]): void {
        this.state.running = this.state.tests.map((_, i) => indices.includes(i));
        this.push();
    }

    setError(title: string, text: string): void {
        this.state.error = { title, text };
        this.state.busy = false;
        this.state.running = this.state.tests.map(() => false);
        this.push();
    }

    setResult(index: number, result: TestResult): void {
        this.state.results[index] = result;
        this.state.running[index] = false;
        this.push();
    }

    setAllResults(results: TestResult[]): void {
        this.state.results = this.state.tests.map((_, i) => results[i] ?? null);
        this.state.running = this.state.tests.map(() => false);
        this.state.busy = false;
        this.push();
    }

    setVerdict(text: string, kind: 'pending' | 'ok' | 'bad'): void {
        this.state.verdict = { text, kind };
        this.push();
    }

    // ------------------------------------------------------------------------

    private reveal(): void {
        if (this.view) {
            this.view.show?.(true);
        } else {
            // View not created yet (panel collapsed) — open it.
            void vscode.commands.executeCommand('codeforcesResults.focus');
        }
    }

    private push(): void {
        this.view?.webview.postMessage({ type: 'state', state: this.state });
    }

    private html(_webview: vscode.Webview): string {
        const nonce = String(Math.random()).slice(2) + String(Date.now());
        const csp = [
            `default-src 'none'`,
            `style-src 'nonce-${nonce}'`,
            `script-src 'nonce-${nonce}'`
        ].join('; ');
        return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 4px 0 12px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
  }
  .muted { color: var(--vscode-descriptionForeground); }
  .row { display: flex; align-items: center; gap: 6px; }
  .pad { padding: 4px 10px; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { padding: 4px 10px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  header .title { font-weight: 600; }
  .chip {
    font-size: 0.85em; padding: 0 6px; border-radius: 3px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    cursor: pointer; white-space: nowrap;
  }
  button {
    font: inherit; color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none; padding: 2px 10px; border-radius: 2px; cursor: pointer;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.link {
    background: none; color: var(--vscode-textLink-foreground);
    padding: 0 4px; border-radius: 0;
  }
  button.link:hover { background: none; text-decoration: underline; }

  .verdict { padding: 4px 10px; }
  .verdict .k-pending { color: var(--vscode-descriptionForeground); }
  .verdict .k-ok { color: var(--vscode-testing-iconPassed); }
  .verdict .k-bad { color: var(--vscode-testing-iconFailed); }

  .compile {
    margin: 8px 10px; padding: 8px; border-radius: 3px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
  }
  .compile pre {
    margin: 4px 0 0; white-space: pre-wrap; word-break: break-word;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px);
  }

  .case { border-bottom: 1px solid var(--vscode-panel-border); }
  .case > .head {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 10px; cursor: pointer; user-select: none;
  }
  .case > .head:hover { background: var(--vscode-list-hoverBackground); }
  .case .name { flex: 1; }
  .case .time { color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
  .badge {
    width: 14px; height: 14px; display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; flex: none;
  }
  .badge.pass { color: var(--vscode-testing-iconPassed); }
  .badge.fail { color: var(--vscode-testing-iconFailed); }
  .badge.none { color: var(--vscode-descriptionForeground); }
  .spinner {
    width: 12px; height: 12px; border-radius: 50%;
    border: 1.5px solid var(--vscode-descriptionForeground); border-top-color: transparent;
    animation: spin 0.7s linear infinite; flex: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .case > .body { padding: 4px 10px 10px; display: none; }
  .case.open > .body { display: block; }
  .io { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
  .io > div { min-width: 0; }
  .io .lbl { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin-bottom: 2px; }
  .io pre {
    margin: 0; padding: 5px 6px; overflow-x: auto; white-space: pre;
    background: var(--vscode-textCodeBlock-background);
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px);
    line-height: 1.4;
  }
  .io pre .diff { background: var(--vscode-diffEditor-removedTextBackground, rgba(255,0,0,0.2)); display: block; }
  .io pre .diff.ins { background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,255,0,0.2)); }
  .case .actions { margin-top: 6px; display: flex; gap: 6px; }
  .stderr { margin-top: 6px; }
  .stderr .lbl { font-size: 0.82em; color: var(--vscode-descriptionForeground); }

  .tabs { display: flex; gap: 2px; padding: 4px 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab {
    background: none; color: var(--vscode-descriptionForeground);
    border: none; border-bottom: 2px solid transparent; border-radius: 0; padding: 4px 8px; cursor: pointer;
  }
  .tab.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .tab:hover { background: var(--vscode-list-hoverBackground); }

  .attempts { display: flex; flex-direction: column; }
  .attempt {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 10px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .attempt:hover { background: var(--vscode-list-hoverBackground); }
  .attempt .v { flex: 1; min-width: 0; }
  .attempt .meta {
    color: var(--vscode-descriptionForeground); font-size: 0.85em;
    white-space: nowrap; font-variant-numeric: tabular-nums;
  }

  .add { padding: 8px 10px; }
  .add textarea {
    width: 100%; box-sizing: border-box; resize: vertical; min-height: 42px;
    font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px);
    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  }
  .add .lbl { font-size: 0.82em; color: var(--vscode-descriptionForeground); margin: 4px 0 2px; }
  .empty { padding: 16px 10px; }
</style>
</head>
<body>
<div id="app"><div class="empty muted">Open a Codeforces problem to see its samples here.</div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (tag, props, kids) => {
  const el = document.createElement(tag);
  if (props) for (const k in props) {
    if (k === 'class') el.className = props[k];
    else if (k === 'text') el.textContent = props[k];
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), props[k]);
    else el.setAttribute(k, props[k]);
  }
  for (const kid of kids || []) if (kid) el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  return el;
};

function firstDiffLine(expected, actual) {
  const e = (expected || '').replace(/\\s+$/,'').split('\\n');
  const a = (actual || '').replace(/\\s+$/,'').split('\\n');
  const n = Math.max(e.length, a.length);
  for (let i = 0; i < n; i++) if ((e[i] ?? '') !== (a[i] ?? '')) return i;
  return -1;
}
function preWithDiff(textLines, diffIndex, ins) {
  const pre = $('pre');
  textLines.forEach((line, i) => {
    if (i === diffIndex) pre.appendChild($('span', { class: 'diff' + (ins ? ' ins' : '') }, [line + '\\n']));
    else pre.appendChild(document.createTextNode(line + '\\n'));
  });
  return pre;
}

let state = null;
let tab = 'tests';

function renderAttempts(app, s) {
  if (!s.attempts.length) {
    app.appendChild($('div', { class: 'empty muted', text: 'No attempts yet — submit to start your history.' }));
    return;
  }
  const list = $('div', { class: 'attempts' });
  s.attempts.forEach((a) => {
    list.appendChild($('div', {
      class: 'attempt', title: 'Diff the source you submitted then against the current file',
      onclick: () => post('showAttemptSource', { index: a.origIndex })
    }, [
      $('span', { class: 'badge ' + (a.kind === 'ok' ? 'pass' : a.kind === 'warn' ? 'none' : 'fail'),
                  text: a.kind === 'ok' ? '✔' : (a.kind === 'warn' ? '·' : '✘') }),
      $('span', { class: 'v', text: a.verdict }),
      $('span', { class: 'meta', text: a.when + '  ·  ' + a.language + (a.submissionId ? '  ·  #' + a.submissionId : '') })
    ]));
  });
  app.appendChild(list);
}

function render() {
  const app = document.getElementById('app');
  app.textContent = '';
  if (!state || !state.problem) {
    app.appendChild($('div', { class: 'empty muted', text: 'Open a Codeforces problem to see its samples here.' }));
    return;
  }
  const s = state;

  // header
  const head = $('header', null, [
    $('div', { class: 'row' }, [
      $('span', { class: 'title', text: s.problem.index + '. ' + s.problem.name }),
      $('a', { href: s.problem.url, text: 'open' })
    ]),
    $('div', { class: 'row'}, [
      $('button', { onclick: () => post('runAll'), text: s.busy ? 'Running…' : 'Run all' }),
      $('button', { class: 'secondary', onclick: () => post('submit'), text: 'Submit' }),
      $('span', { class: 'chip', title: 'Change compiler', onclick: () => vscode.postMessage({ type: 'pickLang' }),
                  text: s.lang || 'set language' })
    ])
  ]);
  app.appendChild(head);

  if (s.verdict) {
    app.appendChild($('div', { class: 'verdict' }, [
      $('span', { class: 'muted', text: 'Verdict: ' }),
      $('span', { class: 'k-' + s.verdict.kind, text: s.verdict.text })
    ]));
  }

  app.appendChild($('div', { class: 'tabs' }, [
    $('button', { class: 'tab' + (tab === 'tests' ? ' on' : ''),
                  onclick: () => { tab = 'tests'; render(); }, text: 'Tests' }),
    $('button', { class: 'tab' + (tab === 'attempts' ? ' on' : ''),
                  onclick: () => { tab = 'attempts'; render(); },
                  text: 'Attempts' + (s.attempts.length ? ' (' + s.attempts.length + ')' : '') })
  ]));

  if (tab === 'attempts') { renderAttempts(app, s); return; }

  if (s.error) {
    app.appendChild($('div', { class: 'compile' }, [
      $('div', { class: 'muted', text: s.error.title }),
      $('pre', { text: s.error.text })
    ]));
  }

  // cases
  s.tests.forEach((t, i) => {
    const r = s.results[i];
    const running = s.running[i];
    const failed = r && r.outcome !== 'passed';
    const wrap = $('div', { class: 'case' + (failed || (!r && !running) ? ' open' : '') });

    let badge;
    if (running) badge = $('span', { class: 'spinner' });
    else if (!r) badge = $('span', { class: 'badge none', text: '○' });
    else badge = $('span', { class: 'badge ' + (r.outcome === 'passed' ? 'pass' : 'fail'),
                             text: r.outcome === 'passed' ? '✔' : '✘' });

    const head2 = $('div', { class: 'head', onclick: () => wrap.classList.toggle('open') }, [
      badge,
      $('span', { class: 'name', text: t.label + (r && r.outcome !== 'passed' ? ' — ' + r.outcome : '') }),
      $('span', { class: 'time', text: r ? r.ms + ' ms' : '' })
    ]);
    wrap.appendChild(head2);

    const diffIdx = r ? firstDiffLine(t.expected, r.actual) : -1;
    const body = $('div', { class: 'body' }, [
      $('div', { class: 'io' }, [
        $('div', null, [ $('div', { class: 'lbl', text: 'Input' }), $('pre', { text: t.input }) ]),
        $('div', null, [ $('div', { class: 'lbl', text: 'Expected' }),
                         preWithDiff((t.expected || '').split('\\n'), diffIdx, false) ]),
        $('div', null, [ $('div', { class: 'lbl', text: 'Actual' }),
                         r ? preWithDiff((r.actual || '').split('\\n'), diffIdx, true)
                           : $('pre', { class: 'muted', text: running ? '…' : '(not run)' }) ])
      ])
    ]);
    if (r && r.stderr && r.stderr.trim()) {
      body.appendChild($('div', { class: 'stderr' }, [
        $('div', { class: 'lbl', text: 'stderr' }), $('pre', { text: r.stderr })
      ]));
    }
    const actions = $('div', { class: 'actions' }, [
      $('button', { class: 'link', onclick: () => post('runOne', { index: i }), text: 'Run' }),
      t.custom ? $('button', { class: 'link', onclick: () => post('deleteTest', { index: i - s.sampleCount }), text: 'Delete' }) : null
    ]);
    body.appendChild(actions);
    wrap.appendChild(body);
    app.appendChild(wrap);
  });

  // add-test
  const inp = $('textarea', { rows: '3', placeholder: 'input' });
  const exp = $('textarea', { rows: '2', placeholder: 'expected output' });
  app.appendChild($('div', { class: 'add' }, [
    $('div', { class: 'lbl', text: 'Add a test case' }),
    inp,
    $('div', { class: 'lbl', text: 'Expected output' }),
    exp,
    $('div', { class: 'row'}, [
      $('button', { class: 'secondary', onclick: () => { post('addTest', { input: inp.value, expected: exp.value }); inp.value = ''; exp.value = ''; }, text: 'Add test' })
    ])
  ]));
}

function post(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }

window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'state') { state = e.data.state; render(); }
});
post('ready');
</script>
</body>
</html>`;
    }
}

function toRows(attempts: Attempt[]): AttemptRow[] {
    return attempts
        .map((a, i) => ({
            origIndex: i,
            when: new Date(a.at).toLocaleString(),
            verdict: a.verdict,
            kind: verdictKind(a.verdict),
            language: a.language || '—',
            submissionId: a.submissionId
        }))
        .reverse(); // newest first
}
