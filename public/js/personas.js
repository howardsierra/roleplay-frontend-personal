// Personas: the active persona, SillyTavern-style locks (chat / character / default),
// description placement (position, depth, role), persona lorebooks, and ST-shaped views of
// it all (power_user.personas / persona_descriptions) for extensions written for SillyTavern.
import { api } from './api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChatDebounced } from './state.js';
import { eventSource, event_types } from './events.js';
import { toast, toPngBlob } from './ui.js';

export const PERSONA_POSITION = { IN_PROMPT: 0, AN_TOP: 2, AN_BOTTOM: 3, AT_DEPTH: 4, NONE: 9 };
const DEFAULT_DEPTH = 2;

export const allPersonas = () => (state.settings.personas ??= []);
export const findPersona = id => (id ? allPersonas().find(p => p.id === id || p.stAvatar === id) : null) || null;
export const activePersona = () => findPersona(state.settings.personaId) || allPersonas()[0] || null;
export const defaultPersonaId = () => state.settings.defaultPersonaId || null;

/** Description placement with SillyTavern's defaults. */
export function placement(p = activePersona()) {
    const st = p?.st || {};
    return {
        position: Number(st.position ?? PERSONA_POSITION.IN_PROMPT),
        depth: Number(st.depth ?? DEFAULT_DEPTH),
        role: Number(st.role ?? 0),
        lorebook: st.lorebook || '',
    };
}

const characterKeys = () => [state.character?.avatar, state.character?.id].filter(Boolean);
const connectedTo = (p, keys = characterKeys()) => (p?.connections || []).some(c => c.type === 'character' && keys.includes(c.id));

export function newPersona(fields = {}) {
    return {
        id: fields.id || crypto.randomUUID(),
        name: 'New persona', title: '', description: '', avatar: '',
        st: { position: 0, depth: DEFAULT_DEPTH, role: 0, lorebook: '' },
        connections: [],
        created: Date.now(),
        ...fields,
    };
}

// ---------------------------------------------------------------- switching
export async function setActivePersona(id, { quiet = true } = {}) {
    const p = findPersona(id);
    if (!p) return false;
    const changed = state.settings.personaId !== p.id;
    state.settings.personaId = p.id;
    saveSettingsDebounced();
    if (changed) {
        if (!quiet) toast(`You are now ${p.name || 'unnamed'}`, 'info', { timeout: 2200 });
        await eventSource.emit(event_types.PERSONA_CHANGED, p.id);
        const { printMessages } = await import('./chat.js');
        if (state.character) printMessages();
    }
    return true;
}

// ---------------------------------------------------------------- locks
/** type: 'chat' | 'character' | 'default' — is the active persona locked that way? */
export function isPersonaLocked(type = 'chat') {
    const p = activePersona();
    if (!p) return false;
    if (type === 'chat') return !!state.chatId && !!chatMetadata().persona && findPersona(chatMetadata().persona)?.id === p.id;
    if (type === 'character') return !!state.character && connectedTo(p);
    if (type === 'default') return defaultPersonaId() === p.id;
    return false;
}

export async function togglePersonaLock(type = 'chat') {
    const p = activePersona();
    if (!p) return;
    const on = isPersonaLocked(type);
    if (type === 'chat') {
        if (!state.chatId) return toast('Open a chat first', 'warning');
        if (on) delete chatMetadata().persona; else chatMetadata().persona = p.id;
        saveChatDebounced();
    } else if (type === 'character') {
        if (!state.character) return toast('Open a character first', 'warning');
        const keys = characterKeys();
        // A character connects to one persona at a time.
        for (const other of allPersonas()) other.connections = (other.connections || []).filter(c => !(c.type === 'character' && keys.includes(c.id)));
        if (!on) p.connections.push({ type: 'character', id: keys[0] });
    } else if (type === 'default') {
        state.settings.defaultPersonaId = on ? null : p.id;
    }
    saveSettingsDebounced();
    await eventSource.emit(event_types.PERSONA_UPDATED, p.id);
}

/** When a chat opens: chat lock, then the character's persona, then the default. */
export async function applyPersonaForChat() {
    if (!state.character) return;
    const byChat = findPersona(chatMetadata().persona);
    const byChar = allPersonas().find(p => connectedTo(p));
    const byDefault = findPersona(defaultPersonaId());
    const pick = byChat || byChar || byDefault;
    if (pick && pick.id !== state.settings.personaId) await setActivePersona(pick.id, { quiet: false });
}

// ---------------------------------------------------------------- create / delete / convert
export async function deletePersona(id) {
    const p = findPersona(id);
    if (!p) return false;
    state.settings.personas = allPersonas().filter(x => x !== p);
    if (state.settings.defaultPersonaId === p.id) state.settings.defaultPersonaId = null;
    if (findPersona(chatMetadata().persona)?.id === p.id) { delete chatMetadata().persona; saveChatDebounced(); }
    if (state.settings.personaId === p.id) {
        const next = findPersona(defaultPersonaId()) || allPersonas()[0];
        state.settings.personaId = next?.id ?? null;
        if (next) await eventSource.emit(event_types.PERSONA_CHANGED, next.id);
    }
    saveSettingsDebounced();
    await eventSource.emit(event_types.PERSONA_DELETED, { avatarId: p.id, name: p.name });
    return true;
}

export async function uploadPersonaImage(blobOrFile) {
    const res = await api.upload('images?name=persona.png', await toPngBlob(blobOrFile, 768));
    return res.url;
}

