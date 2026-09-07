import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CodeforcesApi } from './api';
import {
    ensureSolutionFile,
    readMeta,
    updateMeta,
    appendAttempt,
    metaPath,
    solutionPath,
    ProblemMeta,
    Attempt
} from './files';
import { problemDetail } from './scrape';
import { Session } from './session';
import { showStatement } from './statement';
import { fetchLanguages, latestSubmissionId, submitSolution, watchVerdict } from './submit';
import { CodeforcesTree, CodeforcesNode } from './tree';
import { Contest, ContestKind, Language, Problem, Sample, problemUrl } from './types';
import { RelayServer } from './relay';
import { setCacheDir, clearCache } from './cache';
import { ResultsViewProvider, ResultsActions } from './resultsView';
import { failingTest, isAccepted } from './verdict';
import { showStats } from './statsView';
import { setArchiveRoot, hasArchiveRoot, rebuildIndex, writeRun, RunRecord } from './archive';
import { migrateOldLayout, hasOldLayout } from './migrate';
import {
    ArchiveTree,
    ArchiveContentProvider,
    ARCHIVE_SCHEME,
    openArchiveEntry,
    diffArchiveEntry,
    VERDICT_FILTERS,
    forceRebuild
} from './archiveView';
import { showWalkthrough } from './walkthrough';
import { DEFAULT_LANGUAGES, LanguagesConfig, extensionForLanguageName } from './languages';

let session: Session;
let api: CodeforcesApi;
let tree: CodeforcesTree;
let explorerTreeView: vscode.TreeView<CodeforcesNode>;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let langStatus: vscode.StatusBarItem;
let relay: RelayServer | undefined;
/** Set when another window of this same extension owns the relay port — see startRelay(). */
let remoteRelayPort: number | undefined;
let relayToken: string;
let resultsView: ResultsViewProvider;
let archiveView: ArchiveTree | undefined;
let archiveTreeView: vscode.TreeView<unknown> | undefined;
let panelFile: string | undefined;
let panelMeta: ProblemMeta | undefined;

const BANNER_DISMISSED_KEY = 'codeforces.setupBannerDismissed';

/**
 * `globalState.get()` then `.update()` is two steps with no atomicity across
 * processes. This extension activates in every window, so on a fresh install
 * two windows opening around the same time would both read "no token yet",
 * each mint their own, and both write — last write wins in storage, but the
 * window that lost the race keeps running its now-orphaned in-memory token
 * until its next reload, when it picks up whatever the *next* race happened
 * to leave behind. That's the "token keeps changing" bug: it only takes one
 * such race, ever, to leave two windows permanently disagreeing.
 *
 * `globalStorageUri` is a real file shared by every window on this profile,
 * so an exclusive create (`wx`) is atomic at the OS level: whichever window
 * gets there first wins, and every other window — now or on a later reload —
 * reads that same winning value back instead of minting its own.
 */
function loadOrCreateRelayToken(context: vscode.ExtensionContext): string {
    const dir = context.globalStorageUri.fsPath;
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'relay-token');
    // Seed from the old (racy) globalState value if one exists, so upgrading
    // to this fix doesn't itself force one more re-pair.
    const legacy = context.globalState.get<string>('codeforces.relayToken');
    const candidate = legacy && legacy.length === 32 ? legacy : crypto.randomBytes(16).toString('hex');
    try {
        fs.writeFileSync(file, candidate, { flag: 'wx' });
        return candidate;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw err;
        }
    }
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length === 32) {
        return existing;
    }
    // Empty/corrupt file (e.g. a crash mid-write) — nobody owns a valid value yet, reclaim it.
    fs.writeFileSync(file, candidate);
    return candidate;
}

function newRelayServer(): RelayServer {
    return new RelayServer(relayToken, (m) => dbg(`[relay] ${m}`), () => {
        void vscode.window
            .showWarningMessage(
                'Codeforces: the companion extension is using an old relay token. Re-pair it.',
                'Relay info'
            )
            .then((choice) => {
                if (choice === 'Relay info') {
                    void relayInfo();
                }
            });
    });
}

/**
 * True if whatever answered on `port` looks like this same extension's relay
 * (matches the /health shape) rather than an unrelated process that happens
 * to be squatting the port. EADDRINUSE alone can't tell those apart.
 */
async function isSiblingRelay(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (!res.ok) {
            return false;
        }
        const body = (await res.json()) as { tokenRequired?: unknown; protocolVersion?: unknown };
        return body.tokenRequired === true && typeof body.protocolVersion === 'number';
    } catch {
        return false;
    }
}

/**
 * The extension activates in every window, but the relay binds one shared
 * port — only one window can ever hold it. If EADDRINUSE turns out to be
 * another window of ours (confirmed via /health, never assumed), that isn't
 * a failure: that window's relay works and the companion is paired to it.
 * This window just remembers the port and leaves `relay` unset; deactivate()
 * on the owning window already frees the port, so the next ensureRelay()
 * call from any other window picks it up automatically — no explicit
 * handoff needed.
 */
async function startRelay(): Promise<void> {
    const port = vscode.workspace.getConfiguration('codeforces').get<number>('relayPort', 27121);
    const candidate = newRelayServer();
    try {
        await candidate.start(port);
        relay = candidate;
        remoteRelayPort = undefined;
        // Reads fall back to the companion when Cloudflare blocks direct Node fetch.
        session.http.setRelayFetcher((u, binary) => relay!.fetchViaCompanion(u, binary));
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE' && (await isSiblingRelay(port))) {
            relay = undefined;
            remoteRelayPort = port;
            dbg(`[relay] port ${port} is owned by another window of this extension — will take over if it closes`);
            return;
        }
        relay = undefined;
        remoteRelayPort = undefined;
        void vscode.window.showWarningMessage(
            `Codeforces: relay could not start on port ${port} (${(err as Error).message}). ` +
                'Browser submit and Cloudflare-blocked reads are unavailable until you free the port and reload.'
        );
    }
}

/** Call before anything that needs a working relay — retries claiming the port if this window doesn't own it yet. */
async function ensureRelay(): Promise<void> {
    if (relay?.running) {
        return;
    }
    await startRelay();
}

