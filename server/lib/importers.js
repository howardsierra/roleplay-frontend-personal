// Importers for character cards and chats from other apps (SillyTavern, Marinara Engine, Lumiverse, RisuAI,
// Agnai, oobabooga, CAI Tools, Kobold Lite, Chub). Pure functions so they can be unit-tested.
import JSZip from 'jszip';
import { isPng, readCardText } from './png.js';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- character cards

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
export const isZip = buf => buf.indexOf(ZIP_SIGNATURE) >= 0 && buf.indexOf(ZIP_SIGNATURE) < 1024 * 1024 && !isPng(buf);

/** `data:image/...;base64,...` → Buffer (or null). */
export function decodeDataUrl(url) {
    const m = String(url || '').match(/^data:image\/[\w.+-]+;base64,(.+)$/s);
    return m ? Buffer.from(m[1], 'base64') : null;
}

const CHARX_PREFIXES = ['embeded://', 'embedded://', '__asset:'];
const CHARX_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'apng', 'avif', 'bmp', 'jfif']);

/** CharX (.charx ZIP: card.json + assets/…): the card, its main icon as the avatar, and any Lumiverse world books. */
export async function readCharX(buf) {
    const start = buf.indexOf(ZIP_SIGNATURE); // self-extracting archives have a stub in front
    const zip = await JSZip.loadAsync(start > 0 ? buf.subarray(start) : buf);
    const cardFile = zip.file('card.json');
    if (!cardFile) throw fail('This archive has no card.json (not a CharX card)');
    const card = JSON.parse(await cardFile.async('string'));
    if (card.spec === undefined) throw fail('Invalid CharX card file: missing spec field');
    const icons = (Array.isArray(card.data?.assets) ? card.data.assets : []).map(a => {
        const uri = String(a?.uri || '').trim();
        const prefix = CHARX_PREFIXES.find(p => uri.toLowerCase().startsWith(p));
        if (!prefix) return null;
        const zipPath = uri.slice(prefix.length).replace(/\\/g, '/').replace(/^\/+/, '');
        const ext = String(a.ext || zipPath.split('.').pop() || '').toLowerCase().replace(/^\./, '');
        return { type: String(a.type || '').toLowerCase(), name: String(a.name || ''), ext, zipPath };
    }).filter(a => a && a.type === 'icon' && CHARX_IMAGE_EXT.has(a.ext));
    const icon = icons.find(a => a.name.toLowerCase() === 'main') || icons[0];
    let avatar = null;
    if (icon) avatar = await zip.file(icon.zipPath)?.async('nodebuffer') ?? null;
    if (!avatar) { // no asset list: fall back to the first image under assets/icon/
        const first = Object.keys(zip.files).find(p => /^assets\/icon\/.+\.(png|jpe?g|webp|gif)$/i.test(p));
        if (first) avatar = await zip.file(first).async('nodebuffer');
    }
    let books = [];
    const modules = zip.file('lumiverse_modules.json');
    if (modules) {
        try {
            const parsed = JSON.parse(await modules.async('string'));
            if (Array.isArray(parsed?.world_books)) books = parsed.world_books;
        } catch { /* optional extra: ignore if broken */ }
    }
    return { card, avatar, books };
}

/**
 * Any supported character upload → { card, avatar (Buffer|null), books (extra lorebooks for the client) }.
 * PNG (chara / ccv3), CharX, SillyTavern V1/V2/V3 JSON, gradio/Pygmalion JSON, Marinara native export.
 */
export async function parseCharacterUpload(buf) {
    try {
        return await parseUpload(buf);
    } catch (err) {
        if (err instanceof SyntaxError) throw fail(`The character data couldn't be read: ${err.message}`);
        if (!err.status && /zip|central directory|end of data/i.test(err.message)) throw fail(`Not a valid CharX archive: ${err.message}`);
        throw err;
    }
}

async function parseUpload(buf) {
    if (!Buffer.isBuffer(buf) || !buf.length) throw fail('Empty upload');
    if (isPng(buf)) {
        const text = readCardText(buf);
        const json = text.ccv3 || text.chara;
        if (!json) throw fail('This PNG has no character data in it');
        return { card: JSON.parse(json), avatar: buf, books: [] };
    }
    if (isZip(buf)) return readCharX(buf);
    let json;
    try {
        json = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
    } catch {
        throw fail('Not a PNG, CharX or JSON character card');
    }
    return unwrapCharacterJson(json);
}

