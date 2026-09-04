/** Shared verdict-string helpers, used by the tree, the results panel and stats. */

export function isAccepted(verdict: string): boolean {
    return /^(accepted|ok\b|happy new year)/i.test(verdict.trim());
}

/** "Wrong answer on test 3" -> 3 */
export function failingTest(verdict: string): number | undefined {
    const m = /on test (\d+)/i.exec(verdict);
    return m ? Number(m[1]) : undefined;
}

/** Bucket a verdict for the stats breakdown. */
export function verdictCategory(verdict: string): string {
    const s = verdict.toLowerCase();
    if (isAccepted(verdict)) return 'Accepted';
    if (/wrong answer/.test(s)) return 'Wrong answer';
    if (/time limit|\btle\b/.test(s)) return 'Time limit';
    if (/memory limit|\bmle\b/.test(s)) return 'Memory limit';
    if (/idleness/.test(s)) return 'Idleness limit';
    if (/compil/.test(s)) return 'Compilation error';
    if (/runtime error|\brte\b/.test(s)) return 'Runtime error';
    if (/partial/.test(s)) return 'Partial';
    if (/rejected|refused|denied|skipped|identical/.test(s)) return 'Rejected';
    return 'Other';
}

export function verdictKind(verdict: string): 'ok' | 'bad' | 'warn' {
    if (isAccepted(verdict)) return 'ok';
    if (/pending|in queue|running|testing|judging|waiting/i.test(verdict)) return 'warn';
    return 'bad';
}