/** Accurate reason the relay isn't usable from THIS window right now, for callers that need a full sentence. */
function relayUnavailableMessage(): string {
    if (remoteRelayPort !== undefined) {
        return (
            `The browser relay is running in another VS Code window (port ${remoteRelayPort}). ` +
            'Submit from that window, or close it to let this window take over.'
        );
    }
    return (
        'The submit relay is not running. Reload the window, or set "codeforces.directSubmit" ' +
        'if Codeforces is not enforcing its Turnstile check.'
    );
}

export function activate(context: vscode.ExtensionContext): void {
    session = new Session(context.secrets);
    session.http.setLogger((m) => dbg(m));
    api = new CodeforcesApi(session.http);
    tree = new CodeforcesTree(
        session,
        api,
        () => Boolean(relay?.companionOnline),
        context.globalState.get<boolean>(BANNER_DISMISSED_KEY, false)
    );
    output = vscode.window.createOutputChannel('Codeforces');
    status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    langStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    context.subscriptions.push(output, status, langStatus);

    const resultsActions: ResultsActions = {
        runAll: () => void runTestsFor(panelFile, panelMeta),
        runOne: (i) => void runTestsFor(panelFile, panelMeta, i),
        addTest: (input, expected) => addUserTest(input, expected),
        deleteTest: (i) => deleteUserTest(i),
        submit: () => void submitFor(panelFile, panelMeta),
        pickLang: () => void vscode.commands.executeCommand('codeforces.pickLanguage'),
        showAttemptSource: (i) => void showAttemptSource(i)
    };
    resultsView = new ResultsViewProvider(context.extensionUri, resultsActions);

    archiveView = new ArchiveTree();
    archiveTreeView = vscode.window.createTreeView('codeforcesArchiveView', { treeDataProvider: archiveView });

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ResultsViewProvider.viewType, resultsView),
        archiveTreeView,
        vscode.workspace.registerTextDocumentContentProvider(ARCHIVE_SCHEME, new ArchiveContentProvider()),
        vscode.commands.registerCommand('codeforces.archiveOpenEntry', (n) => void openArchiveEntry(n)),
        vscode.commands.registerCommand('codeforces.archiveDiff', (n) => void diffArchiveEntry(n)),
        vscode.commands.registerCommand('codeforces.archiveRefresh', () => {
            forceRebuild();
            archiveView?.refresh();
        }),
        vscode.commands.registerCommand('codeforces.archiveFilter', archiveFilter),
        vscode.commands.registerCommand('codeforces.archiveSearch', archiveSearch),
        vscode.window.onDidChangeActiveTextEditor(() => syncActiveProblem()),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('codeforces.languages')) {
                syncActiveProblem();
            }
        })
    );

    void session.load();
    setCacheDir(context.globalStorageUri.fsPath);
    void initArchiveRoot();

    relayToken = loadOrCreateRelayToken(context);
    void startRelay();

    explorerTreeView = vscode.window.createTreeView('codeforcesExplorer', { treeDataProvider: tree });

    context.subscriptions.push(
        explorerTreeView,
        vscode.commands.registerCommand('codeforces.refresh', () => {
            clearCache();
            api.invalidate();
            tree.refresh();
            forceRebuild();
            archiveView?.refresh();
        }),
        // Refresh above already clears this same disk cache (statements included —
        // see LESSONS.md, "Statement images"); this is a dedicated, visible action
        // for when the cache itself is the thing being debugged, since Refresh's
        // effect is otherwise silent and easy to mistake for "did nothing".
        vscode.commands.registerCommand('codeforces.clearCache', () => {
            clearCache();
            api.invalidate();
            void vscode.window.showInformationMessage(
                'Codeforces: cache cleared. Re-open any already-open problem to re-fetch its statement — ' +
                    'clearing the cache does not refresh a panel that is already showing one.'
            );
        }),
        vscode.commands.registerCommand('codeforces.login', login),
        vscode.commands.registerCommand('codeforces.importSession', importSession),
        vscode.commands.registerCommand('codeforces.logout', logout),
        vscode.commands.registerCommand('codeforces.addGroup', addGroup),
        vscode.commands.registerCommand('codeforces.removeGroup', removeGroup),
        vscode.commands.registerCommand('codeforces.openProblem', openProblem),
        vscode.commands.registerCommand('codeforces.openInBrowser', openInBrowser),
        vscode.commands.registerCommand('codeforces.runTests', runTests),
        vscode.commands.registerCommand('codeforces.submit', submit),
        vscode.commands.registerCommand('codeforces.pickLanguage', pickLanguage),
        vscode.commands.registerCommand('codeforces.lastVerdict', () => output.show()),
        vscode.commands.registerCommand('codeforces.relayInfo', relayInfo),
        vscode.commands.registerCommand('codeforces.checkCompanion', checkCompanion),
        vscode.commands.registerCommand('codeforces.stats', () => showStats(context.extensionUri)),
        vscode.commands.registerCommand('codeforces.changeWorkspace', () => changeWorkspaceFolder()),
        vscode.commands.registerCommand('codeforces.setupWalkthrough', () =>
            showWalkthrough(relay ? { running: relay.running, port: relay.port } : undefined)
        ),
        vscode.commands.registerCommand('codeforces.dismissSetupBanner', () => {
            tree.dismissBanner();
            void context.globalState.update(BANNER_DISMISSED_KEY, true);
        }),
        vscode.window.registerUriHandler({ handleUri: (uri) => void handleDeepLink(uri) })
    );

    syncActiveProblem();
}

// ---- workspace root: picked once, stored globally, follows the user ---------

function pickFolder(title: string): Thenable<string | undefined> {
    return vscode.window
        .showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            canSelectMany: false,
            openLabel: 'Use this folder',
            title
        })
        .then((uris) => uris?.[0]?.fsPath);
}

/** Activation: adopt a previously-chosen folder if there is one. No prompt — the
 *  tree browses fine through /api/* with nothing configured. */
async function initArchiveRoot(): Promise<void> {
    const root = vscode.workspace.getConfiguration('codeforces').get<string>('workspaceRoot', '').trim();
    if (!root || !fs.existsSync(root)) {
        return;
    }
    setArchiveRoot(root);
    await runMigrationIfNeeded(root);
    tree.refresh();
    archiveView?.refresh();
    syncActiveProblem();
}

