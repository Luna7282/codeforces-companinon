const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Codeforces asks for at most one request per second and gets unhappy well
 * before that during a live contest. Everything goes through one queue.
 */
class RateLimiter {
    private last = 0;
    private chain: Promise<void> = Promise.resolve();

    constructor(private readonly minGapMs: number) {}

    run<T>(fn: () => Promise<T>): Promise<T> {
        const result = this.chain.then(async () => {
            const wait = this.minGapMs - (Date.now() - this.last);
            if (wait > 0) {
                await new Promise((r) => setTimeout(r, wait));
            }
            this.last = Date.now();
            return fn();
        });
        this.chain = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }
}

export interface CookieRecord {
    [name: string]: string;
}

export interface RelayFetchResult {
    status: number;
    body: string;
    contentType?: string;
}
export type RelayFetcher = (url: string, binary?: boolean) => Promise<RelayFetchResult>;

export class CfHttp {
    private cookies: CookieRecord = {};
    private userAgent = USER_AGENT;
    private readonly limiter = new RateLimiter(1100);
    private relayFetcher: RelayFetcher | undefined;
    private relayLatched = false;
    private logger: (msg: string) => void = () => {};

    constructor(private readonly onCookieChange: (c: CookieRecord) => void = () => {}) {}

    /** Wired to the Codeforces output channel (only visible with codeforces.debug on). */
    setLogger(fn: (msg: string) => void): void {
        this.logger = fn;
    }

    log(msg: string): void {
        this.logger(msg);
    }

    /**
     * Register a transport that fetches a URL through the companion browser
     * extension. Used for page reads once Cloudflare's TLS-fingerprint block
     * trips (see LESSONS.md 2026-09-04); `/api/*` never uses it.
     */
    setRelayFetcher(fn: RelayFetcher | undefined): void {
        this.relayFetcher = fn;
    }

    /** True once a Cloudflare block has forced reads onto the companion for this session. */
    get relayActive(): boolean {
        return this.relayLatched;
    }

    private isApi(url: string): boolean {
        return url.startsWith('https://codeforces.com/api/');
    }

    private looksLikeCloudflare(status: number, body: string): boolean {
        return (
            (status === 403 || status === 503) &&
            /cf-browser-verification|Just a moment|cf_chl|Enable JavaScript and cookies/i.test(body)
        );
    }

    /**
     * A real Codeforces page (200, not a Cloudflare interstitial) with no
     * signed-in profile link. Node's own cookie jar (imported once, or never
     * populated) can go stale independently of the browser being logged in —
     * unlike a Cloudflare block this is a normal 200, so it needs its own
     * check rather than falling out of looksLikeCloudflare. Same marker
     * background.js's looksSignedOut() and Session.findHandle() use.
     */
    private looksSignedOut(status: number, body: string): boolean {
        return (
            status >= 200 &&
            status < 400 &&
            /X-Csrf-Token|class="lang-chooser"|id="pageContent"/i.test(body) &&
            !/href="\/profile\//i.test(body)
        );
    }

    loadCookies(c: CookieRecord | undefined): void {
        this.cookies = c ? { ...c } : {};
    }

    /**
     * Cloudflare binds a cf_clearance cookie to the exact User-Agent that
     * solved the challenge, so an imported browser session must send the
     * browser's UA verbatim. Empty/undefined restores the built-in string.
     */
    setUserAgent(ua: string | undefined): void {
        this.userAgent = ua && ua.trim() ? ua.trim() : USER_AGENT;
    }

    exportCookies(): CookieRecord {
        return { ...this.cookies };
    }

    clearCookies(): void {
        this.cookies = {};
        this.onCookieChange(this.cookies);
    }

    hasSession(): boolean {
        return Boolean(this.cookies['JSESSIONID']);
    }

