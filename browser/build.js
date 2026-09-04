#!/usr/bin/env node
/*
 * Zips browser/ into a Chrome-Web-Store-ready package. No dependencies —
 * hand-rolled ZIP writer (STORE method, no compression; the companion is a
 * few KB, so size isn't worth pulling in a zip library for).
 *
 * Usage: node browser/build.js
 * Output: dist/codeforces-inline-companion-<version>.zip
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT_DIR = path.join(SRC, '..', 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));

// Only what Chrome needs to run the extension — no README, no build.js itself.
const FILES = [
    'manifest.json',
    'background.js',
    'content.js',
    'deeplink-config.js',
    'options.html',
    'options.js',
    'icons/16.png',
    'icons/48.png',
    'icons/128.png'
];

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
    const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
    const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
    return { time, date };
}

function buildZip(entries) {
    const { time, date } = dosDateTime(new Date());
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const { name, data } of entries) {
        const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(0, 8); // method: store
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        localParts.push(local, nameBuf, data);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(0, 10);
        central.writeUInt16LE(time, 12);
        central.writeUInt16LE(date, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }

    const centralStart = offset;
    const centralBuf = Buffer.concat(centralParts);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(centralStart, 16);

    return Buffer.concat([...localParts, centralBuf, end]);
}

const missing = FILES.filter((f) => !fs.existsSync(path.join(SRC, f)));
if (missing.length) {
    console.error('Missing files, not building:', missing.join(', '));
    process.exit(1);
}

const entries = FILES.map((name) => ({ name, data: fs.readFileSync(path.join(SRC, name)) }));
fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, `codeforces-inline-companion-${manifest.version}.zip`);
fs.writeFileSync(outFile, buildZip(entries));
console.log(
    `Wrote ${path.relative(process.cwd(), outFile)} — ${entries.length} files, ${fs.statSync(outFile).size} bytes`
);
