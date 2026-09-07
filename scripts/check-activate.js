#!/usr/bin/env node
// Headless check: does the bundled out/extension.js require() and activate()
// without throwing? Catches require/resolution errors esbuild bundling can
// introduce (missing externals, broken dynamic import() rewrites, etc).
// Run after `npm run bundle` — see `npm run selftest`.
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const Module = require('module');

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-activate-check-'));

// --- minimal but real implementations for constructors/enums evaluated at
// module-load time (e.g. `new vscode.ThemeIcon(...)` at top level in tree.ts) ---
class Disposable {
    constructor(fn) { this._fn = fn; }
    dispose() { if (this._fn) this._fn(); }
    static from(...items) {
        return new Disposable(() => items.forEach((i) => i && i.dispose && i.dispose()));
    }
}
class EventEmitter {
    constructor() {
        this._listeners = [];
        this.event = (cb) => {
            this._listeners.push(cb);
            return new Disposable(() => {
                this._listeners = this._listeners.filter((l) => l !== cb);
            });
        };
    }
    fire(e) { this._listeners.forEach((cb) => cb(e)); }
    dispose() { this._listeners = []; }
}
class ThemeColor { constructor(id) { this.id = id; } }
class ThemeIcon { constructor(id, color) { this.id = id; this.color = color; } }
class TreeItem {
    constructor(label, collapsibleState) {
        this.label = label;
        this.collapsibleState = collapsibleState;
    }
}
function uriFrom(fsPath) {
    return { fsPath, scheme: 'file', path: fsPath, toString: () => fsPath, toJSON: () => fsPath };
}
const Uri = {
    file: (p) => uriFrom(p),
    parse: (s) => uriFrom(s),
    joinPath: (base, ...parts) => uriFrom(path.join(base.fsPath, ...parts))
};

// --- generic auto-stub: any vscode API this script's author didn't
// anticipate returns a harmless callable/constructable/property-chainable
// no-op instead of throwing "X is not a function" / "cannot read property". ---
function autoStub(name) {
    const fn = function (...args) {
        void args;
        return autoStub(`${name}()`);
    };
    fn.__isAutoStub = true;
    return new Proxy(fn, {
        get(target, prop) {
            if (typeof prop === 'symbol') return undefined;
            if (prop === 'then') return undefined; // never look like a thenable
            if (prop === 'dispose') return () => {};
            if (!(prop in target)) target[prop] = autoStub(`${name}.${String(prop)}`);
            return target[prop];
        },
        construct() { return autoStub(`new ${name}`); },
        apply(target, thisArg, args) { return target(...args); }
    });
}

const registeredCommands = new Map();
// A dedicated port, not the real default (27121) — this test's own fake
// sibling relay binds it below, and must not collide with a real relay that
// might be running on this machine while the check runs.
const TEST_RELAY_PORT = 27321;
const config = { 'codeforces.relayPort': TEST_RELAY_PORT };

const infoMessages = [];
const warningMessages = [];

const vscodeStub = {
    // classes / enums touched at module-eval time or during activate()
    Disposable,
    EventEmitter,
    ThemeColor,
    ThemeIcon,
    TreeItem,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ViewColumn: { Active: -1, Beside: -2, One: 1 },
    Uri,

    window: {
        createOutputChannel: (name) => ({
            name,
            appendLine() {}, append() {}, show() {}, hide() {}, clear() {}, dispose() {}
        }),
        createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '', command: undefined }),
        createTreeView: (id, opts) => ({ visible: true, reveal: async () => {}, dispose() {}, onDidChangeSelection: () => new Disposable(() => {}) }),
        registerTreeDataProvider: () => new Disposable(() => {}),
        registerWebviewViewProvider: () => new Disposable(() => {}),
        registerUriHandler: () => new Disposable(() => {}),
        onDidChangeActiveTextEditor: () => new Disposable(() => {}),
        showInformationMessage: async (msg) => { infoMessages.push(msg); return undefined; },
        showWarningMessage: async (msg) => { warningMessages.push(msg); return undefined; },
        showErrorMessage: async () => undefined,
        showOpenDialog: async () => undefined,
        activeTextEditor: undefined
    },

    workspace: {
        getConfiguration: (section) => ({
            get: (key, def) => {
                const full = section ? `${section}.${key}` : key;
                return Object.prototype.hasOwnProperty.call(config, full) ? config[full] : def;
            },
            update: async () => {},
            has: () => false
        }),
        workspaceFolders: undefined,
        textDocuments: [],
        onDidChangeConfiguration: () => new Disposable(() => {}),
        registerTextDocumentContentProvider: () => new Disposable(() => {})
    },

    commands: {
        registerCommand: (id, fn) => {
            registeredCommands.set(id, fn);
            return new Disposable(() => registeredCommands.delete(id));
        },
        executeCommand: async () => undefined
    }
};

// Proxy the top-level module too, so any vscode.<Something> this script
// didn't stub falls back to an auto-stub instead of "undefined".
const vscodeProxy = new Proxy(vscodeStub, {
    get(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in target) return target[prop];
        return autoStub(`vscode.${String(prop)}`);
    }
});

// Intercept require('vscode') for every module in the bundle's graph.
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    if (request === 'vscode') return 'vscode';
    return originalResolve.call(this, request, ...rest);
};
require.cache.vscode = {
    id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeProxy
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'vscode') return vscodeProxy;
    return originalLoad.call(this, request, ...rest);
};

