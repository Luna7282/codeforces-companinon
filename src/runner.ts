import { exec, spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Sample } from './types';

export type TestOutcome = 'passed' | 'wrong answer' | 'timed out' | 'runtime error';

export interface TestResult {
    index: number;
    outcome: TestOutcome;
    ms: number;
    expected: string;
    actual: string;
    stderr: string;
}

function expand(template: string, sourceFile: string): string {
    const dir = path.dirname(sourceFile);
    const name = path.basename(sourceFile, path.extname(sourceFile));
    const bin = path.join(dir, name + (os.platform() === 'win32' ? '.exe' : ''));
    return template
        .replace(/\$\{file\}/g, sourceFile)
        .replace(/\$\{dir\}/g, dir)
        .replace(/\$\{name\}/g, name)
        .replace(/\$\{bin\}/g, bin);
}

/** Resolves with the compiler's stderr on success (warnings, usually empty); rejects on failure. */
export async function compile(sourceFile: string): Promise<string> {
    const template = vscode.workspace.getConfiguration('codeforces').get<string>('compileCommand', '').trim();
    if (!template) {
        return '';
    }
    const command = expand(template, sourceFile);
    return new Promise<string>((resolve, reject) => {
        exec(command, { cwd: path.dirname(sourceFile) }, (err, _stdout, stderr) => {
            if (err) {
                reject(new Error(stderr.trim() || err.message));
            } else {
                resolve(stderr.trim());
            }
        });
    });
}

/** Trailing whitespace differences are not failures on Codeforces. */
function normalise(text: string): string {
    return text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((line) => line.replace(/\s+$/, ''))
        .join('\n')
        .replace(/\n+$/, '');
}

function runOne(command: string, cwd: string, input: string, timeoutMs: number): Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
    ms: number;
    timedOut: boolean;
}> {
    return new Promise((resolve) => {
        const started = Date.now();
        const child = spawn(command, { cwd, shell: true });
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (d) => (stdout += d.toString()));
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, code, ms: Date.now() - started, timedOut });
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ stdout, stderr: err.message, code: 1, ms: Date.now() - started, timedOut });
        });

        child.stdin.write(input.endsWith('\n') ? input : input + '\n');
        child.stdin.end();
    });
}

export async function runSamples(sourceFile: string, samples: Sample[]): Promise<TestResult[]> {
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const runTemplate = cfg.get<string>('runCommand', '').trim();
    const timeoutMs = cfg.get<number>('timeoutMs', 5000);
    if (!runTemplate) {
        throw new Error('Set codeforces.runCommand before running tests.');
    }
    const command = expand(runTemplate, sourceFile);
    const cwd = path.dirname(sourceFile);

    const results: TestResult[] = [];
    for (let i = 0; i < samples.length; i++) {
        const r = await runOne(command, cwd, samples[i].input, timeoutMs);
        let outcome: TestOutcome;
        if (r.timedOut) {
            outcome = 'timed out';
        } else if (r.code !== 0) {
            outcome = 'runtime error';
        } else if (normalise(r.stdout) === normalise(samples[i].output)) {
            outcome = 'passed';
        } else {
            outcome = 'wrong answer';
        }
        results.push({
            index: i + 1,
            outcome,
            ms: r.ms,
            expected: samples[i].output,
            actual: r.stdout,
            stderr: r.stderr
        });
    }
    return results;
}
