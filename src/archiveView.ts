import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    archiveRoot,
    hasArchiveRoot,
    readIndex,
    rebuildIndex,
    recordFiles,
    ArchiveIndexEntry,
    RunRecord,
    AttemptRecord
} from './archive';
import { verdictKind, verdictCategory } from './verdict';

export const ARCHIVE_SCHEME = 'cf-archive';

interface TimelineItem {
    type: 'run' | 'attempt';
    at: number;
    lastAt: number;
    count: number; // run invocations folded into this record (1 for attempts)
    file: string; // absolute path of the runs/… or attempts/… json
    title: string; // single-entry label
    groupTitle: string; // label when several of these collapse together
    detail: string;
    kind: 'ok' | 'bad' | 'warn';
    category: string; // for the verdict filter
    key: string; // consecutive items with the same key collapse into one row
}

type Node =
    | { t: 'judge'; judge: string }
    | { t: 'scope'; judge: string; seg: string }
    | { t: 'problem'; entry: ArchiveIndexEntry }
    | { t: 'group'; entry: ArchiveIndexEntry; items: TimelineItem[] }
    | { t: 'timeline'; entry: ArchiveIndexEntry; item: TimelineItem }
    | { t: 'msg'; label: string };

const STATE_ICON: Record<'solved' | 'attempted' | 'untouched', vscode.ThemeIcon> = {
    solved: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
    attempted: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconFailed')),
    untouched: new vscode.ThemeIcon('circle-large-outline')
};

export class ArchiveTree implements vscode.TreeDataProvider<Node> {
    private emitter = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    filterCategory: string | undefined;
    search: string | undefined;

    refresh(): void {
        this.emitter.fire(undefined);
    }

    getTreeItem(node: Node): vscode.TreeItem {
        switch (node.t) {
            case 'msg': {
                const i = new vscode.TreeItem(node.label);
                i.iconPath = new vscode.ThemeIcon('info');
                return i;
            }
            case 'judge': {
                const i = new vscode.TreeItem(cap(node.judge), vscode.TreeItemCollapsibleState.Expanded);
                i.iconPath = new vscode.ThemeIcon('archive');
                return i;
            }
            case 'scope': {
                const entries = this.entriesInScope(node.judge, node.seg);
                const solved = entries.filter((e) => e.solved).length;
                const i = new vscode.TreeItem(node.seg, vscode.TreeItemCollapsibleState.Collapsed);
                i.description = `${solved}/${entries.length} solved`;
                i.iconPath = new vscode.ThemeIcon('folder');
                return i;
            }
            case 'problem': {
                const e = node.entry;
                const i = new vscode.TreeItem(
                    `${e.ref.index}. ${e.name}`,
                    vscode.TreeItemCollapsibleState.Collapsed
                );
                i.description = [
                    e.attemptCount ? `${e.attemptCount} attempt${e.attemptCount === 1 ? '' : 's'}` : '',
                    e.runCount ? `${e.runCount} run${e.runCount === 1 ? '' : 's'}` : ''
                ]
                    .filter(Boolean)
                    .join(' · ');
                i.iconPath = STATE_ICON[e.solved ? 'solved' : e.attemptCount || e.runCount ? 'attempted' : 'untouched'];
                i.tooltip = e.url || undefined;
                return i;
            }
            case 'group': {
                const g = node.items;
                const runs = g.reduce((n, it) => n + it.count, 0);
                const kind = g[0].kind;
                const i = new vscode.TreeItem(g[0].groupTitle, vscode.TreeItemCollapsibleState.Collapsed);
                i.description = `${runs} ${g[0].type === 'attempt' ? 'submissions' : 'runs'} · ${ago(g[g.length - 1].at)} – ${ago(g[0].lastAt)}`;
                i.iconPath = new vscode.ThemeIcon(
                    g[0].type === 'attempt' ? 'cloud-upload' : 'play',
                    new vscode.ThemeColor(
                        kind === 'ok'
                            ? 'testing.iconPassed'
                            : kind === 'warn'
                              ? 'testing.iconQueued'
                              : 'testing.iconFailed'
                    )
                );
                return i;
            }
            case 'timeline': {
                const it = node.item;
                const i = new vscode.TreeItem(it.title, vscode.TreeItemCollapsibleState.None);
                i.description = `${it.type === 'attempt' ? 'submitted' : 'ran'}${it.count > 1 ? ` ×${it.count}` : ''} · ${ago(it.lastAt)}`;
                i.tooltip = `${it.detail}\n${new Date(it.at).toLocaleString()}`;
                i.iconPath = new vscode.ThemeIcon(
                    it.type === 'attempt' ? 'cloud-upload' : 'play',
                    new vscode.ThemeColor(
                        it.kind === 'ok'
                            ? 'testing.iconPassed'
                            : it.kind === 'warn'
                              ? 'testing.iconQueued'
                              : 'testing.iconFailed'
                    )
                );
                i.contextValue = 'cfArchiveEntry';
                i.command = {
                    command: 'codeforces.archiveOpenEntry',
                    title: 'Open archived source',
                    arguments: [node]
                };
                return i;
            }
        }
    }