/** Makes a persona from a character card (name, description, avatar). */
export async function convertCharacterToPersona(characterOrIndex) {
    const ref = typeof characterOrIndex === 'number' ? state.characters[characterOrIndex] : characterOrIndex;
    if (!ref) throw new Error('Character not found');
    const full = ref.card ? ref : await api.get(`characters/${encodeURIComponent(ref.id)}`);
    const d = full.card?.data || {};
    let avatar = '';
    if (full.avatar) {
        try {
            const blob = await (await fetch(`files/avatars/${encodeURIComponent(full.avatar)}`)).blob();
            avatar = await uploadPersonaImage(blob);
        } catch { /* keep the default avatar */ }
    }
    const description = String(d.description || '').replace(/\{\{char\}\}/gi, '{{user}}');
    const p = newPersona({ name: d.name || 'Unnamed', description, avatar });
    allPersonas().push(p);
    saveSettingsDebounced();
    await eventSource.emit(event_types.PERSONA_CREATED, { avatarId: p.id, name: p.name, description, title: '' });
    toast(`${p.name} is now a persona`, 'success');
    return p;
}

// ---------------------------------------------------------------- ST-shaped views
const DESCRIPTOR_KEYS = ['description', 'title', 'position', 'depth', 'role', 'lorebook', 'connections'];
const descriptorCache = new WeakMap();

/** A live { description, title, position, depth, role, lorebook, connections } view of a persona. */
export function descriptorOf(p) {
    if (descriptorCache.has(p)) return descriptorCache.get(p);
    p.st ??= { position: 0, depth: DEFAULT_DEPTH, role: 0, lorebook: '' };
    p.connections ??= [];
    const view = new Proxy({}, {
        get(_t, k) {
            if (k === 'description' || k === 'title') return p[k] ?? '';
            if (k === 'connections') return p.connections;
            if (k === 'position' || k === 'depth' || k === 'role') return Number(p.st[k] ?? (k === 'depth' ? DEFAULT_DEPTH : 0));
            if (k === 'lorebook') return p.st.lorebook || '';
            return undefined;
        },
        set(_t, k, v) {
            if (k === 'description' || k === 'title') p[k] = String(v ?? '');
            else if (k === 'connections') p.connections = Array.isArray(v) ? v : [];
            else if (k === 'position' || k === 'depth' || k === 'role') p.st[k] = Number(v);
            else if (k === 'lorebook') p.st.lorebook = String(v ?? '');
            return true;
        },
        has: (_t, k) => DESCRIPTOR_KEYS.includes(k),
        ownKeys: () => DESCRIPTOR_KEYS,
        getOwnPropertyDescriptor: (_t, k) => (DESCRIPTOR_KEYS.includes(k) ? { enumerable: true, configurable: true, writable: true, value: view[k] } : undefined),
        deleteProperty: () => true,
    });
    descriptorCache.set(p, view);
    return view;
}

function assignDescriptor(p, obj = {}) {
    const d = descriptorOf(p);
    for (const k of DESCRIPTOR_KEYS) if (k in obj) d[k] = obj[k];
}

/** power_user.personas — { id: name }; writing a new id creates a persona. */
export const personasView = new Proxy({}, {
    get: (_t, id) => (typeof id === 'string' ? findPersona(id)?.name : undefined),
    set(_t, id, name) {
        const p = findPersona(id);
        if (p) p.name = String(name ?? '');
        else allPersonas().push(newPersona({ id, name: String(name ?? '') }));
        return true;
    },
    has: (_t, id) => !!findPersona(id),
    deleteProperty(_t, id) {
        state.settings.personas = allPersonas().filter(p => p.id !== id);
        return true;
    },
    ownKeys: () => allPersonas().map(p => p.id),
    getOwnPropertyDescriptor: (_t, id) => {
        const p = findPersona(id);
        return p ? { enumerable: true, configurable: true, writable: true, value: p.name } : undefined;
    },
});

/** power_user.persona_descriptions — { id: descriptor }. */
export const descriptionsView = new Proxy({}, {
    get: (_t, id) => { const p = typeof id === 'string' && findPersona(id); return p ? descriptorOf(p) : undefined; },
    set(_t, id, obj) {
        let p = findPersona(id);
        if (!p) allPersonas().push(p = newPersona({ id, name: '' }));
        assignDescriptor(p, obj);
        return true;
    },
    has: (_t, id) => !!findPersona(id),
    deleteProperty: () => true,
    ownKeys: () => allPersonas().map(p => p.id),
    getOwnPropertyDescriptor: (_t, id) => {
        const p = findPersona(id);
        return p ? { enumerable: true, configurable: true, writable: true, value: descriptorOf(p) } : undefined;
    },
});

/** Adds persona fields to a power_user object (mutated in place by ST extensions). */
export function definePersonaFields(pu) {
    const active = () => activePersona();
    // Non-enumerable, so these live views aren't copied into the saved settings.
    const field = (name, get, set) => Object.defineProperty(pu, name, { configurable: true, enumerable: false, get, set });
    field('personas', () => personasView, () => {});
    field('persona_descriptions', () => descriptionsView, () => {});
    field('default_persona', () => defaultPersonaId(), v => { state.settings.defaultPersonaId = findPersona(v)?.id ?? null; });
    field('persona_description', () => active()?.description || '', v => { const p = active(); if (p) p.description = String(v ?? ''); });
    field('persona_description_position', () => placement().position, v => { const p = active(); if (p) (p.st ??= {}).position = Number(v); });
    field('persona_description_depth', () => placement().depth, v => { const p = active(); if (p) (p.st ??= {}).depth = Number(v); });
    field('persona_description_role', () => placement().role, v => { const p = active(); if (p) (p.st ??= {}).role = Number(v); });
    field('persona_description_lorebook', () => placement().lorebook, v => { const p = active(); if (p) (p.st ??= {}).lorebook = String(v ?? ''); });
    return pu;
}

export function bindPersonas() {
    eventSource.on(event_types.CHAT_CHANGED, id => { if (id) applyPersonaForChat(); });
}
