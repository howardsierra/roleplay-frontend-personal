// Whole-Reverie backups: download everything as one .tar.gz, restore it (merge or replace), and
// automatic snapshots kept on the server (daily, and before every restore) so a restore can be undone.
import express from 'express';
import * as tar from 'tar';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, DIRS, readJson, writeJson } from '../lib/storage.js';

const router = express.Router();
const SNAP_DIR = path.join(DATA_DIR, 'backups');
const STATE_FILE = path.join(SNAP_DIR, 'state.json');
const KEEP_SNAPSHOTS = 5;
const DAY = 24 * 60 * 60 * 1000;
// Never inside an archive: the login session secret, the snapshots themselves, temp files.
const ALWAYS_SKIP = new Set(['.session-secret', 'backups']);
const MANIFEST = 'reverie-backup.json';

let busy = null; // one archive / restore at a time
async function exclusive(fn) {
    while (busy) await busy.catch(() => {});
    busy = fn();
    try { return await busy; } finally { busy = null; }
}

const readState = () => readJson(STATE_FILE, {});
async function writeState(patch) {
    await fsp.mkdir(SNAP_DIR, { recursive: true });
    await writeJson(STATE_FILE, { ...(await readState()), ...patch });
}

async function count(dir, test) {
    let n = 0;
    try {
        for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) n += await count(path.join(dir, entry.name), test);
            else if (test(entry.name)) n++;
        }
    } catch { /* missing folder */ }
    return n;
}

async function sizeOf(target) {
    try {
        const stat = await fsp.stat(target);
        if (!stat.isDirectory()) return stat.size;
        let total = 0;
        for (const name of await fsp.readdir(target)) total += await sizeOf(path.join(target, name));
        return total;
    } catch { return 0; }
}

async function summary() {
    const settings = await readJson(path.join(DATA_DIR, 'settings.json'), {});
    return {
        characters: await count(DIRS.characters, n => n.endsWith('.json')),
        chats: await count(DIRS.chats, n => n.endsWith('.jsonl')),
        personas: (settings.personas || []).length,
        lorebooks: await count(DIRS.worlds, n => n.endsWith('.json')),
        presets: await count(DIRS.presets, n => n.endsWith('.json')),
        images: await count(DIRS.images, () => true) + await count(DIRS.backgrounds, () => true),
    };
}

/** Top-level entries of DATA_DIR that go into an archive. */
async function archiveEntries({ secrets = false, extensions = true } = {}) {
    return (await fsp.readdir(DATA_DIR)).filter(n => !ALWAYS_SKIP.has(n) && !n.endsWith('.tmp')
        && (secrets || n !== 'secrets.json')
        && (extensions || n !== 'extensions'));
}

async function writeManifest(opts) {
    const manifest = { app: 'reverie', format: 1, created: new Date().toISOString(), version: process.env.npm_package_version || '0.1.0', secrets: !!opts.secrets, extensions: opts.extensions !== false, contents: await summary() };
    await fsp.writeFile(path.join(DATA_DIR, MANIFEST), JSON.stringify(manifest, null, 2));
    return manifest;
}

function archiveStream(entries) {
    return tar.c({ gzip: true, cwd: DATA_DIR, portable: true, filter: p => !/(^|\/)\.git(\/|$)|\.tmp$/.test(p) }, entries);
}

// ---------------------------------------------------------------- snapshots
const snapshotName = reason => `snapshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${reason}.tar.gz`;

async function listSnapshots() {
    try {
        const names = (await fsp.readdir(SNAP_DIR)).filter(n => /^snapshot-.*\.tar\.gz$/.test(n));
        const out = [];
        for (const name of names) {
            const stat = await fsp.stat(path.join(SNAP_DIR, name));
            out.push({ name, size: stat.size, created: stat.mtimeMs, reason: name.match(/-(daily|manual|before-restore)\.tar\.gz$/)?.[1] || 'manual' });
        }
        return out.sort((a, b) => b.created - a.created);
    } catch { return []; }
}

/** Snapshots leave out extensions (re-installable) and API keys, to stay small. */
async function takeSnapshot(reason = 'manual') {
    await fsp.mkdir(SNAP_DIR, { recursive: true });
    const name = snapshotName(reason);
    const file = path.join(SNAP_DIR, name);
    await writeManifest({ secrets: false, extensions: false });
    await pipeline(archiveStream(await archiveEntries({ secrets: false, extensions: false })), fs.createWriteStream(`${file}.tmp`));
    await fsp.rename(`${file}.tmp`, file);
    const all = await listSnapshots();
    for (const old of all.slice(KEEP_SNAPSHOTS)) await fsp.rm(path.join(SNAP_DIR, old.name), { force: true });
    await writeState({ lastSnapshot: Date.now() });
    return name;
}

export async function dailySnapshot() {
    const state = await readState();
    if (Date.now() - (state.lastSnapshot || 0) < DAY) return;
    const { characters, chats } = await summary();
    if (!characters && !chats) return; // nothing worth keeping yet
    await exclusive(() => takeSnapshot('daily')).catch(err => console.error('[backup] daily snapshot failed:', err.message));
}

const snapFile = name => {
    if (!/^snapshot-[\w-]+\.tar\.gz$/.test(name)) throw Object.assign(new Error('Unknown snapshot'), { status: 404 });
    return path.join(SNAP_DIR, name);
};

