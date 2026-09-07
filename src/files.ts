import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { Problem, Sample } from './types';
import {
    ProblemRef,
    AttemptRecord,
    MetaFile,
    archiveRoot,
    problemDir,
    readMetaFile,
    writeMetaFile,
    listAttempts,
    writeAttempt,
    touchIndex
} from './archive';

/** One recorded submission attempt. Append-only — the full history is kept. */
export type Attempt = AttemptRecord;

export interface ProblemMeta {
    problem: Problem;
    /** Samples scraped from the statement. */
    samples: Sample[];
    /** Test cases the user added by hand in the Results panel. */
    userTests?: Sample[];
    /** Every submission attempt, oldest first (assembled from attempts/*.json). */
    attempts?: Attempt[];
    url: string;
}

/** Judge-agnostic key for a Codeforces problem. */
export function refOf(p: Problem): ProblemRef {
    return {
        judge: 'codeforces',
        scope: p.kind,
        groupCode: p.groupCode,
        contestRef: String(p.contestId),
        index: p.index
    };
}

/** The configured archive root. Set globally, follows the user between projects. */
export function workspaceRoot(): string {
    const configured = vscode.workspace.getConfiguration('codeforces').get<string>('workspaceRoot', '').trim();
    if (configured) {
        return configured;
    }
    throw new Error('No Codeforces workspace folder set. Run "Codeforces: Change workspace folder".');
}

/** `ext` picks which language's file within the problem folder — defaults to codeforces.extension. */
export function solutionPath(problem: Problem, ext?: string): string {
    const resolvedExt = ext ?? vscode.workspace.getConfiguration('codeforces').get<string>('extension', '.cpp');
    const dir = problemDir(refOf(problem));
    return path.join(dir, `${path.basename(dir)}${resolvedExt}`);
}

/** Where the diagnostic in activeMeta() points when a file isn't linked. */
export function metaPath(sourceFile: string): string {
    return path.join(path.dirname(sourceFile), '.meta.json');
}

export function writeMeta(sourceFile: string, meta: ProblemMeta): void {
    const dir = path.dirname(sourceFile);
    const existing = readMetaFile(dir);
    const file: MetaFile = {
        ref: refOf(meta.problem),
        problem: meta.problem,
        name: meta.problem.name,
        url: meta.url,
        samples: meta.samples,
        userTests: meta.userTests,
        createdAt: existing?.createdAt ?? Date.now()
    };
    // attempts are NOT stored here — they live in attempts/*.json.
    writeMetaFile(dir, file);
    touchIndex(dir);
}

export function readMeta(sourceFile: string): ProblemMeta | undefined {
    const dir = path.dirname(sourceFile);
    const file = readMetaFile(dir);
    if (!file) {
        return undefined;
    }
    return {
        problem: file.problem as Problem,
        samples: file.samples ?? [],
        userTests: file.userTests,
        attempts: listAttempts(dir),
        url: file.url
    };
}

/** Merge a partial update into .meta.json. `attempts` in the patch is ignored (use appendAttempt). */
export function updateMeta(sourceFile: string, patch: Partial<ProblemMeta>): ProblemMeta | undefined {
    const current = readMeta(sourceFile);
    if (!current) {
        return undefined;
    }
    const next: ProblemMeta = {
        ...current,
        ...patch,
        attempts: current.attempts // never let a patch clobber history
    };
    writeMeta(sourceFile, next);
    return next;
}

/** Append one attempt (writes attempts/<ts>.json). Never overwrites earlier entries. */
export function appendAttempt(sourceFile: string, attempt: Attempt): ProblemMeta | undefined {
    const dir = path.dirname(sourceFile);
    if (!readMetaFile(dir)) {
        return undefined;
    }
    writeAttempt(dir, attempt);
    return readMeta(sourceFile);
}

function templateContents(): string {
    const p = vscode.workspace.getConfiguration('codeforces').get<string>('templatePath', '').trim();
    if (!p) {
        return '';
    }
    try {
        return fs.readFileSync(p, 'utf8');
    } catch {
        void vscode.window.showWarningMessage(`Template not found at ${p}. Created an empty file instead.`);
        return '';
    }
}

/**
 * Creates the problem directory + source file if absent (NEVER overwrites an
 * existing one — a language switch must not touch another language's file),
 * writes the shared .meta.json, returns the source path. `ext` picks which
 * language's file; omit for the default (codeforces.extension).
 */
export function ensureSolutionFile(problem: Problem, meta: ProblemMeta, ext?: string): string {
    // Fail early with a clear message rather than throwing a raw path error.
    archiveRoot();
    const target = solutionPath(problem, ext);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (!fs.existsSync(target)) {
        fs.writeFileSync(target, templateContents(), 'utf8');
    }
    writeMeta(target, meta);
    return target;
}
