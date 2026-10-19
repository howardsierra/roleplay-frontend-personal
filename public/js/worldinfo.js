// Lorebooks / World Info, stored in SillyTavern's world format: { name, entries: { uid: entry } }.
import { api } from './api.js';
import { state, currentPersona, saveChatDebounced } from './state.js';
import { substituteParams } from './macros.js';
import { applyRegex, REGEX_PLACEMENT } from './regex.js';
import { runWorldInfoInterceptors, preparePullMacros } from './spindle/hooks.js';

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
        triggers: [], // generation types it's limited to (empty = all)
        automationId: '',
        vectorized: false,
        displayIndex: null,
        ...partial,
    };
}

/**
 * Accepts an ST world file, a V2 character_book, a list of entries, or a lorebook exported by NovelAI, Agnai,
 * RisuAI, Lumiverse or Marinara Engine.
 */
export function normalizeWorld(json, fallbackName = 'Lorebook') {
    const converted = convertForeignBook(json, fallbackName);
    if (converted) return converted;
    if (json?.entries && !Array.isArray(json.entries)) {
        const entries = {};
        for (const [k, e] of Object.entries(json.entries)) {
            // Marinara's "compatible" export flags regex keys with useRegex / regex.
            const fixed = e && (e.useRegex === true || e.regex === true) ? { ...e, key: regexKeys(e.key, e.caseSensitive), keysecondary: regexKeys(e.keysecondary, e.caseSensitive) } : e;
            entries[k] = newEntry(Number(e?.uid ?? k), fixed);
        }
        return { name: json.name || fallbackName, entries };
    }
    const list = Array.isArray(json?.entries) ? json.entries : Array.isArray(json) ? json : [];
    const entries = {};
    list.forEach((e, i) => {
        const entry = fromBookEntry(e, i);
        while (entries[entry.uid]) entry.uid = Math.max(list.length, ...Object.keys(entries).map(Number)) + 1; // duplicate ids
        entries[entry.uid] = entry;
    });
    return { name: json?.name || fallbackName, entries };
}

// V2 character_book entry (ST keeps its extra fields in extensions; other tools sometimes use camelCase at the top).
function fromBookEntry(e, i) {
    const ext = e.extensions || {};
    const pick = (...vals) => vals.find(v => v !== undefined && v !== null);
    const posMap = { before_char: 0, after_char: 1 };
    const known = new Set(['position', 'depth', 'role', 'probability', 'useProbability', 'selectiveLogic', 'group', 'group_override',
        'group_weight', 'use_group_scoring', 'exclude_recursion', 'prevent_recursion', 'delay_until_recursion', 'match_whole_words',
        'case_sensitive', 'scan_depth', 'sticky', 'cooldown', 'delay', 'ignore_budget', 'outlet_name', 'match_persona_description',
        'match_character_description', 'match_character_personality', 'match_character_depth_prompt', 'match_scenario',
        'match_creator_notes', 'triggers', 'automation_id', 'vectorized', 'display_index']);
    const otherExt = Object.fromEntries(Object.entries(ext).filter(([k]) => !known.has(k)));
    const uid = Number.isFinite(Number(e.id)) ? Number(e.id) : i;
    return newEntry(uid, {
        ...(Object.keys(otherExt).length ? { extensions: otherExt } : {}),
        // Marinara writes regex keys as plain patterns flagged useRegex / regex (snake use_regex only counts when the
        // entry is clearly Marinara's: SillyTavern sets use_regex on every entry and uses /…/ for real regexes).
        key: marinaraRegex(e) ? regexKeys(e.keys || e.key, pick(e.case_sensitive, e.caseSensitive)) : e.keys || e.key || [],
        keysecondary: marinaraRegex(e) ? regexKeys(e.secondary_keys || e.secondaryKeys || e.keysecondary, pick(e.case_sensitive, e.caseSensitive)) : e.secondary_keys || e.secondaryKeys || e.keysecondary || [],
        comment: e.comment || e.name || '',
        content: e.content || '',
        constant: !!e.constant,
        selective: !!e.selective, // SillyTavern's convertCharacterBook: `selective || false`
        selectiveLogic: toLogic(pick(ext.selectiveLogic, e.selectiveLogic, ext.selective_logic, e.selective_logic, 0)),
        order: pick(e.insertion_order, e.insertionOrder, e.order, 100),
        // No position at all reads as "after" in SillyTavern (anything but 'before_char').
        position: pick(ext.position, typeof e.position === 'number' ? e.position : undefined, posMap[e.position], 1),
        disable: e.enabled === false || !!e.disable,
        depth: pick(ext.depth, e.depth, 4),
        role: toRole(pick(ext.role, e.role, 0)),
        probability: pick(ext.probability, e.probability, 100),
        useProbability: pick(ext.useProbability, e.useProbability, ext.use_probability, true),
        caseSensitive: pick(e.case_sensitive, ext.case_sensitive, e.caseSensitive, null),
        matchWholeWords: pick(ext.match_whole_words, e.matchWholeWords, null),
        excludeRecursion: !!pick(ext.exclude_recursion, e.excludeRecursion),
        preventRecursion: !!pick(ext.prevent_recursion, e.preventRecursion),
        delayUntilRecursion: pick(ext.delay_until_recursion, e.delayUntilRecursion, false), // true or a level number
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
        triggers: pick(ext.triggers, e.triggers, []),
        automationId: pick(ext.automation_id, e.automationId, ''),
        vectorized: !!pick(ext.vectorized, e.vectorized),
        displayIndex: pick(ext.display_index, e.displayIndex, null),
    });
}

