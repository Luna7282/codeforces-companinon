import * as vscode from 'vscode';
import { CodeforcesApi } from './api';
import { Session } from './session';
import { groupContests, groupProblems } from './scrape';
import { readMeta, solutionPath } from './files';
import { isAccepted } from './verdict';
import { Contest, Problem, SolveState, contestUrl, problemKey } from './types';

type Node =
    | { type: 'banner' }
    | { type: 'section'; id: 'contests' | 'gym' | 'groups' | 'problemset'; label: string }
    | { type: 'group'; groupCode: string }
    | { type: 'contest'; contest: Contest }
    | { type: 'rating'; rating: number; problems: Problem[] }
    | { type: 'problem'; problem: Problem; state: SolveState; attempts: number }
    | { type: 'message'; label: string; command?: vscode.Command };

const ICONS: Record<SolveState, vscode.ThemeIcon> = {
    solved: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed')),
    attempted: new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconFailed')),
    untouched: new vscode.ThemeIcon('circle-large-outline')
};

export class CodeforcesTree implements vscode.TreeDataProvider<Node> {
    private emitter = new vscode.EventEmitter<Node | undefined>();
    readonly onDidChangeTreeData = this.emitter.event;

    /** Optimistic solve-state per problem, set from a verdict before the API catches up. */
    private overrides = new Map<string, SolveState>();

    constructor(
        private readonly session: Session,
        private readonly api: CodeforcesApi,
        private readonly companionOnline: () => boolean,
        private bannerDismissed: boolean
    ) {}

    refresh(): void {
        this.overrides.clear();
        this.api.invalidate();
        this.emitter.fire(undefined);
    }

    /** Repaint a problem's icon now, without waiting for the solve-state cache to expire. */
    markSolveState(problem: Problem, state: SolveState): void {
        this.overrides.set(problemKey(problem), state);
        this.emitter.fire(undefined);
    }

    dismissBanner(): void {
        this.bannerDismissed = true;
        this.emitter.fire(undefined);
    }

    /**
     * Lets `TreeView.reveal()` (used by the deep-link handler to land on a
     * specific contest/group after a companion click) walk from a node up to
     * a root without any extra bookkeeping — a contest/group node already
     * carries everything needed to compute its section.
     */
    getParent(node: Node): Node | undefined {
        if (node.type === 'contest') {
            if (node.contest.kind === 'group') {
                return { type: 'group', groupCode: node.contest.groupCode ?? '' };
            }
            return { type: 'section', id: node.contest.kind === 'gym' ? 'gym' : 'contests', label: '' };
        }
        if (node.type === 'group') {
            return { type: 'section', id: 'groups', label: '' };
        }
        if (node.type === 'problem') {
            const p = node.problem;
            return { type: 'contest', contest: { id: p.contestId, name: '', kind: p.kind, groupCode: p.groupCode } };
        }
        return undefined;
    }

    getTreeItem(node: Node): vscode.TreeItem {
        switch (node.type) {
            case 'banner': {
                const item = new vscode.TreeItem(
                    'Set up the browser companion to open problems',
                    vscode.TreeItemCollapsibleState.None
                );
                item.iconPath = new vscode.ThemeIcon('plug');
                item.tooltip =
                    'Codeforces blocks this extension’s own requests for statements, group contests, ' +
                    'and submitting. Click for the setup walkthrough.';
                item.contextValue = 'cfSetupBanner';
                item.command = {
                    command: 'codeforces.setupWalkthrough',
                    title: 'Codeforces: Setup walkthrough'
                };
                return item;
            }
            case 'section': {
                const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Collapsed);
                item.contextValue = 'cfSection';
                item.id = sectionNodeId(node.id);
                return item;
            }
            case 'group': {
                const item = new vscode.TreeItem(node.groupCode, vscode.TreeItemCollapsibleState.Collapsed);
                item.iconPath = new vscode.ThemeIcon('organization');
                item.contextValue = 'cfGroup';
                item.id = groupNodeId(node.groupCode);
                return item;
            }
            case 'contest': {
                const item = new vscode.TreeItem(node.contest.name, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = describeContest(node.contest);
                item.tooltip = contestUrl(node.contest);
                item.iconPath = new vscode.ThemeIcon('list-ordered');
                item.contextValue = 'cfContest';
                item.id = contestNodeId(node.contest);
                return item;
            }
            case 'rating': {
                const label = node.rating ? String(node.rating) : 'Unrated';
                const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                item.description = `${node.problems.length} problem${node.problems.length === 1 ? '' : 's'}`;
                item.iconPath = new vscode.ThemeIcon('symbol-numeric');
                return item;
            }
            case 'problem': {
                const p = node.problem;
                const item = new vscode.TreeItem(`${p.index}. ${p.name}`, vscode.TreeItemCollapsibleState.None);
                const bits = [
                    p.rating ? String(p.rating) : '',
                    node.attempts > 0 ? `${node.attempts} attempt${node.attempts === 1 ? '' : 's'}` : ''
                ].filter(Boolean);
                item.description = bits.join(' · ') || undefined;
                item.iconPath = ICONS[node.state];
                item.contextValue = 'cfProblem';
                item.id = problemNodeId(p);
                item.command = {
                    command: 'codeforces.openProblem',
                    title: 'Open problem',
                    arguments: [p]
                };
                return item;
            }
            case 'message': {
                const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
                item.iconPath = new vscode.ThemeIcon('info');
                item.command = node.command;
                return item;
            }
        }
    }

