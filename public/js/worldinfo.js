// Lorebooks / World Info, stored in SillyTavern's world format: { name, entries: { uid: entry } }.
import { api } from './api.js';
import { state } from './state.js';
import { substituteParams } from './macros.js';

export const WI_POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6 };
export const WI_LOGIC = { AND_ANY: 0, NOT_ALL: 1, NOT_ANY: 2, AND_ALL: 3 };

export function newEntry(uid, partial = {}) {
    return {
        uid,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        constant: false,
        selective: true,
        selectiveLogic: 0,
        order: 100,
        position: 0,
        disable: false,
        depth: 4,
        role: 0,
        probability: 100,
        useProbability: true,
        excludeRecursion: false,
        preventRecursion: false,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        group: '',
        ...partial,
    };
}

/** Accepts an ST world file, a V2 character_book, or a list of entries. */
export function normalizeWorld(json, fallbackName = 'Lorebook') {
    if (json?.entries && !Array.isArray(json.entries)) {
        const entries = {};
        for (const [k, e] of Object.entries(json.entries)) entries[k] = newEntry(Number(e.uid ?? k), e);
        return { name: json.name || fallbackName, entries };
    }
    const list = Array.isArray(json?.entries) ? json.entries : Array.isArray(json) ? json : [];
    return { name: json?.name || fallbackName, entries: Object.fromEntries(list.map((e, i) => [i, fromBookEntry(e, i)])) };
}

function fromBookEntry(e, i) {
    const ext = e.extensions || {};
    const posMap = { before_char: 0, after_char: 1 };
    return newEntry(i, {
        key: e.keys || e.key || [],
        keysecondary: e.secondary_keys || e.keysecondary || [],
        comment: e.comment || e.name || '',
        content: e.content || '',
        constant: !!e.constant,
        selective: e.selective ?? true,
        selectiveLogic: ext.selectiveLogic ?? 0,
        order: e.insertion_order ?? e.order ?? 100,
        position: ext.position ?? posMap[e.position] ?? 0,
        disable: e.enabled === false,
        depth: ext.depth ?? 4,
        role: ext.role ?? 0,
        probability: ext.probability ?? 100,
        useProbability: ext.useProbability ?? true,
        caseSensitive: e.case_sensitive ?? ext.case_sensitive ?? null,
        matchWholeWords: ext.match_whole_words ?? null,
        excludeRecursion: !!ext.exclude_recursion,
        preventRecursion: !!ext.prevent_recursion,
        scanDepth: ext.scan_depth ?? null,
        group: ext.group || '',
    });
}

/** ST world → V2 character_book (for embedding in exported cards). */
export function toCharacterBook(world) {
    return {
        name: world.name,
        entries: Object.values(world.entries || {}).map((e, i) => ({
            id: i,
            keys: e.key,
            secondary_keys: e.keysecondary,
            comment: e.comment,
            content: e.content,
            constant: e.constant,
            selective: e.selective,
            insertion_order: e.order,
            enabled: !e.disable,
            position: e.position === 1 ? 'after_char' : 'before_char',
            case_sensitive: e.caseSensitive,
            extensions: {
                position: e.position, depth: e.depth, role: e.role, probability: e.probability,
                useProbability: e.useProbability, selectiveLogic: e.selectiveLogic, group: e.group,
                exclude_recursion: e.excludeRecursion, prevent_recursion: e.preventRecursion,
                match_whole_words: e.matchWholeWords, scan_depth: e.scanDepth,
            },
        })),
    };
}

export async function loadWorld(id) {
    if (state.worldsCache.has(id)) return state.worldsCache.get(id);
    const world = await api.get(`worlds/${encodeURIComponent(id)}`);
    state.worldsCache.set(id, world);
    return world;
}

export async function saveWorld(world) {
    const saved = await api.put(`worlds/${encodeURIComponent(world.id)}`, world);
    state.worldsCache.set(saved.id, saved);
    return saved;
}

