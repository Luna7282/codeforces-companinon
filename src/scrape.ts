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
        return cached;
    }
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

    // Statement images are relative to the contest, so make them absolute.
    root.find('img').each((_, img) => {
        const src = $(img).attr('src');
        if (src && src.startsWith('/')) {
            $(img).attr('src', `https://codeforces.com${src}`);
        }
    });

    const detail: ProblemDetail = {
        statementHtml: root.html() ?? '',
        samples,
        timeLimit: timeLimit || undefined,
        memoryLimit: memoryLimit || undefined
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
