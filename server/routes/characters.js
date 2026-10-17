import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, DIRS, listJson, newId, readJson, removeFile, within, writeJson, writeAtomic } from '../lib/storage.js';
import { isPng, readCardText, writeCardText } from '../lib/png.js';
import { normalizeCard, placeholderPng, summarize, bannerData } from '../lib/card.js';

const router = express.Router();
const raw = express.raw({ type: () => true, limit: '64mb' });
const charFile = id => within(DIRS.characters, `${id}.json`);

async function load(id) {
    const c = await readJson(charFile(id));
    if (!c) throw Object.assign(new Error('Character not found'), { status: 404 });
    return c;
}

function imageExt(buf) {
    if (isPng(buf)) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
    if (buf.subarray(0, 3).toString() === 'GIF') return 'gif';
    return null;
}

async function saveAvatar(id, buf) {
    const ext = imageExt(buf);
    if (!ext) throw Object.assign(new Error('Unsupported image type'), { status: 400 });
    const name = `${id}-${Date.now().toString(36)}.${ext}`;
    await writeAtomic(within(DIRS.avatars, name), buf);
    return name;
}

async function createFromCard(card, avatarBuf) {
    const id = newId();
    const character = { id, card: normalizeCard(card), avatar: null, fav: false, created: Date.now(), updated: Date.now() };
    if (avatarBuf) character.avatar = await saveAvatar(id, avatarBuf);
    await writeJson(charFile(id), character);
    return character;
}

// ---------------------------------------------------------------- the built-in Assistant
// Like SillyTavern's and Marinara Engine's default assistant: a plain helpful chat partner (not a roleplay
// character) for questions, brainstorming and drafting cards or lore. Added once; delete it and it stays gone
// (the Characters browser can add it back).
const ASSISTANT_MARK = path.join(DATA_DIR, '.assistant-added');

export function assistantCard() {
    return {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: 'Assistant',
            description: 'A helpful, friendly general-purpose assistant built into Reverie. Not a roleplay character: it answers directly. Good for questions, brainstorming characters and plots, drafting character cards and lorebook entries, polishing writing, and explaining prompts, presets and settings.',
            personality: 'Warm, clear, practical, honest about what it doesn\'t know.',
            scenario: '',
            first_mes: 'Hi {{user}}! I\'m your assistant. Ask me anything, or try:\n\n- *“Help me create a character for a cozy fantasy story.”*\n- *“Write three lorebook entries for a cyberpunk city.”*\n- *“Make this paragraph more atmospheric.”*\n- *“What do temperature and top-p actually do?”*',
            mes_example: '',
            creator_notes: 'Reverie\'s built-in assistant. Chats with it work like any other chat. Its own main prompt replaces the preset\'s roleplay instructions.',
            system_prompt: 'You are {{char}}, a knowledgeable, friendly assistant built into Reverie, a roleplay and creative-writing app. You are not roleplaying and you are not a character in a story: talk with {{user}} directly as yourself. Help with anything they ask: questions, brainstorming, writing and editing, creating characters, scenarios and lorebook entries, and explaining AI settings and prompts. Use Markdown when it helps (headings, lists, tables, code blocks). Be concise by default and go into detail when asked. If you are unsure, say so.',
            post_history_instructions: '',
            alternate_greetings: [],
            tags: ['assistant'],
            creator: 'Reverie',
            character_version: '1.0',
            extensions: { reverie: { assistant: true }, talkativeness: '0.5', fav: false, world: '', depth_prompt: { prompt: '', depth: 4, role: 'system' } },
        },
    };
}

const isAssistant = c => !!c?.card?.data?.extensions?.reverie?.assistant;

export async function addAssistant() {
    const avatar = await fsp.readFile(new URL('../assets/assistant.png', import.meta.url)).catch(() => null);
    return createFromCard(assistantCard(), avatar);
}

/** On startup: add the Assistant the first time Reverie runs with this data folder. */
export async function seedAssistant() {
    if (await fsp.access(ASSISTANT_MARK).then(() => true, () => false)) return;
    const all = await listJson(DIRS.characters);
    if (!all.some(x => isAssistant(x.data))) await addAssistant();
    await fsp.writeFile(ASSISTANT_MARK, `${new Date().toISOString()}\n`);
}

