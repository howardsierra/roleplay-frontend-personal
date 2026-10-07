// Central app state. `settings` is persisted to the server (data/settings.json).
import { api } from './api.js';
import { eventSource, event_types } from './events.js';

export const DEFAULT_SETTINGS = {
    connection: {
        provider: 'openrouter',
        model: '',
        baseUrl: '',
        profiles: [],
    },
    presetId: null,
    personas: [],
    personaId: null,
    worlds: { active: [], scanDepth: 4, budgetPercent: 30, recursive: true, includeNames: true },
    regex: [],
    allowCharacterRegex: true,
    image: {
        provider: 'pollinations',
        model: '',
        baseUrl: '',
        width: 832,
        height: 1216,
        steps: 28,
        scale: 6,
        sampler: '',
        negative: 'lowres, bad anatomy, bad hands, text, error, watermark, signature, blurry',
        prefix: 'masterpiece, best quality, ',
        workflow: '',
        inlineTags: true,
        autoGenerateInline: true,
        promptFromChatInstruction: 'Describe the current scene from the last message as a single comma-separated image generation prompt: subject, appearance, clothing, pose, setting, lighting, style. Reply with the prompt only.',
    },
    generation: {
        preferCharPrompt: true,
        preferCharInstructions: true,
        maxContextOverride: null,
        trimIncomplete: false,
    },
    render: {
        html: true,
        quotes: true,
        python: 'button',
        pyodideUrl: 'https://cdn.jsdelivr.net/pyodide/v0.28.3/full/',
        iframeScripts: true,
        reasoningCollapsed: true,
    },
    appearance: {
        themeName: 'Nocturne',
        theme: null,
        background: '',
        bgBlur: 0,
        bgDim: 0.35,
        chatStyle: 'cards',
        chatFont: 'Lora',
        uiFont: 'Inter',
        fontScale: 1,
        chatWidth: 52,
        avatarStyle: 'round',
        aurora: true,
        showTimestamps: false,
        enterToSend: 'desktop',
    },
    extension_settings: {},
    extensions: { disabled: [] },
    variables: { global: {} },
};

function merge(base, extra) {
    if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra ?? base;
    const out = { ...base };
    for (const [k, v] of Object.entries(extra ?? {})) {
        out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k]) && typeof v === 'object' && v !== null && !Array.isArray(v)
            ? merge(base[k], v)
            : v;
    }
    return out;
}

export const state = {
    settings: structuredClone(DEFAULT_SETTINGS),
    characters: [],
    character: null, // full character object { id, card, avatar }
    chatId: null,
    chat: [], // array of SillyTavern-shaped messages
    chatMeta: {}, // header line of the JSONL (contains chat_metadata)
    preset: null,
    worldsCache: new Map(),
    generating: false,
    abortController: null,
    providers: null,
};

export async function loadSettings() {
    const saved = await api.get('settings');
    state.settings = merge(structuredClone(DEFAULT_SETTINGS), saved);
}

let saveTimer = null;
export function saveSettingsDebounced() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettings, 600);
}

export async function saveSettings() {
    clearTimeout(saveTimer);
    await api.put('settings', state.settings);
    eventSource.emit(event_types.SETTINGS_UPDATED);
}

export function chatMetadata() {
    state.chatMeta.chat_metadata ??= {};
    return state.chatMeta.chat_metadata;
}

let chatSaveTimer = null;
let chatSaving = Promise.resolve();
export function saveChatDebounced() {
    clearTimeout(chatSaveTimer);
    chatSaveTimer = setTimeout(saveChat, 500);
}

export async function saveChat() {
    clearTimeout(chatSaveTimer);
    if (!state.character || !state.chatId) return;
    const charId = state.character.id;
    const chatId = state.chatId;
    const payload = { meta: state.chatMeta, messages: state.chat };
    chatSaving = chatSaving.then(() => api.put(`chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`, payload)).catch(err => {
        console.error('Chat save failed', err);
    });
    return chatSaving;
}

/** Saved OpenAI-compatible endpoints ({ id, name, baseUrl }); each has its own key on the server. */
export function customEndpoint(c = state.settings.connection) {
    return c.provider === 'custom' ? (state.settings.connection.endpoints || []).find(e => e.id === c.endpointId) || null : null;
}

/** The provider fields every chat request sends (the server picks the right API key from them). */
export function connectionRequest(c = state.settings.connection) {
    const ep = customEndpoint(c);
    return { provider: c.provider, model: c.model, baseUrl: c.baseUrl || ep?.baseUrl || '', ...(ep ? { endpointId: ep.id } : {}) };
}

export function currentPersona() {
    const { personas, personaId } = state.settings;
    return personas.find(p => p.id === personaId) || personas[0] || { id: null, name: 'User', description: '', avatar: '' };
}

export function charName() {
    return state.character?.card?.data?.name || '';
}

export function userName() {
    return currentPersona().name || 'User';
}
