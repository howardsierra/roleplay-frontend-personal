// Chats are stored in SillyTavern's JSONL format so they can be moved between apps:
// line 1 = header { user_name, character_name, create_date, chat_metadata }, then one message per line.
import { bannerData } from '../lib/card.js';
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DIRS, listJson, safeName, within, writeAtomic, removeFile } from '../lib/storage.js';
import { convertChatImport, parseJsonlLines } from '../lib/importers.js';

const router = express.Router();
const text = express.text({ type: () => true, limit: '64mb' });

const dirFor = charId => within(DIRS.chats, charId);
// The extension is added after cleaning the id, so a long chat name can't lose its ".jsonl".
const fileFor = (charId, chatId) => path.join(dirFor(charId), `${safeName(chatId)}.jsonl`);
const exists = file => fsp.access(file).then(() => true, () => false);
const notFound = msg => Object.assign(new Error(msg), { status: 404 });
const badRequest = msg => Object.assign(new Error(msg), { status: 400 });
// Chats belong to a character that exists (a stray request mustn't create folders for nobody).
async function requireCharacter(charId) {
    if (!(await exists(within(DIRS.characters, `${charId}.json`)))) throw notFound('No such character');
}
// Names straight from readdir are real files: join them as they are (they may predate today's name rules).
const listedFile = (charId, name) => path.join(dirFor(charId), path.basename(name));
// New and renamed chats keep names comfortably short.
const chatName = s => safeName(String(s).slice(0, 100));

/** SillyTavern JSONL → { meta, messages, skipped }. Lines that aren't valid JSON are skipped (and counted). */
export function parseJsonl(src) {
    return parseJsonlLines(src);
}

function toJsonl({ meta, messages }) {
    return [meta ?? {}, ...(messages ?? [])].map(x => JSON.stringify(x)).join('\n') + '\n';
}

function stamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
}