/** ST world → V2 character_book (for embedding in exported cards). */
export function toCharacterBook(world) {
    return {
        name: world.name,
        entries: Object.values(world.entries || {}).map((e, i) => ({
            id: Number.isFinite(Number(e.uid)) ? Number(e.uid) : i,
            keys: e.key,
            secondary_keys: e.keysecondary,
            comment: e.comment,
            content: e.content,
            constant: e.constant,
            selective: e.selective,
            insertion_order: e.order,
            enabled: !e.disable,
            position: Number(e.position) === 0 ? 'before_char' : 'after_char', // what ST writes for every other position
            case_sensitive: e.caseSensitive,
            use_regex: true,
            extensions: {
                case_sensitive: e.caseSensitive,
                ...(e.extensions || {}),
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
                triggers: e.triggers || [], automation_id: e.automationId || '', vectorized: !!e.vectorized,
                display_index: e.displayIndex ?? i,
            },
        })),
    };
}

// ---------------------------------------------------------------- lorebooks from other apps

const LOGIC_NAMES = { and: 0, and_any: 0, or: 0, not_all: 1, not: 2, not_any: 2, and_all: 3 };
/** selectiveLogic as a number: Marinara uses names ('and', 'not_all'…), some files a numeric string. */
function toLogic(v) {
    if (typeof v === 'string') return LOGIC_NAMES[v.trim().toLowerCase()] ?? (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : 0);
    return Number.isFinite(Number(v)) ? Number(v) : 0;
}
const toRole = v => (typeof v === 'string' ? ({ system: 0, user: 1, assistant: 2 }[v.toLowerCase()] ?? (Number(v) || 0)) : Number(v) || 0);
const marinaraRegex = e => e.useRegex === true || e.regex === true || (e.use_regex === true && typeof e.selectiveLogic === 'string');
/** Plain regex patterns → SillyTavern's /pattern/flags keys (patterns already written as /…/ stay as they are). */
function regexKeys(keys, caseSensitive) {
    const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? keys.split(',') : [];
    return list.map(k => String(k).trim()).filter(Boolean).map(k => (/^\/.+\/[gimsuy]*$/.test(k) ? k : `/${k}/${caseSensitive ? '' : 'i'}`));
}
const splitKeys = v => (Array.isArray(v) ? v.map(String) : String(v ?? '').split(',').map(x => x.trim()).filter(Boolean));
const book = (name, list) => ({ name, entries: Object.fromEntries(list.map((e, i) => [i, newEntry(i, { displayIndex: i, ...e })])) });

/** NovelAI / Agnai / RisuAI / Lumiverse / Marinara lorebooks → a Reverie world (null if it's none of those). */
export function convertForeignBook(json, fallbackName = 'Lorebook') {
    if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
    if (json.lorebookVersion !== undefined && Array.isArray(json.entries)) return fromNovelAI(json, fallbackName);
    if (json.kind === 'memory' && Array.isArray(json.entries)) return fromAgnai(json, fallbackName);
    if (json.type === 'risu' && Array.isArray(json.data)) return fromRisu(json, fallbackName);
    if (json.type === 'lumiverse_world_book' && Array.isArray(json.entries)) return fromLumiverse(json, fallbackName);
    if (json.type === 'marinara_lorebook' && json.data && typeof json.data === 'object') return fromMarinara(json.data, fallbackName);
    return null;
}