/** Ensure a workspace folder is set, prompting the first time it's actually needed. */
async function ensureRootInteractive(): Promise<boolean> {
    if (hasArchiveRoot()) {
        return true;
    }
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const configured = cfg.get<string>('workspaceRoot', '').trim();
    if (configured && fs.existsSync(configured)) {
        setArchiveRoot(configured);
        await runMigrationIfNeeded(configured);
        return true;
    }
    const choice = await vscode.window.showInformationMessage(
        'Pick a folder for your Codeforces solutions, run logs and submission archive. It is stored globally and used from now on.',
        'Choose folder…',
        'Cancel'
    );
    if (choice !== 'Choose folder…') {
        return false;
    }
    const chosen = await pickFolder('Codeforces workspace folder');
    if (!chosen) {
        return false;
    }
    await cfg.update('workspaceRoot', chosen, vscode.ConfigurationTarget.Global);
    setArchiveRoot(chosen);
    await runMigrationIfNeeded(chosen);
    tree.refresh();
    archiveView?.refresh();
    syncActiveProblem();
    return true;
}

async function runMigrationIfNeeded(root: string): Promise<void> {
    const candidates = [root, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)];
    if (!hasOldLayout(candidates)) {
        return;
    }
    const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Codeforces: migrating existing solutions…' },
        async () => migrateOldLayout(candidates)
    );
    output.appendLine(
        `[migrate] ${report.migrated} problems, ${report.attemptsPreserved} attempts preserved, ` +
            `${report.skipped} skipped` + (report.errors.length ? `, ${report.errors.length} errors` : '')
    );
    for (const e of report.errors) {
        output.appendLine(`[migrate]   ${e}`);
    }
    if (report.migrated > 0 || report.errors.length > 0) {
        output.show(true);
        const msg =
            `Codeforces: migrated ${report.migrated} problem${report.migrated === 1 ? '' : 's'} ` +
            `(${report.attemptsPreserved} attempt${report.attemptsPreserved === 1 ? '' : 's'} preserved) into ${root}/codeforces.` +
            (report.errors.length ? ` ${report.errors.length} left in place — see the Codeforces output channel.` : '');
        report.errors.length
            ? void vscode.window.showWarningMessage(msg)
            : void vscode.window.showInformationMessage(msg);
    }
}

async function changeWorkspaceFolder(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const oldRoot = cfg.get<string>('workspaceRoot', '').trim();
    const chosen = await pickFolder('New Codeforces workspace folder');
    if (!chosen || chosen === oldRoot) {
        return;
    }

    const oldContent = oldRoot && fs.existsSync(path.join(oldRoot, 'codeforces'));
    let move = false;
    if (oldContent) {
        const a = await vscode.window.showInformationMessage(
            `Move your existing Codeforces content from "${oldRoot}" into "${chosen}"? ` +
                'Choosing "Leave it" orphans the old folder.',
            { modal: true },
            'Move',
            'Leave it'
        );
        if (a === undefined) {
            return; // cancelled
        }
        move = a === 'Move';
    }

    if (move) {
        try {
            fs.cpSync(path.join(oldRoot, 'codeforces'), path.join(chosen, 'codeforces'), { recursive: true });
            const oldIdx = path.join(oldRoot, '.archive-index.json');
            if (fs.existsSync(oldIdx)) {
                fs.copyFileSync(oldIdx, path.join(chosen, '.archive-index.json'));
            }
            // verify a marker file made it before deleting the source
            fs.rmSync(path.join(oldRoot, 'codeforces'), { recursive: true, force: true });
            fs.rmSync(oldIdx, { force: true });
        } catch (err) {
            void vscode.window.showErrorMessage(
                `Codeforces: could not move content (${(err as Error).message}). The setting was not changed.`
            );
            return;
        }
    }

    await cfg.update('workspaceRoot', chosen, vscode.ConfigurationTarget.Global);
    setArchiveRoot(chosen);
    rebuildIndex();
    panelFile = undefined;
    panelMeta = undefined;
    tree.refresh();
    archiveView?.refresh();
    void vscode.window.showInformationMessage(
        `Codeforces workspace is now ${chosen}${move ? ' (content moved)' : ''}.`
    );
}

function allLanguages(): LanguagesConfig {
    return vscode.workspace.getConfiguration('codeforces').get<LanguagesConfig>('languages', {});
}

/** The Codeforces compiler name last picked for `ext` (e.g. "GNU G++20"), if any. */
function languageNameFor(ext: string): string | undefined {
    const n = (allLanguages()[ext]?.programTypeName ?? DEFAULT_LANGUAGES[ext]?.programTypeName ?? '').trim();
    return n || undefined;
}

/** Merge-updates just `ext`'s entry in codeforces.languages — never clobbers other extensions. */
async function setLanguageName(ext: string, programTypeName: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const languages = { ...allLanguages() };
    languages[ext] = { ...DEFAULT_LANGUAGES[ext], ...languages[ext], programTypeName };
    await cfg.update('languages', languages, vscode.ConfigurationTarget.Global);
}

/** Point the Results panel + language status bar at the active solution file. */
function syncActiveProblem(): void {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') {
        return; // focus went to a webview/panel — leave the panel showing what it had
    }
    const file = ed.document.uri.fsPath;
    const meta = readMeta(file);
    if (!meta) {
        langStatus.hide();
        return;
    }
    const lang = languageNameFor(path.extname(file));
    langStatus.text = `$(gear) ${lang ?? 'CF: set language'} $(chevron-down)`;
    langStatus.tooltip = 'Codeforces submission language for this file — click to change';
    langStatus.command = 'codeforces.pickLanguage';
    langStatus.show();

    if (file === panelFile) {
        panelMeta = meta; // pick up on-disk changes (e.g. custom tests)
        resultsView.setLang(path.basename(file), lang);
    } else {
        setPanelProblem(file, meta);
    }
}

function setPanelProblem(file: string, meta: ProblemMeta): void {
    panelFile = file;
    panelMeta = meta;
    resultsView.setContext(
        { index: meta.problem.index, name: meta.problem.name, url: meta.url },
        meta.samples,
        meta.userTests ?? [],
        meta.attempts ?? [],
        path.basename(file),
        languageNameFor(path.extname(file))
    );
}