async function activeBooks() {
    const books = [];
    const list = await api.get('worlds').catch(() => []);
    const ids = new Set(state.settings.worlds.active || []);
    // Character-linked lorebook (ST stores the world name in extensions.world).
    const linked = state.character?.card?.data?.extensions?.world;
    if (linked) for (const w of list) if (w.name === linked) ids.add(w.id);
    for (const w of list) if ((state.chatMeta?.chat_metadata?.world_info || null) === w.name) ids.add(w.id);
    // The persona's lorebook (SillyTavern's persona_description_lorebook).
    const personaBook = (state.settings.personas || []).find(p => p.id === state.settings.personaId)?.st?.lorebook;
    if (personaBook) for (const w of list) if (w.name === personaBook) ids.add(w.id);
    for (const id of ids) {
        try { books.push(await loadWorld(id)); } catch { /* deleted */ }
    }
    const embedded = state.character?.card?.data?.character_book;
    if (embedded?.entries?.length && !linked) books.push(normalizeWorld(embedded, `${state.character.card.data.name} (embedded)`));
    return books;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyMatches(key, text, entry) {
    const k = String(key).trim();
    if (!k) return false;
    const rx = k.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (rx) {
        try { return new RegExp(rx[1], rx[2]).test(text); } catch { return false; }
    }
    const caseSensitive = entry.caseSensitive ?? false;
    const whole = entry.matchWholeWords ?? false;
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = substituteParams(caseSensitive ? k : k.toLowerCase());
    if (!whole) return hay.includes(needle);
    return new RegExp(`(?:^|\\W)${escapeRegex(needle)}(?:$|\\W)`, caseSensitive ? '' : 'i').test(hay);
}

function entryActivates(entry, text) {
    if (entry.constant) return true;
    const primary = (entry.key || []).some(k => keyMatches(k, text, entry));
    if (!primary) return false;
    const secondary = (entry.keysecondary || []).filter(k => String(k).trim());
    if (!entry.selective || !secondary.length) return true;
    const hits = secondary.map(k => keyMatches(k, text, entry));
    switch (Number(entry.selectiveLogic)) {
        case WI_LOGIC.AND_ALL: return hits.every(Boolean);
        case WI_LOGIC.NOT_ANY: return !hits.some(Boolean);
        case WI_LOGIC.NOT_ALL: return !hits.every(Boolean);
        default: return hits.some(Boolean);
    }
}

/**
 * Scan the chat and return activated lore, grouped by where it goes.
 * @returns {{ before: string, after: string, depth: Array<{content, depth, role}>, activated: object[] }}
 */
export async function scanWorldInfo(chatMessages, { contextTokens = 64000, forced = [] } = {}) {
    const books = await activeBooks();
    const cfg = state.settings.worlds;
    const entries = [];
    for (const book of books) {
        for (const e of Object.values(book.entries || {})) if (!e.disable && String(e.content || '').trim()) entries.push({ ...e, book: book.name });
    }
    if (!entries.length) return { before: '', after: '', depth: [], activated: [], total: 0 };

    const recent = chatMessages.slice(-Math.max(1, cfg.scanDepth || 4));
    const lines = recent.map(m => (cfg.includeNames ? `${m.name}: ${m.mes}` : m.mes));
    const baseText = lines.join('\n');
    const activated = new Map();
    let scanText = baseText;
    for (let pass = 0; pass < (cfg.recursive ? 4 : 1); pass++) {
        let added = '';
        for (const e of entries) {
            const id = `${e.book}:${e.uid}`;
            if (activated.has(id)) continue;
            const depthText = e.scanDepth ? chatMessages.slice(-e.scanDepth).map(m => m.mes).join('\n') : scanText;
            const text = pass > 0 && e.excludeRecursion ? baseText : depthText;
            if (!(entryActivates(e, text) || forced.includes(e.uid))) continue;
            if (e.useProbability && e.probability < 100 && Math.random() * 100 >= e.probability) continue;
            activated.set(id, e);
            if (!e.preventRecursion) added += `\n${e.content}`;
        }
        if (!added) break;
        scanText = `${baseText}\n${added}`;
    }

    // Inclusion groups: keep only the highest-order entry per group.
    const byGroup = new Map();
    for (const [id, e] of activated) {
        if (!e.group) continue;
        for (const g of String(e.group).split(',').map(s => s.trim()).filter(Boolean)) {
            const prev = byGroup.get(g);
            if (!prev || e.order > prev[1].order) {
                if (prev) activated.delete(prev[0]);
                byGroup.set(g, [id, e]);
            } else activated.delete(id);
        }
    }

    // Budget (rough token estimate), highest order first.
    const budget = Math.floor(contextTokens * (cfg.budgetPercent || 30) / 100) * 3.5;
    const sorted = [...activated.values()].sort((a, b) => b.order - a.order);
    const kept = [];
    let used = 0;
    for (const e of sorted) {
        const content = substituteParams(e.content);
        if (used + content.length > budget && !e.constant) continue;
        used += content.length;
        kept.push({ ...e, content });
    }
    kept.sort((a, b) => a.order - b.order);
    const before = kept.filter(e => [0, 5].includes(Number(e.position))).map(e => e.content).join('\n');
    const after = kept.filter(e => [1, 2, 3, 6].includes(Number(e.position))).map(e => e.content).join('\n');
    const depth = kept.filter(e => Number(e.position) === 4).map(e => ({
        content: e.content, depth: Number(e.depth) || 0, role: ['system', 'user', 'assistant'][Number(e.role) || 0],
    }));
    return { before, after, depth, activated: kept, total: entries.length };
}