// SillyTavern's convertNovelLorebook.
function fromNovelAI(json, fallbackName) {
    return book(json.name || fallbackName, json.entries.map(e => ({
        key: splitKeys(e.keys), comment: e.displayName || '', content: e.text || '',
        constant: false, selective: false, order: e.contextConfig?.budgetPriority ?? 0, position: 0, disable: !e.enabled,
    })));
}

// SillyTavern's convertAgnaiMemoryBook.
function fromAgnai(json, fallbackName) {
    return book(json.name || fallbackName, json.entries.map(e => ({
        key: splitKeys(e.keywords), comment: e.name || '', content: e.entry || '',
        constant: false, selective: false, order: e.weight ?? 100, position: 0, disable: !e.enabled,
    })));
}

// SillyTavern's convertRisuLorebook.
function fromRisu(json, fallbackName) {
    return book(json.name || fallbackName, json.data.map(e => ({
        key: splitKeys(e.key), keysecondary: e.secondkey ? splitKeys(e.secondkey) : [], comment: e.comment || '', content: e.content || '',
        constant: !!e.alwaysActive, selective: !!e.selective, order: e.insertorder ?? 100, position: 0, disable: false,
        probability: e.activationPercent ?? 100, useProbability: true,
    })));
}

// Lumiverse's native world book export: snake_case fields, positions 0-6 like SillyTavern, 7 = at a
// {{wi_marker}} (no Reverie equivalent: placed before the character), 8 = outlet-only.
function fromLumiverse(json, fallbackName) {
    const pos = p => (Number(p) === 8 ? 7 : Number(p) === 7 ? 0 : Number.isFinite(Number(p)) ? Number(p) : 0);
    return book(json.name || fallbackName, json.entries.map(e => {
        const ext = e.extensions || {};
        const keys = v => (e.use_regex ? regexKeys(v, e.case_sensitive) : splitKeys(v));
        return {
            key: keys(e.key ?? e.keys), keysecondary: keys(e.keysecondary ?? e.secondary_keys ?? []),
            comment: e.comment || '', content: e.content || '',
            constant: !!e.constant, selective: !!e.selective, selectiveLogic: toLogic(e.selective_logic ?? 0),
            order: e.order_value ?? 100, position: pos(e.position), depth: e.depth ?? 4, role: toRole(e.role ?? 0),
            disable: !!e.disabled, probability: e.probability ?? 100, useProbability: e.use_probability ?? true,
            group: e.group_name || '', groupOverride: !!e.group_override, groupWeight: e.group_weight ?? 100,
            excludeRecursion: !!e.exclude_recursion, preventRecursion: !!e.prevent_recursion,
            delayUntilRecursion: e.delay_until_recursion ?? false, matchWholeWords: e.match_whole_words ?? null,
            caseSensitive: e.case_sensitive ?? null, scanDepth: e.scan_depth ?? null,
            sticky: e.sticky ?? 0, cooldown: e.cooldown ?? 0, delay: e.delay ?? 0,
            outletName: e.outlet_name || '', automationId: e.automation_id || '', vectorized: !!e.vectorized,
            ...(ext.characterFilter ? { characterFilter: ext.characterFilter } : {}),
            ...(Array.isArray(ext.triggers) ? { triggers: ext.triggers } : {}),
        };
    }));
}

