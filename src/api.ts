import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CfHttp } from './http';
import { Contest, Problem, SolveState, problemKey } from './types';

interface ApiEnvelope<T> {
    status: string;
    comment?: string;
    result: T;
}

interface RawContest {
    id: number;
    name: string;
    phase: string;
    startTimeSeconds?: number;
    durationSeconds?: number;
}

interface RawProblem {
    contestId?: number;
    index: string;
    name: string;
    rating?: number;
    tags?: string[];
}

interface RawSubmission {
    problem: RawProblem;
    verdict?: string;
    contestId?: number;
}

const API = 'https://codeforces.com/api';

export class CodeforcesApi {
    private contestCache = new Map<string, { at: number; value: Contest[] }>();
    private problemCache = new Map<number, { at: number; value: Problem[] }>();
    private problemsetCache: { at: number; value: Problem[] } | undefined;
    private solvedCache: { at: number; value: Map<string, SolveState> } | undefined;

    constructor(private readonly http: CfHttp) {}

    private credentials(): { key: string; secret: string } | undefined {
        const cfg = vscode.workspace.getConfiguration('codeforces');
        const key = cfg.get<string>('apiKey', '').trim();
        const secret = cfg.get<string>('apiSecret', '').trim();
        return key && secret ? { key, secret } : undefined;
    }

    private buildUrl(method: string, params: Record<string, string>): string {
        const creds = this.credentials();
        if (!creds) {
            const qs = new URLSearchParams(params).toString();
            return `${API}/${method}${qs ? `?${qs}` : ''}`;
        }
        const time = Math.floor(Date.now() / 1000).toString();
        const signed: Record<string, string> = { ...params, apiKey: creds.key, time };
        const sorted = Object.keys(signed)
            .sort()
            .map((k) => `${k}=${signed[k]}`)
            .join('&');
        const rand = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
        const hash = crypto
            .createHash('sha512')
            .update(`${rand}/${method}?${sorted}#${creds.secret}`)
            .digest('hex');
        return `${API}/${method}?${sorted}&apiSig=${rand}${hash}`;
    }

    private async call<T>(method: string, params: Record<string, string> = {}): Promise<T> {
        const body = await this.http.getJson<ApiEnvelope<T>>(this.buildUrl(method, params));
        if (body.status !== 'OK') {
            throw new Error(body.comment || `${method} failed`);
        }
        return body.result;
    }

    invalidate(): void {
        this.contestCache.clear();
        this.problemCache.clear();
        this.problemsetCache = undefined;
        this.solvedCache = undefined;
    }

    /** Drop just the solve-state cache — e.g. right after a verdict lands. */
    invalidateSolveStates(): void {
        this.solvedCache = undefined;
    }

    async contests(gym: boolean): Promise<Contest[]> {
        const cacheKey = gym ? 'gym' : 'main';
        const hit = this.contestCache.get(cacheKey);
        if (hit && Date.now() - hit.at < 5 * 60_000) {
            return hit.value;
        }
        const raw = await this.call<RawContest[]>('contest.list', gym ? { gym: 'true' } : {});
        const limit = vscode.workspace.getConfiguration('codeforces').get<number>('contestLimit', 25);
        const value: Contest[] = raw.slice(0, limit).map((c) => ({
            id: c.id,
            name: c.name,
            kind: gym ? 'gym' : 'contest',
            phase: c.phase,
            startTimeSeconds: c.startTimeSeconds,
            durationSeconds: c.durationSeconds
        }));
        this.contestCache.set(cacheKey, { at: Date.now(), value });
        return value;
    }

    /**
     * Problem list for a public contest or gym. Group contests are not exposed
     * by the API at all, so those go through the scraper instead.
     */
    async problems(contest: Contest): Promise<Problem[]> {
        const hit = this.problemCache.get(contest.id);
        if (hit && Date.now() - hit.at < 30 * 60_000) {
            return hit.value;
        }
        const result = await this.call<{ problems: RawProblem[] }>('contest.standings', {
            contestId: String(contest.id),
            from: '1',
            count: '1'
        });
        const value: Problem[] = result.problems.map((p) => ({
            contestId: p.contestId ?? contest.id,
            index: p.index,
            name: p.name,
            kind: contest.kind,
            groupCode: contest.groupCode,
            rating: p.rating,
            tags: p.tags
        }));
        this.problemCache.set(contest.id, { at: Date.now(), value });
        return value;
    }

    /** The whole public problemset, from problemset.problems (no companion needed). */
    async problemsetProblems(): Promise<Problem[]> {
        if (this.problemsetCache && Date.now() - this.problemsetCache.at < 60 * 60_000) {
            return this.problemsetCache.value;
        }
        const result = await this.call<{ problems: RawProblem[] }>('problemset.problems', {});
        const value: Problem[] = result.problems
            .filter((p) => p.contestId)
            .map((p) => ({
                contestId: p.contestId as number,
                index: p.index,
                name: p.name,
                kind: 'contest' as const,
                rating: p.rating,
                tags: p.tags
            }));
        this.problemsetCache = { at: Date.now(), value };
        return value;
    }

    /** Map of "contestId/INDEX" to how far you got on it. */
    async solveStates(handle: string): Promise<Map<string, SolveState>> {
        if (!handle) {
            return new Map();
        }
        if (this.solvedCache && Date.now() - this.solvedCache.at < 3 * 60_000) {
            return this.solvedCache.value;
        }
        const map = new Map<string, SolveState>();
        try {
            const subs = await this.call<RawSubmission[]>('user.status', {
                handle,
                from: '1',
                count: '10000'
            });
            for (const s of subs) {
                const contestId = s.problem.contestId ?? s.contestId;
                if (!contestId) {
                    continue;
                }
                const key = problemKey({ contestId, index: s.problem.index });
                if (s.verdict === 'OK') {
                    map.set(key, 'solved');
                } else if (!map.has(key)) {
                    map.set(key, 'attempted');
                }
            }
        } catch {
            // A missing or renamed handle should not take the tree down.
        }
        this.solvedCache = { at: Date.now(), value: map };
        return map;
    }
}
