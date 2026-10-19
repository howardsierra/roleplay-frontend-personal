// Character card normalization (V1 / V2 / V3 → V2-shaped storage that keeps V3 extras).
import zlib from 'node:zlib';
import { crc32 } from './png.js';

const TEXT_FIELDS = [
    'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
    'creator_notes', 'system_prompt', 'post_history_instructions', 'creator', 'character_version',
];

// SillyTavern's old flat (V1) fields that are not part of V2 `data`; they're dropped or moved on upconversion.
const V1_LEFTOVERS = ['avatar', 'chat', 'create_date', 'creatorcomment', 'json_data', 'talkativeness', 'fav',
    'depth_prompt_prompt', 'depth_prompt_depth', 'depth_prompt_role', 'spec', 'spec_version', 'data'];

const splitTags = tags => (typeof tags === 'string' ? tags.split(',').map(x => x.trim()).filter(Boolean)
    : Array.isArray(tags) ? tags.map(String) : []);

/**
 * A flat V1 card (or a gradio / Pygmalion one) → V2 `data`, like SillyTavern's convertToV2 / charaFormatData:
 * talkativeness, fav and depth_prompt_* move into data.extensions; avatar/chat/create_date/json_data are dropped.
 */
export function upconvertV1(raw) {
    // Gradio / Pygmalion export: { char_name, char_persona, char_greeting, world_scenario, example_dialogue }.
    const gradio = typeof raw.char_name === 'string' && !('name' in raw);
    const src = gradio ? {
        name: raw.char_name,
        description: raw.char_persona,
        personality: raw.personality,
        scenario: raw.world_scenario,
        first_mes: raw.char_greeting,
        mes_example: raw.example_dialogue,
    } : raw;
    const data = {};
    // Foreign keys ST doesn't know are kept (charaFormatData keeps json_data's other fields).
    if (!gradio) for (const [k, v] of Object.entries(raw)) if (!V1_LEFTOVERS.includes(k)) data[k] = v;
    for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']) data[k] = src[k] ?? '';
    data.creator_notes = src.creator_notes || raw.creatorcomment || '';
    data.tags = splitTags(raw.tags);
    const ext = raw.extensions && typeof raw.extensions === 'object' ? { ...raw.extensions } : {};
    ext.talkativeness = raw.talkativeness || ext.talkativeness || 0.5;
    ext.fav = raw.fav === true || raw.fav === 'true';
    ext.world = ext.world || raw.world || '';
    const depth = Number(raw.depth_prompt_depth);
    if (raw.depth_prompt_prompt != null || !ext.depth_prompt) {
        ext.depth_prompt = {
            prompt: raw.depth_prompt_prompt ?? '',
            depth: raw.depth_prompt_depth != null && !Number.isNaN(depth) ? depth : 4,
            role: raw.depth_prompt_role ?? 'system',
        };
    }
    data.extensions = ext;
    return data;
}

