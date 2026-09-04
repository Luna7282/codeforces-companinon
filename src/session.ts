import * as vscode from 'vscode';
import * as cheerio from 'cheerio';
import { CfHttp, CookieRecord } from './http';

const SECRET_KEY = 'codeforces.session';

interface StoredSession {
    cookies: CookieRecord;
    handle: string;
    ftaa: string;
    bfaa: string;
    /** Set when the session was imported from a browser (see importBrowserSession). */
    userAgent?: string;
    /** cf_clearance expiry, epoch ms, if the user supplied it on import. */
    clearanceExpiry?: number;
}

export interface BrowserSessionInput {
    cfClearance: string;
    jsessionId: string;
    userAgent: string;
    /** Optional: the "Expires" value shown next to cf_clearance in DevTools. */
    clearanceExpiry?: number;
}

export interface AccessDiagnosis {
    status: number;
    /** Body is a Cloudflare "Just a moment" / cf_chl interstitial. */
    cloudflareInterstitial: boolean;
    /** Body looks like a real Codeforces page (not the interstitial). */
    codeforcesHtml: boolean;
    handle?: string;
    /** The signed-out /enter login form is present. */
    loginFormPresent: boolean;
    verdict:
        | 'through-and-signed-in'
        | 'through-but-signed-out'
        | 'cloudflare-interstitial'
        | 'unknown';
    /** First ~200 chars of the body, for eyeballing an 'unknown'. */
    bodyHead: string;
}

function randomString(len: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < len; i++) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
}

/** Codeforces' login form carries two opaque fingerprint fields. */
function genFtaa(): string {
    return randomString(18, 'abcdefghijklmnopqrstuvwxyz0123456789');
}

function genBfaa(): string {
    return randomString(32, 'abcdef0123456789');
}

export class Session {
    readonly http: CfHttp;
    private handle = '';
    private ftaa = genFtaa();
    private bfaa = genBfaa();
    private userAgent: string | undefined;
    private clearanceExpiry: number | undefined;
    private loaded = false;

    constructor(private readonly secrets: vscode.SecretStorage) {
        this.http = new CfHttp(() => void this.persist());
    }

    async load(): Promise<void> {
        if (this.loaded) {
            return;
        }
        this.loaded = true;
        const raw = await this.secrets.get(SECRET_KEY);
        if (!raw) {
            return;
        }
        try {
            const stored = JSON.parse(raw) as StoredSession;
            this.http.loadCookies(stored.cookies);
            this.handle = stored.handle ?? '';
            this.ftaa = stored.ftaa || this.ftaa;
            this.bfaa = stored.bfaa || this.bfaa;
            this.userAgent = stored.userAgent;
            this.clearanceExpiry = stored.clearanceExpiry;
            this.http.setUserAgent(stored.userAgent);
        } catch {
            await this.secrets.delete(SECRET_KEY);
        }
    }

    private async persist(): Promise<void> {
        const payload: StoredSession = {
            cookies: this.http.exportCookies(),
            handle: this.handle,
            ftaa: this.ftaa,
            bfaa: this.bfaa,
            userAgent: this.userAgent,
            clearanceExpiry: this.clearanceExpiry
        };
        await this.secrets.store(SECRET_KEY, JSON.stringify(payload));
    }

    get currentHandle(): string {
        return this.handle;
    }

    /** cf_clearance expiry (epoch ms) from the last import, if the user gave one. */
    get clearanceExpiresAt(): number | undefined {
        return this.clearanceExpiry;
    }

    /**
     * Adopt a session copied out of a logged-in browser: its cf_clearance +
     * JSESSIONID cookies and the browser's exact User-Agent. Cloudflare ties
     * cf_clearance to that UA, so http.ts sends it verbatim from here on. This
     * is the way in while Codeforces is in Cloudflare "under attack" mode and
     * a Node-side password login can't pass the check.
     */
    async importBrowserSession(input: BrowserSessionInput): Promise<string | undefined> {
        await this.load();
        const jar = this.http.exportCookies();
        jar['cf_clearance'] = input.cfClearance.trim();
        jar['JSESSIONID'] = input.jsessionId.trim();
        this.http.loadCookies(jar);
        this.userAgent = input.userAgent.trim();
        this.clearanceExpiry = input.clearanceExpiry;
        this.http.setUserAgent(this.userAgent);
        try {
            const html = await this.http.get('https://codeforces.com/');
            const handle = Session.findHandle(html);
            if (handle) {
                this.handle = handle;
            }
        } catch {
            // Persist anyway — the caller surfaces the failure.
        }
        await this.persist();
        return this.handle || undefined;
    }

