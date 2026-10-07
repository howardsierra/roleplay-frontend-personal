// Bridges SillyTavern-shaped DOM elements (that extensions look for) to Reverie's real state:
// #customCSS, #connection_profiles, #chat_completion_source, ST sampler inputs, chat menu options,
// and draggable floating panels (#movingDivs / .drag-grabber / .dragClose).
import { state, saveSettingsDebounced } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { applyTheme } from '../themes.js';
import { savePresetDebounced } from '../preset-store.js';
import { debounce, toast } from '../ui.js';

const $ = window.jQuery;

export function ensureProfileIds() {
    let changed = false;
    for (const p of state.settings.connection.profiles || []) {
        if (!p.id) {
            p.id = crypto.randomUUID();
            changed = true;
        }
    }
    if (changed) saveSettingsDebounced();
}

/** Profiles in the shape ST's Connection Manager uses. */
export function stProfiles() {
    ensureProfileIds();
    return (state.settings.connection.profiles || []).map(p => ({
        id: p.id, name: p.name, mode: 'cc', api: p.provider, model: p.model, 'api-url': p.baseUrl || '',
        preset: state.preset?.name, provider: p.provider, baseUrl: p.baseUrl || '',
    }));
}

function activeProfileId() {
    const c = state.settings.connection;
    return (c.profiles || []).find(p => p.provider === c.provider && p.model === c.model && (p.baseUrl || '') === (c.baseUrl || ''))?.id || '';
}

/** Keep extension_settings.connectionManager in sync (read directly by many extensions). */
export function syncConnectionManager() {
    const es = state.settings.extension_settings;
    es.connectionManager = { ...(es.connectionManager || {}), profiles: stProfiles(), selectedProfile: activeProfileId() || null };
}

const SAMPLER_INPUTS = {
    temp_openai: 'temperature', top_p_openai: 'top_p', top_k_openai: 'top_k', min_p_openai: 'min_p',
    freq_pen_openai: 'frequency_penalty', pres_pen_openai: 'presence_penalty', repetition_penalty_openai: 'repetition_penalty',
    openai_max_tokens: 'max_tokens', openai_max_context: 'context_size', seed_openai: 'seed',
};

function refreshDom() {
    const css = document.getElementById('customCSS');
    if (css && document.activeElement !== css) css.value = state.settings.appearance.customCss || '';

    const profiles = document.getElementById('connection_profiles');
    if (profiles) {
        profiles.replaceChildren(new Option('<None>', ''), ...stProfiles().map(p => new Option(p.name, p.id)));
        profiles.value = activeProfileId();
    }
    const source = document.getElementById('chat_completion_source');
    if (source) {
        const providers = state.providers?.chat || { [state.settings.connection.provider]: { label: state.settings.connection.provider } };
        source.replaceChildren(...Object.entries(providers).map(([k, v]) => new Option(v.label || k, k)));
        source.value = state.settings.connection.provider;
    }
    for (const [id, key] of Object.entries(SAMPLER_INPUTS)) {
        const input = document.getElementById(id);
        if (input && state.preset) input.value = state.preset.samplers[key] ?? '';
    }
    syncConnectionManager();
}

export function applyProfile(id) {
    const p = (state.settings.connection.profiles || []).find(x => x.id === id);
    if (!p) return false;
    Object.assign(state.settings.connection, { provider: p.provider, model: p.model, baseUrl: p.baseUrl || '' });
    saveSettingsDebounced();
    syncConnectionManager();
    eventSource.emit(event_types.CONNECTION_PROFILE_LOADED, p.name);
    return true;
}

// ---------------- draggable panels ----------------
export function dragElement($el) {
    const el = $el?.jquery ? $el[0] : $el;
    if (!el || el.dataset.rvDraggable) return;
    el.dataset.rvDraggable = '1';
    const handle = el.querySelector('.drag-grabber') || document.getElementById(`${el.id}header`) || el.querySelector('.dragTitle');
    if (!handle) return;
    handle.style.touchAction = 'none';
    handle.style.cursor = 'grab';
    handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const dx = e.clientX - rect.left;
        const dy = e.clientY - rect.top;
        handle.setPointerCapture(e.pointerId);
        const move = ev => {
            el.style.left = `${Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - dx))}px`;
            el.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
    });
}

export function installStDom() {
    ensureProfileIds();
    refreshDom();

    // jQuery handlers fire for both real input and extensions calling .trigger('input').
    const applyCss = debounce(() => applyTheme(), 150);
    $('#customCSS').on('input', function onCss() {
        state.settings.appearance.customCss = this.value;
        saveSettingsDebounced();
        applyCss();
    });
    $('#connection_profiles').on('change', function onProfile() {
        if (this.value && applyProfile(this.value)) toast(`Connection: ${this.selectedOptions[0]?.textContent}`, 'success', { timeout: 1400 });
    });
    $('#chat_completion_source').on('change', function onSource() {
        state.settings.connection.provider = this.value;
        saveSettingsDebounced();
        eventSource.emit(event_types.CHATCOMPLETION_SOURCE_CHANGED, this.value);
    });
    for (const [id, key] of Object.entries(SAMPLER_INPUTS)) {
        $(`#${id}`).on('input change', function onSampler() {
            if (!state.preset || this.value === '') return;
            state.preset.samplers[key] = Number(this.value);
            savePresetDebounced();
        });
    }

    const actions = {
        option_select_chat: () => import('../characters.js').then(m => m.showChatList()),
        option_start_new_chat: () => import('../characters.js').then(m => m.newChat()),
        option_close_chat: () => import('../characters.js').then(m => m.closeChat?.()),
        option_impersonate: () => import('../chat.js').then(m => m.generate('impersonate')),
        option_continue: () => import('../chat.js').then(m => m.generate('continue')),
        option_regenerate: () => import('../chat.js').then(m => m.swipeRight()),
    };
    for (const [id, fn] of Object.entries(actions)) document.getElementById(id)?.addEventListener('click', fn);

    // Floating panels: close buttons and ST's "draggable" class.
    document.addEventListener('click', e => {
        const close = e.target.closest('.dragClose, .floating_panel_close');
        if (close) close.closest('.draggable, .drawer-content.fillLeft, .drawer-content.fillRight')?.remove();
    });

    for (const ev of [event_types.SETTINGS_UPDATED, event_types.PRESET_CHANGED, event_types.OAI_PRESET_CHANGED_AFTER, event_types.CHATCOMPLETION_MODEL_CHANGED]) {
        eventSource.on(ev, refreshDom);
    }
}