// ---------------------------------------------------------------- restore
/** Checks the archive looks like a Reverie backup and returns its top-level names. */
async function inspect(file) {
    const top = new Set();
    let manifest = null;
    const pending = [];
    await tar.t({
        file,
        onReadEntry: entry => {
            const p = entry.path.replace(/^\.\//, '');
            if (p.split('/').includes('..') || p.startsWith('/')) throw Object.assign(new Error('That archive has unsafe paths.'), { status: 400 });
            top.add(p.split('/')[0]);
            if (p === MANIFEST) pending.push(entry.concat().then(buf => { try { manifest = JSON.parse(buf.toString('utf8')); } catch { /* ignore */ } }));
            else entry.resume();
        },
    });
    await Promise.all(pending);
    const looksRight = manifest?.app === 'reverie' || top.has('settings.json') || top.has('characters') || top.has('chats');
    if (!looksRight) throw Object.assign(new Error('That doesn\'t look like a Reverie backup.'), { status: 400 });
    return { top: [...top].filter(n => n && !ALWAYS_SKIP.has(n)), manifest };
}

async function restoreFrom(file, { mode = 'merge' } = {}) {
    const { top, manifest } = await inspect(file);
    const safety = await takeSnapshot('before-restore');
    if (mode === 'replace') {
        // Clear what the backup would rebuild; keep what it doesn't carry (API keys, extensions when left out).
        for (const name of await fsp.readdir(DATA_DIR)) {
            if (ALWAYS_SKIP.has(name) || name.endsWith('.tmp')) continue;
            if (name === 'secrets.json' && !top.includes('secrets.json')) continue;
            if (name === 'extensions' && !top.includes('extensions')) continue;
            await fsp.rm(path.join(DATA_DIR, name), { recursive: true, force: true });
        }
    }
    let files = 0;
    await tar.x({
        file, cwd: DATA_DIR, strict: true,
        filter: p => {
            const clean = p.replace(/^\.\//, '');
            const ok = !clean.split('/').includes('..') && !clean.startsWith('/') && !ALWAYS_SKIP.has(clean.split('/')[0]);
            if (ok) files++;
            return ok;
        },
    });
    for (const dir of Object.values(DIRS)) await fsp.mkdir(dir, { recursive: true });
    return { ok: true, files, mode, safety, from: manifest?.created || null };
}

// ---------------------------------------------------------------- routes
router.get('/backup/info', async (_req, res) => {
    const state = await readState();
    const sizes = {};
    for (const name of await archiveEntries({ secrets: true, extensions: true })) sizes[name] = await sizeOf(path.join(DATA_DIR, name));
    res.json({
        contents: await summary(),
        size: Object.entries(sizes).reduce((n, [k, v]) => n + (k === 'secrets.json' ? 0 : v), 0),
        extensionsSize: sizes.extensions || 0,
        lastDownload: state.lastDownload || null,
        snapshots: await listSnapshots(),
    });
});

// Download everything. API keys only with ?secrets=1; ?extensions=0 leaves installed extensions out.
router.get('/backup', async (req, res) => {
    const opts = { secrets: req.query.secrets === '1', extensions: req.query.extensions !== '0' };
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="reverie-backup-${stamp}.tar.gz"`);
    await exclusive(async () => {
        await writeManifest(opts);
        await pipeline(archiveStream(await archiveEntries(opts)), res);
    });
    await writeState({ lastDownload: Date.now() });
});

// Restore an uploaded backup. The upload streams to a temp file (never held in memory).
router.post('/backup/restore', async (req, res) => {
    const mode = req.query.mode === 'replace' ? 'replace' : 'merge';
    await fsp.mkdir(SNAP_DIR, { recursive: true });
    const tmp = path.join(SNAP_DIR, `upload-${Date.now()}.tmp`);
    try {
        await pipeline(req, fs.createWriteStream(tmp));
        if (!(await fsp.stat(tmp)).size) return res.status(400).json({ error: 'Empty upload' });
        res.json(await exclusive(() => restoreFrom(tmp, { mode })));
    } finally {
        await fsp.rm(tmp, { force: true });
    }
});

router.post('/backup/snapshots', async (_req, res) => {
    res.json({ name: await exclusive(() => takeSnapshot('manual')) });
});

router.get('/backup/snapshots/:name', async (req, res) => {
    const file = snapFile(req.params.name);
    res.download(file, req.params.name.replace(/^snapshot-/, 'reverie-'));
});

router.post('/backup/snapshots/:name/restore', async (req, res) => {
    const file = snapFile(req.params.name);
    // Copy it first: restoring prunes old snapshots, which could include this one.
    const copy = path.join(SNAP_DIR, `restore-${Date.now()}.tmp`);
    await fsp.copyFile(file, copy);
    try {
        res.json(await exclusive(() => restoreFrom(copy, { mode: req.query.mode === 'replace' ? 'replace' : 'merge' })));
    } finally {
        await fsp.rm(copy, { force: true });
    }
});

router.delete('/backup/snapshots/:name', async (req, res) => {
    await fsp.rm(snapFile(req.params.name), { force: true });
    res.json({ ok: true });
});

export default router;
