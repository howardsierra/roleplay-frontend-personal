// Lorebooks / World Info, stored in SillyTavern's world format: { name, entries: { uid: entry } }.
import { api } from './api.js';
import { state, currentPersona, saveChatDebounced } from './state.js';
import { substituteParams } from './macros.js';

export const WI_POSITION = { before: 0, after: 1, ANTop: 2, ANBottom: 3, atDepth: 4, EMTop: 5, EMBottom: 6, outlet: 7 };
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
        delayUntilRecursion: false,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        useGroupScoring: null,
        sticky: 0,
        cooldown: 0,
        delay: 0,
        ignoreBudget: false,
        outletName: '',
        characterFilter: { isExclude: false, names: [], tags: [] },
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
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

// V2 character_book entry (ST keeps its extra fields in extensions; other tools sometimes use camelCase at the top).
function fromBookEntry(e, i) {
    const ext = e.extensions || {};
    const pick = (...vals) => vals.find(v => v !== undefined && v !== null);
    const posMap = { before_char: 0, after_char: 1 };
    return newEntry(i, {
        key: e.keys || e.key || [],
        keysecondary: e.secondary_keys || e.secondaryKeys || e.keysecondary || [],
        comment: e.comment || e.name || '',
        content: e.content || '',
        constant: !!e.constant,
        selective: e.selective ?? true,
        selectiveLogic: pick(ext.selectiveLogic, e.selectiveLogic, 0),
        order: pick(e.insertion_order, e.insertionOrder, e.order, 100),
        position: pick(ext.position, typeof e.position === 'number' ? e.position : undefined, posMap[e.position], 0),
        disable: e.enabled === false || !!e.disable,
        depth: pick(ext.depth, e.depth, 4),
        role: pick(ext.role, e.role, 0),
        probability: pick(ext.probability, e.probability, 100),
        useProbability: pick(ext.useProbability, e.useProbability, true),
        caseSensitive: pick(e.case_sensitive, ext.case_sensitive, e.caseSensitive, null),
        matchWholeWords: pick(ext.match_whole_words, e.matchWholeWords, null),
        excludeRecursion: !!pick(ext.exclude_recursion, e.excludeRecursion),
        preventRecursion: !!pick(ext.prevent_recursion, e.preventRecursion),
        delayUntilRecursion: !!pick(ext.delay_until_recursion, e.delayUntilRecursion),
        scanDepth: pick(ext.scan_depth, e.scanDepth, null),
        group: pick(ext.group, e.group, ''),
        groupOverride: !!pick(ext.group_override, e.groupOverride),
        groupWeight: pick(ext.group_weight, e.groupWeight, 100),
        useGroupScoring: pick(ext.use_group_scoring, e.useGroupScoring, null),
        sticky: pick(ext.sticky, e.sticky, 0),
        cooldown: pick(ext.cooldown, e.cooldown, 0),
        delay: pick(ext.delay, e.delay, 0),
        ignoreBudget: !!pick(ext.ignore_budget, e.ignoreBudget),
        outletName: pick(ext.outlet_name, e.outletName, ''),
        matchPersonaDescription: !!pick(ext.match_persona_description, e.matchPersonaDescription),
        matchCharacterDescription: !!pick(ext.match_character_description, e.matchCharacterDescription),
        matchCharacterPersonality: !!pick(ext.match_character_personality, e.matchCharacterPersonality),
        matchCharacterDepthPrompt: !!pick(ext.match_character_depth_prompt, e.matchCharacterDepthPrompt),
        matchScenario: !!pick(ext.match_scenario, e.matchScenario),
        matchCreatorNotes: !!pick(ext.match_creator_notes, e.matchCreatorNotes),
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
                delay_until_recursion: e.delayUntilRecursion, group_override: e.groupOverride, group_weight: e.groupWeight,
                use_group_scoring: e.useGroupScoring, sticky: e.sticky, cooldown: e.cooldown, delay: e.delay,
                ignore_budget: e.ignoreBudget, outlet_name: e.outletName,
                match_persona_description: e.matchPersonaDescription, match_character_description: e.matchCharacterDescription,
                match_character_personality: e.matchCharacterPersonality, match_character_depth_prompt: e.matchCharacterDepthPrompt,
                match_scenario: e.matchScenario, match_creator_notes: e.matchCreatorNotes,
            },
        })),
    };
}

