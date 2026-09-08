import * as cheerio from 'cheerio';
import { Session } from './session';
import { Language, Problem, submitUrl } from './types';
import { parseLanguages } from './scrape';

function snippet(html: string): string {
    return html.replace(/\s+/g, ' ').trim().slice(0, 400);
}

export interface Verdict {
    submissionId: string;
    verdict: string;
    passedTests?: string;
    timeMs?: string;
    memoryKb?: string;
    waiting: boolean;
}

/**
 * `_tta` is a weak anti-bot checksum Codeforces derives from the `39ce7`
 * cookie, client-side, on every form. cf-tool ships a constant ("594") and
 * Codeforces has tolerated that, but computing the real value is cheap and
 * matches what a browser sends. Falls back to the cf-tool constant when the
 * cookie is missing (e.g. a freshly imported session).
 */
function computeTta(cookie39ce7: string | undefined): string {
    if (!cookie39ce7) {
        return '594';
    }
    let e = 0;
    for (let n = 0; n < cookie39ce7.length; n++) {
        e = (e + (n + 1) * (n + 2) * cookie39ce7.charCodeAt(n)) % 1009;
        if (n % 3 === 0) {
            e++;
        }
        if (n % 2 === 0) {
            e *= 2;
        }
        if (n > 0) {
            e -= Math.trunc(cookie39ce7.charCodeAt(Math.trunc(n / 2)) / 2) * (e % 5);
        }
        e = ((e % 1009) + 1009) % 1009;
    }
    return String(e);
}

export async function fetchLanguages(session: Session, problem: Problem): Promise<Language[]> {
    const url = submitUrl(problem);
    let html: string;
    try {
        html = await session.http.get(url, { requireSession: true });
    } catch (err) {
        session.http.log(`[fetchLanguages] GET ${url} threw: ${(err as Error).message}`);
        throw err;
    }
    const langs = parseLanguages(html);
    session.http.log(`[fetchLanguages] GET ${url} -> ${html.length} chars, ${langs.length} language(s) parsed`);
    if (langs.length === 0) {
        const handle = Session.findHandle(html);
        session.http.log(
            `[fetchLanguages] no languages parsed; handle=${handle ?? '(none — looks signed out)'}; body: ${snippet(html)}`
        );
        if (!handle) {
            throw new Error(
                "Codeforces served a real page, but with no signed-in profile link — your session isn't being " +
                    'carried. If you\'re logged in through Chrome, try again (the companion may have fetched this ' +
                    'via its service worker instead of a page tab); otherwise re-run "Codeforces: Import session ' +
                    'from browser".'
            );
        }
        throw new Error(
            `No compiler list on the submit page, though you're signed in as ${handle} — you probably lack access ` +
                'to this contest (not started yet, or you are not registered).'
        );
    }
    return langs;
}

export async function submitSolution(
    session: Session,
    problem: Problem,
    source: string,
    programTypeId: string
): Promise<string> {
    const url = submitUrl(problem);
    const { html, csrf } = await session.pageWithCsrf(url, { requireSession: true });

    if (parseLanguages(html).length === 0) {
        throw new Error('Submit page did not load a compiler list — sign in again with "Codeforces: Log in".');
    }

    const { ftaa, bfaa } = session.fingerprint;
    const body = await session.http.post(
        `${url}?csrf_token=${csrf}`,
        {
            csrf_token: csrf,
            ftaa,
            bfaa,
            action: 'submitSolutionFormSubmitted',
            submittedProblemIndex: problem.index,
            programTypeId,
            contestId: String(problem.contestId),
            source,
            tabSize: '4',
            _tta: computeTta(session.http.exportCookies()['39ce7']),
            // sourceCodeConfirmed is Codeforces' "you have submitted exactly the
            // same code before" gate — without it an identical resubmission is
            // rejected with a confirmation prompt instead of going through.
            sourceCodeConfirmed: 'true'
        },
        url
    );
    // NOTE: the live submit form also carries a `turnstileToken` (Cloudflare
    // Turnstile) hidden field, populated by a browser-only challenge widget.
    // We cannot produce one headlessly. Submits may be rejected while
    // Codeforces enforces it; see LESSONS.md (2026-09-04).

    const $ = cheerio.load(body);
    const error = $('span.error').first().text().trim();
    if (error) {
        if (/identical/i.test(error)) {
            throw new Error('Codeforces rejected this as identical to your previous submission.');
        }
        throw new Error(error);
    }

    const id = $('table.status-frame-datatable tr[data-submission-id]')
        .first()
        .attr('data-submission-id');
    if (!id) {
        throw new Error('Submitted, but Codeforces did not return a submission id. Check the site to confirm.');
    }
    return id;
}

