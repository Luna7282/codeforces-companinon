import * as fs from 'fs';
import * as path from 'path';
import { Problem } from './types';
import {
    ProblemRef,
    problemDir,
    writeMetaFile,
    writeAttempt,
    readMetaFile,
    listAttempts,
    rebuildIndex,
    readIndex,
    setArchiveRoot
} from './archive';

/**
 * One-time migration of the pre-archive layout:
 *
 *   <oldRoot>/(group-<code>-<id> | gym-<id> | <digits>)/<X><ext>
 *   <oldRoot>/.../.cf/<X><ext>.json         (a ProblemMeta with inline `attempts`)
 *
 * into <archiveRoot>/codeforces/<scope-folder>/<index>/… — non-destructively:
 * copy + verify every problem first, only then delete the old files.
 */

export interface MigrationReport {
    migrated: number;
    skipped: number;
    attemptsPreserved: number;
    errors: string[];
}

interface OldMeta {
    problem?: Problem;
    samples?: { input: string; output: string }[];
    userTests?: { input: string; output: string }[];
    attempts?: {
        at: number;
        submissionId?: string;
        verdict: string;
        failingTest?: number;
        timeMs?: string;
        memoryKb?: string;
        language: string;
        source: string;
    }[];
    url?: string;
}

const OLD_DIR = /^(?:group-(.+)-(\d+)|gym-(\d+)|(\d+))$/;

// Only real source files migrate — not build artifacts (A.exe, *.class, *.o) or
// other tools' droppings (.cph/). Non-destructive: anything not listed here is
// left untouched in the old folder.
const SOURCE_EXT = new Set([
    '.cpp', '.cxx', '.cc', '.c', '.h', '.hpp', '.py', '.py3', '.java', '.kt', '.kts',
    '.rs', '.go', '.js', '.mjs', '.ts', '.cs', '.rb', '.pl', '.pas', '.dpr', '.hs',
    '.ml', '.scala', '.sc', '.swift', '.fs', '.vb', '.lua', '.php', '.jl', '.nim',
    '.cr', '.ex', '.exs', '.erl', '.clj', '.d', '.r', '.txt'
]);

function refFor(entry: string, index: string): ProblemRef | undefined {
    const m = OLD_DIR.exec(entry);
    if (!m) {
        return undefined;
    }
    if (m[1] !== undefined) {
        return { judge: 'codeforces', scope: 'group', groupCode: m[1], contestRef: m[2], index };
    }
    if (m[3] !== undefined) {
        return { judge: 'codeforces', scope: 'gym', contestRef: m[3], index };
    }
    return { judge: 'codeforces', scope: 'contest', contestRef: m[4], index };
}

function minimalProblem(ref: ProblemRef): Problem {
    return {
        contestId: Number(ref.contestRef),
        index: ref.index,
        name: ref.index,
        kind: ref.scope,
        groupCode: ref.groupCode
    };
}

/** Any pre-archive contest folders under these roots? Cheap check for whether to run. */
export function hasOldLayout(roots: string[]): boolean {
    for (const root of roots) {
        let entries: string[];
        try {
            entries = fs.readdirSync(root);
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!OLD_DIR.test(e)) {
                continue;
            }
            const dir = path.join(root, e);
            try {
                if (!fs.statSync(dir).isDirectory()) {
                    continue;
                }
            } catch {
                continue;
            }
            const inner = safeReaddir(dir).filter((f) => f !== '.cf' && f !== '.meta.json');
            if (inner.length > 0 || fs.existsSync(path.join(dir, '.cf'))) {
                return true;
            }
        }
    }
    return false;
}

