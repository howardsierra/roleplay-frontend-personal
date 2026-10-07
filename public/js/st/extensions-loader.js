// Loads installed SillyTavern third-party extensions (manifest.json → js + css).
import { api } from '../api.js';
import { state } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { toast } from '../ui.js';

export const loaded = new Map(); // name -> { manifest, error? }
const interceptors = [];

export function getInterceptors() {
    return interceptors.map(name => globalThis[name]).filter(fn => typeof fn === 'function');
}

export async function listExtensions() {
    return api.get('extensions');
}

export async function loadExtensions() {
    let list = [];
    try {
        list = await listExtensions();
    } catch (err) {
        console.error('Could not list extensions', err);
        return;
    }
    const disabled = new Set(state.settings.extensions.disabled || []);
    for (const ext of list) {
        if (disabled.has(ext.name)) continue;
        await loadOne(ext);
    }
    await eventSource.emit(event_types.EXTENSIONS_FIRST_LOAD);
    await eventSource.emit(event_types.EXTENSION_SETTINGS_LOADED);
}

export async function loadOne(ext) {
    const { name, manifest } = ext;
    const base = `/scripts/extensions/third-party/${encodeURIComponent(name)}/`;
    try {
        for (const css of [].concat(manifest.css || [])) {
            if (!css) continue;
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = base + css;
            link.dataset.extension = name;
            document.head.append(link);
        }
        if (manifest.generate_interceptor) interceptors.push(manifest.generate_interceptor);
        for (const js of [].concat(manifest.js || [])) {
            if (js) await import(base + js);
        }
        loaded.set(name, { manifest });
    } catch (err) {
        console.error(`Extension ${name} failed to load`, err);
        loaded.set(name, { manifest, error: err.message || String(err) });
        toast(`${manifest.display_name || name}: ${err.message}`, 'error', { title: 'Extension failed to load' });
    }
}