    async getChildren(node?: Node): Promise<Node[]> {
        try {
            return await this.children(node);
        } catch (err) {
            return [{ type: 'message', label: (err as Error).message }];
        }
    }

    private async children(node?: Node): Promise<Node[]> {
        if (!node) {
            const roots: Node[] = [];
            if (!this.bannerDismissed && !this.companionOnline()) {
                roots.push({ type: 'banner' });
            }
            roots.push(
                { type: 'section', id: 'contests', label: 'Contests' },
                { type: 'section', id: 'problemset', label: 'Problemset' },
                { type: 'section', id: 'groups', label: 'Groups' },
                { type: 'section', id: 'gym', label: 'Gym' }
            );
            return roots;
        }

        if (node.type === 'section' && node.id === 'contests') {
            const contests = await this.api.contests(false);
            return contests.map((contest) => ({ type: 'contest' as const, contest }));
        }

        if (node.type === 'section' && node.id === 'gym') {
            const contests = await this.api.contests(true);
            return contests.map((contest) => ({ type: 'contest' as const, contest }));
        }

        if (node.type === 'section' && node.id === 'problemset') {
            const problems = await this.api.problemsetProblems();
            const byRating = new Map<number, Problem[]>();
            for (const p of problems) {
                const r = p.rating ?? 0;
                let bucket = byRating.get(r);
                if (!bucket) {
                    bucket = [];
                    byRating.set(r, bucket);
                }
                bucket.push(p);
            }
            return [...byRating.entries()]
                .sort(([a], [b]) => (a || Infinity) - (b || Infinity))
                .map(([rating, ps]) => ({ type: 'rating' as const, rating, problems: ps }));
        }

        if (node.type === 'rating') {
            const handle = vscode.workspace.getConfiguration('codeforces').get<string>('handle', '').trim();
            const states = await this.api.solveStates(handle || this.session.currentHandle);
            return node.problems.map((problem) => this.toProblemNode(problem, states));
        }

        if (node.type === 'section' && node.id === 'groups') {
            const codes = vscode.workspace.getConfiguration('codeforces').get<string[]>('groups', []);
            if (codes.length === 0) {
                return [
                    {
                        type: 'message',
                        label: 'Add a group',
                        command: { command: 'codeforces.addGroup', title: 'Add group' }
                    }
                ];
            }
            return codes.map((groupCode) => ({ type: 'group' as const, groupCode }));
        }

        if (node.type === 'group') {
            const contests = await groupContests(this.session.http, node.groupCode);
            if (contests.length === 0) {
                return [{ type: 'message', label: 'No contests in this group' }];
            }
            return contests.map((contest) => ({ type: 'contest' as const, contest }));
        }

        if (node.type === 'contest') {
            const problems =
                node.contest.kind === 'group'
                    ? await groupProblems(this.session.http, node.contest)
                    : await this.api.problems(node.contest);
            const handle = vscode.workspace.getConfiguration('codeforces').get<string>('handle', '').trim();
            const states = await this.api.solveStates(handle || this.session.currentHandle);
            return problems.map((problem) => this.toProblemNode(problem, states));
        }

        return [];
    }

    private toProblemNode(problem: Problem, states: Map<string, SolveState>): Node {
        const local = localAttempts(problem);
        return {
            type: 'problem',
            problem,
            attempts: local.length,
            // Local metadata is authoritative (it has attempts the API refused);
            // reconcile with user.status, never lose a local entry.
            state: resolveState(this.overrides.get(problemKey(problem)), states.get(problemKey(problem)), local)
        };
    }
}

function localAttempts(problem: Problem): { verdict: string }[] {
    try {
        return readMeta(solutionPath(problem))?.attempts ?? [];
    } catch {
        return []; // no workspace folder open yet
    }
}

function resolveState(
    override: SolveState | undefined,
    apiState: SolveState | undefined,
    attempts: { verdict: string }[]
): SolveState {
    if (override) {
        return override;
    }
    if (apiState === 'solved' || attempts.some((a) => isAccepted(a.verdict))) {
        return 'solved';
    }
    if (apiState === 'attempted' || attempts.length > 0) {
        return 'attempted';
    }
    return 'untouched';
}

// Stable ids so TreeView.reveal() can match a freshly-built skeleton node
// (see extension.ts's deep-link handler) against the real node `getChildren`
// returns — reveal walks the tree by id, not by object identity.
function sectionNodeId(id: string): string {
    return `section:${id}`;
}
function groupNodeId(groupCode: string): string {
    return `group:${groupCode}`;
}
function contestNodeId(contest: Contest): string {
    return `contest:${contest.kind}:${contest.groupCode ?? ''}:${contest.id}`;
}
function problemNodeId(problem: Problem): string {
    return `problem:${problem.kind}:${problem.groupCode ?? ''}:${problem.contestId}:${problem.index.toUpperCase()}`;
}

function describeContest(c: Contest): string {
    if (c.phase === 'BEFORE' && c.startTimeSeconds) {
        return `starts ${new Date(c.startTimeSeconds * 1000).toLocaleString()}`;
    }
    if (c.phase === 'CODING') {
        return 'running now';
    }
    return '';
}

export type { Node as CodeforcesNode, Problem };