    async getChildren(node?: Node): Promise<Node[]> {
        if (!hasArchiveRoot()) {
            return [{ t: 'msg', label: 'Set a workspace folder — run "Codeforces: Change workspace folder".' }];
        }
        if (!node) {
            const judges = [...new Set(Object.values(readIndex().problems).map((e) => e.ref.judge))].sort();
            if (judges.length === 0) {
                return [{ t: 'msg', label: 'No archived problems yet. Open a problem and run or submit.' }];
            }
            return judges.map((judge) => ({ t: 'judge', judge }));
        }
        if (node.t === 'judge') {
            const segs = new Set<string>();
            for (const e of Object.values(readIndex().problems)) {
                if (e.ref.judge === node.judge && this.entryVisible(e)) {
                    segs.add(scopeSeg(e));
                }
            }
            return [...segs]
                .sort()
                .reverse()
                .map((seg) => ({ t: 'scope' as const, judge: node.judge, seg }));
        }
        if (node.t === 'scope') {
            return this.entriesInScope(node.judge, node.seg)
                .filter((e) => this.entryVisible(e))
                .sort((a, b) => b.lastActivity - a.lastActivity)
                .map((entry) => ({ t: 'problem' as const, entry }));
        }
        if (node.t === 'problem') {
            const items = timelineFor(node.entry).filter(
                (it) => !this.filterCategory || it.category === this.filterCategory
            );
            if (items.length === 0) {
                return [{ t: 'msg', label: 'Nothing matches the current filter.' }];
            }
            return groupTimeline(items).map((g) =>
                g.length === 1
                    ? ({ t: 'timeline', entry: node.entry, item: g[0] } as Node)
                    : ({ t: 'group', entry: node.entry, items: g } as Node)
            );
        }
        if (node.t === 'group') {
            return node.items.map((item) => ({ t: 'timeline' as const, entry: node.entry, item }));
        }
        return [];
    }

    private entriesInScope(judge: string, seg: string): ArchiveIndexEntry[] {
        return Object.values(readIndex().problems).filter((e) => e.ref.judge === judge && scopeSeg(e) === seg);
    }

    private entryVisible(e: ArchiveIndexEntry): boolean {
        if (this.search && !e.name.toLowerCase().includes(this.search.toLowerCase())) {
            return false;
        }
        if (this.filterCategory) {
            return timelineFor(e).some((it) => it.category === this.filterCategory);
        }
        return true;
    }
}

// ---- timeline assembly ---------------------------------------------------

