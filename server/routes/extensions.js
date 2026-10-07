// Install / update / remove SillyTavern-style third-party extensions, and serve their files.
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { DATA_DIR, DIRS, readJson, removeFile, safeName, within, writeJson } from '../lib/storage.js';
import { buildShimModule, rewriteImports } from '../lib/esm-shim.js';

const run = promisify(execFile);
export const apiRouter = express.Router();
export const serveRouter = express.Router();

function parseRepo(url) {
    const clean = String(url || '').trim().replace(/\.git$/, '').replace(/\/+$/, '');
    if (!/^https:\/\/[\w.-]+\/[\w.~-]+\/[\w.~-]+/.test(clean)) {
        throw Object.assign(new Error('Enter an https:// Git repository URL'), { status: 400 });
    }
    const m = clean.match(/^https:\/\/([\w.-]+)\/([\w.~-]+)\/([\w.~-]+)(?:\/tree\/(.+))?$/);
    if (!m) throw Object.assign(new Error('Unrecognized repository URL'), { status: 400 });
    return { host: m[1], owner: m[2], repo: m[3], branch: m[4], url: `https://${m[1]}/${m[2]}/${m[3]}` };
}

async function hasGit() {
    try { await run('git', ['--version']); return true; } catch { return false; }
}

async function download(info, target, branch) {
    if (await hasGit()) {
        const args = ['clone', '--depth', '1'];
        if (branch) args.push('--branch', branch);
        await run('git', [...args, `${info.url}.git`, target], { timeout: 120000 });
        // Remember the source too, so updates still work after a backup restore (which drops .git).
        await fsp.writeFile(path.join(target, '.reverie-source.json'), JSON.stringify({ url: info.url, branch: branch || null }));
        return;
    }
    // No git binary: fall back to a tarball download (GitHub / GitLab).
    const ref = branch || 'HEAD';
    let tarUrl;
    if (info.host === 'github.com') tarUrl = `https://codeload.github.com/${info.owner}/${info.repo}/tar.gz/${ref}`;
    else if (info.host === 'gitlab.com') tarUrl = `https://gitlab.com/${info.owner}/${info.repo}/-/archive/${branch || 'main'}/${info.repo}.tar.gz`;
    else throw Object.assign(new Error('Install git to add extensions from this host'), { status: 400 });
    const res = await fetch(tarUrl);
    if (!res.ok) throw Object.assign(new Error(`Download failed (${res.status})`), { status: 502 });
    await fsp.mkdir(target, { recursive: true });
    await pipeline(Readable.fromWeb(res.body), tar.x({ cwd: target, strip: 1 }));
    await fsp.writeFile(path.join(target, '.reverie-source.json'), JSON.stringify({ url: info.url, branch: branch || null }));
}

async function describe(name) {
    const dir = within(DIRS.extensions, name);
    // Reverie-native extensions ship reverie-extension.json; SillyTavern ones ship manifest.json.
    const native = await readJson(path.join(dir, 'reverie-extension.json'));
    const manifest = native || await readJson(path.join(dir, 'manifest.json'));
    if (!manifest) return null;
    const type = native ? 'reverie' : 'sillytavern';
    let source = await readJson(path.join(dir, '.reverie-source.json'));
    if (!source && fs.existsSync(path.join(dir, '.git'))) {
        try {
            const { stdout } = await run('git', ['-C', dir, 'config', '--get', 'remote.origin.url']);
            source = { url: stdout.trim() };
        } catch { /* ignore */ }
    }
    return { name, type, manifest, source };
}

apiRouter.get('/', async (_req, res) => {
    let names = [];
    try { names = await fsp.readdir(DIRS.extensions); } catch { /* none */ }
    const list = [];
    for (const name of names) {
        const ext = await describe(name).catch(() => null);
        if (ext) list.push(ext);
    }
    list.sort((a, b) => (a.manifest.loading_order ?? 100) - (b.manifest.loading_order ?? 100) || a.name.localeCompare(b.name));
    res.json(list);
});

apiRouter.post('/install', async (req, res) => {
    const info = parseRepo(req.body?.url);
    const branch = req.body?.branch || info.branch;
    const name = safeName(info.repo);
    const target = within(DIRS.extensions, name);
    if (fs.existsSync(target)) return res.status(409).json({ error: `"${name}" is already installed` });
    try {
        await download(info, target, branch);
        if (!fs.existsSync(path.join(target, 'manifest.json')) && !fs.existsSync(path.join(target, 'reverie-extension.json'))) {
            throw Object.assign(new Error('That repository has no manifest.json or reverie-extension.json, so it is not an extension'), { status: 400 });
        }
    } catch (err) {
        await removeFile(target);
        throw err;
    }
    res.json(await describe(name));
});