/** A readable one-line preview: no code blocks, HTML, or markdown symbols. */
export function plainPreview(text, max) {
    return String(text ?? '')
        .replace(/```[\s\S]*?(```|$)/g, ' ')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/[*_~`#>]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
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
            const stat = await fsp.stat(listedFile(charId, name)).catch(() => null);
            if (!stat) continue; // deleted while we looked
            all.push({ charId, chatId: name.slice(0, -6), updated: stat.mtimeMs, charName: c.card?.data?.name || '', avatar: c.avatar || null, banner: !!bannerData(c).banner, charUpdated: c.updated || 0 });
        }
    }
    all.sort((a, b) => b.updated - a.updated);
    const top = all.slice(0, limit);
    for (const item of top) {
        try {
            const { messages } = parseJsonl(await fsp.readFile(fileFor(item.charId, item.chatId), 'utf8'));
            item.count = messages.length;
            item.preview = plainPreview(messages.at(-1)?.mes, 140);
        } catch { item.preview = ''; }
    }
    res.json(top);
});

/** About 180 characters of `plain` around the first `term` (lower-case), cut at word boundaries. */
export function searchSnippet(plain, term) {
    const at = Math.max(0, plain.toLowerCase().indexOf(term));
    let start = Math.max(0, at - 70);
    if (start > 0) start = plain.indexOf(' ', start) + 1 || start;
    if (start > at) start = at;
    let end = Math.min(plain.length, at + term.length + 110);
    if (end < plain.length) {
        const space = plain.lastIndexOf(' ', end);
        if (space > at + term.length) end = space;
    }
    return (start ? '…' : '') + plain.slice(start, end).trim() + (end < plain.length ? '…' : '');
}

// Search every chat for messages containing all the words in ?q= (case-insensitive), newest chats first.
router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q.length < 2) return res.json({ results: [], total: 0 });
    const terms = q.split(/\s+/).filter(Boolean).slice(0, 8);
    const limit = Math.min(200, Number(req.query.limit) || 80);
    const characters = new Map((await listJson(DIRS.characters)).map(({ data }) => [data.id, data]));
    const chats = [];
    for (const [charId, c] of characters) {
        let names = [];
        try { names = (await fsp.readdir(dirFor(charId))).filter(n => n.endsWith('.jsonl')); } catch { continue; }
        for (const name of names) {
            const stat = await fsp.stat(listedFile(charId, name)).catch(() => null);
            if (stat) chats.push({ charId, chatId: name.slice(0, -6), updated: stat.mtimeMs, charName: c.card?.data?.name || '', avatar: c.avatar || null });
        }
    }
    chats.sort((a, b) => b.updated - a.updated);
    const results = [];
    let total = 0;
    for (const chat of chats) {
        let messages;
        try { ({ messages } = parseJsonl(await fsp.readFile(fileFor(chat.charId, chat.chatId), 'utf8'))); } catch { continue; }
        messages.forEach((m, index) => {
            const plain = plainPreview(m?.mes, 100000);
            const lower = plain.toLowerCase();
            if (!terms.every(t => lower.includes(t))) return;
            total++;
            if (results.length >= limit) return;
            results.push({ ...chat, index, name: m.name || '', isUser: !!m.is_user, date: m.send_date || null, snippet: searchSnippet(plain, terms[0]) });
        });
    }
    res.json({ results, total, terms });
});

router.get('/:charId', async (req, res) => {
    let names = [];
    try {
        names = (await fsp.readdir(dirFor(req.params.charId))).filter(n => n.endsWith('.jsonl'));
    } catch { /* no chats yet */ }
    const list = [];
    for (const name of names) {
        const file = listedFile(req.params.charId, name);
        const [stat, src] = await Promise.all([fsp.stat(file), fsp.readFile(file, 'utf8')]).catch(() => [null, null]);
        if (!stat) continue;
        let count = 0;
        let preview = '';
        try {
            const { messages } = parseJsonl(src);
            count = messages.length;
            preview = plainPreview(messages.at(-1)?.mes, 160);
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

/** A free chat name for this character: `base`, else `base (2)`, `base (3)`… */
async function freeChatId(charId, name) {
    const base = chatName(name);
    let id = base;
    for (let i = 2; await fsp.access(fileFor(charId, id)).then(() => true, () => false); i++) id = `${base} (${i})`;
    return id;
}

router.post('/:charId', async (req, res) => {
    await requireCharacter(req.params.charId);
    const id = await freeChatId(req.params.charId, req.body?.name || `${req.body?.characterName || 'Chat'} - ${stamp()}`);
    const chat = {
        meta: { user_name: req.body?.userName || 'User', character_name: req.body?.characterName || '', create_date: stamp(), chat_metadata: {} },
        messages: req.body?.messages || [],
    };
    await writeAtomic(fileFor(req.params.charId, id), toJsonl(chat));
    res.json({ id, ...chat });
});

router.put('/:charId/:chatId', async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || !Array.isArray(req.body.messages)) throw badRequest('Expected { meta, messages: [...] }');
    await requireCharacter(req.params.charId);
    await writeAtomic(fileFor(req.params.charId, req.params.chatId), toJsonl(req.body));
    res.json({ ok: true });
});

router.post('/:charId/:chatId/rename', async (req, res) => {
    if (typeof req.body?.name !== 'string' || !req.body.name.trim()) throw badRequest('A new name is needed');
    if (!(await exists(fileFor(req.params.charId, req.params.chatId)))) throw notFound('No such chat');
    const to = chatName(req.body.name);
    const target = fileFor(req.params.charId, to);
    if (await fsp.access(target).then(() => true, () => false)) return res.status(409).json({ error: 'A chat with that name already exists' });
    await fsp.rename(fileFor(req.params.charId, req.params.chatId), target);
    res.json({ id: to });
});

router.delete('/:charId/:chatId', async (req, res) => {
    await removeFile(fileFor(req.params.charId, req.params.chatId));
    res.json({ ok: true });
});

// Import a chat file. Query: ?character_name=&user_name=&filename= (the client knows these; old headers often say "unused").
// Accepts SillyTavern / Chub / Marinara JSONL and the .json chat formats SillyTavern imports (oobabooga, Agnai,
// CAI Tools, Kobold Lite, RisuAI). Unreadable JSONL lines are skipped and reported as `skipped`.
router.post('/:charId/import', text, async (req, res) => {
    const characterName = String(req.query.character_name || '').trim() || 'Character';
    const userName = String(req.query.user_name || '').trim() || 'User';
    const filename = String(req.query.filename || '').replace(/\.(jsonl|json|txt)$/i, '').trim();
    const { chats, skipped, format } = convertChatImport(req.body, { userName, characterName });
    const ids = [];
    for (const chat of chats) {
        for (const k of ['user_name', 'character_name']) {
            if (!chat.meta[k] || chat.meta[k] === 'unused') chat.meta[k] = k === 'user_name' ? userName : characterName;
        }
        const base = chats.length === 1 && filename ? filename : `${characterName} - ${stamp()} imported`;
        let id;
        try { id = await freeChatId(req.params.charId, base); } catch { id = await freeChatId(req.params.charId, `${characterName} - ${stamp()} imported`); }
        await writeAtomic(fileFor(req.params.charId, id), toJsonl(chat));
        ids.push(id);
    }
    const warning = skipped ? `${skipped} line${skipped === 1 ? '' : 's'} couldn't be read and ${skipped === 1 ? 'was' : 'were'} skipped` : undefined;
    res.json({ id: ids[0], ids, skipped, format, ...(warning ? { warning } : {}) });
});

router.get('/:charId/:chatId/export', async (req, res) => {
    const file = fileFor(req.params.charId, req.params.chatId);
    if (!(await exists(file))) throw notFound('No such chat');
    const { meta, messages } = parseJsonl(await fsp.readFile(file, 'utf8'));
    // Always start with a header line, so SillyTavern (which expects one) can read it.
    const header = Object.keys(meta).length ? meta : {
        user_name: messages.find(m => m.is_user)?.name || 'User',
        character_name: messages.find(m => !m.is_user && !m.is_system)?.name || '',
        create_date: stamp(),
        chat_metadata: {},
    };
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(req.params.chatId)}.jsonl`);
    res.type('application/jsonl').send(toJsonl({ meta: header, messages }));
});

export default router;
