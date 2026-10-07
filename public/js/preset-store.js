import { api } from './api.js';
import { state, saveSettingsDebounced } from './state.js';
import { eventSource, event_types } from './events.js';
import { defaultPreset, normalizePreset } from './presets.js';

export async function listPresets() {
    return api.get('presets');
}

export async function ensurePreset() {
    let list = await listPresets();
    if (!list.length) {
        const created = await api.post('presets', defaultPreset());
        list = [created];
    }
    const id = list.some(p => p.id === state.settings.presetId) ? state.settings.presetId : list[0].id;
    await selectPreset(id, { silent: true });
}

export async function selectPreset(id, { silent = false } = {}) {
    await eventSource.emit(event_types.OAI_PRESET_CHANGED_BEFORE, { preset: state.preset });
    const preset = await api.get(`presets/${encodeURIComponent(id)}`);
    state.preset = normalizePreset(preset);
    state.settings.presetId = id;
    saveSettingsDebounced();
    if (!silent) {
        await eventSource.emit(event_types.OAI_PRESET_CHANGED_AFTER);
        await eventSource.emit(event_types.PRESET_CHANGED, { apiId: 'openai', name: state.preset.name });
    }
}

let timer = null;
export function savePresetDebounced() {
    clearTimeout(timer);
    timer = setTimeout(savePreset, 700);
}

export async function savePreset() {
    clearTimeout(timer);
    if (!state.preset?.id) return;
    const saved = await api.put(`presets/${encodeURIComponent(state.preset.id)}`, state.preset);
    state.preset.updated = saved.updated;
}

export async function createPreset(preset) {
    const created = await api.post('presets', preset);
    await selectPreset(created.id);
    return created;
}

export async function deletePreset(id) {
    await api.del(`presets/${encodeURIComponent(id)}`);
    await eventSource.emit(event_types.PRESET_DELETED, { apiId: 'openai', id });
    await ensurePreset();
}