async function showAttemptSource(origIndex: number): Promise<void> {
    const a = panelMeta?.attempts?.[origIndex];
    if (!a || !panelFile) {
        return;
    }
    const lang = languageIdFor(panelFile);
    const past = await vscode.workspace.openTextDocument({ content: a.source, language: lang });
    const title = `${new Date(a.at).toLocaleString()} · ${a.verdict}  ↔  current`;
    await vscode.commands.executeCommand('vscode.diff', past.uri, vscode.Uri.file(panelFile), title, {
        viewColumn: vscode.ViewColumn.Beside
    });
}

function languageIdFor(file: string): string | undefined {
    const ext = path.extname(file).toLowerCase();
    return (
        {
            '.cpp': 'cpp',
            '.cc': 'cpp',
            '.cxx': 'cpp',
            '.c': 'c',
            '.py': 'python',
            '.java': 'java',
            '.rs': 'rust',
            '.go': 'go',
            '.js': 'javascript',
            '.ts': 'typescript',
            '.kt': 'kotlin'
        } as Record<string, string>
    )[ext];
}

async function saveDoc(file: string): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === file);
    if (doc?.isDirty) {
        await doc.save();
    }
}

async function runTestsFor(
    file: string | undefined,
    meta: ProblemMeta | undefined,
    onlyIndex?: number
): Promise<void> {
    if (!file || !meta) {
        activeMeta('runTests');
        return;
    }
    await saveDoc(file);
    const tests: Sample[] = [...meta.samples, ...(meta.userTests ?? [])];
    if (tests.length === 0) {
        void vscode.window.showInformationMessage('Codeforces: no samples or custom tests to run.');
        return;
    }
    const { compile, runSamples } = await import('./runner');
    const dir = path.dirname(file);
    const source = fs.readFileSync(file, 'utf8');
    const label = (i: number): string =>
        i < meta.samples.length ? `Sample ${i + 1}` : `Custom ${i - meta.samples.length + 1}`;

    resultsView.setRunning(onlyIndex === undefined ? tests.map((_, i) => i) : [onlyIndex]);
    resultsView.setBusy(true);

    const language = path.extname(file);
    let compileOutput = '';
    try {
        compileOutput = await compile(file);
    } catch (err) {
        const msg = (err as Error).message;
        resultsView.setError('Compilation failed', msg);
        recordRun(dir, { at: Date.now(), source, language, compileOk: false, compileOutput: msg, tests: [] });
        return;
    }
    try {
        const indices = onlyIndex === undefined ? tests.map((_, i) => i) : [onlyIndex];
        const results = await runSamples(file, indices.map((i) => tests[i]));
        if (onlyIndex === undefined) {
            resultsView.setAllResults(results);
        } else {
            results[0].index = onlyIndex + 1;
            resultsView.setResult(onlyIndex, results[0]);
            resultsView.setBusy(false);
        }
        recordRun(dir, {
            at: Date.now(),
            source,
            language,
            compileOk: true,
            compileOutput: compileOutput || undefined,
            tests: results.map((r, k) => ({
                label: label(indices[k]),
                outcome: r.outcome,
                ms: r.ms,
                expected: r.expected,
                actual: r.actual,
                stderr: r.stderr
            }))
        });
    } catch (err) {
        resultsView.setError('Could not run tests', (err as Error).message);
    }
}

function recordRun(dir: string, rec: RunRecord): void {
    try {
        writeRun(dir, rec);
        archiveView?.refresh();
    } catch {
        /* archiving a run must never break the run itself */
    }
}

async function archiveFilter(): Promise<void> {
    if (!archiveView) {
        return;
    }
    const pick = await vscode.window.showQuickPick(VERDICT_FILTERS, { title: 'Filter archive by verdict' });
    if (pick === undefined) {
        return;
    }
    archiveView.filterCategory = pick === 'All' ? undefined : pick;
    updateArchiveDescription();
    archiveView.refresh();
}

async function archiveSearch(): Promise<void> {
    if (!archiveView) {
        return;
    }
    const text = await vscode.window.showInputBox({
        title: 'Search archive by problem name',
        value: archiveView.search ?? '',
        prompt: 'Leave empty to clear'
    });
    if (text === undefined) {
        return;
    }
    archiveView.search = text.trim() || undefined;
    updateArchiveDescription();
    archiveView.refresh();
}

function updateArchiveDescription(): void {
    if (!archiveTreeView || !archiveView) {
        return;
    }
    const bits = [
        archiveView.filterCategory ? `verdict: ${archiveView.filterCategory}` : '',
        archiveView.search ? `“${archiveView.search}”` : ''
    ].filter(Boolean);
    archiveTreeView.description = bits.join('  ·  ') || undefined;
}

function addUserTest(input: string, expected: string): void {
    if (!panelFile || !panelMeta || (!input.trim() && !expected.trim())) {
        return;
    }
    const userTests: Sample[] = [...(panelMeta.userTests ?? []), { input, output: expected }];
    const next = updateMeta(panelFile, { userTests });
    if (next) {
        panelMeta = next;
        resultsView.setTests(next.samples, next.userTests ?? []);
    }
}

function deleteUserTest(customIndex: number): void {
    if (!panelFile || !panelMeta?.userTests) {
        return;
    }
    const userTests = panelMeta.userTests.filter((_, i) => i !== customIndex);
    const next = updateMeta(panelFile, { userTests });
    if (next) {
        panelMeta = next;
        resultsView.setTests(next.samples, next.userTests ?? []);
    }
}

