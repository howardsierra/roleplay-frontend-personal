import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DIRS, listJson, newId, readJson, removeFile, within, writeJson, writeAtomic } from '../lib/storage.js';
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
