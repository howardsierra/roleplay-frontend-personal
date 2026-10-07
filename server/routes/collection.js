// Generic JSON collection (presets, lorebooks, themes, personas...).
// Each item is one file: <dir>/<id>.json, and always carries { id, name }.
import express from 'express';
import { listJson, newId, readJson, removeFile, within, writeJson } from '../lib/storage.js';

export function collectionRouter(dir, { summary } = {}) {
    const router = express.Router();
    const fileFor = id => within(dir, `${id}.json`);

    router.get('/', async (_req, res) => {
        const items = await listJson(dir);
        const list = items.map(({ data }) => (summary ? summary(data) : data));
        list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        res.json(list);
    });

    router.get('/:id', async (req, res) => {
        const item = await readJson(fileFor(req.params.id));
        if (!item) return res.status(404).json({ error: 'Not found' });
        res.json(item);
    });

    router.post('/', async (req, res) => {
        const item = { ...req.body, id: newId(), created: Date.now(), updated: Date.now() };
        if (!item.name) item.name = 'Untitled';
        await writeJson(fileFor(item.id), item);
        res.json(item);
    });

    router.put('/:id', async (req, res) => {
        const file = fileFor(req.params.id);
        const existing = await readJson(file);
        const item = { ...req.body, id: req.params.id, created: existing?.created ?? Date.now(), updated: Date.now() };
        await writeJson(file, item);
        res.json(item);
    });

    router.delete('/:id', async (req, res) => {
        await removeFile(fileFor(req.params.id));
        res.json({ ok: true });
    });

    return router;
}