/**
 * Newest submission id for this problem by the signed-in user, read off the
 * status page (rows are newest-first). Used by the browser-relay path, which
 * never sees the submit response and has to discover the id after the fact.
 */
export async function latestSubmissionId(
    session: Session,
    problem: Problem
): Promise<string | undefined> {
    const html = await session.http.get(statusUrl(problem), { requireSession: true });
    const $ = cheerio.load(html);
    const wanted = new RegExp(`/problem/${problem.index}$`);
    let found: string | undefined;
    $('table.status-frame-datatable tr[data-submission-id]').each((_, row) => {
        if (found) {
            return;
        }
        const href = $(row).find('a[href*="/problem/"]').first().attr('href') ?? '';
        if (wanted.test(href)) {
            found = $(row).attr('data-submission-id');
        }
    });
    return found;
}

/** Status page for wherever the problem lives. */
function statusUrl(problem: Problem): string {
    if (problem.kind === 'gym') {
        return `https://codeforces.com/gym/${problem.contestId}/my`;
    }
    if (problem.kind === 'group') {
        return `https://codeforces.com/group/${problem.groupCode}/contest/${problem.contestId}/my`;
    }
    return `https://codeforces.com/contest/${problem.contestId}/my`;
}

const WAITING = /^(In queue|Running|Waiting|Testing|Pending)/i;

export async function fetchVerdict(
    session: Session,
    problem: Problem,
    submissionId: string
): Promise<Verdict> {
    const html = await session.http.get(statusUrl(problem), { requireSession: true });
    const $ = cheerio.load(html);
    const row = $(`tr[data-submission-id="${submissionId}"]`).first();
    if (row.length === 0) {
        return { submissionId, verdict: 'Not found yet', waiting: true };
    }
    const cells = row.find('td');
    const verdictCell = row.find('td.status-cell').first();
    const verdict = (verdictCell.length ? verdictCell.text() : $(cells[4]).text()).replace(/\s+/g, ' ').trim();
    const timeMs = $(cells[cells.length - 2]).text().trim();
    const memoryKb = $(cells[cells.length - 1]).text().trim();
    return {
        submissionId,
        verdict: verdict || 'Unknown',
        timeMs,
        memoryKb,
        waiting: WAITING.test(verdict) || verdict === ''
    };
}

/** Polls until the verdict settles or the budget runs out. */
export async function watchVerdict(
    session: Session,
    problem: Problem,
    submissionId: string,
    onUpdate: (v: Verdict) => void,
    maxMs = 180_000
): Promise<Verdict> {
    const deadline = Date.now() + maxMs;
    let last: Verdict = { submissionId, verdict: 'In queue', waiting: true };
    while (Date.now() < deadline) {
        try {
            last = await fetchVerdict(session, problem, submissionId);
        } catch (err) {
            last = { submissionId, verdict: `Could not read status: ${(err as Error).message}`, waiting: true };
        }
        onUpdate(last);
        if (!last.waiting) {
            return last;
        }
        // Each poll is a browser round-trip via the companion — keep it gentle.
        await new Promise((r) => setTimeout(r, 4000));
    }
    return last;
}