    private cookieHeader(): string {
        return Object.entries(this.cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    private absorb(response: Response): void {
        const anyHeaders = response.headers as unknown as {
            getSetCookie?: () => string[];
        };
        const raw =
            typeof anyHeaders.getSetCookie === 'function'
                ? anyHeaders.getSetCookie()
                : ([response.headers.get('set-cookie')].filter(Boolean) as string[]);
        let changed = false;
        for (const line of raw) {
            const pair = line.split(';', 1)[0];
            const eq = pair.indexOf('=');
            if (eq <= 0) {
                continue;
            }
            const name = pair.slice(0, eq).trim();
            const value = pair.slice(eq + 1).trim();
            if (this.cookies[name] !== value) {
                this.cookies[name] = value;
                changed = true;
            }
        }
        if (changed) {
            this.onCookieChange(this.exportCookies());
        }
    }

    private headers(extra?: Record<string, string>): Record<string, string> {
        const h: Record<string, string> = {
            'User-Agent': this.userAgent,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...extra
        };
        const cookie = this.cookieHeader();
        if (cookie) {
            h['Cookie'] = cookie;
        }
        return h;
    }

    /**
     * @param opts.requireSession The page is useless without a signed-in
     * session (submit form, "my" status page) — Node's own cookie jar can be
     * stale or never populated even while the browser is logged in, and that
     * shows up as a normal 200 with signed-out markup, not a Cloudflare
     * block. So for these reads a signed-out result is treated exactly like
     * a Cloudflare challenge: retry through the companion, which fetches in
     * page context in an actual signed-in tab. Leave unset for reads that
     * work fine anonymously (problem statements, contest lists) — otherwise
     * a user who never imported a session would force every read through
     * the companion forever.
     */
    async get(url: string, opts?: { requireSession?: boolean }): Promise<string> {
        // Once Cloudflare has blocked a direct read this session, every non-API
        // read goes straight through the companion — no failed Node request first.
        if (this.relayLatched && this.relayFetcher && !this.isApi(url)) {
            this.log(`[transport] ${url} -> relay (latched)`);
            return this.viaRelay(url);
        }
        return this.limiter.run(async () => {
            const res = await fetch(url, {
                headers: this.headers(),
                redirect: 'follow'
            });
            this.absorb(res);
            const body = await res.text();
            if (this.looksLikeCloudflare(res.status, body)) {
                if (this.relayFetcher && !this.isApi(url)) {
                    this.relayLatched = true;
                    this.log(`[transport] ${url} -> direct Node fetch Cloudflare-challenged (${res.status}); latching relay`);
                    return this.viaRelay(url);
                }
                this.guardCloudflare(res.status, body, url);
            }
            if (opts?.requireSession && this.looksSignedOut(res.status, body)) {
                if (this.relayFetcher && !this.isApi(url)) {
                    this.relayLatched = true;
                    this.log(
                        `[transport] ${url} -> direct Node fetch came back signed-out (${res.status}) on a ` +
                            'session-required read; latching relay'
                    );
                    return this.viaRelay(url);
                }
                this.log(`[transport] ${url} -> direct Node fetch signed-out (${res.status}); no companion registered`);
            }
            if (!res.ok) {
                throw new Error(`GET ${url} returned ${res.status}`);
            }
            this.log(`[transport] ${url} -> direct Node fetch (${res.status})`);
            return body;
        });
    }

    private async viaRelay(url: string): Promise<string> {
        try {
            return await this.relayGetOnce(url);
        } catch (err) {
            const m = (err as Error).message;
            // `companion-offline` / `companion-timeout` is usually a suspended MV3
            // service worker. Its chrome.alarms keepalive revives it within ~30s,
            // so keep retrying across that window before giving up.
            if (m === 'companion-offline' || m === 'companion-timeout') {
                const deadline = Date.now() + 30_000;
                while (Date.now() < deadline) {
                    await new Promise((r) => setTimeout(r, 5000));
                    try {
                        return await this.relayGetOnce(url);
                    } catch (again) {
                        const gm = (again as Error).message;
                        if (gm !== 'companion-offline' && gm !== 'companion-timeout') {
                            throw this.relayError(gm);
                        }
                    }
                }
                throw this.relayError(m);
            }
            throw this.relayError(m, err as Error);
        }
    }

    private relayError(kind: string, fallback?: Error): Error {
        if (kind === 'companion-auth') {
            return new Error(
                'The companion extension is running but its relay token is wrong. Run "Codeforces: Relay info" ' +
                    "and paste the current port and token into the companion's options."
            );
        }
        if (kind === 'companion-offline' || kind === 'companion-timeout') {
            return new Error(
                'The companion extension is asleep or not responding. Open chrome://extensions and click its ' +
                    '"service worker" link to wake it, then retry — or run "Codeforces: Check companion".'
            );
        }
        return fallback ?? new Error(kind);
    }

    private async relayGetOnce(url: string): Promise<string> {
        const out: RelayFetchResult = await this.relayFetcher!(url);
        this.log(`[transport] ${url} -> relay round-trip returned status ${out.status}`);
        if (this.looksLikeCloudflare(out.status, out.body)) {
            throw new Error(
                'Codeforces served a Cloudflare challenge in the browser too — open codeforces.com in Chrome, ' +
                    'clear the check, then retry.'
            );
        }
        if (out.status < 200 || out.status >= 400) {
            throw new Error(`GET ${url} via companion returned ${out.status}`);
        }
        return out.body;
    }

    /**
     * Fetches image bytes and returns them as a `data:` URI, for inlining into
     * the statement webview. Cloudflare blocks these exactly like it blocks
     * page reads (see LESSONS.md, "Statement images") — a blocked response
     * comes back with `Content-Type: text/html` (a challenge page), same
     * status as a real image in some cases, so success is judged by content
     * type, never status code alone.
     */
    async getImageDataUri(url: string): Promise<string> {
        this.log(`[image] getImageDataUri(${url})`);
        if (this.relayLatched && this.relayFetcher) {
            this.log(`[image] relay already latched from an earlier block this session — skipping straight to companion`);
            return this.imageViaRelay(url);
        }
        try {
            return await this.limiter.run(async () => {
                const res = await fetch(url, { headers: this.headers(), redirect: 'follow' });
                const contentType = res.headers.get('content-type') ?? '';
                this.log(`[image] direct fetch ${url} -> status=${res.status} content-type=${contentType || 'none'}`);
                if (!res.ok || !contentType.startsWith('image/')) {
                    throw new Error(
                        `GET ${url} did not return an image (status ${res.status}, content-type ${contentType || 'none'})`
                    );
                }
                const buf = Buffer.from(await res.arrayBuffer());
                this.log(`[image] direct fetch succeeded for ${url} (${buf.length} bytes) — inlined without the companion`);
                return `data:${contentType};base64,${buf.toString('base64')}`;
            });
        } catch (err) {
            this.log(`[image] direct fetch failed for ${url}: ${(err as Error).message}`);
            if (this.relayFetcher) {
                this.relayLatched = true;
                this.log(`[image] falling back to the companion for ${url}`);
                return this.imageViaRelay(url);
            }
            this.log(`[image] no companion registered — giving up on ${url}`);
            throw err;
        }
    }

    private async imageViaRelay(url: string): Promise<string> {
        const out = await this.relayFetcher!(url, true);
        this.log(
            `[image] companion fetch ${url} -> status=${out.status} content-type=${out.contentType || 'none'} ` +
                `bodyLen=${out.body.length}`
        );
        const contentType = out.contentType ?? '';
        if (out.status < 200 || out.status >= 400 || !contentType.startsWith('image/')) {
            throw new Error(
                `GET ${url} via companion did not return an image (status ${out.status}, content-type ${contentType || 'none'})`
            );
        }
        this.log(`[image] companion fetch succeeded for ${url} — inlined`);
        return `data:${contentType};base64,${out.body}`;
    }

    async getJson<T>(url: string): Promise<T> {
        const body = await this.get(url);
        return JSON.parse(body) as T;
    }

    /** GET with no Cloudflare guard and no !ok throw — for diagnostics only. */
    async rawGet(url: string): Promise<{ status: number; body: string }> {
        return this.limiter.run(async () => {
            const res = await fetch(url, { headers: this.headers(), redirect: 'follow' });
            this.absorb(res);
            return { status: res.status, body: await res.text() };
        });
    }

    async post(url: string, form: Record<string, string>, referer?: string): Promise<string> {
        return this.limiter.run(async () => {
            const res = await fetch(url, {
                method: 'POST',
                headers: this.headers({
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Origin: 'https://codeforces.com',
                    ...(referer ? { Referer: referer } : {})
                }),
                body: new URLSearchParams(form).toString(),
                redirect: 'follow'
            });
            this.absorb(res);
            const body = await res.text();
            this.guardCloudflare(res.status, body, url);
            if (!res.ok) {
                throw new Error(`POST ${url} returned ${res.status}`);
            }
            return body;
        });
    }
    private guardCloudflare(status: number, body: string, _url: string): void {
        if (!this.looksLikeCloudflare(status, body)) {
            return;
        }
        if (this.cookies['cf_clearance']) {
            throw new Error(
                'Your browser session expired — run "Codeforces: Import session from browser" again.'
            );
        }
        throw new Error(
            'Codeforces is blocking direct requests. Start the companion extension in Chrome to load problems, ' +
                'or run "Codeforces: Import session from browser" if the Cloudflare check is off.'
        );
    }
}

const SIGNED_OUT_PAGE = '<html><meta name="X-Csrf-Token" content="x"><body>Enter</body></html>';
const SIGNED_IN_PAGE = '<html><body><a href="/profile/tourist">tourist</a></body></html>';

/**
 * Stubs global fetch + a relay fetcher — no real network — to pin down the
 * transport-selection logic fixed in LESSONS.md ("session lost to a direct
 * Node fetch"): a session-required read that comes back signed-out over
 * direct Node must retry through the relay, and a read that doesn't ask for
 * a session must not. Run: node out/http.js
 */
export async function selfTest(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');
    const realFetch = globalThis.fetch;
    try {
        // requireSession + signed-out direct response -> latches relay and retries there.
        {
            const http = new CfHttp();
            globalThis.fetch = (async () =>
                new Response(SIGNED_OUT_PAGE, { status: 200 })) as unknown as typeof fetch;
            let relayCalls = 0;
            http.setRelayFetcher(async () => {
                relayCalls++;
                return { status: 200, body: SIGNED_IN_PAGE };
            });
            const body = await http.get('https://codeforces.com/contest/1/submit', { requireSession: true });
            assert.strictEqual(relayCalls, 1, 'signed-out + requireSession retries once through the relay');
            assert.strictEqual(body, SIGNED_IN_PAGE, 'the relay body wins once latched');
            assert.strictEqual(http.relayActive, true, 'latches for subsequent reads too');
        }

        // Same signed-out response, but requireSession not set -> stays direct, no relay call.
        {
            const http = new CfHttp();
            globalThis.fetch = (async () =>
                new Response(SIGNED_OUT_PAGE, { status: 200 })) as unknown as typeof fetch;
            let relayCalls = 0;
            http.setRelayFetcher(async () => {
                relayCalls++;
                return { status: 200, body: SIGNED_IN_PAGE };
            });
            const body = await http.get('https://codeforces.com/problemset/problem/1/A');
            assert.strictEqual(relayCalls, 0, 'no requireSession -> signed-out direct response is accepted as-is');
            assert.strictEqual(body, SIGNED_OUT_PAGE);
            assert.strictEqual(http.relayActive, false, 'not latched for a read that never asked for a session');
        }

        // requireSession + already signed-in direct response -> no relay call at all.
        {
            const http = new CfHttp();
            globalThis.fetch = (async () =>
                new Response(SIGNED_IN_PAGE, { status: 200 })) as unknown as typeof fetch;
            let relayCalls = 0;
            http.setRelayFetcher(async () => {
                relayCalls++;
                return { status: 200, body: SIGNED_IN_PAGE };
            });
            const body = await http.get('https://codeforces.com/contest/1/submit', { requireSession: true });
            assert.strictEqual(relayCalls, 0, 'already signed in over direct Node -> no relay round-trip needed');
            assert.strictEqual(body, SIGNED_IN_PAGE);
        }

        console.log('http selfTest: OK');
    } finally {
        globalThis.fetch = realFetch;
    }
}

if (require.main === module) {
    selfTest().catch((e) => {
        console.error('http selfTest: FAIL\n', e);
        process.exit(1);
    });
}