// Marinara keeps backstory / appearance as card extensions; other apps only read the description.
function foldMarinaraExtras(data) {
    const ext = data.extensions;
    for (const [key, label] of [['backstory', 'Backstory'], ['appearance', 'Appearance']]) {
        const value = ext?.[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        if (!data.description.includes(value.trim())) data.description = [data.description, `${label}:\n${value.trim()}`].filter(Boolean).join('\n\n');
        delete ext[key];
    }
}

export function normalizeCard(raw, { fromImport = false } = {}) {
    if (!raw || typeof raw !== 'object') throw Object.assign(new Error('Invalid character data'), { status: 400 });
    // V2/V3 keep everything under `data`; V1 is flat.
    const isV1 = !(raw.data && typeof raw.data === 'object') && !raw.spec;
    const src = isV1 ? upconvertV1(raw) : { ...(raw.data || {}) };
    const data = { ...src };
    for (const field of TEXT_FIELDS) data[field] = typeof src[field] === 'string' ? src[field] : (src[field] == null ? '' : String(src[field]));
    if (!data.name) data.name = raw.char_name || raw.name || 'Unnamed';
    if (!data.creator_notes && typeof raw.creatorcomment === 'string') data.creator_notes = raw.creatorcomment;
    data.alternate_greetings = Array.isArray(src.alternate_greetings) ? src.alternate_greetings.map(String)
        : typeof src.alternate_greetings === 'string' && src.alternate_greetings ? [src.alternate_greetings] : [];
    data.tags = src.tags != null ? splitTags(src.tags) : splitTags(raw.tags);
    data.extensions = src.extensions && typeof src.extensions === 'object' && !Array.isArray(src.extensions) ? src.extensions : {};
    if (src.character_book && typeof src.character_book === 'object') data.character_book = src.character_book;
    else delete data.character_book;
    if (fromImport) foldMarinaraExtras(data);
    // Remember V3 cards so they're exported as V3 again.
    const v3 = raw.spec === 'chara_card_v3';
    return { spec: v3 ? 'chara_card_v3' : 'chara_card_v2', spec_version: v3 ? String(raw.spec_version || '3.0') : '2.0', data };
}

/** The card as SillyTavern exports it: V2/V3 plus the old top-level V1 fields, with private fields cleared. */
export function exportableCard(card) {
    const out = structuredClone(card);
    const d = out.data;
    d.extensions = { ...(d.extensions || {}), fav: false };
    return {
        name: d.name,
        description: d.description,
        personality: d.personality,
        scenario: d.scenario,
        first_mes: d.first_mes,
        mes_example: d.mes_example,
        creatorcomment: d.creator_notes,
        avatar: 'none',
        talkativeness: d.extensions.talkativeness ?? 0.5,
        fav: false,
        tags: d.tags || [],
        ...out,
    };
}

/** A Reverie (SillyTavern-format) world → V2 character_book, field for field like ST's convertWorldInfoToCharacterBook. */
export function worldToCharacterBook(name, entries) {
    const result = { entries: [], name };
    for (const index in entries || {}) {
        const entry = entries[index];
        result.entries.push({
            id: entry.uid,
            keys: entry.key,
            secondary_keys: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            constant: entry.constant,
            selective: entry.selective,
            insertion_order: entry.order,
            enabled: !entry.disable,
            position: entry.position == 0 ? 'before_char' : 'after_char',
            use_regex: true, // ST keys are always regex
            extensions: {
                ...entry.extensions,
                position: entry.position,
                exclude_recursion: entry.excludeRecursion,
                display_index: entry.displayIndex,
                probability: entry.probability ?? null,
                useProbability: entry.useProbability ?? false,
                depth: entry.depth ?? 4,
                selectiveLogic: entry.selectiveLogic ?? 0,
                outlet_name: entry.outletName ?? '',
                group: entry.group ?? '',
                group_override: entry.groupOverride ?? false,
                group_weight: entry.groupWeight ?? null,
                prevent_recursion: entry.preventRecursion ?? false,
                delay_until_recursion: entry.delayUntilRecursion ?? false,
                scan_depth: entry.scanDepth ?? null,
                match_whole_words: entry.matchWholeWords ?? null,
                use_group_scoring: entry.useGroupScoring ?? false,
                case_sensitive: entry.caseSensitive ?? null,
                automation_id: entry.automationId ?? '',
                role: entry.role ?? 0,
                vectorized: entry.vectorized ?? false,
                sticky: entry.sticky ?? null,
                cooldown: entry.cooldown ?? null,
                delay: entry.delay ?? null,
                match_persona_description: entry.matchPersonaDescription ?? false,
                match_character_description: entry.matchCharacterDescription ?? false,
                match_character_personality: entry.matchCharacterPersonality ?? false,
                match_character_depth_prompt: entry.matchCharacterDepthPrompt ?? false,
                match_scenario: entry.matchScenario ?? false,
                match_creator_notes: entry.matchCreatorNotes ?? false,
                triggers: entry.triggers ?? [],
                ignore_budget: entry.ignoreBudget ?? false,
            },
        });
    }
    return result;
}

export function summarize(character) {
    const d = character.card.data;
    return {
        id: character.id,
        name: d.name,
        avatar: character.avatar,
        tags: d.tags,
        creator: d.creator,
        assistant: !!d.extensions?.reverie?.assistant,
        notes: (d.creator_notes || '').slice(0, 280),
        fav: !!character.fav,
        created: character.created,
        updated: character.updated,
        lastChat: character.lastChat || null,
        banner: !!bannerData(character).banner,
        accent: bannerData(character).accentColor || null,
    };
}

/** Avatar Banner data stored in the card (SillyTavern-AvatarBanner's format). */
export const bannerData = character => character?.card?.data?.extensions?.['SillyTavern-AvatarBanner'] || {};

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
