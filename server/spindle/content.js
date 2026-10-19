// spindle.world_books.* and spindle.presets.* answered on the server from Reverie's own stores
// (the same files /api/worlds and /api/presets serve). Reverie keeps lorebooks in SillyTavern's
// world format ({ entries: { uid: entry } }) and presets as { blocks, samplers, ... }; these map
// them to and from Lumiverse's DTOs.
import { DIRS, listJson, newId, readJson, removeFile, withLock, within, writeJson } from '../lib/storage.js';

const NOT_HANDLED = Symbol('not handled');
export { NOT_HANDLED };

const seconds = t => Math.floor((Number(t) || Date.now()) / 1000);
const page = (all, opts = {}) => {
    const limit = Math.max(1, Math.min(200, Number(opts?.limit) || 50));
    const offset = Math.max(0, Number(opts?.offset) || 0);
    return { data: all.slice(offset, offset + limit), total: all.length };
};
const notFound = what => Object.assign(new Error(`${what} not found`), { code: 'NOT_FOUND' });

// ---------------------------------------------------------------- world books
const worldFile = id => within(DIRS.worlds, `${id}.json`);
const readWorld = async id => (id ? readJson(worldFile(id)).catch(() => null) : null);
const ROLES = ['system', 'user', 'assistant'];

function worldDto(w) {
    return {
        id: w.id,
        name: w.name || '',
        description: w.description || '',
        metadata: { ...(w.metadata || {}) },
        created_at: seconds(w.created),
        updated_at: seconds(w.updated),
    };
}

/** Lumiverse entry fields → Reverie (SillyTavern) entry fields. */
const ENTRY_FIELDS = {
    key: 'key', keysecondary: 'keysecondary', content: 'content', comment: 'comment', position: 'position', depth: 'depth',
    order_value: 'order', selective: 'selective', constant: 'constant', group_name: 'group', group_override: 'groupOverride',
    group_weight: 'groupWeight', probability: 'probability', scan_depth: 'scanDepth', case_sensitive: 'caseSensitive',
    match_whole_words: 'matchWholeWords', automation_id: 'automationId', prevent_recursion: 'preventRecursion',
    exclude_recursion: 'excludeRecursion', delay_until_recursion: 'delayUntilRecursion', sticky: 'sticky', cooldown: 'cooldown',
    delay: 'delay', selective_logic: 'selectiveLogic', use_probability: 'useProbability', vectorized: 'vectorized',
    extensions: 'extensions', exclude_greeting: 'excludeGreeting', use_regex: 'useRegex',
};

function entryPatch(input = {}) {
    const out = {};
    for (const [lv, rv] of Object.entries(ENTRY_FIELDS)) if (input[lv] !== undefined) out[rv] = input[lv];
    if (input.disabled !== undefined) out.disable = !!input.disabled;
    if (input.role !== undefined) out.role = typeof input.role === 'number' ? input.role : Math.max(0, ROLES.indexOf(input.role));
    if (out.key && !Array.isArray(out.key)) out.key = String(out.key).split(',').map(s => s.trim()).filter(Boolean);
    if (out.keysecondary && !Array.isArray(out.keysecondary)) out.keysecondary = String(out.keysecondary).split(',').map(s => s.trim()).filter(Boolean);
    return out;
}

function entryDto(w, e) {
    return {
        id: `${w.id}:${e.uid}`,
        world_book_id: w.id,
        uid: String(e.uid),
        key: [...(e.key || [])],
        keysecondary: [...(e.keysecondary || [])],
        content: e.content || '',
        comment: e.comment || '',
        position: Number(e.position ?? 0),
        depth: Number(e.depth ?? 4),
        role: ROLES[Number(e.role)] ?? null,
        order_value: Number(e.order ?? 100),
        selective: e.selective !== false,
        constant: !!e.constant,
        disabled: !!e.disable,
        group_name: e.group || '',
        group_override: !!e.groupOverride,
        group_weight: Number(e.groupWeight ?? 100),
        probability: Number(e.probability ?? 100),
        scan_depth: e.scanDepth === null || e.scanDepth === undefined || e.scanDepth === '' ? null : Number(e.scanDepth),
        exclude_greeting: !!e.excludeGreeting,
        case_sensitive: !!e.caseSensitive,
        match_whole_words: !!e.matchWholeWords,
        automation_id: e.automationId || null,
        use_regex: !!e.useRegex,
        prevent_recursion: !!e.preventRecursion,
        exclude_recursion: !!e.excludeRecursion,
        delay_until_recursion: !!e.delayUntilRecursion,
        priority: Number(e.order ?? 100),
        sticky: Number(e.sticky) || 0,
        cooldown: Number(e.cooldown) || 0,
        delay: Number(e.delay) || 0,
        selective_logic: Number(e.selectiveLogic) || 0,
        use_probability: e.useProbability !== false,
        vectorized: !!e.vectorized,
        extensions: { ...(e.extensions || {}) },
        created_at: seconds(e.created || w.created),
        updated_at: seconds(e.updated || w.updated),
    };
}