export function migrateOldLayout(roots: string[]): MigrationReport {
    const report: MigrationReport = { migrated: 0, skipped: 0, attemptsPreserved: 0, errors: [] };
    const toRemove: { source: string; meta?: string }[] = [];
    const contestDirs = new Set<string>();
    const seen = new Set<string>(); // dedupe roots

    for (const root of roots) {
        const abs = path.resolve(root);
        if (seen.has(abs)) {
            continue;
        }
        seen.add(abs);

        for (const entry of safeReaddir(abs)) {
            if (!OLD_DIR.test(entry)) {
                continue;
            }
            const contestDir = path.join(abs, entry);
            try {
                if (!fs.statSync(contestDir).isDirectory()) {
                    continue;
                }
            } catch {
                continue;
            }

            for (const fileName of safeReaddir(contestDir)) {
                const src = path.join(contestDir, fileName);
                if (fileName === '.cf' || fileName === '.meta.json') {
                    continue;
                }
                try {
                    if (!fs.statSync(src).isFile()) {
                        continue;
                    }
                } catch {
                    continue;
                }

                const ext = path.extname(fileName);
                if (!SOURCE_EXT.has(ext.toLowerCase())) {
                    continue; // build artifact / other tool's file — leave it
                }
                const index = path.basename(fileName, ext);
                const ref = refFor(entry, index);
                if (!ref) {
                    continue;
                }

                const oldMetaPath = path.join(contestDir, '.cf', `${fileName}.json`);
                const oldMeta = readJson<OldMeta>(oldMetaPath);
                let target: string;
                try {
                    target = problemDir(ref);
                } catch (e) {
                    report.errors.push(`${entry}/${fileName}: ${(e as Error).message}`);
                    continue;
                }

                if (fs.existsSync(path.join(target, '.meta.json'))) {
                    report.skipped++;
                    contestDirs.add(contestDir);
                    continue;
                }

                try {
                    fs.mkdirSync(target, { recursive: true });
                    const targetSrc = path.join(target, `${path.basename(target)}${ext}`);
                    fs.copyFileSync(src, targetSrc);

                    writeMetaFile(target, {
                        ref,
                        problem: oldMeta?.problem ?? minimalProblem(ref),
                        name: oldMeta?.problem?.name ?? ref.index,
                        url: oldMeta?.url ?? '',
                        samples: oldMeta?.samples ?? [],
                        userTests: oldMeta?.userTests,
                        createdAt: Date.now()
                    });
                    for (const a of oldMeta?.attempts ?? []) {
                        writeAttempt(target, a);
                    }

                    // verify before we schedule any deletion
                    const okSource = fs.readFileSync(src).equals(fs.readFileSync(targetSrc));
                    const okMeta = !!readMetaFile(target);
                    const okAttempts = listAttempts(target).length === (oldMeta?.attempts?.length ?? 0);
                    if (!okSource || !okMeta || !okAttempts) {
                        throw new Error(
                            `verify failed (source:${okSource} meta:${okMeta} attempts:${okAttempts})`
                        );
                    }

                    report.migrated++;
                    report.attemptsPreserved += oldMeta?.attempts?.length ?? 0;
                    toRemove.push({ source: src, meta: fs.existsSync(oldMetaPath) ? oldMetaPath : undefined });
                    contestDirs.add(contestDir);
                } catch (e) {
                    report.errors.push(`${entry}/${fileName}: ${(e as Error).message}`);
                }
            }
        }
    }

    // Only now, after every problem copied + verified, remove the originals.
    for (const { source, meta } of toRemove) {
        try {
            fs.rmSync(source, { force: true });
            if (meta) {
                fs.rmSync(meta, { force: true });
            }
        } catch (e) {
            report.errors.push(`remove ${source}: ${(e as Error).message}`);
        }
    }
    for (const dir of contestDirs) {
        const cf = path.join(dir, '.cf');
        try {
            if (fs.existsSync(cf) && safeReaddir(cf).length === 0) {
                fs.rmSync(cf, { recursive: true, force: true });
            }
            if (safeReaddir(dir).length === 0) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        } catch {
            /* leave a non-empty old folder alone */
        }
    }

    try {
        rebuildIndex();
    } catch {
        /* index rebuild is best effort */
    }
    return report;
}

function safeReaddir(p: string): string[] {
    try {
        return fs.readdirSync(p);
    } catch {
        return [];
    }
}
function readJson<T>(p: string): T | undefined {
    try {
        return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch {
        return undefined;
    }
}

/** Non-destructive-migration self-test over a real temp dir. Run: node out/migrate.js */
export function selfTest(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const os: typeof import('os') = require('os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-migrate-'));
    try {
        setArchiveRoot(tmp);

        const cd = path.join(tmp, 'group-ABCdef-664504');
        fs.mkdirSync(path.join(cd, '.cf'), { recursive: true });
        fs.writeFileSync(path.join(cd, 'A.cpp'), 'int main(){}\n');
        fs.writeFileSync(
            path.join(cd, '.cf', 'A.cpp.json'),
            JSON.stringify({
                problem: { contestId: 664504, index: 'A', name: 'Hello World', kind: 'group', groupCode: 'ABCdef' },
                samples: [{ input: '', output: 'Hello World' }],
                userTests: [{ input: '1', output: '1' }],
                attempts: [
                    { at: 1000, verdict: 'Wrong answer on test 2', failingTest: 2, language: 'C++17', source: 'v1' },
                    { at: 2000, verdict: 'Accepted', submissionId: '999', language: 'C++17', source: 'v2' }
                ],
                url: 'https://codeforces.com/group/ABCdef/contest/664504/problem/A'
            })
        );
        const cd2 = path.join(tmp, 'gym-100001');
        fs.mkdirSync(cd2, { recursive: true });
        fs.writeFileSync(path.join(cd2, 'B.py'), 'print(1)\n');

        const r = migrateOldLayout([tmp]);
        assert.strictEqual(r.migrated, 2, 'migrated 2');
        assert.strictEqual(r.attemptsPreserved, 2, 'attempts preserved');
        assert.deepStrictEqual(r.errors, [], 'no errors');

        const aDir = path.join(tmp, 'codeforces', 'group-ABCdef-664504', 'A');
        assert.strictEqual(fs.readFileSync(path.join(aDir, 'A.cpp'), 'utf8'), 'int main(){}\n', 'source bytes intact');
        const meta = readMetaFile(aDir);
        assert.ok(meta && meta.name === 'Hello World' && meta.userTests && meta.userTests.length === 1, 'meta + userTests');
        assert.deepStrictEqual(
            listAttempts(aDir).map((a) => a.verdict),
            ['Wrong answer on test 2', 'Accepted'],
            'both attempts, in order'
        );
        assert.ok(!fs.existsSync(path.join(cd, 'A.cpp')), 'old source removed');
        assert.ok(!fs.existsSync(cd), 'empty old contest folder removed');

        const bDir = path.join(tmp, 'codeforces', 'gym-100001', 'B');
        assert.ok(fs.existsSync(path.join(bDir, 'B.py')), 'bare source migrated');
        assert.strictEqual(readMetaFile(bDir)?.ref.scope, 'gym', 'minimal meta written');

        const e = Object.values(readIndex().problems).find((p) => p.ref.index === 'A');
        assert.ok(e && e.attemptCount === 2 && e.solved === true, 'index entry rolled up');

        assert.strictEqual(migrateOldLayout([tmp]).migrated, 0, 'second run is a no-op');
        console.log('migrate selfTest: OK');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

if (require.main === module) {
    try {
        selfTest();
    } catch (e) {
        console.error('migrate selfTest: FAIL\n', e);
        process.exit(1);
    }
}