async function checkCompanion(): Promise<void> {
    await ensureRelay();
    if (!relay?.running) {
        if (remoteRelayPort !== undefined) {
            void vscode.window.showInformationMessage(
                `Codeforces: another VS Code window is running the browser relay, on port ${remoteRelayPort}. ` +
                    'Submit and browser-relay reads work from that window; this one will take over automatically ' +
                    'once it closes.'
            );
        } else {
            void vscode.window.showWarningMessage(
                'Codeforces: the relay is not running in this window. Run "Developer: Reload Window".'
            );
        }
        return;
    }
    // Ping our own /health so a totally dead port is obvious in the log.
    let healthOk = false;
    try {
        const res = await fetch(`http://127.0.0.1:${relay.port}/health`);
        healthOk = res.ok;
    } catch {
        healthOk = false;
    }

    const status = relay.companionStatus;
    const seen = relay.companionEverSeen;
    let message: string;
    if (relay.companionError) {
        message = `Companion reported a problem: ${relay.companionError}`;
    } else if (status === 'online') {
        message = `Companion is polling on 127.0.0.1:${relay.port}. All good.`;
    } else if (status === 'auth-rejected') {
        message =
            'Companion is running but its relay token is wrong. Run "Codeforces: Relay info" and re-paste ' +
            'the port and token into the companion options.';
    } else if (seen) {
        message =
            'Companion has gone quiet — its background service worker is asleep (Chrome suspends MV3 workers ' +
            'after ~30s idle). It should wake within ~30s on its own; to wake it now, open chrome://extensions ' +
            'and click the companion\'s "service worker" link.';
    } else {
        message =
            'No companion has connected to this window. In Chrome: chrome://extensions → Load unpacked → the ' +
            'browser/ folder, then set its options from "Codeforces: Relay info".';
    }
    dbg(
        `[check companion] health=${healthOk ? 'ok' : 'DOWN'} status=${status} everSeen=${seen} ` +
            `port=${relay.port} pending=${relay.pendingCount}`
    );
    void vscode.window.showInformationMessage(`Codeforces: ${message}`);
}

export function deactivate(): void {
    // The session lives in SecretStorage; only the relay socket needs closing.
    relay?.stop();
    relay = undefined;
}

async function relayInfo(): Promise<void> {
    await ensureRelay();
    if (!relay?.running) {
        if (remoteRelayPort !== undefined) {
            void vscode.window.showWarningMessage(
                `Codeforces: the browser relay is running in another VS Code window (port ${remoteRelayPort}), ` +
                    'not this one. Run "Relay info" from that window instead, or close it to let this window ' +
                    'take over.'
            );
        } else {
            void vscode.window.showWarningMessage('Codeforces: the submit relay is not running. Reload the window.');
        }
        return;
    }
    // One paste-able "port:token" string — the companion's options page
    // accepts this in a single field and splits it, so there's exactly one
    // clipboard round-trip instead of two separate copy actions.
    await vscode.env.clipboard.writeText(`${relay.port}:${relay.token}`);
    void vscode.window.showInformationMessage(
        `Codeforces: copied "${relay.port}:${relay.token}" — paste it into the companion's "Paste from Relay info" field.`
    );
}

/** Verbose tracing — only reaches the output channel when codeforces.debug is on. */
function dbg(msg: string): void {
    if (vscode.workspace.getConfiguration('codeforces').get<boolean>('debug', false)) {
        output.appendLine(msg);
    }
}

function fail(err: unknown): void {
    void vscode.window.showErrorMessage(`Codeforces: ${(err as Error).message}`);
}

/** True when an error means "this needs the companion browser extension". */
function needsCompanion(err: unknown): boolean {
    const m = (err as Error)?.message ?? '';
    return /companion extension|blocking direct requests|Cloudflare challenge in the browser|open codeforces\.com in Chrome/i.test(
        m
    );
}

/** Offer the setup walkthrough instead of a bare error, when an action needs the companion. */
async function promptCompanion(action: string): Promise<void> {
    const online = Boolean(relay?.companionOnline);
    const pick = await vscode.window.showInformationMessage(
        `${action} needs the companion browser extension — Codeforces blocks the extension's own requests behind Cloudflare. ` +
            (online
                ? 'The companion is connected but could not fetch the page; make sure a codeforces.com tab is open and past the "Just a moment" check.'
                : 'It runs in Chrome and reads pages in a tab you are already signed in to.'),
        'Setup walkthrough',
        'Not now'
    );
    if (pick === 'Setup walkthrough') {
        void vscode.commands.executeCommand('codeforces.setupWalkthrough');
    }
}

async function login(): Promise<void> {
    const handleOrEmail = await vscode.window.showInputBox({
        prompt: 'Codeforces handle or email',
        ignoreFocusOut: true
    });
    if (!handleOrEmail) {
        return;
    }
    const password = await vscode.window.showInputBox({
        prompt: 'Password',
        password: true,
        ignoreFocusOut: true
    });
    if (!password) {
        return;
    }
    try {
        const handle = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Signing in to Codeforces' },
            () => session.login(handleOrEmail, password)
        );
        await vscode.workspace
            .getConfiguration('codeforces')
            .update('handle', handle, vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(`Signed in as ${handle}.`);
        tree.refresh();
    } catch (err) {
        fail(err);
    }
}

async function importSession(): Promise<void> {
    const cfClearance = await vscode.window.showInputBox({
        prompt: 'cf_clearance cookie value  (Chrome: F12 → Application → Cookies → https://codeforces.com)',
        password: true,
        ignoreFocusOut: true
    });
    if (!cfClearance) {
        return;
    }
    const jsessionId = await vscode.window.showInputBox({
        prompt: 'JSESSIONID cookie value  (same place)',
        password: true,
        ignoreFocusOut: true
    });
    if (!jsessionId) {
        return;
    }
    const userAgent = await vscode.window.showInputBox({
        prompt: 'Browser User-Agent — paste exactly  (DevTools console: navigator.userAgent)',
        ignoreFocusOut: true
    });
    if (!userAgent) {
        return;
    }
    const expiryRaw = await vscode.window.showInputBox({
        prompt: 'cf_clearance "Expires" from DevTools (optional — Enter to skip)',
        placeHolder: '2026-09-04T15:30:00Z  or a Unix timestamp',
        ignoreFocusOut: true
    });
    const clearanceExpiry = parseExpiry(expiryRaw);

    try {
        const handle = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Importing browser session' },
            () => session.importBrowserSession({ cfClearance, jsessionId, userAgent, clearanceExpiry })
        );
        const window_ = clearanceExpiry
            ? `Clearance valid until ${new Date(clearanceExpiry).toLocaleString()} ` +
              `(~${Math.max(0, Math.round((clearanceExpiry - Date.now()) / 60000))} min).`
            : 'Clearance expiry unknown — cf_clearance usually lasts 30–60 min.';

        // Diagnostic: raw GET /enter so we can see exactly where it stands.
        const diag = await session.diagnoseEnter().catch((e) => ({ error: (e as Error).message }));
        output.appendLine('');
        output.appendLine('--- Import session diagnostic: GET https://codeforces.com/enter ---');
        output.appendLine(JSON.stringify(diag, null, 2));
        output.show(true);

        if (handle) {
            await vscode.workspace
                .getConfiguration('codeforces')
                .update('handle', handle, vscode.ConfigurationTarget.Global);
            void vscode.window.showInformationMessage(`Imported Codeforces session for ${handle}. ${window_}`);
        } else if ('verdict' in diag && diag.verdict === 'cloudflare-interstitial') {
            void vscode.window.showErrorMessage(
                'Still hitting a Cloudflare interstitial with the cookie set — the request is being blocked before ' +
                    'Codeforces sees it (Node TLS fingerprint). The session import cannot get past this. ' +
                    'See the Codeforces output channel.'
            );
        } else if ('verdict' in diag && diag.verdict === 'through-but-signed-out') {
            void vscode.window.showWarningMessage(
                'Through Cloudflare, but Codeforces shows the login form — the cookie set is incomplete ' +
                    '(JSESSIONID alone is not the whole session). See the Codeforces output channel.'
            );
        } else {
            void vscode.window.showWarningMessage(
                `Session stored but the handle could not be confirmed. Check the Codeforces output channel. ${window_}`
            );
        }
        tree.refresh();
    } catch (err) {
        fail(err);
    }
}

