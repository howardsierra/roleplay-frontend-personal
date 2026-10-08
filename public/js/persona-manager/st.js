// What the vendored Persona Manager imports from SillyTavern, backed by Reverie's persona model.
import { state, saveSettingsDebounced } from '../state.js';
import { api } from '../api.js';
import { eventSource, event_types } from '../events.js';
import { toastr } from '../ui.js';
import {
    personasView, descriptionsView, activePersona, findPersona, allPersonas, defaultPersonaId, setActivePersona,
    isPersonaLocked, togglePersonaLock, convertCharacterToPersona, deletePersona, uploadPersonaImage,
} from '../personas.js';

export { eventSource, event_types, toastr, isPersonaLocked, togglePersonaLock };

export const saveSettings = () => saveSettingsDebounced();
export const extension_settings = new Proxy({}, {
    get: (_t, k) => (state.settings.extension_settings ??= {})[k],
    set: (_t, k, v) => { (state.settings.extension_settings ??= {})[k] = v; return true; },
});
export const default_user_avatar = 'icons/user.svg';
export const setUserName = () => {};
export const isFirefox = () => /firefox/i.test(navigator.userAgent);

// The active persona id; a live binding, so the manager always reads the current value.
export let user_avatar = state.settings?.personaId ?? null;
const syncActive = () => { user_avatar = activePersona()?.id ?? null; };
eventSource.on(event_types.PERSONA_CHANGED, syncActive);
eventSource.on(event_types.SETTINGS_LOADED, syncActive);
eventSource.on(event_types.PERSONA_DELETED, syncActive);
syncActive();

export const power_user = {
    get personas() { return personasView; },
    get persona_descriptions() { return descriptionsView; },
    get default_persona() { return defaultPersonaId(); },
    set default_persona(id) { state.settings.defaultPersonaId = findPersona(id)?.id ?? null; },
    // The manager mirrors the active persona's fields here; Reverie reads them from the persona itself.
    set persona_description(_v) {}, set persona_description_position(_v) {}, set persona_description_depth(_v) {},
    set persona_description_role(_v) {}, set persona_description_lorebook(_v) {},
};

export const getUserAvatars = async () => allPersonas().map(p => p.id);
export const getUserAvatar = id => findPersona(id)?.avatar || default_user_avatar;
export const getThumbnailUrl = (type, id) => (type === 'persona' ? getUserAvatar(id) : id ? `files/avatars/${encodeURIComponent(id)}` : 'icons/icon.svg');
export const setUserAvatar = async id => { await setActivePersona(id, { quiet: true }); syncActive(); };
export const setPersonaDescription = () => saveSettingsDebounced();

export let world_names = [];
export async function refreshWorldNames() {
    world_names = (await api.get('worlds').catch(() => [])).map(w => w.name).filter(Boolean);
}
export const openWorldInfoEditor = () => import('../panels/settings.js').then(m => m.openSettings('lore'));

export async function convertCharacter(index) {
    syncActive();
    return convertCharacterToPersona(state.characters[index]);
}
export { convertCharacterToPersona };

export async function renderExtensionTemplateAsync(_ext, name) {
    return (await fetch(`js/persona-manager/${name}.html`)).text();
}

// ---------------------------------------------------------------- avatar images
/** Sets a persona's image from a blob (SVG placeholders just clear it). */
export async function uploadAvatarBlob(id, blob) {
    const p = findPersona(id);
    if (!p) throw new Error('No such persona');
    p.avatar = !blob || /svg/.test(blob.type) ? '' : await uploadPersonaImage(blob);
    saveSettingsDebounced();
    return p.avatar;
}

export async function fetchAvatarBlob(id) {
    const url = findPersona(id)?.avatar;
    if (!url) return null;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return res.blob();
}

export async function deleteAvatar(id) {
    return deletePersona(id);
}

/** New ids the manager mints look like "1712345678-Name.png"; any unique string works. */
export function ensurePersona(id, name) {
    if (!findPersona(id)) personasView[id] = name;
    return findPersona(id);
}

export function getContext() {
    const ctx = window.SillyTavern.getContext();
    return new Proxy(ctx, {
        get(t, k) {
            if (k === 'saveSettingsDebounced') return saveSettingsDebounced;
            if (k === 'characters') return state.characters.map(c => ({ ...c, name: c.name || c.card?.data?.name, avatar: c.avatar || c.id }));
            if (k === 'groups') return [];
            if (k === 'getThumbnailUrl') return getThumbnailUrl;
            return t[k];
        },
    });
}