const withoutUndefined = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v !== undefined));

export async function loadWorld(id) {
    if (state.worldsCache.has(id)) return state.worldsCache.get(id);
    const world = await api.get(`worlds/${encodeURIComponent(id)}`);
    // Fill in defaults: books written by other tools (or older Reverie) leave fields out.
    for (const [k, e] of Object.entries(world.entries || {})) world.entries[k] = newEntry(e.uid ?? Number(k), withoutUndefined(e));
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
    const byName = name => list.find(w => w.name === name);
    // Character-linked lorebook (ST stores the world name in extensions.world).
    const linked = state.character?.card?.data?.extensions?.world;
    const linkedBook = linked && byName(linked);
    if (linkedBook) ids.add(linkedBook.id);
    const chatBook = byName(state.chatMeta?.chat_metadata?.world_info);
    if (chatBook) ids.add(chatBook.id);
    // The persona's lorebook (SillyTavern's persona_description_lorebook).
    const personaBook = byName(currentPersona()?.st?.lorebook);
    if (personaBook) ids.add(personaBook.id);
    // This story's own lorebook (written by the Lorebook Keeper agent).
    const storyBook = state.chatMeta?.chat_metadata?.rv_agents?.loreBookId;
    if (storyBook && list.some(w => w.id === storyBook)) ids.add(storyBook);
    for (const id of ids) {
        try { books.push(await loadWorld(id)); } catch { /* deleted */ }
    }
    // The card's own book, unless it's already loaded as the linked lorebook.
    const embedded = state.character?.card?.data?.character_book;
    if (embedded?.entries?.length && !linkedBook) books.push(normalizeWorld(embedded, `${state.character.card.data.name} (embedded)`));
    return books;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function keyMatches(key, text, entry, cfg) {
    const k = String(key).trim();
    if (!k) return false;
    const rx = k.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
    if (rx) {
        try { return new RegExp(rx[1], rx[2]).test(text); } catch { return false; }
    }
    const caseSensitive = entry.caseSensitive ?? cfg.caseSensitive ?? false;
    const whole = entry.matchWholeWords ?? cfg.matchWholeWords ?? false;
    const hay = caseSensitive ? text : text.toLowerCase();
    // Fill in {{char}}/{{user}} first, then lowercase: names have capitals the lowercased text doesn't.
    const filled = substituteParams(k);
    const needle = caseSensitive ? filled : filled.toLowerCase();
    // Like ST, whole-word matching only applies to single-word keys.
    if (!whole || /\s/.test(needle)) return hay.includes(needle);
    return new RegExp(`(?:^|\\W)${escapeRegex(needle)}(?:$|\\W)`).test(hay);
}

/** How well an entry matches: 0 = not activated, otherwise the number of keys that hit (for group scoring). */
function entryScore(entry, text, cfg) {
    const primaryHits = (entry.key || []).filter(k => keyMatches(k, text, entry, cfg)).length;
    if (!primaryHits) return 0;
    const secondary = (entry.keysecondary || []).filter(k => String(k).trim());
    if (!entry.selective || !secondary.length) return primaryHits;
    const hits = secondary.map(k => keyMatches(k, text, entry, cfg));
    const n = hits.filter(Boolean).length;
    let ok;
    switch (Number(entry.selectiveLogic)) {
        case WI_LOGIC.AND_ALL: ok = n === hits.length; break;
        case WI_LOGIC.NOT_ANY: ok = n === 0; break;
        case WI_LOGIC.NOT_ALL: ok = n < hits.length; break;
        default: ok = n > 0;
    }
    return ok ? primaryHits + n : 0;
}

/** ST's per-entry character filter: only (or never) for these characters / tags. */
function passesCharacterFilter(entry) {
    const f = entry.characterFilter;
    if (!f || (!f.names?.length && !f.tags?.length)) return true;
    const c = state.character;
    const norm = s => String(s || '').toLowerCase().replace(/\.(png|json|webp)$/i, '').trim();
    if (f.names?.length) {
        const mine = new Set([c?.id, c?.avatar, c?.card?.data?.name].filter(Boolean).map(norm));
        const listed = f.names.some(n => mine.has(norm(n)));
        if (f.isExclude ? listed : !listed) return false;
    }
    if (f.tags?.length) {
        const tags = new Set((c?.card?.data?.tags || []).map(norm));
        const tagged = f.tags.some(t => tags.has(norm(t)));
        if (f.isExclude ? tagged : !tagged) return false;
    }
    return true;
}

/** Extra text an entry may also match against (ST's "match character description" etc.). */
function extraSources(entry) {
    const d = state.character?.card?.data ?? {};
    const parts = [];
    if (entry.matchPersonaDescription) parts.push(currentPersona()?.description);
    if (entry.matchCharacterDescription) parts.push(d.description);
    if (entry.matchCharacterPersonality) parts.push(d.personality);
    if (entry.matchCharacterDepthPrompt) parts.push(d.extensions?.depth_prompt?.prompt);
    if (entry.matchScenario) parts.push(state.chatMeta?.chat_metadata?.scenario || d.scenario);
    if (entry.matchCreatorNotes) parts.push(d.creator_notes);
    return parts.filter(Boolean).map(t => substituteParams(t)).join('\n');
}

function weightedPick(list) {
    const weights = list.map(e => Math.max(0, Number(e.groupWeight ?? 100)) || 0);
    const total = weights.reduce((a, b) => a + b, 0);
    if (!total) return list[0];
    let r = Math.random() * total;
    for (let i = 0; i < list.length; i++) if ((r -= weights[i]) < 0) return list[i];
    return list.at(-1);
}

/**
 * Scan the chat and return activated lore, grouped by where it goes.
 * Timed effects (sticky / cooldown / delay) are counted in messages and remembered per chat.
 * @returns {{ before: string, after: string, anTop: string, anBottom: string, emTop: string, emBottom: string,
 *   outlets: Record<string,string>, depth: Array<{content, depth, role}>, activated: object[], total: number }}
 */
export async function scanWorldInfo(chatMessages, { contextTokens = 64000, forced = [], dryRun = false } = {}) {
    const empty = { before: '', after: '', anTop: '', anBottom: '', emTop: '', emBottom: '', outlets: {}, depth: [], activated: [], total: 0 };
    const books = await activeBooks();
    const cfg = state.settings.worlds;
    const entries = [];
    const seen = new Set();
    for (const book of books) {
        if (seen.has(book.name)) continue; // the same book linked twice (character + chat, say)
        seen.add(book.name);
        for (const raw of Object.values(book.entries || {})) {
            const e = newEntry(raw.uid, withoutUndefined(raw));
            if (e.disable || !String(e.content || '').trim() || !passesCharacterFilter(e)) continue;
            entries.push({ ...e, book: book.name });
        }
    }
    if (!entries.length) return empty;

    // ----- timed effects -----
    const turn = chatMessages.length;
    const meta = state.chatMeta?.chat_metadata;
    const timed = dryRun || !meta ? structuredClone(meta?.rv_timed_wi || {}) : (meta.rv_timed_wi ??= {});
    let timedChanged = false;
    const timedState = id => {
        const r = timed[id];
        if (!r) return 'none';
        if (turn < r.at) { delete timed[id]; timedChanged = true; return 'none'; } // the chat was rewound
        if (turn === r.at || turn < r.stickyEnd) return 'sticky'; // same turn (a regenerate) or still sticking
        if (turn < r.cooldownEnd) return 'cooldown';
        delete timed[id];
        timedChanged = true;
        return 'none';
    };

    const recent = chatMessages.slice(-Math.max(1, cfg.scanDepth || 4));
    const lines = recent.map(m => (cfg.includeNames ? `${m.name}: ${m.mes}` : m.mes));
    const baseText = lines.join('\n');
    const activated = new Map(); // id -> entry
    const scores = new Map();
    const sticky = new Set();
    let scanText = baseText;
    for (let pass = 0; pass < (cfg.recursive ? 4 : 1); pass++) {
        let added = '';
        for (const e of entries) {
            const id = `${e.book}:${e.uid}`;
            if (activated.has(id)) continue;
            const t = timedState(id);
            if (t === 'cooldown') continue;
            if (t === 'sticky') {
                activated.set(id, e);
                sticky.add(id);
                scores.set(id, Infinity);
                if (!e.preventRecursion) added += `\n${e.content}`;
                continue;
            }
            if (Number(e.delay) > 0 && turn < Number(e.delay)) continue;
            const isForced = forced.includes(e.uid);
            if (e.delayUntilRecursion && pass === 0 && !isForced && !e.constant) continue;
            let score = e.constant || isForced ? 1 : 0;
            if (!score) {
                const depthText = e.scanDepth ? chatMessages.slice(-e.scanDepth).map(m => (cfg.includeNames ? `${m.name}: ${m.mes}` : m.mes)).join('\n') : scanText;
                let text = pass > 0 && e.excludeRecursion ? baseText : depthText;
                const extra = extraSources(e);
                if (extra) text += `\n${extra}`;
                score = entryScore(e, text, cfg);
            }
            if (!score) continue;
            if (e.useProbability && Number(e.probability ?? 100) < 100 && Math.random() * 100 >= Number(e.probability)) continue;
            activated.set(id, e);
            scores.set(id, score);
            if (!e.preventRecursion) added += `\n${e.content}`;
        }
        if (!added) break;
        scanText = `${scanText}\n${added}`;
    }

    // Inclusion groups (ST): one entry per group. Sticky entries win, then "prioritize" entries (highest
    // order), then optionally the best-scoring ones; the rest is a weighted draw.
    const groups = new Map();
    for (const [id, e] of activated) {
        for (const g of String(e.group || '').split(',').map(s => s.trim()).filter(Boolean)) {
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(id);
        }
    }
    for (const ids of groups.values()) {
        let pool = ids.filter(id => activated.has(id));
        if (pool.length < 2) continue;
        let winner;
        const stuck = pool.filter(id => sticky.has(id));
        if (stuck.length) winner = stuck[0];
        else {
            const prio = pool.filter(id => activated.get(id).groupOverride);
            if (prio.length) winner = prio.sort((a, b) => activated.get(b).order - activated.get(a).order)[0];
            else {
                const scoring = pool.some(id => activated.get(id).useGroupScoring ?? cfg.useGroupScoring);
                if (scoring) {
                    const best = Math.max(...pool.map(id => scores.get(id) || 0));
                    pool = pool.filter(id => (scores.get(id) || 0) === best);
                }
                const picked = weightedPick(pool.map(id => activated.get(id)));
                winner = pool.find(id => activated.get(id) === picked);
            }
        }
        for (const id of pool) if (id !== winner && !sticky.has(id)) activated.delete(id);
    }

    // Budget (rough token estimate), highest order first. Constant and "ignore budget" entries always fit.
    const budget = Math.floor(contextTokens * (cfg.budgetPercent || 30) / 100) * 3.5;
    const sorted = [...activated.entries()].sort((a, b) => b[1].order - a[1].order);
    const kept = [];
    let used = 0;
    for (const [id, e] of sorted) {
        const content = substituteParams(e.content);
        if (used + content.length > budget && !e.constant && !e.ignoreBudget) continue;
        used += content.length;
        kept.push({ ...e, content });
        // Start (or keep) the entry's sticky / cooldown clock.
        if (!sticky.has(id) && (Number(e.sticky) > 0 || Number(e.cooldown) > 0)) {
            const stickyEnd = turn + (Number(e.sticky) || 0);
            timed[id] = { at: turn, stickyEnd, cooldownEnd: stickyEnd + (Number(e.cooldown) || 0) };
            timedChanged = true;
        }
    }
    if (timedChanged && !dryRun && meta) saveChatDebounced();

    kept.sort((a, b) => a.order - b.order);
    const at = pos => kept.filter(e => Number(e.position) === pos).map(e => e.content).join('\n');
    const outlets = {};
    for (const e of kept.filter(e => Number(e.position) === WI_POSITION.outlet && e.outletName)) {
        outlets[e.outletName] = outlets[e.outletName] ? `${outlets[e.outletName]}\n${e.content}` : e.content;
    }
    const depth = kept.filter(e => Number(e.position) === WI_POSITION.atDepth).map(e => ({
        content: e.content, depth: Number(e.depth) || 0, role: ['system', 'user', 'assistant'][Number(e.role) || 0],
    }));
    return {
        before: at(WI_POSITION.before),
        after: at(WI_POSITION.after),
        anTop: at(WI_POSITION.ANTop),
        anBottom: at(WI_POSITION.ANBottom),
        emTop: at(WI_POSITION.EMTop),
        emBottom: at(WI_POSITION.EMBottom),
        outlets,
        depth,
        activated: kept,
        total: entries.length,
    };
}
