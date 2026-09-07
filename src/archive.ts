import * as fs from 'fs';
import * as path from 'path';
import { isAccepted } from './verdict';

/**
 * On-disk archive of everything the user has done, judge-agnostic.
 *
 *   <root>/
 *     codeforces/                     <- judge is a path segment; another slots in beside it
 *       group-<code>-<contestRef>/
 *       gym-<contestRef>/
 *       contest-<contestRef>/
 *         A/
 *           A.cpp                     current source
 *           .meta.json               MetaFile: ref, problem, samples, user tests
 *           runs/<ts>.json           one RunRecord per local run
 *           attempts/<ts>.json       one AttemptRecord per submission
 *     .archive-index.json            ArchiveIndex, rolled up for fast reads
 *
 * Everything here is keyed by { judge, scope, groupCode?, contestRef, index },
 * never by "Codeforces contest id" directly, so a future judge needs no migration.
 */

export interface ProblemRef {
    judge: string; // 'codeforces'
    scope: 'contest' | 'gym' | 'group';
    groupCode?: string;
    contestRef: string; // contest / gym id, as a string
    index: string; // 'A', 'H1', ...
}

export interface AttemptRecord {
    at: number;
    submissionId?: string;
    verdict: string;
    failingTest?: number;
    timeMs?: string;
    memoryKb?: string;
    language: string;
    source: string;
}

export interface RunTestOutcome {
    label: string;
    outcome: 'passed' | 'wrong answer' | 'timed out' | 'runtime error';
    ms: number;
    expected: string;
    actual: string;
    stderr: string;
}

export interface RunRecord {
    at: number;
    /** Consecutive runs with identical source AND identical outcome collapse into
     *  one record — `count` invocations, most recent at `lastAt`. */
    count?: number;
    lastAt?: number;
    /** Which language file this run was — a problem can hold more than one at once. */
    language?: string;
    source: string;
    compileOk: boolean;
    compileOutput?: string;
    tests: RunTestOutcome[];
}

export interface MetaFile {
    ref: ProblemRef;
    /** Opaque judge-specific problem object (a Codeforces `Problem` today). */
    problem: unknown;
    name: string;
    url: string;
    samples: { input: string; output: string }[];
    userTests?: { input: string; output: string }[];
    createdAt: number;
}

export interface ArchiveIndexEntry {
    key: string;
    ref: ProblemRef;
    name: string;
    url: string;
    dir: string; // relative to root
    solved: boolean;
    attemptCount: number;
    runCount: number;
    lastActivity: number;
}

export interface ArchiveIndex {
    version: 1;
    updatedAt: number;
    problems: Record<string, ArchiveIndexEntry>;
}

let root: string | undefined;

export function setArchiveRoot(dir: string): void {
    root = dir;
}

export function archiveRoot(): string {
    if (!root) {
        throw new Error('No Codeforces workspace folder set. Run "Codeforces: Change workspace folder".');
    }
    return root;
}

export function hasArchiveRoot(): boolean {
    return Boolean(root);
}

// ---- key / path derivation -------------------------------------------------

export function keyOf(ref: ProblemRef): string {
    return [ref.judge, ref.scope, ref.groupCode ?? '-', ref.contestRef, ref.index].join('/');
}

function scopeFolder(ref: ProblemRef): string {
    if (ref.scope === 'group') {
        return `group-${ref.groupCode}-${ref.contestRef}`;
    }
    return `${ref.scope}-${ref.contestRef}`; // gym-<id> / contest-<id>
}

/** Absolute directory that holds one problem's source + .meta.json + runs/ + attempts/. */
export function problemDir(ref: ProblemRef): string {
    return path.join(archiveRoot(), ref.judge, scopeFolder(ref), safeSeg(ref.index));
}

function safeSeg(s: string): string {
    return s.replace(/[^A-Za-z0-9_-]/g, '') || '_';
}

/** Parse a "<judge>/<scope-folder>/<index>" directory back into a ref (best effort). */
export function refFromDir(dir: string): ProblemRef | undefined {
    const parts = path.relative(archiveRoot(), dir).split(/[\\/]/);
    if (parts.length < 3) {
        return undefined;
    }
    const [judge, scopeSeg, index] = parts;
    let m: RegExpExecArray | null;
    if ((m = /^group-(.+)-(\d+)$/.exec(scopeSeg))) {
        return { judge, scope: 'group', groupCode: m[1], contestRef: m[2], index };
    }
    if ((m = /^gym-(\d+)$/.exec(scopeSeg))) {
        return { judge, scope: 'gym', contestRef: m[1], index };
    }
    if ((m = /^contest-(\d+)$/.exec(scopeSeg))) {
        return { judge, scope: 'contest', contestRef: m[1], index };
    }
    return undefined;
}

// ---- .meta.json ----------------------------------------------------------

export function readMetaFile(dir: string): MetaFile | undefined {
    const p = path.join(dir, '.meta.json');
    if (!fs.existsSync(p)) {
        return undefined;
    }
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as MetaFile;
    } catch {
        return undefined;
    }
}

