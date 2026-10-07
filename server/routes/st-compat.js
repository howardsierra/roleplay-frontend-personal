// A subset of SillyTavern's server API that popular extensions call directly.
// Paths and response shapes mirror ST (e.g. uploads return { path: 'user/images/<folder>/<file>' }).
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DIRS, listJson, readJson, safeName, within, writeAtomic, removeFile } from '../lib/storage.js';
import { chatCompletion } from '../lib/providers.js';
import { getSecret } from './ai.js';

const router = express.Router();
export const USER_FILES = path.join(DATA_DIR, 'user-files');
fs.mkdirSync(USER_FILES, { recursive: true });

const IMAGE_FORMATS = /^(png|jpe?g|webp|gif|avif|bmp|mp4|webm)$/i;
const sanitize = name => String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1F]/g, '').replace(/^\.+/, '').trim().slice(0, 120) || 'file';

router.post('/images/upload', async (req, res) => {
    const { image, ch_name: folder, filename, format = 'png' } = req.body || {};
    if (!image) return res.status(400).json({ error: 'No image data' });
    if (!IMAGE_FORMATS.test(format)) return res.status(400).json({ error: 'Unsupported format' });
    const dir = folder ? within(DIRS.images, sanitize(folder)) : DIRS.images;
    const name = `${sanitize(filename || Date.now())}.${format.toLowerCase()}`;
    await writeAtomic(within(dir, name), Buffer.from(String(image).replace(/^data:[^,]+,/, ''), 'base64'));
    const rel = folder ? `${sanitize(folder)}/${name}` : name;
    res.json({ path: `user/images/${rel}` });
});

router.post('/images/list', async (req, res) => {
    const folder = req.body?.folder ? sanitize(req.body.folder) : '';
    const dir = folder ? within(DIRS.images, folder) : DIRS.images;
    let names = [];
    try { names = (await fsp.readdir(dir, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name); } catch { /* none */ }
    const withTime = await Promise.all(names.map(async n => ({ n, t: (await fsp.stat(path.join(dir, n))).mtimeMs })));
    withTime.sort((a, b) => (req.body?.sortOrder === 'asc' ? a.t - b.t : b.t - a.t));
    res.json(withTime.map(x => x.n));
});

router.post('/images/folders', async (_req, res) => {
    const entries = await fsp.readdir(DIRS.images, { withFileTypes: true }).catch(() => []);
    res.json(entries.filter(d => d.isDirectory()).map(d => d.name));
});

router.post('/images/delete', async (req, res) => {
    const rel = String(req.body?.path || '').replace(/^\/?user\/images\//, '');
    const full = path.resolve(DIRS.images, rel);
    if (!full.startsWith(DIRS.images + path.sep)) return res.status(400).json({ error: 'Bad path' });
    await removeFile(full);
    res.json({ ok: true });
});

router.post('/files/upload', async (req, res) => {
    const { name, data } = req.body || {};
    if (!name || !data) return res.status(400).json({ error: 'Missing name or data' });
    const file = sanitize(name);
    await writeAtomic(within(USER_FILES, file), Buffer.from(String(data), 'base64'));
    res.json({ path: `user/files/${file}` });
});

router.post('/files/sanitize-filename', (req, res) => res.json({ fileName: sanitize(req.body?.fileName) }));

router.post('/files/delete', async (req, res) => {
    const file = String(req.body?.path || '').replace(/^\/?user\/files\//, '');
    await removeFile(within(USER_FILES, sanitize(file)));
    res.json({ ok: true });
});

// Personas: ST lists avatar file names; Reverie's persona ids play that role.
router.post('/avatars/get', async (_req, res) => {
    const settings = await readJson(path.join(DATA_DIR, 'settings.json'), {});
    res.json((settings.personas || []).map(p => p.id));
});

router.post('/backgrounds/all', async (_req, res) => {
    const names = (await fsp.readdir(DIRS.backgrounds).catch(() => [])).filter(n => !n.startsWith('.'));
    res.json({ images: names, config: { width: 160, height: 90 } });
});

router.post('/worldinfo/get', async (req, res) => {
    const worlds = await listJson(DIRS.worlds);
    const hit = worlds.find(w => w.data.name === req.body?.name);
    if (!hit) return res.status(404).json({ error: 'World not found' });
    res.json({ entries: hit.data.entries || {} });
});

router.post('/extensions/discover', async (_req, res) => {
    const names = await fsp.readdir(DIRS.extensions).catch(() => []);
    res.json(names.map(n => ({ type: 'local', name: `third-party/${n}` })));
});

router.post('/characters/chats', async (req, res) => {
    const characters = await listJson(DIRS.characters);
    const c = characters.find(x => x.data.avatar === req.body?.avatar_url || x.data.id === req.body?.avatar_url)?.data;
    if (!c) return res.json([]);
    const dir = within(DIRS.chats, c.id);
    const names = (await fsp.readdir(dir).catch(() => [])).filter(n => n.endsWith('.jsonl'));
    res.json(await Promise.all(names.map(async n => {
        const stat = await fsp.stat(path.join(dir, n));
        return { file_name: n, file_size: `${(stat.size / 1024).toFixed(1)}kb`, last_mes: stat.mtimeMs, mes: '' };
    })));
});

// API keys never leave the server.
router.post('/secrets/find', (_req, res) => res.status(403).json({ error: 'Reverie does not expose API keys to extensions' }));
router.post('/secrets/read', (_req, res) => res.json({}));

// ST's direct chat-completions endpoint, routed through Reverie's active connection.
router.post('/backends/chat-completions/generate', async (req, res) => {
    const b = req.body || {};
    const settings = await readJson(path.join(DATA_DIR, 'settings.json'), {});
    const conn = settings.connection || {};
    const provider = conn.provider;
    const model = b.model && b.chat_completion_source === provider ? b.model : conn.model;
    const params = {};
    for (const k of ['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'max_tokens', 'seed', 'stop', 'reasoning_effort']) {
        if (b[k] !== undefined && b[k] !== null) params[k] = b[k];
    }
    const messages = (b.messages || []).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map(x => x.text || '').join('') }));
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const opts = { provider, baseUrl: conn.baseUrl, key: await getSecret(provider), model, messages, params, signal: controller.signal };
    if (b.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        const chunk = delta => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
        try {
            await chatCompletion({ ...opts, stream: true, onText: t => chunk({ content: t }), onReasoning: r => chunk({ reasoning: r }) });
        } catch (err) {
            if (!controller.signal.aborted) res.write(`data: ${JSON.stringify({ error: { message: err.message } })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        return res.end();
    }
    let text = '';
    let reasoning = '';
    try {
        const result = await chatCompletion({ ...opts, stream: false, onText: t => { text += t; }, onReasoning: r => { reasoning += r; } });
        res.json({ id: `rv-${Date.now()}`, object: 'chat.completion', model, choices: [{ index: 0, message: { role: 'assistant', content: text, reasoning_content: reasoning || undefined }, finish_reason: result.finish || 'stop' }], usage: result.usage });
    } catch (err) {
        res.status(err.status || 502).json({ error: { message: err.message } });
    }
});

export default router;
export { safeName };