function timelineFor(entry: ArchiveIndexEntry): TimelineItem[] {
    const dir = path.join(archiveRoot(), entry.dir);
    const out: TimelineItem[] = [];

    for (const file of recordFiles(dir, 'runs')) {
        const r = readJson<RunRecord>(file);
        if (!r) {
            continue;
        }
        const passed = r.tests.filter((t) => t.outcome === 'passed').length;
        const failedLabels = r.tests.filter((t) => t.outcome !== 'passed').map((t) => t.label);
        const failed = failedLabels.length;
        const sig = r.compileOk ? r.tests.map((t) => `${t.label}:${t.outcome}`).join('|') : `compile:${firstLine(r.compileOutput ?? '')}`;
        const groupTitle = !r.compileOk
            ? 'Compile error'
            : failed === 0
              ? 'Ran — all passed'
              : `${failedLabels.join(', ')} failed`;
        out.push({
            type: 'run',
            at: r.at,
            lastAt: r.lastAt ?? r.at,
            count: r.count ?? 1,
            file,
            title: !r.compileOk ? 'Compile error' : `Ran — ${passed}/${r.tests.length} passed`,
            groupTitle,
            detail: !r.compileOk
                ? firstLine(r.compileOutput ?? '')
                : r.tests.map((t) => `${t.label}: ${t.outcome}`).join('  ·  '),
            kind: !r.compileOk || failed > 0 ? 'bad' : 'ok',
            category: !r.compileOk ? 'Compilation error' : failed > 0 ? 'Wrong answer' : 'Accepted',
            key: `run:${sig}`
        });
    }
    for (const file of recordFiles(dir, 'attempts')) {
        const a = readJson<AttemptRecord>(file);
        if (!a) {
            continue;
        }
        out.push({
            type: 'attempt',
            at: a.at,
            lastAt: a.at,
            count: 1,
            file,
            title: a.verdict,
            groupTitle: a.verdict,
            detail: [a.language, a.timeMs, a.memoryKb, a.submissionId && `#${a.submissionId}`]
                .filter(Boolean)
                .join('  ·  '),
            kind: verdictKind(a.verdict),
            category: verdictCategory(a.verdict),
            key: `attempt:${a.verdict}`
        });
    }
    return out.sort((x, y) => y.lastAt - x.lastAt);
}

/** Fold consecutive timeline items with the same key into one group each. */
function groupTimeline(items: TimelineItem[]): TimelineItem[][] {
    const groups: TimelineItem[][] = [];
    for (const it of items) {
        const last = groups[groups.length - 1];
        if (last && last[0].key === it.key) {
            last.push(it);
        } else {
            groups.push([it]);
        }
    }
    return groups;
}

// ---- read-only source + outcome documents ------------------------------

/** Opens the exact source of a timeline entry read-only, with the outcome beside it. */
export async function openArchiveEntry(node: {
    entry: ArchiveIndexEntry;
    item: TimelineItem;
}): Promise<void> {
    const ext = sourceExt(path.join(archiveRoot(), node.entry.dir));
    const label = `${node.entry.ref.index} · ${node.item.title} · ${dateStamp(node.item.at)}`;
    const src = archiveUri(`${label}${ext}`, node.item.file, 'source');
    const out = archiveUri(`${label} — outcome.txt`, node.item.file, 'outcome');

    await vscode.window.showTextDocument(src, { viewColumn: vscode.ViewColumn.One, preview: false });
    await vscode.window.showTextDocument(out, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
}

/** Diff a timeline entry's source against the problem's current source file. */
export async function diffArchiveEntry(node: {
    entry: ArchiveIndexEntry;
    item: TimelineItem;
}): Promise<void> {
    const dir = path.join(archiveRoot(), node.entry.dir);
    const ext = sourceExt(dir);
    const current = fs
        .readdirSync(dir)
        .find((f) => path.extname(f) === ext && !f.startsWith('.'));
    if (!current) {
        void vscode.window.showWarningMessage('No current source file for this problem to diff against.');
        return;
    }
    const left = archiveUri(`${node.entry.ref.index} · ${node.item.title}${ext}`, node.item.file, 'source');
    await vscode.commands.executeCommand(
        'vscode.diff',
        left,
        vscode.Uri.file(path.join(dir, current)),
        `${node.entry.ref.index}: ${node.item.title} ↔ current`
    );
}

function archiveUri(title: string, file: string, kind: 'source' | 'outcome'): vscode.Uri {
    const payload = Buffer.from(JSON.stringify({ file, kind }), 'utf8').toString('base64url');
    return vscode.Uri.from({ scheme: ARCHIVE_SCHEME, path: `/${title}`, query: payload });
}

export class ArchiveContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        let file: string;
        let kind: string;
        try {
            const p = JSON.parse(Buffer.from(uri.query, 'base64url').toString('utf8')) as {
                file: string;
                kind: string;
            };
            file = p.file;
            kind = p.kind;
        } catch {
            return '(could not decode archive reference)';
        }
        const rec = readJson<RunRecord & AttemptRecord>(file);
        if (!rec) {
            return '(archive record not found)';
        }
        if (kind === 'source') {
            return rec.source ?? '(no source recorded)';
        }
        return outcomeText(file, rec);
    }
}