export function writeMetaFile(dir: string, meta: MetaFile): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

// ---- runs/ and attempts/ ----------------------------------------------------

function readRecords<T>(dir: string, sub: string): T[] {
    const d = path.join(dir, sub);
    if (!fs.existsSync(d)) {
        return [];
    }
    return fs
        .readdirSync(d)
        .filter((f) => f.endsWith('.json'))
        .sort() // filenames are zero-safe timestamps, so lexical === chronological
        .map((f) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as T;
            } catch {
                return undefined;
            }
        })
        .filter((x): x is T => x !== undefined);
}

function writeRecord(dir: string, sub: string, at: number, data: unknown): void {
    const d = path.join(dir, sub);
    fs.mkdirSync(d, { recursive: true });
    let name = `${String(at).padStart(15, '0')}.json`;
    let n = 1;
    while (fs.existsSync(path.join(d, name))) {
        name = `${String(at).padStart(15, '0')}-${n++}.json`;
    }
    fs.writeFileSync(path.join(d, name), JSON.stringify(data, null, 2), 'utf8');
}

export function listAttempts(dir: string): AttemptRecord[] {
    return readRecords<AttemptRecord>(dir, 'attempts');
}

/** Absolute paths of the run/attempt json files in a problem dir, chronological. */
export function recordFiles(dir: string, sub: 'runs' | 'attempts'): string[] {
    const d = path.join(dir, sub);
    try {
        return fs
            .readdirSync(d)
            .filter((f) => f.endsWith('.json'))
            .sort()
            .map((f) => path.join(d, f));
    } catch {
        return [];
    }
}

export function writeAttempt(dir: string, rec: AttemptRecord): void {
    writeRecord(dir, 'attempts', rec.at || Date.now(), rec);
    touchIndex(dir);
}

export function listRuns(dir: string): RunRecord[] {
    return readRecords<RunRecord>(dir, 'runs');
}

function runOutcomeSig(r: RunRecord): string {
    return r.compileOk
        ? '1|' + r.tests.map((t) => `${t.label}:${t.outcome}`).join('|')
        : '0|' + (r.compileOutput ?? '');
}

/**
 * A run identical to the previous one (same source AND same outcome) just bumps
 * a count + timestamp on the existing record — only a real change earns a new file.
 */
export function writeRun(dir: string, rec: RunRecord): void {
    const files = recordFiles(dir, 'runs');
    const last = files.length ? files[files.length - 1] : undefined;
    if (last) {
        try {
            const prev = JSON.parse(fs.readFileSync(last, 'utf8')) as RunRecord;
            if (prev.source === rec.source && prev.language === rec.language && runOutcomeSig(prev) === runOutcomeSig(rec)) {
                prev.count = (prev.count ?? 1) + 1;
                prev.lastAt = rec.at || Date.now();
                fs.writeFileSync(last, JSON.stringify(prev, null, 2), 'utf8');
                touchIndex(dir);
                return;
            }
        } catch {
            /* fall through and write a fresh record */
        }
    }
    writeRecord(dir, 'runs', rec.at || Date.now(), rec);
    touchIndex(dir);
}

// ---- rolled-up index ------------------------------------------------------

function indexPath(): string {
    return path.join(archiveRoot(), '.archive-index.json');
}

export function readIndex(): ArchiveIndex {
    try {
        const raw = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as ArchiveIndex;
        if (raw && raw.version === 1 && raw.problems) {
            return raw;
        }
    } catch {
        /* fall through to rebuild */
    }
    return rebuildIndex();
}

function entryFor(dir: string): ArchiveIndexEntry | undefined {
    const meta = readMetaFile(dir);
    if (!meta) {
        return undefined;
    }
    const attempts = listAttempts(dir);
    const runs = listRuns(dir);
    const times = [
        ...attempts.map((a) => a.at),
        ...runs.map((r) => r.lastAt ?? r.at),
        meta.createdAt
    ].filter((n) => typeof n === 'number');
    return {
        key: keyOf(meta.ref),
        ref: meta.ref,
        name: meta.name,
        url: meta.url,
        dir: path.relative(archiveRoot(), dir),
        solved: attempts.some((a) => isAccepted(a.verdict)),
        attemptCount: attempts.length,
        runCount: runs.reduce((n, r) => n + (r.count ?? 1), 0),
        lastActivity: times.length ? Math.max(...times) : 0
    };
}

/** Walk every problem directory and rebuild the index from scratch. */
export function rebuildIndex(): ArchiveIndex {
    const problems: Record<string, ArchiveIndexEntry> = {};
    if (root) {
        for (const dir of allProblemDirs()) {
            const e = entryFor(dir);
            if (e) {
                problems[e.key] = e;
            }
        }
        const idx: ArchiveIndex = { version: 1, updatedAt: Date.now(), problems };
        try {
            fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf8');
        } catch {
            /* best effort */
        }
        return idx;
    }
    return { version: 1, updatedAt: Date.now(), problems };
}

