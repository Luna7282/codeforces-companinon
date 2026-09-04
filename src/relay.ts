import * as http from 'http';
import * as crypto from 'crypto';
import type { AddressInfo } from 'net';
import { ContestKind } from './types';

/**
 * Localhost job queue the companion browser extension (see browser/) polls.
 *
 * Two job types, because Cloudflare blocks the extension's Node requests two
 * different ways (see LESSONS.md 2026-09-04):
 *
 *  - 'submit' — Cloudflare Turnstile guards the submit form. The companion
 *    opens the submit page, fills it, and stops; the user solves the challenge
 *    and clicks Submit.
 *  - 'fetch'  — Cloudflare rejects Node's TLS fingerprint outright, so even
 *    plain page reads have to go through the browser. The extension asks the
 *    companion to GET a URL and hand back the HTML.
 *
 * Bound to 127.0.0.1 only; every request must carry the token generated at
 * startup, or any page in the browser could read the user's source, queue
 * submissions, or drive arbitrary fetches.
 */

interface JobCommon {
    id: string;
    createdAt: number;
    type: 'submit' | 'fetch';
}

export interface SubmitJob extends JobCommon {
    type: 'submit';
    kind: ContestKind;
    contestId: number;
    groupCode?: string;
    index: string;
    source: string;
    programTypeId: string;
    programTypeName?: string;
}

export interface FetchJob extends JobCommon {
    type: 'fetch';
    url: string;
}

export type RelayJob = SubmitJob | FetchJob;
export type SubmitJobInput = Omit<SubmitJob, 'id' | 'createdAt' | 'type'>;

export interface RelayFetchResult {
    status: number;
    body: string;
}

/**
 * Bumped only when the wire protocol between this file and browser/background.js
 * changes shape (new required job field, endpoint, auth scheme, ...). The
 * companion checks this against its own copy on every /health hit — see
 * LESSONS.md for why a version mismatch must never fail silently.
 */
export const PROTOCOL_VERSION = 1;

// Under LONG_POLL_MS the companion reconnects before Chrome's ~30s MV3 idle
// suspend can bite; a returned poll still refreshes lastPollAt inside
// COMPANION_FRESH_MS.
const LONG_POLL_MS = 20_000;
const FETCH_TIMEOUT_MS = 20_000;
const COMPANION_FRESH_MS = 30_000;
const MAX_BODY = 8 * 1024 * 1024;