    /** Pulls the csrf token out of any Codeforces page. */
    static findCsrf(html: string): string {
        const $ = cheerio.load(html);
        const meta = $('meta[name="X-Csrf-Token"]').attr('content');
        if (meta) {
            return meta;
        }
        const input = $('input[name="csrf_token"]').first().attr('value');
        if (input) {
            return input;
        }
        const inline = /csrf='([0-9a-f]{32})'/.exec(html);
        if (inline) {
            return inline[1];
        }
        throw new Error(
            'Could not find a csrf token on the page. Codeforces may have changed its markup, or the request was blocked.'
        );
    }

    static findHandle(html: string): string | undefined {
        const $ = cheerio.load(html);
        const href = $('div.lang-chooser a[href^="/profile/"]').first().attr('href');
        if (href) {
            return href.split('/').pop();
        }
        const alt = $('#header a[href^="/profile/"]').first().attr('href');
        return alt ? alt.split('/').pop() : undefined;
    }

    /** Fetches a page and returns both its body and a fresh csrf token. */
    async pageWithCsrf(url: string): Promise<{ html: string; csrf: string }> {
        const html = await this.http.get(url);
        return { html, csrf: Session.findCsrf(html) };
    }

    async isLoggedIn(): Promise<boolean> {
        await this.load();
        if (!this.http.hasSession()) {
            return false;
        }
        const html = await this.http.get('https://codeforces.com/enter');
        const handle = Session.findHandle(html);
        if (handle) {
            this.handle = handle;
            await this.persist();
            return true;
        }
        return false;
    }

    async login(handleOrEmail: string, password: string): Promise<string> {
        await this.load();
        const { csrf } = await this.pageWithCsrf('https://codeforces.com/enter');
        const body = await this.http.post(
            'https://codeforces.com/enter',
            {
                csrf_token: csrf,
                action: 'enter',
                ftaa: this.ftaa,
                bfaa: this.bfaa,
                handleOrEmail,
                password,
                _tta: '176',
                remember: 'on'
            },
            'https://codeforces.com/enter'
        );

        const handle = Session.findHandle(body);
        if (!handle) {
            if (/Invalid handle or password/i.test(body)) {
                throw new Error('Codeforces rejected that handle or password.');
            }
            throw new Error('Login did not complete. Codeforces may be showing a captcha — sign in once in a browser, then retry.');
        }
        this.handle = handle;
        await this.persist();
        return handle;
    }

    /**
     * After an import, GET /enter raw (no Cloudflare guard) and classify the
     * response so we can tell "TLS fingerprint still blocked" from "through
     * Cloudflare but the cookie set is incomplete".
     */
    async diagnoseEnter(): Promise<AccessDiagnosis> {
        const { status, body } = await this.http.rawGet('https://codeforces.com/enter');
        const cloudflareInterstitial =
            /Just a moment|cf[-_]chl|cf-browser-verification|Enable JavaScript and cookies/i.test(body);
        const codeforcesHtml =
            !cloudflareInterstitial &&
            /X-Csrf-Token|Codeforces\.|id="pageContent"|class="lang-chooser"|href="\/profile\//i.test(body);
        const handle = codeforcesHtml ? Session.findHandle(body) : undefined;
        const loginFormPresent = /id=["']enterForm["']|name=["']handleOrEmail["']/i.test(body);

        let verdict: AccessDiagnosis['verdict'] = 'unknown';
        if (cloudflareInterstitial) {
            verdict = 'cloudflare-interstitial';
        } else if (codeforcesHtml && handle) {
            verdict = 'through-and-signed-in';
        } else if (codeforcesHtml && loginFormPresent) {
            verdict = 'through-but-signed-out';
        }

        return {
            status,
            cloudflareInterstitial,
            codeforcesHtml,
            handle,
            loginFormPresent,
            verdict,
            bodyHead: body.slice(0, 200).replace(/\s+/g, ' ')
        };
    }

    async logout(): Promise<void> {
        this.handle = '';
        this.http.clearCookies();
        await this.secrets.delete(SECRET_KEY);
    }

    get fingerprint(): { ftaa: string; bfaa: string } {
        return { ftaa: this.ftaa, bfaa: this.bfaa };
    }
}
