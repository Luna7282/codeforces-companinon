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
}
export type RelayFetcher = (url: string) => Promise<RelayFetchResult>;

export class CfHttp {
    private cookies: CookieRecord = {};
    private userAgent = USER_AGENT;
    private readonly limiter = new RateLimiter(1100);
    private relayFetcher: RelayFetcher | undefined;
    private relayLatched = false;

    constructor(private readonly onCookieChange: (c: CookieRecord) => void = () => {}) {}

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

    async get(url: string): Promise<string> {
        // Once Cloudflare has blocked a direct read this session, every non-API
        // read goes straight through the companion — no failed Node request first.
        if (this.relayLatched && this.relayFetcher && !this.isApi(url)) {
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
                    return this.viaRelay(url);
                }
                this.guardCloudflare(res.status, body, url);
            }
            if (!res.ok) {
                throw new Error(`GET ${url} returned ${res.status}`);
            }
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