/** Accepts an ISO date, an epoch-seconds or epoch-ms value; returns epoch ms. */
function parseExpiry(raw: string | undefined): number | undefined {
    if (!raw || !raw.trim()) {
        return undefined;
    }
    const s = raw.trim();
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) {
        return n > 1e12 ? n : n * 1000;
    }
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? undefined : parsed;
}

async function logout(): Promise<void> {
    await session.logout();
    tree.refresh();
    void vscode.window.showInformationMessage('Signed out of Codeforces.');
}

/** Adds a group code to `codeforces.groups` if it isn't there already. Returns whether it was newly added. */
async function ensureGroupAdded(code: string): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const groups = cfg.get<string[]>('groups', []);
    if (groups.includes(code)) {
        return false;
    }
    await cfg.update('groups', [...groups, code], vscode.ConfigurationTarget.Global);
    tree.refresh();
    if (!relay?.companionOnline) {
        void promptCompanion('Reading a group’s contests');
    }
    return true;
}

async function addGroup(): Promise<void> {
    const input = await vscode.window.showInputBox({
        prompt: 'Group code or group URL',
        placeHolder: 'https://codeforces.com/group/xxxxxxxx/contests',
        ignoreFocusOut: true
    });
    if (!input) {
        return;
    }
    const match = /group\/([A-Za-z0-9]+)/.exec(input);
    const code = (match ? match[1] : input).trim();
    await ensureGroupAdded(code);
}

async function removeGroup(node?: { groupCode?: string }): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const groups = cfg.get<string[]>('groups', []);
    const code = node?.groupCode ?? (await vscode.window.showQuickPick(groups, { title: 'Remove group' }));
    if (!code) {
        return;
    }
    await cfg.update(
        'groups',
        groups.filter((g) => g !== code),
        vscode.ConfigurationTarget.Global
    );
    tree.refresh();
}

const DEEPLINK_KINDS: ContestKind[] = ['contest', 'gym', 'group'];

/** Brings the Explorer view forward with a contest/group/section node expanded and selected. */
async function revealNode(node: CodeforcesNode): Promise<void> {
    try {
        await explorerTreeView.reveal(node, { select: true, focus: true, expand: true });
    } catch {
        // The node isn't in the tree yet (e.g. a fresh group with no cached
        // contests) — refreshing and focusing the view is still useful.
        tree.refresh();
        await vscode.commands.executeCommand('codeforcesExplorer.focus');
    }
}

/**
 * Handles vscode://<publisher>.<name>/openProblem, /openContest, /openGroup and
 * /openProblemset — sent by the companion (a per-problem button, and the
 * toolbar icon for any Codeforces page; browser/content.js and background.js).
 * The URI itself is never hardcoded there either; both sides derive it from
 * this extension's own package.json (scripts/gen-companion-config.js).
 */
async function handleDeepLink(uri: vscode.Uri): Promise<void> {
    const q = new URLSearchParams(uri.query);

    // The companion's fallback-to-Marketplace decision hinges on this landing
    // here at all — ack immediately, before any slow statement fetch, so a
    // successful open never races the companion's short poll window.
    const ackId = q.get('ackId');
    if (ackId) {
        relay?.reportDeepLinkAck(ackId);
    }

    if (uri.path === '/openProblem') {
        const kind = q.get('kind');
        const contestId = Number(q.get('contestId'));
        const index = q.get('index');
        if (!kind || !DEEPLINK_KINDS.includes(kind as ContestKind) || !Number.isFinite(contestId) || !index) {
            void vscode.window.showWarningMessage('Codeforces: could not open that link — it looks malformed.');
            return;
        }
        const problem: Problem = {
            contestId,
            index,
            name: q.get('name')?.trim() || index,
            kind: kind as ContestKind,
            groupCode: q.get('groupCode') || undefined
        };
        await openProblem(problem);
        await revealNode({ type: 'problem', problem, state: 'untouched', attempts: 0 });
        return;
    }

    if (uri.path === '/openContest') {
        const kind = q.get('kind');
        const contestId = Number(q.get('contestId'));
        if (!kind || !DEEPLINK_KINDS.includes(kind as ContestKind) || !Number.isFinite(contestId)) {
            void vscode.window.showWarningMessage('Codeforces: could not open that link — it looks malformed.');
            return;
        }
        const groupCode = q.get('groupCode') || undefined;
        if (kind === 'group' && groupCode) {
            await ensureGroupAdded(groupCode);
        }
        const contest: Contest = { id: contestId, name: '', kind: kind as ContestKind, groupCode };
        await revealNode({ type: 'contest', contest });
        return;
    }

    if (uri.path === '/openGroup') {
        const groupCode = q.get('groupCode');
        if (!groupCode) {
            void vscode.window.showWarningMessage('Codeforces: could not open that link — it looks malformed.');
            return;
        }
        await ensureGroupAdded(groupCode);
        await revealNode({ type: 'group', groupCode });
        return;
    }

    if (uri.path === '/openProblemset') {
        await revealNode({ type: 'section', id: 'problemset', label: 'Problemset' });
    }
}