// Marinara Engine's native lorebook export: { lorebook, entries, folders }. Positions 0/1/2/7 (2 = at depth),
// role and selectiveLogic as names, regex keys as plain patterns, entries in disabled folders are off.
function fromMarinara(data, fallbackName) {
    const offFolders = new Set((data.folders || []).filter(f => f && f.enabled === false).map(f => f.id));
    const pos = p => ({ 0: 0, 1: 1, 2: 4, 7: 7 }[Number(p)] ?? 0);
    const entries = (Array.isArray(data.entries) ? data.entries : []).slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return book(data.lorebook?.name || fallbackName, entries.map(e => {
        const keys = v => (e.useRegex ? regexKeys(v, e.caseSensitive) : splitKeys(v ?? []));
        return {
            key: keys(e.keys), keysecondary: keys(e.secondaryKeys), comment: e.name || '', content: e.content || '',
            constant: !!e.constant, selective: !!e.selective, selectiveLogic: toLogic(e.selectiveLogic),
            order: e.order ?? 100, position: pos(e.position), depth: e.depth ?? 4, role: toRole(e.role ?? 0),
            disable: e.enabled === false || offFolders.has(e.folderId),
            probability: e.probability ?? 100, useProbability: e.probability != null,
            scanDepth: e.scanDepth ?? null, matchWholeWords: e.matchWholeWords ?? null, caseSensitive: e.caseSensitive ?? null,
            sticky: e.sticky ?? 0, cooldown: e.cooldown ?? 0, delay: e.delay ?? 0,
            group: e.group || '', groupWeight: e.groupWeight ?? 100, outletName: e.outletName || '',
            excludeRecursion: !!e.excludeRecursion, preventRecursion: !!e.preventRecursion, delayUntilRecursion: !!e.delayUntilRecursion,
            vectorized: e.excludeFromVectorization === false,
        };
    }));
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



// Where a book comes from decides its priority (SillyTavern's order): chat lore, then persona lore, then
// character and global lore by the chosen strategy.
export const WI_STRATEGY = { evenly: 0, characterFirst: 1, globalFirst: 2 };

async function activeBooks() {
    const list = await api.get('worlds').catch(() => []);
    const byName = name => (name ? list.find(w => w.name === name) : null);
    const sources = new Map(); // id -> source
    const add = (w, source) => { if (w && !sources.has(w.id)) sources.set(w.id, source); };
    const meta = state.chatMeta?.chat_metadata || {};
    add(byName(meta.world_info), 'chat');
    // This story's own lorebook (written by the Lorebook Keeper agent).
    add(list.find(w => w.id === meta.rv_agents?.loreBookId), 'chat');
    // The persona's lorebook (SillyTavern's persona_description_lorebook).
    add(byName(currentPersona()?.st?.lorebook), 'persona');
    // Character-linked lorebook (ST keeps its name in extensions.world), plus any extra books.
    const ext = state.character?.card?.data?.extensions || {};
    const linked = byName(ext.world);
    add(linked, 'character');
    for (const name of extraBooks()) add(byName(name), 'character');
    for (const id of state.settings.worlds.active || []) add(list.find(w => w.id === id), 'global');
    const books = [];
    for (const [id, source] of sources) {
        try { books.push({ book: await loadWorld(id), source }); } catch { /* deleted */ }
    }
    // The card's own book, unless it's already loaded as the linked lorebook.
    const embedded = state.character?.card?.data?.character_book;
    if (embedded?.entries?.length && !linked) books.push({ book: normalizeWorld(embedded, `${state.character.card.data.name} (embedded)`), source: 'character' });
    return books;
}

/** A character's additional lorebooks (ST's "extra books" for the character). */
export function extraBooks(character = state.character) {
    const ext = character?.card?.data?.extensions || {};
    const fromCard = Array.isArray(ext.extra_worlds) ? ext.extra_worlds : [];
    // Imported from SillyTavern settings: world_info.charLore [{ name: avatar file, extraBooks }]
    const avatar = String(character?.avatar || character?.id || '').replace(/\.(png|webp|json)$/i, '');
    const fromSt = (state.settings.worlds.charLore || []).find(c => String(c.name || '').replace(/\.(png|webp|json)$/i, '') === avatar)?.extraBooks || [];
    return [...new Set([...fromCard, ...fromSt].filter(Boolean))];
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** ST's "/pattern/flags" keys; a pattern with an unescaped / in it isn't a regex. */
function parseRegexKey(k) {
    const m = k.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!m || /(?<!\\)\//.test(m[1])) return null;
    try { return new RegExp(m[1], m[2]); } catch { return null; }
}

function keyMatches(key, text, entry, cfg) {
    // Macros first: a key like /{{char}}'s sword/i is a regex once {{char}} is filled in.
    const k = substituteParams(String(key ?? '')).trim();
    if (!k) return false;
    const rx = parseRegexKey(k);
    if (rx) return rx.test(text);
    const caseSensitive = entry.caseSensitive ?? cfg.caseSensitive ?? false;
    const whole = entry.matchWholeWords ?? cfg.matchWholeWords ?? false;
    const hay = caseSensitive ? text : text.toLowerCase();
    const needle = caseSensitive ? k : k.toLowerCase();
    // Like ST, whole-word matching only applies to single-word keys.
    if (!whole || /\s/.test(needle)) return hay.includes(needle);
    return new RegExp(`(?:^|\\W)${escapeRegex(needle)}(?:$|\\W)`).test(hay);
}

function entryMatches(entry, text, cfg) {
    if (!(entry.key || []).some(k => keyMatches(k, text, entry, cfg))) return false;
    const secondary = (entry.keysecondary || []).filter(k => String(k).trim());
    if (!entry.selective || !secondary.length) return true;
    const hits = secondary.map(k => keyMatches(k, text, entry, cfg));
    switch (Number(entry.selectiveLogic)) {
        case WI_LOGIC.AND_ALL: return hits.every(Boolean);
        case WI_LOGIC.NOT_ANY: return !hits.some(Boolean);
        case WI_LOGIC.NOT_ALL: return !hits.every(Boolean);
        default: return hits.some(Boolean);
    }
}

/** ST's group score: matching keys; secondary keys count for AND ANY, and for AND ALL only when all match. */
function groupScore(entry, text, cfg) {
    const primary = (entry.key || []).filter(k => String(k).trim());
    if (!primary.length) return 0;
    const p = primary.filter(k => keyMatches(k, text, entry, cfg)).length;
    const secondary = (entry.keysecondary || []).filter(k => String(k).trim());
    if (!secondary.length) return p;
    const s = secondary.filter(k => keyMatches(k, text, entry, cfg)).length;
    if (Number(entry.selectiveLogic) === WI_LOGIC.AND_ANY) return p + s;
    if (Number(entry.selectiveLogic) === WI_LOGIC.AND_ALL) return s === secondary.length ? p + s : p;
    return p;
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
    // Like ST, tags only filter characters that have tags.
    const cardTags = (c?.card?.data?.tags || []).map(norm);
    if (f.tags?.length && cardTags.length) {
        const tagged = f.tags.some(t => cardTags.includes(norm(t)));
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

/** ST decorators: leading "@@activate" / "@@dont_activate" lines (and "@@@" fallbacks) come off the content. */
const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];
function parseDecorators(content) {
    if (!content.startsWith('@@')) return [[], content];
    const lines = content.split('\n');
    const decorators = [];
    let fallback = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('@@')) return [decorators, lines.slice(i).join('\n')];
        if (line.startsWith('@@@') && !fallback) continue;
        const name = line.startsWith('@@@') ? line.slice(1) : line;
        if (KNOWN_DECORATORS.some(d => name.startsWith(d))) { decorators.push(name.trim()); fallback = false; } else fallback = true;
    }
    return [decorators, ''];
}

const tokens = text => Math.ceil(String(text || '').length / 3.6);
const delayLevel = e => (e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion) || 0);

