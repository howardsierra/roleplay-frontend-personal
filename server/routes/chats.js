// Chats are stored in SillyTavern's JSONL format so they can be moved between apps:
// line 1 = header { user_name, character_name, create_date, chat_metadata }, then one message per line.
import express from 'express';
import fsp from 'node:fs/promises';
import { DIRS, listJson, safeName, within, writeAtomic, removeFile } from '../lib/storage.js';

const router = express.Router();
const text = express.text({ type: () => true, limit: '64mb' });

const dirFor = charId => within(DIRS.chats, charId);
const fileFor = (charId, chatId) => within(dirFor(charId), `${chatId}.jsonl`);

export function parseJsonl(src) {
    const lines = String(src).split(/\r?\n/).filter(l => l.trim());
    if (!lines.length) return { meta: {}, messages: [] };
    const parsed = lines.map(l => JSON.parse(l));
    const first = parsed[0];
    const isHeader = first && !('mes' in first) && ('chat_metadata' in first || 'user_name' in first || 'create_date' in first);
    return {
        meta: isHeader ? first : {},
        messages: isHeader ? parsed.slice(1) : parsed,
    };
}

function toJsonl({ meta, messages }) {
    return [meta ?? {}, ...(messages ?? [])].map(x => JSON.stringify(x)).join('\n') + '\n';
}

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
}

// Most recently touched chats across every character (for the "Recent stories" sidebar).
router.get('/', async (req, res) => {
    const limit = Math.min(50, Number(req.query.limit) || 12);
    const characters = new Map((await listJson(DIRS.characters)).map(({ data }) => [data.id, data]));
    const all = [];
    for (const [charId, c] of characters) {
        let names = [];
        try { names = (await fsp.readdir(dirFor(charId))).filter(n => n.endsWith('.jsonl')); } catch { continue; }
        for (const name of names) {
            const stat = await fsp.stat(within(dirFor(charId), name));
            all.push({ charId, chatId: name.slice(0, -6), updated: stat.mtimeMs, charName: c.card?.data?.name || '', avatar: c.avatar || null });
        }
    }
    all.sort((a, b) => b.updated - a.updated);
    const top = all.slice(0, limit);
    for (const item of top) {
        try {
            const { messages } = parseJsonl(await fsp.readFile(fileFor(item.charId, item.chatId), 'utf8'));
            item.count = messages.length;
            item.preview = String(messages.at(-1)?.mes ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 90);
        } catch { item.preview = ''; }
    }
    res.json(top);
});

router.get('/:charId', async (req, res) => {
    let names = [];
    try {
        names = (await fsp.readdir(dirFor(req.params.charId))).filter(n => n.endsWith('.jsonl'));
    } catch { /* no chats yet */ }
    const list = [];
    for (const name of names) {
        const file = within(dirFor(req.params.charId), name);
        const [stat, src] = await Promise.all([fsp.stat(file), fsp.readFile(file, 'utf8')]);
        let count = 0;
        let preview = '';
        try {
            const { messages } = parseJsonl(src);
            count = messages.length;
            preview = String(messages.at(-1)?.mes ?? '').replace(/<[^>]+>/g, '').slice(0, 160);
        } catch { preview = '(unreadable chat file)'; }
        list.push({ id: name.slice(0, -6), updated: stat.mtimeMs, count, preview });
    }
    list.sort((a, b) => b.updated - a.updated);
    res.json(list);
});

router.get('/:charId/:chatId', async (req, res) => {
    try {
        const src = await fsp.readFile(fileFor(req.params.charId, req.params.chatId), 'utf8');
        res.json({ id: req.params.chatId, ...parseJsonl(src) });
    } catch (err) {
        if (err.code === 'ENOENT') return res.status(404).json({ error: 'Chat not found' });
        throw err;
    }
});

router.post('/:charId', async (req, res) => {
    const base = safeName(req.body?.name || `${req.body?.characterName || 'Chat'} - ${stamp()}`);
    let id = base;
    for (let i = 2; await fsp.access(fileFor(req.params.charId, id)).then(() => true, () => false); i++) id = `${base} (${i})`;
    const chat = {
        meta: { user_name: req.body?.userName || 'User', character_name: req.body?.characterName || '', create_date: stamp(), chat_metadata: {} },
        messages: req.body?.messages || [],
    };
    await writeAtomic(fileFor(req.params.charId, id), toJsonl(chat));
    res.json({ id, ...chat });
});

router.put('/:charId/:chatId', async (req, res) => {
    await writeAtomic(fileFor(req.params.charId, req.params.chatId), toJsonl(req.body));
    res.json({ ok: true });
});

router.post('/:charId/:chatId/rename', async (req, res) => {
    const to = safeName(req.body.name);
    const target = fileFor(req.params.charId, to);
    if (await fsp.access(target).then(() => true, () => false)) return res.status(409).json({ error: 'A chat with that name already exists' });
    await fsp.rename(fileFor(req.params.charId, req.params.chatId), target);
    res.json({ id: to });
});

router.delete('/:charId/:chatId', async (req, res) => {
    await removeFile(fileFor(req.params.charId, req.params.chatId));
    res.json({ ok: true });
});

router.post('/:charId/import', text, async (req, res) => {
    const chat = parseJsonl(req.body);
    const id = safeName(`${chat.meta.character_name || 'Imported'} - ${stamp()}`);
    await writeAtomic(fileFor(req.params.charId, id), toJsonl(chat));
    res.json({ id });
});

router.get('/:charId/:chatId/export', async (req, res) => {
    const file = fileFor(req.params.charId, req.params.chatId);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.chatId)}.jsonl`);
    res.type('application/jsonl').send(await fsp.readFile(file, 'utf8'));
});

export default router;
