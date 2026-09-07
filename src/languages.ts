import * as path from 'path';
import * as os from 'os';

/**
 * Per-language config (compile/run commands, remembered Codeforces compiler
 * name), keyed by file extension. Lets a problem hold one file per language
 * without a global "the current compiler" setting fighting itself between
 * files — see LESSONS.md, "Multiple languages per problem".
 */
export interface LanguageConfig {
    compileCommand?: string;
    runCommand?: string;
    /** The Codeforces compiler *name* last picked for this extension (e.g. "GNU G++20").
     *  Never the numeric id — ids aren't portable between contests, so the id is always
     *  re-resolved from a fresh per-problem compiler list by matching this name. */
    programTypeName?: string;
}

export type LanguagesConfig = Record<string, LanguageConfig>;

export const DEFAULT_LANGUAGES: LanguagesConfig = {
    '.cpp': {
        compileCommand: 'g++ -std=c++17 -O2 -o "${bin}" "${file}"',
        runCommand: '"${bin}"'
    },
    '.py': {
        runCommand: 'python "${file}"'
    }
};

// Ordered, most-specific-first: e.g. C++ ("g++"/"c++") must be checked before
// the plain-C pattern, since "GNU G++17" would otherwise also match /gcc/.
const EXTENSION_PATTERNS: [RegExp, string][] = [
    [/pypy|python/i, '.py'],
    [/g\+\+|gnu c\+\+|clang\+\+|c\+\+/i, '.cpp'],
    [/gnu gcc|\bgcc\b/i, '.c'],
    [/c#|mono|\.net core/i, '.cs'],
    [/\bjava\b/i, '.java'],
    [/kotlin/i, '.kt'],
    [/rust/i, '.rs'],
    [/\bgo\b/i, '.go'],
    [/typescript/i, '.ts'],
    [/javascript|node\.js/i, '.js'],
    [/haskell/i, '.hs'],
    [/ocaml/i, '.ml'],
    [/pascalabc|\bpascal\b|delphi/i, '.pas'],
    [/perl/i, '.pl'],
    [/php/i, '.php'],
    [/ruby/i, '.rb'],
    [/scala/i, '.scala'],
    [/^f#|\bf#\b/i, '.fs'],
    [/\bdmd\b|d language/i, '.d']
];

/**
 * Best-effort guess at the file extension for a Codeforces compiler display
 * name (e.g. "GNU G++20 13.2 (64 bit, winlibs)" -> ".cpp"). Undefined when
 * nothing matches — callers fall back to not scaffolding a new file rather
 * than guessing wrong and creating one with the wrong extension.
 */
export function extensionForLanguageName(name: string): string | undefined {
    for (const [pattern, ext] of EXTENSION_PATTERNS) {
        if (pattern.test(name)) {
            return ext;
        }
    }
    return undefined;
}

/** `${file}`/`${dir}`/`${name}`/`${bin}` placeholder expansion shared by compile and run commands. */
export function expandCommand(template: string, sourceFile: string): string {
    const dir = path.dirname(sourceFile);
    const name = path.basename(sourceFile, path.extname(sourceFile));
    const bin = path.join(dir, name + (os.platform() === 'win32' ? '.exe' : ''));
    return template
        .replace(/\$\{file\}/g, sourceFile)
        .replace(/\$\{dir\}/g, dir)
        .replace(/\$\{name\}/g, name)
        .replace(/\$\{bin\}/g, bin);
}

/** Self-test for the language/extension heuristic. Run: node out/languages.js */
export function selfTest(): void {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const assert: typeof import('assert') = require('assert');

    const cases: [string, string | undefined][] = [
        ['GNU G++17 7.3.0', '.cpp'],
        ['GNU G++20 13.2 (64 bit, winlibs)', '.cpp'],
        ['Clang++17 Diagnostics', '.cpp'],
        ['GNU GCC C11 5.1.0', '.c'],
        ['Python 3.8.10', '.py'],
        ['PyPy 3.10 (7.3.15)', '.py'],
        ['Java 21 64bit', '.java'],
        ['Kotlin 1.9.21', '.kt'],
        ['Rust 1.75.0 (2021)', '.rs'],
        ['Go 1.19.5', '.go'],
        ['Mono C# 6.8', '.cs'],
        ['MS C# .NET Core 5.0', '.cs'],
        ['JavaScript V8 4.8.0', '.js'],
        ['Node.js 15.8.0', '.js'],
        ['Something Made Up 9000', undefined]
    ];
    for (const [name, expected] of cases) {
        assert.strictEqual(extensionForLanguageName(name), expected, `extensionForLanguageName(${JSON.stringify(name)})`);
    }

    // C++ must win over the plain-C/"gcc" pattern for names that contain both shapes.
    assert.strictEqual(extensionForLanguageName('GNU G++17 (GCC toolchain)'), '.cpp', 'g++ beats a bare "gcc" substring');

    assert.strictEqual(
        expandCommand('g++ -O2 -o "${bin}" "${file}"', path.join('a', 'b', 'A.cpp')),
        `g++ -O2 -o "${path.join('a', 'b', os.platform() === 'win32' ? 'A.exe' : 'A')}" "${path.join('a', 'b', 'A.cpp')}"`,
        'expandCommand substitutes bin/file'
    );

    console.log('languages selfTest: OK');
}

if (require.main === module) {
    try {
        selfTest();
    } catch (e) {
        console.error('languages selfTest: FAIL\n', e);
        process.exit(1);
    }
}