function outcomeText(file: string, rec: RunRecord & AttemptRecord): string {
    const when = new Date(rec.at).toLocaleString();
    if (path.basename(path.dirname(file)) === 'attempts') {
        return [
            `Submission — ${when}`,
            ``,
            `Verdict:    ${rec.verdict}`,
            rec.timeMs ? `Time:       ${rec.timeMs}` : '',
            rec.memoryKb ? `Memory:     ${rec.memoryKb}` : '',
            rec.language ? `Language:   ${rec.language}` : '',
            rec.submissionId ? `Submission: #${rec.submissionId}` : ''
        ]
            .filter((l) => l !== '')
            .join('\n');
    }
    // run
    const head = `Local run — ${when}\n`;
    if (!rec.compileOk) {
        return `${head}\nCompilation failed:\n\n${rec.compileOutput ?? ''}`;
    }
    const body = rec.tests
        .map((t) => {
            const lines = [`${t.label}: ${t.outcome}  (${t.ms} ms)`];
            if (t.outcome !== 'passed') {
                lines.push(`  expected:\n${indent(t.expected)}`);
                lines.push(`  actual:\n${indent(t.actual || '(nothing)')}`);
            }
            if (t.stderr && t.stderr.trim()) {
                lines.push(`  stderr:\n${indent(t.stderr)}`);
            }
            return lines.join('\n');
        })
        .join('\n\n');
    return `${head}${rec.compileOutput ? `\ncompiler output:\n${indent(rec.compileOutput)}\n` : ''}\n${body}`;
}

// ---- helpers -----------------------------------------------------------

function scopeSeg(e: ArchiveIndexEntry): string {
    return e.dir.split(/[\\/]/)[1] ?? '?';
}
function sourceExt(dir: string): string {
    try {
        const f = fs.readdirSync(dir).find((n) => !n.startsWith('.') && path.extname(n));
        return f ? path.extname(f) : '.txt';
    } catch {
        return '.txt';
    }
}
function readJson<T>(p: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
        return undefined;
    }
}
function cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}
function firstLine(s: string): string {
    return s.split('\n')[0].slice(0, 120);
}
function indent(s: string): string {
    return s
        .replace(/\s+$/, '')
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
}
function dateStamp(at: number): string {
    return new Date(at).toISOString().replace(/[:T]/g, '-').slice(0, 16);
}
function ago(at: number): string {
    const s = Math.round((Date.now() - at) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(at).toLocaleDateString();
}

export const VERDICT_FILTERS = [
    'All',
    'Accepted',
    'Wrong answer',
    'Time limit',
    'Memory limit',
    'Runtime error',
    'Compilation error',
    'Idleness limit',
    'Partial',
    'Rejected',
    'Other'
];

export function forceRebuild(): void {
    rebuildIndex();
}
