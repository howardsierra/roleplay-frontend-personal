// Settings blob, backgrounds and the generated-image gallery.
import express from 'express';
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

export default router;