const newEntry = (uid, patch) => ({
    uid, key: [], keysecondary: [], comment: '', content: '', constant: false, selective: true, selectiveLogic: 0, order: 100,
    position: 0, disable: false, depth: 4, role: 0, probability: 100, useProbability: true, ...patch, created: Date.now(), updated: Date.now(),
});

/** Entry ids are "<worldId>:<uid>"; a book name works in place of the id (what activation reports). */
async function findEntry(entryId) {
    const s = String(entryId ?? '');
    const i = s.lastIndexOf(':');
    if (i < 0) return null;
    const ref = s.slice(0, i);
    const uid = s.slice(i + 1);
    let w = await readWorld(ref).catch(() => null);
    if (!w) w = (await listJson(DIRS.worlds)).map(x => x.data).find(x => x.name === ref) || null;
    if (!w) return null;
    const key = Object.keys(w.entries || {}).find(k => String(w.entries[k].uid ?? k) === uid);
    return key === undefined ? null : { world: w, key, entry: w.entries[key] };
}

async function saveWorld(w) {
    w.updated = Date.now();
    await writeJson(worldFile(w.id), w);
    return w;
}

export function worldBooksApi({ changed }) {
    const lock = id => fn => withLock(`world:${id}`, fn);
    return {
        async list(opts) {
            const all = (await listJson(DIRS.worlds)).map(x => x.data).filter(w => w?.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
            return page(all.map(worldDto), opts);
        },
        async get(id) { const w = await readWorld(id); return w ? worldDto(w) : null; },
        async create(input = {}) {
            if (!String(input.name || '').trim()) throw new Error('name is required');
            const w = { id: newId(), name: String(input.name), description: String(input.description || ''), metadata: input.metadata || {}, entries: {}, created: Date.now(), updated: Date.now() };
            await writeJson(worldFile(w.id), w);
            changed('WORLD_BOOK_CHANGED', { id: w.id, worldBook: worldDto(w) }, w.id);
            return worldDto(w);
        },
        update: (id, input = {}) => lock(id)(async () => {
            const w = await readWorld(id);
            if (!w) throw notFound('World book');
            if (input.name !== undefined) w.name = String(input.name);
            if (input.description !== undefined) w.description = String(input.description);
            if (input.metadata !== undefined) w.metadata = input.metadata || {};
            await saveWorld(w);
            changed('WORLD_BOOK_CHANGED', { id, worldBook: worldDto(w) }, id);
            return worldDto(w);
        }),
        async delete(id) {
            if (!(await readWorld(id))) return false;
            await removeFile(worldFile(id));
            changed('WORLD_BOOK_DELETED', { id }, id, true);
            return true;
        },
        entries: {
            async list(worldId, opts) {
                const w = await readWorld(worldId);
                if (!w) return { data: [], total: 0 };
                const all = Object.entries(w.entries || {}).map(([k, e]) => entryDto(w, { uid: Number(k), ...e }));
                all.sort((a, b) => Number(a.uid) - Number(b.uid));
                return page(all, opts);
            },
            async get(entryId) {
                const hit = await findEntry(entryId);
                return hit ? entryDto(hit.world, hit.entry) : null;
            },
            create: (worldId, input = {}) => lock(worldId)(async () => {
                const w = await readWorld(worldId);
                if (!w) throw notFound('World book');
                w.entries ||= {};
                const uid = Math.max(-1, ...Object.keys(w.entries).map(Number).filter(Number.isFinite), ...Object.values(w.entries).map(e => Number(e.uid)).filter(Number.isFinite)) + 1;
                const e = newEntry(uid, entryPatch(input));
                w.entries[uid] = e;
                await saveWorld(w);
                const dto = entryDto(w, e);
                changed('WORLD_BOOK_ENTRY_CHANGED', { id: dto.id, worldBookId: w.id, entry: dto }, w.id);
                return dto;
            }),
            async update(entryId, input = {}) {
                const first = await findEntry(entryId);
                if (!first) throw notFound('World book entry');
                return lock(first.world.id)(async () => {
                    const hit = await findEntry(entryId);
                    if (!hit) throw notFound('World book entry');
                    const e = { ...hit.entry, ...entryPatch(input), uid: hit.entry.uid ?? Number(hit.key), updated: Date.now() };
                    hit.world.entries[hit.key] = e;
                    await saveWorld(hit.world);
                    const dto = entryDto(hit.world, e);
                    changed('WORLD_BOOK_ENTRY_CHANGED', { id: dto.id, worldBookId: hit.world.id, entry: dto }, hit.world.id);
                    return dto;
                });
            },
            async delete(entryId) {
                const first = await findEntry(entryId);
                if (!first) return false;
                return lock(first.world.id)(async () => {
                    const hit = await findEntry(entryId);
                    if (!hit) return false;
                    delete hit.world.entries[hit.key];
                    await saveWorld(hit.world);
                    changed('WORLD_BOOK_ENTRY_DELETED', { id: String(entryId), worldBookId: hit.world.id }, hit.world.id);
                    return true;
                });
            },
        },
    };
}

// ---------------------------------------------------------------- presets (read-only)
const presetFile = id => within(DIRS.presets, `${id}.json`);

function blockDto(b = {}) {
    return {
        id: String(b.id || ''),
        name: b.name || '',
        content: b.content ?? '',
        role: b.role || 'system',
        enabled: b.enabled !== false,
        position: b.position || 'pre_history',
        depth: Number.isFinite(Number(b.depth)) ? Number(b.depth) : 4,
        marker: b.marker ?? null,
        isLocked: !!(b.isLocked || b.sealed),
        color: b.color ?? null,
        injectionTrigger: Array.isArray(b.injectionTrigger) ? [...b.injectionTrigger] : [],
        group: b.group ?? null,
        ...(b.categoryMode ? { categoryMode: b.categoryMode } : {}),
        ...(b.variables ? { variables: structuredClone(b.variables) } : {}),
    };
}

function presetDto(p) {
    return {
        id: p.id,
        name: p.name || '',
        provider: p.source === 'lumiverse' ? 'loom' : (p.source || 'reverie'),
        engine: 'classic',
        parameters: { ...(p.samplers || {}), ...(p.customBody?.enabled ? { custom_body_raw: p.customBody.rawJson } : {}) },
        prompt_order: (p.blocks || []).map(blockDto),
        prompts: { behavior: { ...(p.behavior || {}) }, completion: { ...(p.completion || {}) }, formats: { ...(p.formats || {}) }, stopStrings: [...(p.stopStrings || [])] },
        metadata: { ...(p.meta || {}), source: p.source, promptVariables: structuredClone(p.promptVariables || {}) },
        cache_revision: Number(p.updated) || 0,
        created_at: seconds(p.created),
        updated_at: seconds(p.updated),
    };
}

const readPreset = async id => (id ? readJson(presetFile(id)).catch(() => null) : null);
const readOnly = what => () => { throw Object.assign(new Error(`spindle.presets.${what} isn't supported in Reverie (presets are read-only to extensions)`), { code: 'UNSUPPORTED' }); };

export function presetsApi() {
    return {
        async list(opts) {
            const all = (await listJson(DIRS.presets)).map(x => x.data).filter(p => p?.id).sort((a, b) => String(a.name).localeCompare(String(b.name)));
            return page(all.map(presetDto), opts);
        },
        async get(id) { const p = await readPreset(id); return p ? presetDto(p) : null; },
        create: readOnly('create'),
        update: readOnly('update'),
        delete: readOnly('delete'),
        blocks: {
            async list(id) { const p = await readPreset(id); return p ? (p.blocks || []).map(blockDto) : []; },
            async get(id, blockId) { const b = (await readPreset(id))?.blocks?.find(x => x.id === blockId); return b ? blockDto(b) : null; },
            create: readOnly('blocks.create'),
            update: readOnly('blocks.update'),
            delete: readOnly('blocks.delete'),
        },
        categories: {
            async list(id) {
                const out = [];
                let current = null;
                for (const b of (await readPreset(id))?.blocks || []) {
                    if (b.marker === 'category') { current = { block: blockDto(b), children: [] }; out.push(current); } else if (current) current.children.push(blockDto(b));
                }
                return out;
            },
        },
    };
}

/** Resolve "a.b.c" in an api object; NOT_HANDLED when it isn't one of ours (the tab answers it). */
export function resolveContent(api, path) {
    let node = api;
    for (const part of path.split('.')) {
        if (node == null || !Object.hasOwn(node, part)) return NOT_HANDLED;
        node = node[part];
    }
    return typeof node === 'function' ? node : NOT_HANDLED;
}