async function openProblem(problem: Problem): Promise<void> {
    if (!(await ensureRootInteractive())) {
        return;
    }
    try {
        const detail = await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: `Loading ${problem.index}` },
            () => problemDetail(session.http, problemUrl(problem))
        );
        // The statement page's own title is authoritative — a deep link from
        // the companion may only have carried the index (see LESSONS.md).
        if (detail.name) {
            problem = { ...problem, name: detail.name };
        }
        // Preserve any custom tests / attempt history already stored for this problem.
        const prev = readMeta(solutionPath(problem));
        const meta: ProblemMeta = {
            problem,
            samples: detail.samples,
            url: problemUrl(problem),
            userTests: prev?.userTests,
            attempts: prev?.attempts
        };
        const file = ensureSolutionFile(problem, meta);
        const doc = await vscode.workspace.openTextDocument(file);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        showStatement(problem, detail);
        setPanelProblem(file, meta);
    } catch (err) {
        if (needsCompanion(err)) {
            void promptCompanion('Loading a problem statement');
        } else {
            fail(err);
        }
    }
}

function openInBrowser(node: { problem?: Problem } | Problem): void {
    const problem = 'problem' in node && node.problem ? node.problem : (node as Problem);
    void vscode.env.openExternal(vscode.Uri.parse(problemUrl(problem)));
}

function activeMeta(context: string): { file: string; meta: ProblemMeta } | undefined {
    dbg(`[${context}] invoked`);
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        dbg(`[${context}] no active text editor (a webview / the Output panel doesn't count)`);
        void vscode.window.showWarningMessage(
            'Codeforces: no active editor. Click into the solution file’s editor tab first — the statement webview and the Output panel don’t count.'
        );
        return undefined;
    }
    if (editor.document.uri.scheme !== 'file') {
        dbg(`[${context}] active doc scheme is "${editor.document.uri.scheme}", not "file"`);
        void vscode.window.showWarningMessage(
            `Codeforces: the focused document isn’t a saved file (it’s "${editor.document.uri.scheme}"). Save it, or open the problem from the Codeforces view.`
        );
        return undefined;
    }
    const file = editor.document.uri.fsPath;
    const meta = readMeta(file);
    if (!meta) {
        const where = metaPath(file);
        // Keep this one unconditional — it's the "why did nothing happen" help.
        output.appendLine(`[${context}] "${file}" is not linked to a problem`);
        output.appendLine(`[${context}]   looked for metadata at: ${where} (exists: ${fs.existsSync(where)})`);
        output.show(true);
        void vscode.window.showWarningMessage(
            `Codeforces: "${vscode.workspace.asRelativePath(file)}" isn’t linked to a problem ` +
                `(no metadata at ${path.basename(where)} in that folder). Open the problem from the Codeforces view — ` +
                'that creates the file and its metadata — then run this on that file. See the Codeforces output channel.'
        );
        return undefined;
    }
    dbg(`[${context}] linked to ${meta.problem.index} — ${meta.problem.name}`);
    return { file, meta };
}

async function runTests(): Promise<void> {
    const found = activeMeta('runTests');
    if (!found) {
        return;
    }
    if (found.file !== panelFile) {
        setPanelProblem(found.file, found.meta);
    } else {
        panelMeta = found.meta;
    }
    await runTestsFor(found.file, panelMeta);
}

/** Raw compiler QuickPick, no side effects — shared by pickLanguage() and resolveProgramTypeId(). */
async function promptForLanguage(langs: Language[]): Promise<{ id: string; name: string } | undefined> {
    const choice = await vscode.window.showQuickPick(
        langs.map((l) => ({ label: l.name, id: l.id })),
        { title: 'Submission language' }
    );
    return choice ? { id: choice.id, name: choice.label } : undefined;
}

/**
 * The status-bar / command-palette "change language" action. If the picked
 * compiler maps to a DIFFERENT extension than the active file, that's a
 * language switch for the problem: scaffold that language's file (never
 * overwriting one that already exists) and switch focus to it, leaving the
 * original untouched. Picking a compiler for the SAME extension just updates
 * the remembered name.
 */
async function pickLanguage(): Promise<string | undefined> {
    const found = activeMeta('pickLanguage');
    if (!found) {
        return undefined;
    }
    try {
        const langs = await fetchLanguages(session, found.meta.problem);
        const picked = await promptForLanguage(langs);
        if (!picked) {
            return undefined;
        }
        const currentExt = path.extname(found.file);
        const targetExt = extensionForLanguageName(picked.name) ?? currentExt;

        if (targetExt !== currentExt) {
            const newFile = ensureSolutionFile(found.meta.problem, found.meta, targetExt);
            const doc = await vscode.workspace.openTextDocument(newFile);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }

        await setLanguageName(targetExt, picked.name);
        return picked.id;
    } catch (err) {
        fail(err);
        return undefined;
    }
}

/**
 * Quiet resolution used by submit: a Codeforces compiler id for `file`'s own
 * language, never switching files. Prefers the name already remembered for
 * this extension, re-matched against THIS problem's own compiler list since
 * a numeric id from one contest is not valid on another; prompts only when
 * there's no remembered name yet, or it no longer matches.
 */
async function resolveProgramTypeId(file: string, problem: Problem): Promise<string | undefined> {
    const ext = path.extname(file);
    let langs: Language[];
    try {
        langs = await fetchLanguages(session, problem);
    } catch (err) {
        fail(err);
        return undefined;
    }
    const savedName = languageNameFor(ext);
    const match = savedName ? langs.find((l) => l.name === savedName) : undefined;
    if (match) {
        return match.id;
    }
    const picked = await promptForLanguage(langs);
    if (!picked) {
        return undefined;
    }
    await setLanguageName(ext, picked.name);
    return picked.id;
}

async function submit(): Promise<void> {
    const found = activeMeta('submit');
    if (!found) {
        return;
    }
    if (found.file !== panelFile) {
        setPanelProblem(found.file, found.meta);
    } else {
        panelMeta = found.meta;
    }
    await submitFor(found.file, panelMeta);
}