const bundlePath = process.argv[2] || path.join(__dirname, '..', 'out', 'extension.js');

console.log(`Requiring bundle: ${bundlePath}`);
let ext;
try {
    ext = require(bundlePath);
} catch (err) {
    console.error('FAIL: require() of the bundle threw:');
    console.error(err.stack);
    process.exit(1);
}
console.log(`OK: bundle required cleanly. exports = [${Object.keys(ext).join(', ')}]`);

const fakeContext = {
    subscriptions: [],
    secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
        onDidChange: () => new Disposable(() => {})
    },
    globalState: {
        get: (key, def) => def,
        update: async () => {},
        keys: () => []
    },
    workspaceState: {
        get: (key, def) => def,
        update: async () => {},
        keys: () => []
    },
    globalStorageUri: uriFrom(scratchDir),
    extensionUri: uriFrom(path.join(__dirname, '..')),
    extensionPath: path.join(__dirname, '..'),
    extensionMode: 3
};

let unhandled = false;
process.on('unhandledRejection', (err) => {
    unhandled = true;
    console.error('FAIL: unhandled rejection during/after activate():');
    console.error(err && err.stack ? err.stack : err);
});

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
    // Stands in for "another VS Code window already owns the relay port" —
    // real EADDRINUSE, real /health response, no VS Code involved. Exercises
    // the two-window port-collision fix end to end through the actual
    // activate() code path, not a reimplementation of its logic.
    const siblingRelay = http.createServer((req, res) => {
        if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, port: TEST_RELAY_PORT, tokenRequired: true, protocolVersion: 2 }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise((resolve, reject) => {
        siblingRelay.once('error', reject);
        siblingRelay.listen(TEST_RELAY_PORT, '127.0.0.1', resolve);
    });

    try {
        ext.activate(fakeContext);
    } catch (err) {
        console.error('FAIL: activate() threw:');
        console.error(err.stack);
        process.exit(1);
    }
    console.log('OK: activate() ran without throwing.');
    console.log(`Registered ${registeredCommands.size} commands:`);
    for (const id of registeredCommands.keys()) console.log(`  - ${id}`);

    const hasRunTests = registeredCommands.has('codeforces.runTests');
    console.log(hasRunTests ? 'OK: codeforces.runTests command registered (covers the runner.ts dynamic import path).' : 'FAIL: codeforces.runTests missing.');

    // activate() kicks off startRelay() fire-and-forget (void, not awaited) —
    // give its EADDRINUSE -> /health round trip a moment to settle before
    // checking that it correctly recognized the sibling and didn't just warn.
    await sleep(300);

    let portCollisionOk = true;
    const checkCompanion = registeredCommands.get('codeforces.checkCompanion');
    if (checkCompanion) {
        await checkCompanion();
        const sawSiblingInfo = infoMessages.some(
            (m) => /another VS Code window/.test(m) && m.includes(String(TEST_RELAY_PORT))
        );
        const sawGenericWarning = warningMessages.some((m) => /relay is not running in this window/.test(m));
        if (!sawSiblingInfo || sawGenericWarning) {
            portCollisionOk = false;
            console.error(
                'FAIL: checkCompanion did not accurately report a sibling-owned relay.\n' +
                    '  infoMessages: ' + JSON.stringify(infoMessages) + '\n' +
                    '  warningMessages: ' + JSON.stringify(warningMessages)
            );
        } else {
            console.log('OK: checkCompanion correctly reports the port as owned by another window, not "not running".');
        }
    } else {
        portCollisionOk = false;
        console.error('FAIL: codeforces.checkCompanion not registered.');
    }

    infoMessages.length = 0;
    warningMessages.length = 0;
    const relayInfoCmd = registeredCommands.get('codeforces.relayInfo');
    if (relayInfoCmd) {
        await relayInfoCmd();
        const sawAccurate = warningMessages.some(
            (m) => /another VS Code window/.test(m) && m.includes(String(TEST_RELAY_PORT)) && /not this one/.test(m)
        );
        if (!sawAccurate) {
            portCollisionOk = false;
            console.error(
                'FAIL: relayInfo did not accurately report a sibling-owned relay.\n' +
                    '  warningMessages: ' + JSON.stringify(warningMessages)
            );
        } else {
            console.log('OK: relayInfo correctly distinguishes "another window owns it" from "not running".');
        }
    } else {
        portCollisionOk = false;
        console.error('FAIL: codeforces.relayInfo not registered.');
    }

    await new Promise((resolve) => siblingRelay.close(resolve));
    fs.rmSync(scratchDir, { recursive: true, force: true });

    // Set exitCode and let the process exit naturally rather than calling
    // process.exit() — an abrupt exit right after closing a real server and
    // doing fetch() calls hits a libuv/Windows race (UV_HANDLE_CLOSING
    // assertion in src\win\async.c) that kills the process with a non-test
    // exit code even when every check above passed.
    if (unhandled || !hasRunTests || !portCollisionOk) {
        process.exitCode = 1;
        return;
    }
    console.log('ALL CHECKS PASSED');
    process.exitCode = 0;
}

main().catch((err) => {
    console.error('FAIL:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
});