router.post('/assistant', async (_req, res) => {
    const all = await listJson(DIRS.characters);
    const existing = all.find(x => isAssistant(x.data));
    res.json(existing ? existing.data : await addAssistant());
});

router.get('/', async (_req, res) => {
    const all = await listJson(DIRS.characters);
    res.json(all.map(x => summarize(x.data)).sort((a, b) => (b.lastChat || b.updated) - (a.lastChat || a.updated)));
});

// The character's Avatar Banner as an image (it's stored in the card as a data URL), so lists can show it cheaply.
router.get('/:id/banner', async (req, res) => {
    const m = String(bannerData(await load(req.params.id)).banner || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    if (!m) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=31536000, immutable').type(m[1]).send(Buffer.from(m[2], 'base64'));
});

router.get('/:id', async (req, res) => res.json(await load(req.params.id)));

router.post('/', async (req, res) => {
    const character = await createFromCard(req.body.card ?? req.body);
    res.json(character);
});

router.put('/:id', async (req, res) => {
    const c = await load(req.params.id);
    if (req.body.card) c.card = normalizeCard(req.body.card);
    // Partial updates merge into the saved card, so a writer that only changes a few fields (an editor, the
    // sheet, a banner, an extension) never overwrites other changes with an out-of-date copy of the card.
    if (req.body.data && typeof req.body.data === 'object' && !Array.isArray(req.body.data)) {
        const { extensions, ...fields } = req.body.data;
        c.card = normalizeCard({ ...c.card, data: { ...c.card.data, ...fields } });
    }
    if (req.body.extensions && typeof req.body.extensions === 'object' && !Array.isArray(req.body.extensions)) {
        c.card.data.extensions = { ...(c.card.data.extensions || {}), ...req.body.extensions };
    }
    if ('fav' in req.body) c.fav = !!req.body.fav;
    if ('lastChat' in req.body) c.lastChat = req.body.lastChat;
    c.updated = Date.now();
    await writeJson(charFile(c.id), c);
    res.json(c);
});

router.delete('/:id', async (req, res) => {
    const c = await load(req.params.id);
    if (c.avatar) await removeFile(within(DIRS.avatars, c.avatar));
    await removeFile(within(DIRS.chats, c.id));
    await removeFile(charFile(c.id));
    res.json({ ok: true });
});

router.post('/:id/duplicate', async (req, res) => {
    const c = await load(req.params.id);
    let avatar = null;
    if (c.avatar) avatar = await fsp.readFile(within(DIRS.avatars, c.avatar)).catch(() => null);
    const card = structuredClone(c.card);
    card.data.name = `${card.data.name} (copy)`;
    res.json(await createFromCard(card, avatar));
});

// Import a PNG card (V2 "chara" / V3 "ccv3" chunk) or a JSON card.
router.post('/import', raw, async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: 'Empty upload' });
    let card;
    let avatar = null;
    if (isPng(buf)) {
        const text = readCardText(buf);
        const json = text.ccv3 || text.chara;
        if (!json) return res.status(400).json({ error: 'This PNG has no character data in it' });
        card = JSON.parse(json);
        avatar = buf;
    } else {
        try {
            card = JSON.parse(buf.toString('utf8'));
        } catch {
            return res.status(400).json({ error: 'Not a PNG or JSON character card' });
        }
    }
    res.json(await createFromCard(card, avatar));
});

router.post('/:id/avatar', raw, async (req, res) => {
    const c = await load(req.params.id);
    const old = c.avatar;
    c.avatar = await saveAvatar(c.id, req.body);
    c.updated = Date.now();
    await writeJson(charFile(c.id), c);
    if (old) await removeFile(within(DIRS.avatars, old));
    res.json(c);
});

router.get('/:id/export.:fmt', async (req, res) => {
    const c = await load(req.params.id);
    const filename = encodeURIComponent(c.card.data.name || 'character');
    if (req.params.fmt === 'json') {
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}.json`);
        return res.json(c.card);
    }
    let png = null;
    if (c.avatar && path.extname(c.avatar) === '.png') png = await fsp.readFile(within(DIRS.avatars, c.avatar)).catch(() => null);
    if (!png) png = placeholderPng(c.card.data.name);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}.png`);
    res.type('png').send(writeCardText(png, c.card));
});

export default router;