export class RelayServer {
    private server?: http.Server;
    private boundPort = 0;
    private queue: RelayJob[] = [];
    private waiters: Array<(job: RelayJob | null) => void> = [];
    private pendingFetches = new Map<
        string,
        { resolve: (r: RelayFetchResult) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
    >();
    private lastPollAt = 0;
    private lastRejectedAt = 0;
    private everPolled = false;
    private submitOutcomes = new Map<string, { outcome: string; message?: string; at: number }>();
    private lastCompanionError: { message: string; at: number } | undefined;

    /**
     * @param token  shared secret every request must present, as `X-Relay-Token: <token>`
     *               or `Authorization: Bearer <token>`. Persisted by the caller so it
     *               survives window reloads.
     * @param log    sink for one line per rejected request (endpoint, lengths, branch).
     */
    constructor(
        readonly token: string,
        private readonly log: (msg: string) => void = () => {}
    ) {}

    get running(): boolean {
        return Boolean(this.server);
    }

    get port(): number {
        return this.boundPort;
    }

    get pendingCount(): number {
        return this.queue.length;
    }

    /** True while the companion is actively polling (held long-poll or a recent hit). */
    get companionOnline(): boolean {
        return this.waiters.length > 0 || Date.now() - this.lastPollAt < COMPANION_FRESH_MS;
    }

    /**
     * - `online`  — companion polling successfully
     * - `auth-rejected` — something is polling but its token is wrong (misconfigured companion)
     * - `offline` — nothing has polled recently (asleep MV3 worker, or not running —
     *               `companionEverSeen` tells which)
     */
    get companionStatus(): 'online' | 'auth-rejected' | 'offline' {
        if (this.companionOnline) {
            return 'online';
        }
        if (Date.now() - this.lastRejectedAt < COMPANION_FRESH_MS) {
            return 'auth-rejected';
        }
        return 'offline';
    }

    /** Has a companion ever successfully polled this window? Distinguishes asleep from absent. */
    get companionEverSeen(): boolean {
        return this.everPolled;
    }

    /** A companion-reported error (e.g. protocol mismatch) from the last 5 minutes, if any. */
    get companionError(): string | undefined {
        if (this.lastCompanionError && Date.now() - this.lastCompanionError.at < 5 * 60_000) {
            return this.lastCompanionError.message;
        }
        return undefined;
    }

    /**
     * Outcome the companion observed on the submit page after the user clicked
     * Submit (`error` with a message, `submitted`, or `gone`), consumed once.
     */
    takeSubmitOutcome(jobId: string): { outcome: string; message?: string } | undefined {
        const v = this.submitOutcomes.get(jobId);
        if (v) {
            this.submitOutcomes.delete(jobId);
            return { outcome: v.outcome, message: v.message };
        }
        return undefined;
    }

    start(port: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const server = http.createServer((req, res) => this.handle(req, res));
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
                this.boundPort = (server.address() as AddressInfo).port;
                this.server = server;
                server.removeListener('error', reject);
                resolve();
            });
        });
    }

    stop(): void {
        for (const w of this.waiters.splice(0)) {
            w(null);
        }
        for (const { reject, timer } of this.pendingFetches.values()) {
            clearTimeout(timer);
            reject(new Error('companion-offline'));
        }
        this.pendingFetches.clear();
        this.submitOutcomes.clear();
        this.queue = [];
        this.server?.close();
        this.server = undefined;
    }

    enqueueSubmit(input: SubmitJobInput): SubmitJob {
        const job: SubmitJob = {
            ...input,
            type: 'submit',
            id: crypto.randomBytes(8).toString('hex'),
            createdAt: Date.now()
        };
        this.pushJob(job);
        return job;
    }

    /**
     * Ask the companion to GET `url` in the browser and return the response.
     * Rejects with `companion-offline` (nothing polling), `companion-auth`
     * (polling but token rejected), or `companion-timeout` (no answer in time).
     */
    fetchViaCompanion(url: string): Promise<RelayFetchResult> {
        if (!this.companionOnline) {
            const reason = this.companionStatus === 'auth-rejected' ? 'companion-auth' : 'companion-offline';
            return Promise.reject(new Error(reason));
        }
        const job: FetchJob = {
            type: 'fetch',
            url,
            id: crypto.randomBytes(8).toString('hex'),
            createdAt: Date.now()
        };
        return new Promise<RelayFetchResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingFetches.delete(job.id);
                this.removeJob(job.id);
                reject(new Error('companion-timeout'));
            }, FETCH_TIMEOUT_MS);
            this.pendingFetches.set(job.id, { resolve, reject, timer });
            this.pushJob(job);
        });
    }

    private pushJob(job: RelayJob): void {
        this.queue.push(job);
        const waiter = this.waiters.shift();
        if (waiter) {
            waiter(this.queue[0]);
        }
    }

    private removeJob(id: string): void {
        const i = this.queue.findIndex((j) => j.id === id);
        if (i >= 0) {
            this.queue.splice(i, 1);
        }
    }

    /** Token from `X-Relay-Token: <t>`, `Authorization: Bearer <t>`, or a raw `Authorization: <t>`. */
    private extractToken(req: http.IncomingMessage): string | undefined {
        const x = req.headers['x-relay-token'];
        if (typeof x === 'string' && x.length > 0) {
            return x.trim();
        }
        const auth = req.headers['authorization'];
        if (typeof auth === 'string' && auth.trim().length > 0) {
            const m = /^\s*Bearer\s+(.+?)\s*$/i.exec(auth);
            return (m ? m[1] : auth).trim();
        }
        return undefined;
    }

    private authResult(req: http.IncomingMessage): { ok: boolean; branch: string; recvLen: number } {
        const given = this.extractToken(req);
        if (given === undefined) {
            return { ok: false, branch: 'no-token', recvLen: 0 };
        }
        // Length must match before timingSafeEqual — it throws on unequal lengths.
        if (given.length !== this.token.length) {
            return { ok: false, branch: 'bad-length', recvLen: given.length };
        }
        const ok = crypto.timingSafeEqual(Buffer.from(given), Buffer.from(this.token));
        return { ok, branch: ok ? 'ok' : 'mismatch', recvLen: given.length };
    }

    private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
        res.setHeader('Cache-Control', 'no-store');
        const route = (req.url ?? '').split('?', 1)[0];

        // /health is unauthenticated so a companion can find/verify the server first.
        if (req.method === 'GET' && route === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    ok: true,
                    port: this.boundPort,
                    tokenRequired: true,
                    protocolVersion: PROTOCOL_VERSION
                })
            );
            return;
        }

        const auth = this.authResult(req);
        if (!auth.ok) {
            this.log(
                `REJECT ${req.method ?? '?'} ${route} tokenPresent=${auth.branch === 'no-token' ? 'n' : 'y'} ` +
                    `recvLen=${auth.recvLen} expLen=${this.token.length} branch=${auth.branch}`
            );
            if (
                route === '/pending' ||
                route === '/result' ||
                route === '/ack' ||
                route === '/submit-result' ||
                route === '/companion-error'
            ) {
                this.lastRejectedAt = Date.now();
            }
            res.writeHead(401).end('unauthorized');
            return;
        }

        if (req.method === 'GET' && route === '/pending') {
            this.lastPollAt = Date.now();
            this.everPolled = true;
            this.servePending(req, res);
            return;
        }

        if (req.method === 'POST' && route === '/ack') {
            this.readBody(req, (body) => {
                const id = safeField(body, 'id');
                if (id) {
                    this.removeJob(id);
                }
                res.writeHead(200).end('ok');
            });
            return;
        }

        if (req.method === 'POST' && route === '/result') {
            this.readBody(req, (body) => {
                this.deliverFetchResult(body);
                res.writeHead(200).end('ok');
            });
            return;
        }

        if (req.method === 'POST' && route === '/submit-result') {
            this.readBody(req, (body) => {
                this.recordSubmitOutcome(body);
                res.writeHead(200).end('ok');
            });
            return;
        }

        if (req.method === 'POST' && route === '/companion-error') {
            this.readBody(req, (body) => {
                const message = safeField(body, 'message');
                if (message) {
                    this.lastCompanionError = { message, at: Date.now() };
                    this.log(`[companion] ${message}`);
                }
                res.writeHead(200).end('ok');
            });
            return;
        }

        res.writeHead(404).end('not found');
    }

    private recordSubmitOutcome(body: string): void {
        try {
            const v = JSON.parse(body) as { id?: unknown; outcome?: unknown; message?: unknown };
            if (typeof v.id === 'string' && typeof v.outcome === 'string') {
                this.submitOutcomes.set(v.id, {
                    outcome: v.outcome,
                    message: typeof v.message === 'string' ? v.message : undefined,
                    at: Date.now()
                });
            }
        } catch {
            /* ignore malformed */
        }
        // Keep the map from growing over a long session.
        for (const [k, val] of this.submitOutcomes) {
            if (Date.now() - val.at > 600_000) {
                this.submitOutcomes.delete(k);
            }
        }
    }

    private deliverFetchResult(body: string): void {
        let parsed: { id?: unknown; status?: unknown; body?: unknown };
        try {
            parsed = JSON.parse(body);
        } catch {
            return;
        }
        const id = typeof parsed.id === 'string' ? parsed.id : undefined;
        if (!id) {
            return;
        }
        const pending = this.pendingFetches.get(id);
        if (!pending) {
            return;
        }
        clearTimeout(pending.timer);
        this.pendingFetches.delete(id);
        this.removeJob(id);
        pending.resolve({
            status: typeof parsed.status === 'number' ? parsed.status : 0,
            body: typeof parsed.body === 'string' ? parsed.body : ''
        });
    }

    /** Returns the head job, or holds the response until one arrives (or times out). */
    private servePending(req: http.IncomingMessage, res: http.ServerResponse): void {
        if (this.queue.length > 0) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(this.queue[0]));
            return;
        }
        let settled = false;
        const finish = (job: RelayJob | null) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            const i = this.waiters.indexOf(finish);
            if (i >= 0) {
                this.waiters.splice(i, 1);
            }
            if (job) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(job));
            } else {
                res.writeHead(204).end();
            }
        };
        const timer = setTimeout(() => finish(null), LONG_POLL_MS);
        this.waiters.push(finish);
        req.on('close', () => finish(null));
    }

    private readBody(req: http.IncomingMessage, done: (body: string) => void): void {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
        req.on('error', () => done(''));
    }
}