/**
 * Scan the chat and return activated lore, grouped by where it goes. Follows SillyTavern's scan: passes for
 * recursion (and "delay until recursion" levels), inclusion groups decided before chance rolls, a token
 * budget applied in priority order, timed effects (sticky / cooldown / delay, in messages, kept per chat),
 * minimum activations widening the scan, decorators and generation-type triggers.
 * @param {object[]} chatMessages the visible history, oldest first
 * @param {object} opts
 * @param {string[]} [opts.scanLines] the history as the model will see it (regex applied, thinking removed),
 *   one string per message, oldest first; defaults to the raw messages
 * @param {string[]} [opts.injections] other prompt text to scan (extension prompts marked for scanning, the quiet prompt)
 * @param {string} [opts.type] generation type, for entries limited to some types
 */
export async function scanWorldInfo(chatMessages, { contextTokens = 64000, maxTokens = 0, forced = [], dryRun = false, scanLines, injections = [], type = 'normal' } = {}) {
    const empty = { before: '', after: '', anTop: '', anBottom: '', emTop: [], emBottom: [], outlets: {}, depth: [], activated: [], skipped: [], total: 0 };
    const cfg = state.settings.worlds;
    const loaded = await activeBooks();

    // ----- entries, in priority order -----
    const byOrder = (a, b) => b.order - a.order;
    const groupsOf = { chat: [], persona: [], character: [], global: [] };
    const seen = new Set();
    let total = 0;
    for (const { book, source } of loaded) {
        if (seen.has(book.name)) continue; // the same book linked twice (character + chat, say)
        seen.add(book.name);
        for (const raw of Object.values(book.entries || {})) {
            const e = newEntry(raw.uid, withoutUndefined(raw));
            if (e.disable || !passesCharacterFilter(e)) continue;
            const [decorators, content] = parseDecorators(String(e.content || ''));
            if (!content.trim() && !decorators.length) continue;
            total++;
            groupsOf[source].push({ ...e, content, decorators, book: book.name, id: `${book.name}:${e.uid}` });
        }
    }
    const strategy = Number(cfg.characterStrategy ?? WI_STRATEGY.characterFirst);
    const rest = strategy === WI_STRATEGY.evenly ? [...groupsOf.character, ...groupsOf.global].sort(byOrder)
        : strategy === WI_STRATEGY.globalFirst ? [...groupsOf.global.sort(byOrder), ...groupsOf.character.sort(byOrder)]
            : [...groupsOf.character.sort(byOrder), ...groupsOf.global.sort(byOrder)];
    let entries = [...groupsOf.chat.sort(byOrder), ...groupsOf.persona.sort(byOrder), ...rest];
    // Lumiverse world info interceptors can disable, force or rewrite entries before activation.
    const wiHook = await runWorldInfoInterceptors(entries, { chatMessages, type, dryRun });
    entries = wiHook.entries;
    await preparePullMacros(entries.map(e => e.content));
    if (!entries.length) return empty;
    const priority = new Map(entries.map((e, i) => [e.id, i]));

    // ----- timed effects -----
    const turn = chatMessages.length;
    const meta = state.chatMeta?.chat_metadata;
    const timed = dryRun || !meta ? structuredClone(meta?.rv_timed_wi || {}) : (meta.rv_timed_wi ??= {});
    let timedChanged = false;
    const timedState = e => {
        const r = timed[e.id];
        if (!r) return 'none';
        // The chat was rewound, or the entry no longer has timed effects.
        if (turn < r.at || (!(Number(e.sticky) > 0) && !(Number(e.cooldown) > 0))) { delete timed[e.id]; timedChanged = true; return 'none'; }
        if (turn === r.at || turn < r.stickyEnd) return 'sticky'; // same turn (a regenerate) or still sticking
        if (turn < r.cooldownEnd) return 'cooldown';
        delete timed[e.id];
        timedChanged = true;
        return 'none';
    };
    const timedNow = new Map(entries.map(e => [e.id, timedState(e)]));
    const isSticky = e => timedNow.get(e.id) === 'sticky';

    // ----- the text each entry is matched against -----
    const lines = (scanLines || chatMessages.map(m => m.mes ?? '')).map((text, i) => {
        const m = chatMessages[i];
        return cfg.includeNames && m?.name ? `${m.name}: ${text}` : String(text ?? '');
    });
    const globalDepth = Math.max(0, Number(cfg.scanDepth ?? 2));
    let skew = 0; // min activations widen the scan
    const recurse = [];
    const injected = injections.filter(t => String(t || '').trim());
    const STATE = { none: 0, initial: 1, recursion: 2, minActivations: 3 };
    const textFor = (e, scanState) => {
        const depth = (e.scanDepth === null || e.scanDepth === undefined || e.scanDepth === '' ? globalDepth : Number(e.scanDepth)) + skew;
        const parts = depth > 0 ? [lines.slice(-depth).join('\n')] : [];
        const extra = extraSources(e);
        if (extra) parts.push(extra);
        if (injected.length) parts.push(injected.join('\n'));
        if (recurse.length && scanState !== STATE.minActivations) parts.push(recurse.join('\n'));
        return parts.join('\n');
    };

    // ----- budget -----
    let budget = Math.round((Number(cfg.budgetPercent) || 25) * Math.max(1, contextTokens - (maxTokens || 0)) / 100) || 1;
    if (Number(cfg.budgetCap) > 0) budget = Math.min(budget, Number(cfg.budgetCap));
    let used = 0;
    let overflowed = false;

    const activated = new Map(); // id -> entry (with macros filled in)
    const failedRoll = new Set();
    const leftOut = new Map(); // id -> { e, reason }: matched but kept out
    const levels = [...new Set(entries.filter(e => delayLevel(e)).map(delayLevel))].sort((a, b) => a - b);
    let level = levels.shift() ?? 0;
    const maxSteps = Number(cfg.maxRecursionSteps) || 0;
    const minActivations = Number(cfg.minActivations) || 0;
    const minDepthMax = Number(cfg.minActivationsDepthMax) || 0;
    let scanState = STATE.initial;
    let steps = 0;

    while (scanState) {
        if ((maxSteps && steps >= maxSteps) || steps >= 50) break;
        steps++;
        const now = [];
        for (const e of entries) {
            if (activated.has(e.id) || failedRoll.has(e.id)) continue;
            if (Array.isArray(e.triggers) && e.triggers.length && !e.triggers.includes(type)) continue;
            const sticky = isSticky(e);
            const matchesNow = () => e.constant || entryMatches(e, textFor(e, scanState), cfg);
            if (Number(e.delay) > 0 && turn < Number(e.delay)) {
                if (matchesNow()) leftOut.set(e.id, { e, reason: `waits until the chat has ${e.delay} messages` });
                continue;
            }
            if (timedNow.get(e.id) === 'cooldown') {
                if (matchesNow()) leftOut.set(e.id, { e, reason: `cooling down (${timed[e.id].cooldownEnd - turn} more messages)` });
                continue;
            }
            const lvl = delayLevel(e);
            if (lvl && !sticky && (scanState !== STATE.recursion || lvl > level)) continue;
            if (scanState === STATE.recursion && cfg.recursive && e.excludeRecursion && !sticky) continue;
            if (e.decorators.includes('@@activate')) { now.push(e); continue; }
            if (e.decorators.includes('@@dont_activate')) continue;
            if (forced.includes(e.uid) || e.constant || sticky) { now.push(e); continue; }
            if (!(e.key || []).some(k => String(k).trim())) continue;
            if (entryMatches(e, textFor(e, scanState), cfg)) now.push(e);
        }
        // Sticky entries first, then priority.
        now.sort((a, b) => (isSticky(b) - isSticky(a)) || priority.get(a.id) - priority.get(b.id));

        filterGroups(now, activated, { cfg, isSticky, leftOut, score: e => groupScore(e, textFor(e, scanState), cfg) });

        const added = [];
        for (const e of now) {
            if (overflowed && !e.ignoreBudget) { leftOut.set(e.id, { e, reason: 'lorebook budget full' }); continue; }
            const p = Number(e.probability ?? 100);
            if (e.useProbability && p < 100 && !isSticky(e) && Math.random() * 100 > p) {
                failedRoll.add(e.id); // one roll per reply, not one per pass
                leftOut.set(e.id, { e, reason: `lost its ${p}% chance roll` });
                continue;
            }
            const content = substituteParams(e.content);
            const cost = tokens(content);
            if (!e.ignoreBudget && used + cost > budget) {
                overflowed = true;
                leftOut.set(e.id, { e, reason: 'lorebook budget full' });
                continue;
            }
            used += cost;
            leftOut.delete(e.id);
            activated.set(e.id, { ...e, content });
            added.push({ ...e, content });
        }

        const forRecursion = added.filter(e => !e.preventRecursion);
        let next = STATE.none;
        const recursive = cfg.recursive && !wiHook.disableRecursion;
        if (recursive && !overflowed && forRecursion.length) next = STATE.recursion;
        if (recursive && !overflowed && scanState === STATE.minActivations && recurse.length) next = STATE.recursion;
        if (!next && !overflowed && minActivations > 0 && activated.size < minActivations) {
            const depth = globalDepth + skew;
            if (!((minDepthMax > 0 && depth > minDepthMax) || depth > lines.length)) { next = STATE.minActivations; skew++; }
        }
        if (!next && levels.length) { next = STATE.recursion; level = levels.shift(); }
        if (next && forRecursion.length) recurse.push(forRecursion.map(e => e.content).join('\n'));
        scanState = next;
    }

    // Start (or keep) the sticky / cooldown clock of what went in.
    for (const e of activated.values()) {
        if (!isSticky(e) && (Number(e.sticky) > 0 || Number(e.cooldown) > 0)) {
            const stickyEnd = turn + (Number(e.sticky) || 0);
            timed[e.id] = { at: turn, stickyEnd, cooldownEnd: stickyEnd + (Number(e.cooldown) || 0) };
            timedChanged = true;
        }
    }
    if (timedChanged && !dryRun && meta) saveChatDebounced();

    // ----- assembly (ST order: by order, lower first; equal order in reverse activation order) -----
    const kept = [...activated.values()].sort(byOrder).reverse().map(e => {
        const atDepth = Number(e.position) === WI_POSITION.atDepth;
        return { ...e, content: applyRegex(e.content, REGEX_PLACEMENT.WORLD_INFO, { isPrompt: true, depth: atDepth ? Number(e.depth ?? 4) : undefined }) };
    }).filter(e => String(e.content || '').trim());
    const at = pos => kept.filter(e => Number(e.position) === pos).map(e => e.content);
    const outlets = {};
    // ST lists outlet entries highest order first.
    for (const e of [...kept].reverse().filter(e => Number(e.position) === WI_POSITION.outlet && e.outletName)) {
        outlets[e.outletName] = outlets[e.outletName] ? `${outlets[e.outletName]}\n${e.content}` : e.content;
    }
    // @depth entries: one injection per depth and role.
    const depthGroups = new Map();
    for (const e of kept.filter(e => Number(e.position) === WI_POSITION.atDepth)) {
        const depth = Number(e.depth ?? 4) || 0;
        const role = ['system', 'user', 'assistant'][Number(e.role) || 0];
        const key = `${depth}|${role}`;
        if (!depthGroups.has(key)) depthGroups.set(key, { depth, role, parts: [] });
        depthGroups.get(key).parts.push(e.content);
    }
    return {
        before: at(WI_POSITION.before).join('\n'),
        after: at(WI_POSITION.after).join('\n'),
        anTop: at(WI_POSITION.ANTop).join('\n'),
        anBottom: at(WI_POSITION.ANBottom).join('\n'),
        emTop: at(WI_POSITION.EMTop),
        emBottom: at(WI_POSITION.EMBottom),
        outlets,
        depth: [...depthGroups.values()].map(g => ({ depth: g.depth, role: g.role, content: g.parts.join('\n') })),
        activated: kept,
        skipped: [...leftOut.values()].filter(({ e }) => !activated.has(e.id)).map(({ e, reason }) => ({ ...e, reason })),
        total,
    };
}