/** Recompute the one entry for `dir` and merge it into the index file. */
export function touchIndex(dir: string): void {
    if (!root) {
        return;
    }
    let idx: ArchiveIndex;
    try {
        idx = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as ArchiveIndex;
        if (!idx || idx.version !== 1 || !idx.problems) {
            throw new Error('stale');
        }
    } catch {
        idx = { version: 1, updatedAt: Date.now(), problems: {} };
    }
    const e = entryFor(dir);
    if (e) {
        idx.problems[e.key] = e;
    }
    idx.updatedAt = Date.now();
    try {
        fs.writeFileSync(indexPath(), JSON.stringify(idx, null, 2), 'utf8');
    } catch {
        /* best effort */
    }
}

/** Every "<judge>/<scope-folder>/<index>" directory that has a .meta.json. */
export function allProblemDirs(): string[] {
    const out: string[] = [];
    const base = archiveRoot();
    let judges: string[];
    try {
        judges = fs.readdirSync(base);
    } catch {
        return out;
    }
    for (const judge of judges) {
        const jp = path.join(base, judge);
        if (!isDir(jp) || judge.startsWith('.')) {
            continue;
        }
        for (const scopeSeg of safeReaddir(jp)) {
            const sp = path.join(jp, scopeSeg);
            if (!isDir(sp)) {
                continue;
            }
            for (const idx of safeReaddir(sp)) {
                const ip = path.join(sp, idx);
                if (isDir(ip) && fs.existsSync(path.join(ip, '.meta.json'))) {
                    out.push(ip);
                }
            }
        }
    }
    return out;
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}
function safeReaddir(p: string): string[] {
    try {
        return fs.readdirSync(p);
    } catch {
        return [];
    }
}

/** Layout round-trip self-test. Run: node out/archive.js */
export function selfTest(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os: typeof import('os') = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-archive-'));
    try {
        setArchiveRoot(tmp);
        const ref: ProblemRef = {
            judge: 'codeforces',
            scope: 'group',
            groupCode: 'g1',
            contestRef: '664504',
            index: 'A'
        };
        const dir = problemDir(ref);
        assert.ok(dir.endsWith(path.join('codeforces', 'group-g1-664504', 'A')), 'problemDir shape');

        writeMetaFile(dir, {
            ref,
            problem: { index: 'A' },
            name: 'Hello World',
            url: 'u',
            samples: [],
            createdAt: 100
        });
        const run1 = {
            at: 200,
            source: 's1',
            compileOk: true,
            tests: [
                { label: 'Sample 1', outcome: 'wrong answer' as const, ms: 5, expected: 'x', actual: 'y', stderr: '' }
            ]
        };
        writeRun(dir, run1);
        writeRun(dir, { ...run1, at: 210 }); // identical source + outcome → folds
        writeRun(dir, { ...run1, at: 220 });
        writeAttempt(dir, { at: 300, verdict: 'Accepted', language: 'C++17', source: 's2', submissionId: '9' });

        assert.strictEqual(recordFiles(dir, 'runs').length, 1, 'three identical runs → one file');
        assert.strictEqual(listRuns(dir)[0].count, 3, 'count folded to 3');
        assert.strictEqual(listRuns(dir)[0].lastAt, 220, 'lastAt = newest');

        // a changed outcome earns a new file
        writeRun(dir, {
            ...run1,
            at: 230,
            tests: [{ label: 'Sample 1', outcome: 'passed' as const, ms: 5, expected: 'x', actual: 'x', stderr: '' }]
        });
        assert.strictEqual(recordFiles(dir, 'runs').length, 2, 'changed outcome → second file');
        assert.strictEqual(listAttempts(dir).length, 1, 'one attempt');

        // same source + outcome but a DIFFERENT language never folds — two
        // language files could plausibly share identical source (e.g. both
        // empty), and that must not corrupt one language's run count with
        // another's.
        writeRun(dir, { ...run1, at: 240, language: '.py' });
        assert.strictEqual(recordFiles(dir, 'runs').length, 3, 'different language never folds into a same-source run');

        const idx = readIndex();
        const e = idx.problems[keyOf(ref)];
        assert.ok(e, 'index entry present');
        assert.strictEqual(e.runCount, 5, 'runCount sums folded counts (3 + 1 + 1)');
        assert.strictEqual(e.attemptCount, 1, 'attemptCount');
        assert.strictEqual(e.solved, true, 'solved from Accepted attempt');
        assert.strictEqual(e.lastActivity, 300, 'lastActivity = newest record (the attempt)');
        assert.deepStrictEqual(refFromDir(dir), ref, 'refFromDir round-trips');

        console.log('archive selfTest: OK');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        selfTest();
    } catch (e) {
        console.error('archive selfTest: FAIL\n', e);
        process.exit(1);
    }
}