function safeField(body: string, field: string): string | undefined {
    try {
        const v = JSON.parse(body) as Record<string, unknown>;
        return typeof v[field] === 'string' ? (v[field] as string) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Auth self-test over real HTTP — run: `node out/relay.js`.
 * The earlier in-process check missed the Bearer-header bug because it only
 * ever sent `X-Relay-Token`; this exercises every accepted and rejected shape.
 */
export async function selfTest(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');
    const TOKEN = 'a'.repeat(32);
    const srv = new RelayServer(TOKEN, (m) => console.log('  [reject]', m));
    await srv.start(0);
    const base = `http://127.0.0.1:${srv.port}`;
    const status = (path: string, headers: Record<string, string> = {}) =>
        fetch(base + path, { headers }).then((r) => r.status);

    try {
        // companion status starts absent
        assert.strictEqual(srv.companionEverSeen, false, 'everSeen false before any poll');
        assert.strictEqual(srv.companionStatus, 'offline', 'status offline before any poll');

        // /health: no token required, useful shape
        assert.strictEqual(await status('/health'), 200, '/health must not require a token');
        const health = (await fetch(base + '/health').then((r) => r.json())) as {
            ok?: unknown;
            tokenRequired?: unknown;
            port?: unknown;
            protocolVersion?: unknown;
        };
        assert.deepStrictEqual(
            {
                ok: health.ok,
                tokenRequired: health.tokenRequired,
                portIsNum: typeof health.port === 'number',
                protocolVersion: health.protocolVersion
            },
            { ok: true, tokenRequired: true, portIsNum: true, protocolVersion: PROTOCOL_VERSION },
            '/health body shape'
        );

        // rejected shapes
        assert.strictEqual(await status('/pending'), 401, 'no token → 401');
        assert.strictEqual(await status('/pending', { 'X-Relay-Token': 'tooShort' }), 401, 'bad length → 401');
        assert.strictEqual(await status('/pending', { 'X-Relay-Token': 'b'.repeat(32) }), 401, 'wrong token → 401');
        assert.strictEqual(
            await status('/pending', { Authorization: 'Bearer ' + 'b'.repeat(32) }),
            401,
            'wrong Bearer token → 401'
        );

        // accepted shapes — enqueue so /pending returns immediately instead of long-polling
        srv.enqueueSubmit({ kind: 'contest', contestId: 1, index: 'A', source: 'x', programTypeId: '1' });
        assert.strictEqual(await status('/pending', { 'X-Relay-Token': TOKEN }), 200, 'X-Relay-Token accepted');
        assert.strictEqual(
            await status('/pending', { Authorization: `Bearer ${TOKEN}` }),
            200,
            'Authorization: Bearer accepted'
        );
        assert.strictEqual(
            await status('/pending', { Authorization: TOKEN }),
            200,
            'raw Authorization token accepted'
        );

        // a successful poll marks the companion seen + online
        assert.strictEqual(srv.companionEverSeen, true, 'everSeen true after an authed poll');
        assert.strictEqual(srv.companionStatus, 'online', 'status online right after a poll');

        // /submit-result round-trips into takeSubmitOutcome, once
        await fetch(base + '/submit-result', {
            method: 'POST',
            headers: { 'X-Relay-Token': TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'job1', outcome: 'error', message: 'identical code' })
        });
        assert.deepStrictEqual(
            srv.takeSubmitOutcome('job1'),
            { outcome: 'error', message: 'identical code' },
            'submit outcome recorded'
        );
        assert.strictEqual(srv.takeSubmitOutcome('job1'), undefined, 'submit outcome consumed once');
        assert.strictEqual(await status('/submit-result'), 401, '/submit-result needs a token');

        // companion-reported error (e.g. a protocol mismatch) surfaces via companionError
        assert.strictEqual(srv.companionError, undefined, 'no companion error yet');
        await fetch(base + '/companion-error', {
            method: 'POST',
            headers: { 'X-Relay-Token': TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'protocol mismatch: companion=1 relay=2' })
        });
        assert.strictEqual(srv.companionError, 'protocol mismatch: companion=1 relay=2', 'companion error recorded');

        console.log('relay auth selfTest: OK');
    } finally {
        srv.stop();
    }
}

if (require.main === module) {
    selfTest().catch((e) => {
        console.error('relay auth selfTest: FAIL\n', e);
        process.exit(1);
    });
}
