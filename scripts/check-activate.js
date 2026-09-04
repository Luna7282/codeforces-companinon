#!/usr/bin/env node
// Headless check: does the bundled out/extension.js require() and activate()
// without throwing? Catches require/resolution errors esbuild bundling can
// introduce (missing externals, broken dynamic import() rewrites, etc).
// Run after `npm run bundle` — see `npm run selftest`.
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
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
const config = { 'codeforces.relayPort': 27121 };

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
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
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

try {
    ext.activate(fakeContext);
} catch (err) {
    console.error('FAIL: activate() threw:');
    console.error(err.stack);
    process.exit(1);
}
console.log(`OK: activate() ran without throwing.`);
console.log(`Registered ${registeredCommands.size} commands:`);
for (const id of registeredCommands.keys()) console.log(`  - ${id}`);

const hasRunTests = registeredCommands.has('codeforces.runTests');
console.log(hasRunTests ? 'OK: codeforces.runTests command registered (covers the runner.ts dynamic import path).' : 'FAIL: codeforces.runTests missing.');

// give any fire-and-forget promises (session.load(), relay.start(), etc.) a
// tick to surface unhandled rejections, then exit (relay opened a real local
// socket that would otherwise keep the process alive).
let unhandled = false;
process.on('unhandledRejection', (err) => {
    unhandled = true;
    console.error('FAIL: unhandled rejection during/after activate():');
    console.error(err && err.stack ? err.stack : err);
});
// Not unref'd on purpose: keeps the process alive briefly so relay.start()
// and any other queued microtasks/promises get a chance to run (and surface
// unhandled rejections) before we tear down and force-exit.
setTimeout(() => {
    fs.rmSync(scratchDir, { recursive: true, force: true });
    if (unhandled || !hasRunTests) process.exit(1);
    console.log('ALL CHECKS PASSED');
    process.exit(0);
}, 800);