async function submitFor(file: string | undefined, meta: ProblemMeta | undefined): Promise<void> {
    if (!file || !meta) {
        activeMeta('submit');
        return;
    }
    await saveDoc(file);

    const programTypeId = await resolveProgramTypeId(file, meta.problem);
    if (!programTypeId) {
        return;
    }

    const source = fs.readFileSync(file, 'utf8');
    if (!source.trim()) {
        void vscode.window.showWarningMessage('The file is empty.');
        return;
    }
    const cfg = vscode.workspace.getConfiguration('codeforces');
    const language = languageNameFor(path.extname(file)) ?? programTypeId;
    const record = (verdict: string, extra?: Partial<Attempt>): void => {
        const next = appendAttempt(file, {
            at: Date.now(),
            verdict,
            failingTest: failingTest(verdict),
            language,
            source,
            ...extra
        });
        if (next && file === panelFile) {
            panelMeta = next;
            resultsView.setAttempts(next.attempts ?? []);
        }
        tree.markSolveState(meta.problem, isAccepted(verdict) ? 'solved' : 'attempted');
        archiveView?.refresh();
    };

    // Direct POST only works when Codeforces is NOT enforcing its Cloudflare
    // Turnstile challenge on the submit form (see LESSONS.md, 2026-09-04).
    // Default path hands the job to the companion browser extension instead.
    const directSubmit = cfg.get<boolean>('directSubmit', false);

    try {
        resultsView.setVerdict('submitting…', 'pending');
        const submissionId = directSubmit
            ? await vscode.window.withProgress(
                  { location: vscode.ProgressLocation.Notification, title: 'Submitting to Codeforces' },
                  () => submitSolution(session, meta.problem, source, programTypeId)
              )
            : await queueBrowserSubmit(meta.problem, source, programTypeId, language);

        status.show();
        status.text = `$(sync~spin) ${meta.problem.index}: in queue`;
        resultsView.setVerdict('in queue', 'pending');
        output.appendLine('');
        output.appendLine(`Submitted ${meta.problem.index} as #${submissionId}`);

        const final = await watchVerdict(session, meta.problem, submissionId, (v) => {
            status.text = `$(sync~spin) ${meta.problem.index}: ${v.verdict}`;
            resultsView.setVerdict(v.verdict, 'pending');
        });

        const accepted = isAccepted(final.verdict);
        status.text = `${accepted ? '$(pass-filled)' : '$(error)'} ${meta.problem.index}: ${final.verdict}`;
        status.command = 'codeforces.lastVerdict';
        resultsView.setVerdict(
            final.verdict + (final.timeMs ? ` · ${final.timeMs}` : ''),
            accepted ? 'ok' : 'bad'
        );
        output.appendLine(`Verdict: ${final.verdict}${final.timeMs ? ` · ${final.timeMs}` : ''}`);

        // Append to this problem's history and repaint the tree now (user.status lags).
        record(final.verdict, {
            submissionId: final.submissionId,
            timeMs: final.timeMs,
            memoryKb: final.memoryKb
        });
        api.invalidateSolveStates();

        if (accepted) {
            void vscode.window.showInformationMessage(`${meta.problem.index}: ${final.verdict}`);
        } else {
            void vscode.window.showWarningMessage(`${meta.problem.index}: ${final.verdict}`);
        }
        setTimeout(() => status.hide(), 60_000);
    } catch (err) {
        status.hide();
        const msg = (err as Error).message;
        resultsView.setVerdict(msg, 'bad');
        // Codeforces actually saw and refused this (e.g. identical code) — that's an attempt.
        if (/refused the submission|identical to your previous|rejected this as identical/i.test(msg)) {
            record(`Rejected: ${msg.replace(/^Codeforces refused the submission:\s*/i, '')}`);
        }
        if (needsCompanion(err)) {
            void promptCompanion('Submitting');
        } else {
            fail(err);
        }
    }
}

/**
 * Hands the submission to the companion browser extension and waits for the
 * user to solve the Turnstile challenge and click Submit themselves, then
 * finds the new submission id so the normal verdict watch can take over.
 */
async function queueBrowserSubmit(
    problem: Problem,
    source: string,
    programTypeId: string,
    programTypeName: string
): Promise<string> {
    await ensureRelay();
    if (!relay?.running) {
        throw new Error(relayUnavailableMessage());
    }

    // Baseline: newest existing submission id for THIS problem, captured before
    // enqueuing. Codeforces submission ids increase monotonically, so a real
    // browser submit later shows up as a strictly larger id. Retry a few times
    // so a transient read failure doesn't leave us unable to tell a fresh
    // submission from one made earlier this session.
    let baseline: number | undefined;
    let haveBaseline = false;
    for (let i = 0; i < 3 && !haveBaseline; i++) {
        try {
            const id = await latestSubmissionId(session, problem);
            baseline = id ? Number(id) : undefined; // undefined here = confirmed: none yet
            haveBaseline = true;
        } catch {
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    const job = relay.enqueueSubmit({
        kind: problem.kind,
        contestId: problem.contestId,
        groupCode: problem.groupCode,
        index: problem.index,
        source,
        programTypeId,
        programTypeName
    });
    void vscode.window.showInformationMessage(
        `Queued ${problem.index} for browser submit. Switch to Chrome: solve the Turnstile check and press Submit yourself.`
    );

    return vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Waiting for ${problem.index} to be submitted in the browser…`,
            cancellable: true
        },
        async (_progress, token) => {
            const deadline = Date.now() + 5 * 60_000;
            while (Date.now() < deadline && !token.isCancellationRequested) {
                await new Promise((r) => setTimeout(r, 4000));

                // The companion watches the submit page after you click. If
                // Codeforces refused it (red span.error — e.g. "submitted exactly
                // the same code before"), abort now with that message instead of
                // waiting out the 5 minutes.
                const outcome = relay?.takeSubmitOutcome(job.id);
                if (outcome?.outcome === 'error') {
                    throw new Error(`Codeforces refused the submission: ${outcome.message || 'unknown error'}`);
                }

                let now: string | undefined;
                try {
                    now = await latestSubmissionId(session, problem);
                } catch {
                    continue; // status read failed (Cloudflare, etc.) — keep waiting
                }
                if (!now) {
                    continue;
                }
                if (!haveBaseline) {
                    return now; // never got a baseline; first id seen is best effort
                }
                if (baseline === undefined || Number(now) > baseline) {
                    return now;
                }
            }
            throw new Error(
                token.isCancellationRequested
                    ? 'Cancelled waiting for the browser submission.'
                    : `No new submission for ${problem.index} showed up within 5 minutes — did you press Submit in the browser?`
            );
        }
    );
}
