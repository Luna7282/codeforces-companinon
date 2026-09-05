export type ContestKind = 'contest' | 'gym' | 'group';

export interface Contest {
    id: number;
    name: string;
    kind: ContestKind;
    phase?: string;
    startTimeSeconds?: number;
    durationSeconds?: number;
    /** Only set when kind === 'group'. */
    groupCode?: string;
}

export interface Problem {
    contestId: number;
    index: string;
    name: string;
    kind: ContestKind;
    groupCode?: string;
    rating?: number;
    tags?: string[];
}

export interface Sample {
    input: string;
    output: string;
}

export interface ProblemDetail {
    statementHtml: string;
    samples: Sample[];
    timeLimit?: string;
    memoryLimit?: string;
    /** Parsed off the statement page itself — authoritative over whatever name a caller already had. */
    name?: string;
}

export interface Language {
    id: string;
    name: string;
}

export type SolveState = 'solved' | 'attempted' | 'untouched';

/** Key used to look a problem up in the solved-state map. */
export function problemKey(p: Pick<Problem, 'contestId' | 'index'>): string {
    return `${p.contestId}/${p.index.toUpperCase()}`;
}

export function contestUrl(c: Contest): string {
    if (c.kind === 'gym') {
        return `https://codeforces.com/gym/${c.id}`;
    }
    if (c.kind === 'group') {
        return `https://codeforces.com/group/${c.groupCode}/contest/${c.id}`;
    }
    return `https://codeforces.com/contest/${c.id}`;
}

export function problemUrl(p: Problem): string {
    if (p.kind === 'gym') {
        return `https://codeforces.com/gym/${p.contestId}/problem/${p.index}`;
    }
    if (p.kind === 'group') {
        return `https://codeforces.com/group/${p.groupCode}/contest/${p.contestId}/problem/${p.index}`;
    }
    return `https://codeforces.com/contest/${p.contestId}/problem/${p.index}`;
}

export function submitUrl(p: Problem): string {
    if (p.kind === 'gym') {
        return `https://codeforces.com/gym/${p.contestId}/submit`;
    }
    if (p.kind === 'group') {
        return `https://codeforces.com/group/${p.groupCode}/contest/${p.contestId}/submit`;
    }
    return `https://codeforces.com/contest/${p.contestId}/submit`;
}