apiRouter.post('/:name/update', async (req, res) => {
    const name = safeName(req.params.name);
    const dir = within(DIRS.extensions, name);
    if (fs.existsSync(path.join(dir, '.git'))) {
        await run('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 120000 });
        return res.json(await describe(name));
    }
    const ext = await describe(name);
    if (!ext?.source?.url) return res.status(400).json({ error: 'Unknown source for this extension' });
    const tmp = `${dir}.updating`;
    await removeFile(tmp);
    await download(parseRepo(ext.source.url), tmp, ext.source.branch);
    await removeFile(dir);
    await fsp.rename(tmp, dir);
    res.json(await describe(name));
});

apiRouter.delete('/:name', async (req, res) => {
    await removeFile(within(DIRS.extensions, req.params.name));
    res.json({ ok: true });
});

// Serve /scripts/extensions/third-party/<name>/<file>, rewriting JS imports for compatibility.
serveRouter.get(/^\/scripts\/extensions\/third-party\/([^/]+)\/(.+)$/, async (req, res, next) => {
    const name = safeName(decodeURIComponent(req.params[0]));
    const base = within(DIRS.extensions, name);
    const rel = decodeURIComponent(req.params[1]).replace(/^\/+/, '');
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) || rel.split('/').some(p => p === '.git')) return res.status(403).end();
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
    if (/\.m?js$/.test(file)) {
        const src = await fsp.readFile(file, 'utf8');
        res.type('application/javascript').set('Cache-Control', 'no-cache');
        return res.send(rewriteImports(src, req.path));
    }
    res.set('Cache-Control', 'no-cache');
    res.sendFile(file);
});

// Reverie-native extensions are served as-is (they use the rv API, not ST imports).
serveRouter.get(/^\/rv-extensions\/([^/]+)\/(.+)$/, async (req, res, next) => {
    const base = within(DIRS.extensions, safeName(decodeURIComponent(req.params[0])));
    const rel = decodeURIComponent(req.params[1]).replace(/^\/+/, '');
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) || rel.split('/').includes('.git')) return res.status(403).end();
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
    res.set('Cache-Control', 'no-cache');
    if (/\.m?js$/.test(file)) res.type('application/javascript');
    res.sendFile(file);
});

serveRouter.get(/^\/st-shim(\/.+)$/, (req, res) => {
    res.type('application/javascript').set('Cache-Control', 'no-cache');
    res.send(buildShimModule(req.params[0], req.query.n));
});

// ---------------------------------------------------------------------------
// Per-extension storage for Reverie extensions (data/ext-data/<id>.json), synced across devices.
// ---------------------------------------------------------------------------
export const dataRouter = express.Router();
const TEMPLATE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../templates/starter-extension');
const EXT_DATA = path.join(DATA_DIR, 'ext-data');

dataRouter.get('/:id', async (req, res) => {
    res.json(await readJson(within(EXT_DATA, `${safeName(req.params.id)}.json`), {}));
});

dataRouter.put('/:id', async (req, res) => {
    const file = within(EXT_DATA, `${safeName(req.params.id)}.json`);
    const data = await readJson(file, {});
    for (const [k, v] of Object.entries(req.body || {})) {
        if (v === null) delete data[k];
        else data[k] = v;
    }
    const size = Buffer.byteLength(JSON.stringify(data));
    if (size > 5 * 1024 * 1024) return res.status(413).json({ error: 'Extension storage is limited to 5 MB' });
    await writeJson(file, data);
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Scaffold a starter Reverie extension the user can edit.
// ---------------------------------------------------------------------------
apiRouter.post('/create', async (req, res) => {
    const display = String(req.body?.name || 'My Extension').slice(0, 60);
    const id = safeName(display.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-extension');
    const dir = within(DIRS.extensions, id);
    if (fs.existsSync(dir)) return res.status(409).json({ error: `"${id}" already exists` });
    await fsp.mkdir(dir, { recursive: true });
    const manifest = {
        id, name: display, version: '0.1.0', author: '', description: 'A Reverie extension.',
        apiVersion: 1, main: 'index.js', styles: ['style.css'],
        permissions: ['prompt', 'storage'],
        settings: [
            { key: 'enabled', type: 'toggle', label: 'Add the scene reminder to the prompt', default: true },
            { key: 'reminder', type: 'textarea', label: 'Reminder text', default: 'Keep {{char}} in character and the scene vivid.' },
        ],
    };
    await fsp.writeFile(path.join(dir, 'reverie-extension.json'), JSON.stringify(manifest, null, 2));
    for (const file of ['index.js', 'style.css']) {
        const text = await fsp.readFile(path.join(TEMPLATE_DIR, file), 'utf8');
        await fsp.writeFile(path.join(dir, file), text.replaceAll('__ID__', id));
    }
    res.json(await describe(id));
});
