import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { CfHttp } from './http';
import { readCache, writeCache } from './cache';
import { Contest, Language, Problem, ProblemDetail, Sample } from './types';

const GROUP_TTL = 15 * 60_000; // group structure is stable within a session; Refresh clears it
const STATEMENT_TTL = 30 * 24 * 3600_000; // a finished problem's statement never changes

/**
 * Group contests are invisible to the API — contest.list does not return them
 * even with a signed key — so this is the only way to reach them.
 */
export async function groupContests(http: CfHttp, groupCode: string): Promise<Contest[]> {
    const cacheKey = `groupContests:${groupCode}`;
    const cached = readCache<Contest[]>(cacheKey, GROUP_TTL);
    if (cached) {
        return cached;
    }
    const html = await http.get(`https://codeforces.com/group/${groupCode}/contests?complete=true`);
    const $ = cheerio.load(html);

    if ($('form#enterForm').length || /You are not allowed to view/i.test(html)) {
        throw new Error(`Not signed in, or not a member of group ${groupCode}.`);
    }

    const contests: Contest[] = [];
    const seen = new Set<number>();
    $(`a[href*="/group/${groupCode}/contest/"]`).each((_, el) => {
        const href = $(el).attr('href') ?? '';
        const m = /\/group\/[^/]+\/contest\/(\d+)(?:$|[?#])/.exec(href);
        if (!m) {
            return;
        }
        // Every contest row carries several of these links ("Enter »", "Virtual
        // participation »", "Final standings"); only the ones inside a real
        // multi-cell table row are contests.
        const row = $(el).closest('tr');
        if (row.find('td').length < 2) {
            return;
        }
        const id = Number(m[1]);
        if (seen.has(id)) {
            return;
        }
        // The contest name is the leading text node of the row's first cell —
        // the <a> we matched is the "Enter »" link, whose own text is useless.
        const name = $(el).closest('td').clone().children().remove().end().text().trim();
        if (!name) {
            return;
        }
        seen.add(id);
        contests.push({ id, name, kind: 'group', groupCode });
    });
    writeCache(cacheKey, contests);
    return contests;
}

/** Problem list for a group contest, read off the contest page. */
export async function groupProblems(http: CfHttp, contest: Contest): Promise<Problem[]> {
    const cacheKey = `groupProblems:${contest.groupCode}/${contest.id}`;
    const cached = readCache<Problem[]>(cacheKey, GROUP_TTL);
    if (cached) {
        return cached;
    }
    const url = `https://codeforces.com/group/${contest.groupCode}/contest/${contest.id}`;
    const html = await http.get(url);
    const $ = cheerio.load(html);
    const problems: Problem[] = [];

    $('table.problems tr').each((_, row) => {
        const cells = $(row).find('td');
        if (cells.length < 2) {
            return;
        }
        const index = $(cells[0]).find('a').text().trim();
        const name = $(cells[1]).find('a').first().text().trim();
        if (!index || !name) {
            return;
        }
        problems.push({
            contestId: contest.id,
            index,
            name,
            kind: 'group',
            groupCode: contest.groupCode
        });
    });
    writeCache(cacheKey, problems);
    return problems;
}

function preToText($: cheerio.CheerioAPI, pre: AnyNode): string {
    const $pre = $(pre);
    const lines = $pre.find('div');
    if (lines.length > 0) {
        return lines
            .map((_, d) => $(d).text())
            .get()
            .join('\n')
            .trim();
    }
    const html = $pre.html() ?? '';
    return cheerio
        .load(`<div>${html.replace(/<br\s*\/?>/gi, '\n')}</div>`)('div')
        .text()
        .trim();
}

export async function problemDetail(http: CfHttp, url: string): Promise<ProblemDetail> {
    const cacheKey = `problemDetail:${url}`;
    const cached = readCache<ProblemDetail>(cacheKey, STATEMENT_TTL);
    if (cached) {
        http.log(`[image] problemDetail(${url}) served from the 30-day disk cache — no fetch happens this call`);
        return cached;
    }
    http.log(`[image] problemDetail(${url}) cache miss — fetching fresh`);
    const html = await http.get(url);
    const $ = cheerio.load(html);
    const root = $('div.problem-statement').first();
    if (root.length === 0) {
        throw new Error('No problem statement on that page. The contest may not have started, or you may not have access.');
    }

    const samples: Sample[] = [];
    const inputs = root.find('div.sample-test div.input pre').toArray();
    const outputs = root.find('div.sample-test div.output pre').toArray();
    for (let i = 0; i < Math.min(inputs.length, outputs.length); i++) {
        samples.push({
            input: preToText($, inputs[i]),
            output: preToText($, outputs[i])
        });
    }

    const timeLimit = root.find('div.time-limit').clone().children('div.property-title').remove().end().text().trim();
    const memoryLimit = root
        .find('div.memory-limit')
        .clone()
        .children('div.property-title')
        .remove()
        .end()
        .text()
        .trim();

    // Statement images can be root-relative, protocol-relative, or bare —
    // the URL constructor resolves every shape against the page URL in one
    // call, rather than special-casing each prefix.
    root.find('img').each((_, img) => {
        const src = $(img).attr('src');
        if (src) {
            $(img).attr('src', new URL(src, url).toString());
        }
    });

    // Even absolute, most statement images (espresso.codeforces.com — the
    // Codeforces-operated LaTeX/diagram render CDN) sit behind the same
    // Cloudflare bot check that blocks a direct page fetch (see LESSONS.md,
    // "Statement images"): a blocked <img src> gets an HTML challenge page
    // back, which renders as a broken-image icon, not a 403 the extension can
    // see. So each is fetched and inlined as a data: URI up front — same
    // Cloudflare-fallback machinery as the page fetch itself, and it's cached
    // baked into statementHtml, so the cost is paid once per problem.
    await Promise.all(
        root
            .find('img')
            .toArray()
            .map(async (img) => {
                const src = $(img).attr('src');
                if (!src) {
                    return;
                }
                try {
                    $(img).attr('src', await http.getImageDataUri(src));
                    http.log(`[image] ${src} ends up inlined in statementHtml`);
                } catch (err) {
                    // A broken-icon with no explanation is the worst outcome — replace
                    // the img entirely with a link. VS Code webviews open a plain
                    // https:// <a href> in the user's real browser, where the image
                    // does load (it's only blocked in the webview's own request
                    // contexts, not a real navigation — see LESSONS.md).
                    http.log(`[image] ${src} shown as a link, not inlined — every fetch attempt failed: ${(err as Error).message}`);
                    $(img).replaceWith(
                        `<span class="cf-image-unavailable">Image unavailable in this panel — ` +
                            `<a href="${src}">open it in your browser</a></span>`
                    );
                }
            })
    );

    // "A. Two Sum" -> "Two Sum" — mirrors browser/content.js's parseProblemName,
    // and is the one place both the deep-link-opened and the tree-opened path
    // can get an authoritative name from (the tree already has a good one from
    // the contest listing; a deep link may not).
    const titleText = root.find('.header .title').first().text().trim();
    const name = titleText.replace(/^\s*[A-Za-z0-9]+\.\s*/, '').trim() || undefined;

    const detail: ProblemDetail = {
        statementHtml: root.html() ?? '',
        samples,
        timeLimit: timeLimit || undefined,
        memoryLimit: memoryLimit || undefined,
        name
    };
    writeCache(cacheKey, detail);
    return detail;
}

/** Reads the compiler dropdown off a submit page rather than hardcoding ids. */
export function parseLanguages(html: string): Language[] {
    const $ = cheerio.load(html);
    const langs: Language[] = [];
    $('select[name="programTypeId"] option').each((_, opt) => {
        const id = $(opt).attr('value');
        const name = $(opt).text().trim();
        if (id && name) {
            langs.push({ id, name });
        }
    });
    return langs;
}

// The fourth src is the real value confirmed on a live group-contest problem
// with diagrams — already absolute, and it's genuinely one wide image
// (4532x1658) covering all four
// panels the Note text refers to as "the second image" / "the third image"
// etc., not four separate images. It still needs inlining: Cloudflare blocks
// a direct <img src> fetch to espresso.codeforces.com exactly like it blocks
// a page fetch (confirmed with curl: 403, a "Just a moment" challenge page,
// regardless of Referer — this is bot-fingerprint blocking, not hotlink
// protection), and that challenge page (Content-Type: text/html) is what an
// unauthenticated webview request actually gets back, hence the broken-image
// icon rather than a picture.
const FIXTURE_STATEMENT_HTML = `<html><body><div class="problem-statement">
  <div class="header">
    <div class="title">A. Two Sum</div>
  </div>
  <div class="time-limit"><div class="property-title">time limit per test</div>2 seconds</div>
  <div class="memory-limit"><div class="property-title">memory limit per test</div>256 megabytes</div>
  <p>See the diagram: <img src="/predownloaded/aa/bb/image1.png"></p>
  <p><img src="//espresso.codeforces.com/image2.png"></p>
  <p><img src="images/image3.png"></p>
  <p><img src="https://espresso.codeforces.com/757752967064f2144527500c6b75d2b0d41e87d2.png"></p>
  <p><img src="https://espresso.codeforces.com/unreachable.png"></p>
  <div class="sample-test">
    <div class="input"><pre>1 2</pre></div>
    <div class="output"><pre>3</pre></div>
  </div>
</div></body></html>`;

/** Statement parsing self-test (name extraction, image src resolution + inlining). Run: node out/scrape.js */
export async function selfTest(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');
    const fetchedUrls: string[] = [];
    const fakeHttp = {
        get: async () => FIXTURE_STATEMENT_HTML,
        log: () => {},
        // Stands in for the real Cloudflare-fallback fetch — proves problemDetail
        // asks for every resolved image, without needing real network access
        // (or a real companion) in a fast, deterministic self-test. One URL
        // always fails, standing in for "direct fetch, companion SW fetch, and
        // the background-tab canvas read all failed" — the Option 3 case.
        getImageDataUri: async (u: string) => {
            fetchedUrls.push(u);
            if (u.endsWith('/unreachable.png')) {
                throw new Error('simulated: every fetch attempt failed');
            }
            return `data:image/png;base64,MOCK(${u})`;
        }
    } as unknown as CfHttp;

    const pageUrl = 'https://codeforces.com/contest/1/problem/A';
    const detail = await problemDetail(fakeHttp, pageUrl);

    assert.strictEqual(detail.name, 'Two Sum', 'name stripped of the "A. " index prefix');
    assert.strictEqual(detail.timeLimit, '2 seconds', 'time limit parsed');
    assert.strictEqual(detail.memoryLimit, '256 megabytes', 'memory limit parsed');
    assert.deepStrictEqual(detail.samples, [{ input: '1 2', output: '3' }], 'sample parsed');

    const resolved = [
        'https://codeforces.com/predownloaded/aa/bb/image1.png',
        'https://espresso.codeforces.com/image2.png',
        'https://codeforces.com/contest/1/problem/images/image3.png',
        'https://espresso.codeforces.com/757752967064f2144527500c6b75d2b0d41e87d2.png',
        'https://espresso.codeforces.com/unreachable.png'
    ];
    assert.deepStrictEqual(
        fetchedUrls,
        resolved,
        'root-relative, protocol-relative, bare-relative and already-absolute src all resolve correctly before fetching'
    );

    const $ = cheerio.load(detail.statementHtml);
    assert.strictEqual($('img').length, 4, 'the four inlineable images stay <img> tags');
    const srcs = $('img')
        .toArray()
        .map((img) => $(img).attr('src'));
    assert.deepStrictEqual(
        srcs,
        resolved.slice(0, 4).map((u) => `data:image/png;base64,MOCK(${u})`),
        'every inlineable image src ends up as a data: URI, not the remote (Cloudflare-blockable) URL'
    );

    const fallback = $('.cf-image-unavailable');
    assert.strictEqual(fallback.length, 1, 'the one URL every fetch attempt failed for gets a fallback note, not a broken <img>');
    assert.strictEqual(
        fallback.find('a').attr('href'),
        'https://espresso.codeforces.com/unreachable.png',
        'the fallback links straight to the remote image so it can still be opened in a real browser'
    );

    console.log('scrape selfTest: OK');
}

if (require.main === module) {
    selfTest().catch((e) => {
        console.error('scrape selfTest: FAIL\n', e);
        process.exit(1);
    });
}
