// Loads Reverie-native extensions (folders with reverie-extension.json) and can turn them
// on and off live, without reloading the page.
import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { toast } from '../ui.js';
import { createApi, API_VERSION } from './api.js';

export const active = new Map(); // id -> { ext, disposers, module, links, error? }

export async function listReverieExtensions() {
    return (await api.get('extensions')).filter(e => e.type === 'reverie');
}

export const isEnabled = id => state.settings.rvext?.[id]?.enabled !== false;

export async function activate(ext) {
    const { manifest } = ext;
    const id = manifest.id || ext.name;
    if (active.has(id)) return;
    if (manifest.apiVersion && manifest.apiVersion > API_VERSION) {
        active.set(id, { ext, disposers: [], error: `Needs a newer Reverie (API v${manifest.apiVersion})` });
        return;
    }
    const base = `/rv-extensions/${encodeURIComponent(ext.name)}/`;
    const record = { ext, disposers: [], links: [], module: null };
    active.set(id, record);
    try {
        for (const css of [].concat(manifest.styles || [])) {
            const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: base + css });
            link.dataset.rvext = id;
            document.head.append(link);
            record.links.push(link);
        }
        record.module = await import(`${base}${manifest.main || 'index.js'}?v=${encodeURIComponent(manifest.version || '0')}`);
        const rv = createApi({ id, name: ext.name, manifest }, record.disposers);
        record.rv = rv;
        await record.module.activate?.(rv);
    } catch (err) {
        console.error(`Reverie extension ${id} failed`, err);
        record.error = err.message || String(err);
        toast(`${manifest.name || id}: ${record.error}`, 'error', { title: 'Extension failed' });
    }
}

export async function deactivate(id) {
    const record = active.get(id);
    if (!record) return;
    try { await record.module?.deactivate?.(); } catch (err) { console.error(err); }
    for (const dispose of record.disposers.splice(0).reverse()) {
        try { dispose(); } catch (err) { console.error(err); }
    }
    for (const link of record.links || []) link.remove();
    active.delete(id);
}

export async function setEnabled(ext, enabled) {
    const id = ext.manifest.id || ext.name;
    state.settings.rvext ??= {};
    state.settings.rvext[id] = { ...(state.settings.rvext[id] || { settings: {} }), enabled };
    saveSettingsDebounced();
    if (enabled) await activate(ext);
    else await deactivate(id);
}

/** Change a setting from the settings form; goes through rv.settings so onChange listeners fire. */
export function setExtensionSetting(ext, key, value) {
    const id = ext.manifest.id || ext.name;
    const record = active.get(id);
    if (record?.rv) return record.rv.settings.set(key, value);
    state.settings.rvext ??= {};
    state.settings.rvext[id] ??= { enabled: false, settings: {} };
    state.settings.rvext[id].settings = { ...state.settings.rvext[id].settings, [key]: value };
    saveSettingsDebounced();
}

export async function loadReverieExtensions() {
    let list = [];
    try { list = await listReverieExtensions(); } catch { return; }
    for (const ext of list) {
        if (isEnabled(ext.manifest.id || ext.name)) await activate(ext);
    }
}