/**
 * Inclusion groups, per pass (ST): sticky entries win their group; group scoring drops weaker matches; a
 * group already filled in an earlier pass takes no more; then a "prioritize" entry (highest order) or a
 * weighted draw picks one. Losers are removed from `now`.
 */
function filterGroups(now, activated, { cfg, isSticky, leftOut, score }) {
    const name = e => e.comment || (e.key || [])[0] || `entry ${e.uid}`;
    const groups = new Map();
    for (const e of now) {
        for (const g of String(e.group || '').split(/,\s*/).map(s => s.trim()).filter(Boolean)) {
            if (!groups.has(g)) groups.set(g, []);
            groups.get(g).push(e);
        }
    }
    const remove = (e, reason) => {
        const i = now.indexOf(e);
        if (i < 0) return;
        now.splice(i, 1);
        leftOut.set(e.id, { e, reason });
    };
    for (const [g, all] of groups) {
        const group = all.filter(e => now.includes(e));
        if (!group.length) continue;
        const stuck = group.filter(isSticky);
        if (stuck.length) { for (const e of group) if (!stuck.includes(e)) remove(e, `lost to sticky “${name(stuck[0])}” in group “${g}”`); continue; }
        let pool = group;
        if (cfg.useGroupScoring || pool.some(e => e.useGroupScoring)) {
            const scores = pool.map(score);
            const best = Math.max(...scores);
            pool = pool.filter((e, i) => {
                if (!(e.useGroupScoring ?? cfg.useGroupScoring) || scores[i] >= best) return true;
                remove(e, `matched fewer keywords than others in group “${g}”`);
                return false;
            });
        }
        const filled = [...activated.values()].find(a => String(a.group || '').split(/,\s*/).map(s => s.trim()).includes(g));
        if (filled) { for (const e of pool) remove(e, `group “${g}” already has “${name(filled)}”`); continue; }
        if (pool.length < 2) continue;
        const prio = pool.filter(e => e.groupOverride).sort((a, b) => b.order - a.order);
        let winner = prio[0];
        if (!winner) {
            const weight = e => Math.max(0, Number(e.groupWeight ?? 100));
            let roll = Math.random() * pool.reduce((n, e) => n + weight(e), 0);
            winner = pool.find(e => (roll -= weight(e)) <= 0) || pool.at(-1);
        }
        for (const e of pool) if (e !== winner) remove(e, `lost to “${name(winner)}” in group “${g}”`);
    }
}
