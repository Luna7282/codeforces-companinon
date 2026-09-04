import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Tiny on-disk read cache. Reads now cost a companion poll round-trip
 * (see LESSONS.md 2026-09-04), so scraped pages are cached hard — statements
 * especially, since a finished problem's statement never changes.
 */

let dir: string | undefined;

export function setCacheDir(d: string): void {
    dir = d;
    try {
        fs.mkdirSync(d, { recursive: true });
    } catch {
        /* best effort */
    }
}

function fileFor(key: string): string | undefined {
    if (!dir) {
        return undefined;
    }
    const hash = crypto.createHash('sha1').update(key).digest('hex');
    return path.join(dir, `${hash}.json`);
}

export function readCache<T>(key: string, maxAgeMs: number): T | undefined {
    const file = fileFor(key);
    if (!file || !fs.existsSync(file)) {
        return undefined;
    }
    try {
        const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as { at: number; value: T };
        if (Date.now() - rec.at > maxAgeMs) {
            return undefined;
        }
        return rec.value;
    } catch {
        return undefined;
    }
}

export function writeCache<T>(key: string, value: T): void {
    const file = fileFor(key);
    if (!file) {
        return;
    }
    try {
        fs.writeFileSync(file, JSON.stringify({ at: Date.now(), value }), 'utf8');
    } catch {
        /* best effort */
    }
}

export function clearCache(): void {
    if (!dir) {
        return;
    }
    try {
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith('.json')) {
                fs.unlinkSync(path.join(dir, f));
            }
        }
    } catch {
        /* ignore */
    }
}
