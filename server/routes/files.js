// Settings blob, backgrounds and the generated-image gallery.
import express from 'express';
import * as tar from 'tar';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DIRS, newId, readJson, removeFile, safeName, within, writeAtomic, writeJson } from '../lib/storage.js';

const router = express.Router();
const raw = express.raw({ type: () => true, limit: '64mb' });
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|avif|mp4|webm)$/i;

router.get('/settings', async (_req, res) => res.json(await readJson(SETTINGS_FILE, {})));

router.put('/settings', async (req, res) => {
    await writeJson(SETTINGS_FILE, req.body ?? {});
    res.json({ ok: true });
});

async function listMedia(dir, urlPrefix) {
    let names = [];
    try { names = await fsp.readdir(dir); } catch { /* empty */ }
    const out = [];
    for (const name of names.filter(n => IMAGE_EXT.test(n))) {
        const stat = await fsp.stat(path.join(dir, name));
        out.push({ name, url: `${urlPrefix}/${encodeURIComponent(name)}`, size: stat.size, time: stat.mtimeMs });
    }
    return out.sort((a, b) => b.time - a.time);
}

router.get('/backgrounds', async (_req, res) => res.json(await listMedia(DIRS.backgrounds, 'files/backgrounds')));
router.get('/images', async (_req, res) => res.json(await listMedia(DIRS.images, 'files/images')));

router.post('/backgrounds', raw, async (req, res) => {
    const original = String(req.query.name || 'background.png');
    const ext = (path.extname(original) || '.png').toLowerCase();
    if (!IMAGE_EXT.test(ext)) return res.status(400).json({ error: 'Unsupported file type' });
    const name = safeName(`${path.basename(original, ext).slice(0, 60)}-${newId().slice(0, 5)}${ext}`);
    await writeAtomic(within(DIRS.backgrounds, name), req.body);
    res.json({ name, url: `files/backgrounds/${encodeURIComponent(name)}` });
});

router.delete('/backgrounds/:name', async (req, res) => {
    await removeFile(within(DIRS.backgrounds, req.params.name));
    res.json({ ok: true });
});

router.delete('/images/:name', async (req, res) => {
    await removeFile(within(DIRS.images, req.params.name));
    res.json({ ok: true });
});

// Upload an arbitrary image to the gallery (used for chat attachments & persona avatars).
router.post('/images', raw, async (req, res) => {
    const original = String(req.query.name || 'image.png');
    const ext = (path.extname(original) || '.png').toLowerCase();
    if (!IMAGE_EXT.test(ext)) return res.status(400).json({ error: 'Unsupported file type' });
    const name = `${Date.now().toString(36)}-${newId()}${ext}`;
    await writeAtomic(within(DIRS.images, name), req.body);
    res.json({ name, url: `files/images/${name}` });
});

// Whole-data backup as .tar.gz. API keys and the session secret are left out unless ?secrets=1.
router.get('/backup', async (req, res) => {
    const includeSecrets = req.query.secrets === '1';
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="reverie-backup-${stamp}.tar.gz"`);
    const entries = (await fsp.readdir(DATA_DIR)).filter(n => n !== '.session-secret' && !n.endsWith('.tmp') && (includeSecrets || n !== 'secrets.json'));
    await pipeline(tar.c({ gzip: true, cwd: DATA_DIR, portable: true, filter: p => !/(^|\/)\.git(\/|$)|\.tmp$/.test(p) }, entries), res);
});

// Restore: extracts a backup over the current data (existing files with the same names are replaced).
router.post('/backup/restore', express.raw({ type: () => true, limit: '1gb' }), async (req, res) => {
    if (!req.body?.length) return res.status(400).json({ error: 'Empty upload' });
    let count = 0;
    await pipeline(Readable.from(req.body), tar.x({
        cwd: DATA_DIR,
        strict: true,
        filter: p => {
            const ok = !p.split('/').includes('..') && !p.startsWith('/') && !p.includes('.session-secret');
            if (ok) count++;
            return ok;
        },
    }));
    res.json({ ok: true, files: count });
});

export default router;