/** JSON cards, including Marinara Engine's native export envelope (with an embedded avatar). */
export function unwrapCharacterJson(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw fail('Not a character card');
    if (json.type === 'marinara_character' && json.data && typeof json.data === 'object') {
        const { avatar, sprites, gallery, metadata, ...card } = json.data;
        const inner = card.data && typeof card.data === 'object' ? card : { spec: 'chara_card_v2', spec_version: '2.0', data: card };
        return { card: inner, avatar: decodeDataUrl(avatar), books: [] };
    }
    // A JSON card carrying its avatar as a data URL (some exporters do this).
    const avatar = decodeDataUrl(json.avatar) || decodeDataUrl(json.data?.avatar);
    if (avatar) {
        json = { ...json };
        delete json.avatar;
        if (json.data?.avatar) json.data = { ...json.data, avatar: undefined };
    }
    return { card: json, avatar, books: [] };
}

// ---------------------------------------------------------------- chats

/** SillyTavern JSONL, skipping lines that aren't valid JSON. Returns { meta, messages, skipped }. */
export function parseJsonlLines(src) {
    const lines = String(src).split(/\r?\n/).filter(l => l.trim());
    const parsed = [];
    let skipped = 0;
    for (const line of lines) {
        try {
            const value = JSON.parse(line);
            if (value && typeof value === 'object' && !Array.isArray(value)) parsed.push(value);
            else skipped++;
        } catch { skipped++; }
    }
    if (!parsed.length) return { meta: {}, messages: [], skipped };
    const first = parsed[0];
    const isHeader = !('mes' in first) && ('chat_metadata' in first || 'user_name' in first || 'create_date' in first);
    return { meta: isHeader ? first : {}, messages: isHeader ? parsed.slice(1) : parsed, skipped };
}

const now = () => new Date().toISOString();
const msg = (name, isUser, mes, sendDate = now()) => ({ name, is_user: isUser, send_date: sendDate, mes: String(mes ?? ''), extra: {} });

// Ports of SillyTavern's src/endpoints/chats.js importers. Each returns a list of message arrays.
const importers = {
    kobold(data) {
        const input = '{{[INPUT]}}';
        const output = '{{[OUTPUT]}}';
        const user = String(data.savedsettings?.chatname || 'User');
        const char = String(data.savedsettings?.chatopponent || 'Character').split('||$||')[0];
        const one = m => {
            const isUser = String(m).includes(input);
            return msg(isUser ? user : char, isUser, String(m).replaceAll(input, '').replaceAll(output, '').trim());
        };
        const messages = (data.actions || []).map(one);
        if (data.prompt) messages.unshift(one(data.prompt));
        return [messages];
    },
    cai(data, { userName, characterName }) {
        return (data.histories?.histories ?? []).map(h => (h.msgs || []).map(m => msg(m.src?.is_human ? userName : characterName, !!m.src?.is_human, m.text)));
    },
    ooba(data, { userName, characterName }) {
        const messages = [];
        for (const pair of data.data_visible) {
            if (pair?.[0]) messages.push(msg(userName, true, pair[0]));
            if (pair?.[1]) messages.push(msg(characterName, false, pair[1]));
        }
        return [messages];
    },
    agnai(data, { userName, characterName }) {
        return [data.messages.map(m => msg(m.userId ? userName : characterName, !!m.userId, m.msg))];
    },
    risu(data, { userName, characterName }) {
        return [(data.data?.message || []).map(m => {
            const isUser = m.role === 'user';
            return msg(m.name ?? (isUser ? userName : characterName), isUser, m.data ?? '', new Date(Number(m.time ?? Date.now())).toISOString());
        })];
    },
};

/** Which SillyTavern-supported .json chat format this is (or null). */
export function detectJsonChat(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.savedsettings !== undefined) return 'kobold';
    if (data.histories !== undefined) return 'cai';
    if (Array.isArray(data.data_visible)) return 'ooba';
    if (Array.isArray(data.messages)) return 'agnai';
    if (data.type === 'risuChat') return 'risu';
    return null;
}

