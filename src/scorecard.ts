import * as path from 'path';
import { listAttempts, archiveRoot, ArchiveIndexEntry } from './archive';
import { verdictCategory, isAccepted } from './verdict';

export interface LanguageTotals {
    attempted: number; // unique problems with at least one attempt in this language
    solved: number; // unique problems with at least one Accepted attempt in this language
    attempts: number; // total attempts in this language
}

export interface Totals {
    attempted: number;
    solved: number;
    totalAttempts: number;
    byVerdict: [string, number][]; // sorted desc
    byLanguage: [string, LanguageTotals][]; // sorted desc by attempts
    latest: number;
}

/**
 * One scorecard shape, reused at every level — the whole archive, or a
 * single group/gym/contest clicked in the Archive view. Same computation
 * regardless of scope; only which entries feed it changes.
 */
export function computeStats(entries: ArchiveIndexEntry[]): Totals {
    let attempted = 0;
    let solved = 0;
    let totalAttempts = 0;
    let latest = 0;
    const verdictCounts = new Map<string, number>();
    const langs = new Map<string, { attempted: Set<string>; solved: Set<string>; attempts: number }>();

    for (const entry of entries) {
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
            verdictCounts.set(cat, (verdictCounts.get(cat) ?? 0) + 1);
            if (a.at > latest) {
                latest = a.at;
            }
            const lang = a.language || 'Unknown';
            let ls = langs.get(lang);
            if (!ls) {
                ls = { attempted: new Set(), solved: new Set(), attempts: 0 };
                langs.set(lang, ls);
            }
            ls.attempted.add(entry.key);
            ls.attempts++;
            if (isAccepted(a.verdict)) {
                ls.solved.add(entry.key);
            }
        }
    }

    const byVerdict = [...verdictCounts.entries()].sort((x, y) => y[1] - x[1]);
    const byLanguage = [...langs.entries()]
        .map(
            ([lang, s]) =>
                [lang, { attempted: s.attempted.size, solved: s.solved.size, attempts: s.attempts }] as [
                    string,
                    LanguageTotals
                ]
        )
        .sort((x, y) => y[1].attempts - x[1].attempts);

    return { attempted, solved, totalAttempts, byVerdict, byLanguage, latest };
}

/** Self-test over a real (temp) archive dir. Run: node out/scorecard.js */
export async function selfTest(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs: typeof import('fs') = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os: typeof import('os') = require('os');
    const { setArchiveRoot, writeMetaFile, writeAttempt, rebuildIndex, keyOf } = await import('./archive');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-scorecard-'));
    try {
        setArchiveRoot(tmp);

        // Problem A: solved in both C++ and Python.
        const refA = { judge: 'codeforces', scope: 'contest' as const, contestRef: '1', index: 'A' };
        const dirA = path.join(tmp, 'codeforces', 'contest-1', 'A');
        writeMetaFile(dirA, { ref: refA, problem: {}, name: 'A', url: 'u', samples: [], createdAt: 0 });
        writeAttempt(dirA, { at: 1, verdict: 'Wrong answer on test 3', language: '.cpp', source: 'x' });
        writeAttempt(dirA, { at: 2, verdict: 'Accepted', language: '.cpp', source: 'x' });
        writeAttempt(dirA, { at: 3, verdict: 'Accepted', language: '.py', source: 'y' });

        // Problem B: attempted only in Python, never solved.
        const refB = { judge: 'codeforces', scope: 'contest' as const, contestRef: '1', index: 'B' };
        const dirB = path.join(tmp, 'codeforces', 'contest-1', 'B');
        writeMetaFile(dirB, { ref: refB, problem: {}, name: 'B', url: 'u', samples: [], createdAt: 0 });
        writeAttempt(dirB, { at: 4, verdict: 'Time limit exceeded', language: '.py', source: 'z' });

        const idx = rebuildIndex();
        const entries = [idx.problems[keyOf(refA)], idx.problems[keyOf(refB)]];

        const t = computeStats(entries);
        assert.strictEqual(t.attempted, 2, 'both problems have attempts');
        assert.strictEqual(t.solved, 1, 'only A is solved');
        assert.strictEqual(t.totalAttempts, 4, 'four attempts total');
        assert.strictEqual((t.totalAttempts / t.solved).toFixed(1), '4.0', 'attempts-per-solve');

        const verdictMap = Object.fromEntries(t.byVerdict);
        assert.strictEqual(verdictMap['Accepted'], 2, 'two Accepted attempts');
        assert.strictEqual(verdictMap['Wrong answer'], 1, 'one Wrong answer attempt');
        assert.strictEqual(verdictMap['Time limit'], 1, 'one Time limit attempt');

        const langMap = Object.fromEntries(t.byLanguage) as Record<string, LanguageTotals>;
        assert.deepStrictEqual(langMap['.cpp'], { attempted: 1, solved: 1, attempts: 2 }, '.cpp: A attempted+solved, 2 attempts');
        assert.deepStrictEqual(
            langMap['.py'],
            { attempted: 2, solved: 1, attempts: 2 },
            '.py: both A and B attempted, only A solved, 2 attempts'
        );

        console.log('scorecard selfTest: OK');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

if (require.main === module) {
    selfTest().catch((e) => {
        console.error('scorecard selfTest: FAIL\n', e);
        process.exit(1);
    });
}
