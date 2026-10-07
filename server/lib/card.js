// Character card normalization (V1 / V2 / V3 → V2-shaped storage that keeps V3 extras).
import zlib from 'node:zlib';
import { crc32 } from './png.js';

const TEXT_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version',
];

export function normalizeCard(raw) {
    if (!raw || typeof raw !== 'object') throw Object.assign(new Error('Invalid character data'), { status: 400 });
    // V2/V3 keep everything under `data`; V1 is flat.
    const src = raw.data && typeof raw.data === 'object' ? { ...raw.data } : { ...raw };
    const data = { ...src };
    for (const field of TEXT_FIELDS) data[field] = typeof src[field] === 'string' ? src[field] : (src[field] == null ? '' : String(src[field]));
    if (!data.name) data.name = raw.char_name || raw.name || 'Unnamed';
    if (!data.creator_notes && typeof raw.creatorcomment === 'string') data.creator_notes = raw.creatorcomment;
    data.alternate_greetings = Array.isArray(src.alternate_greetings) ? src.alternate_greetings.map(String) : [];
    data.tags = Array.isArray(src.tags) ? src.tags.map(String) : (Array.isArray(raw.tags) ? raw.tags.map(String) : []);
    data.extensions = src.extensions && typeof src.extensions === 'object' ? src.extensions : {};
    if (src.character_book && typeof src.character_book === 'object') data.character_book = src.character_book;
    else delete data.character_book;
    return { spec: 'chara_card_v2', spec_version: '2.0', data };
}

export function summarize(character) {
    const d = character.card.data;
    return {
        id: character.id,
        name: d.name,
        avatar: character.avatar,
        tags: d.tags,
        creator: d.creator,
        notes: (d.creator_notes || '').slice(0, 280),
        fav: !!character.fav,
        created: character.created,
        updated: character.updated,
        lastChat: character.lastChat || null,
    };
}

// A soft gradient PNG used as the avatar for characters created without one
// (and as the carrier image when exporting a card as PNG).
export function placeholderPng(seedText = 'Reverie', size = 256) {
    let hash = 0;
    for (const ch of seedText) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
    const hue = hash % 360;
    const [r1, g1, b1] = hsl(hue, 0.55, 0.32);
    const [r2, g2, b2] = hsl((hue + 60) % 360, 0.6, 0.55);
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (size * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < size; x++) {
            const t = (x + y) / (2 * size);
            const i = row + 1 + x * 3;
            raw[i] = r1 + (r2 - r1) * t;
            raw[i + 1] = g1 + (g2 - g1) * t;
            raw[i + 2] = b1 + (b2 - b1) * t;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = n => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