// Chub's JSONL keeps mes / swipes as { message } objects.
function flattenChub(m) {
    if (m.mes && typeof m.mes === 'object' && 'message' in m.mes) m.mes = m.mes.message;
    if (Array.isArray(m.swipes)) m.swipes = m.swipes.map(s => (s && typeof s === 'object' && 'message' in s ? s.message : s));
    return m;
}

const newRvId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Marinara / DeepSeek-style extras: message ids, reasoning, and Marinara's rolling summaries → Reverie memory. */
export function adoptForeignFields(chat) {
    const byMarinaraId = new Map();
    chat.messages.forEach((m, i) => {
        const marinaraId = m.marinara_message_id ?? m.extra?.marinara_message_id;
        if (marinaraId && !m.rv_id) m.rv_id = String(marinaraId);
        if (marinaraId) byMarinaraId.set(String(marinaraId), i);
        if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
            m.extra = { ...(m.extra || {}) };
            if (!m.extra.reasoning) m.extra.reasoning = m.reasoning_content;
            delete m.reasoning_content;
        }
    });
    const meta = chat.meta.chat_metadata;
    const summaries = meta?.summaryEntries ?? meta?.marinara_metadata?.summaryEntries;
    if (Array.isArray(summaries) && summaries.length && !meta.rv_memory?.entries?.length) {
        const entries = [];
        for (const s of summaries) {
            if (!s || typeof s !== 'object' || !String(s.content || '').trim()) continue;
            // The messages it covers: by Marinara message id, else by index range.
            let indexes = (Array.isArray(s.messageIds) ? s.messageIds : []).map(id => byMarinaraId.get(String(id))).filter(i => i != null);
            if (!indexes.length && Number.isFinite(s.rangeStartIndex) && Number.isFinite(s.rangeEndIndex)) indexes = [s.rangeStartIndex, s.rangeEndIndex];
            indexes = indexes.filter(i => i >= 0 && i < chat.messages.length);
            const from = indexes.length ? Math.min(...indexes) : null;
            const to = indexes.length ? Math.max(...indexes) : null;
            const idOf = i => {
                if (i == null) return null;
                const m = chat.messages[i];
                m.rv_id ??= m.extra?.rv_id || newRvId();
                return m.rv_id;
            };
            const created = Date.parse(s.createdAt);
            entries.push({
                id: `mem${String(s.id || Math.random().toString(36).slice(2, 10)).replace(/[^\w-]/g, '').slice(0, 24)}`,
                title: String(s.title || 'Summary'),
                text: String(s.content),
                keys: [],
                fromId: idOf(from),
                toId: idOf(to),
                toIndex: to == null ? 0 : to + 1,
                created: Number.isFinite(created) ? created : Date.now(),
                enabled: s.enabled !== false,
                pinned: false,
            });
        }
        if (entries.length) meta.rv_memory = { ...(meta.rv_memory || {}), entries };
    }
    return chat;
}

/**
 * An uploaded chat file → { chats: [{ meta, messages }], skipped, format }.
 * Accepts SillyTavern / Chub / Marinara JSONL and the .json formats SillyTavern imports.
 */
export function convertChatImport(src, { userName = 'User', characterName = 'Character' } = {}) {
    const text = String(src ?? '').replace(/^﻿/, '');
    const header = () => ({ user_name: userName, character_name: characterName, create_date: now(), chat_metadata: {} });
    // A single JSON document (not JSONL)?
    let whole;
    try { whole = JSON.parse(text); } catch { whole = undefined; }
    const format = detectJsonChat(whole);
    if (format) {
        const chats = importers[format](whole, { userName, characterName }).map(messages => ({ meta: header(), messages }));
        if (!chats.length) throw fail('That chat file has no conversations in it');
        return { chats, skipped: 0, format };
    }
    const parsed = parseJsonlLines(text);
    if (!parsed.messages.length && !Object.keys(parsed.meta).length) throw fail(parsed.skipped ? 'None of the lines in that file could be read' : 'That chat file is empty');
    const meta = { ...header(), ...parsed.meta };
    meta.chat_metadata = meta.chat_metadata && typeof meta.chat_metadata === 'object' ? meta.chat_metadata : {};
    const chat = adoptForeignFields({ meta, messages: parsed.messages.map(flattenChub) });
    return { chats: [chat], skipped: parsed.skipped, format: 'jsonl' };
}
