// SillyTavern service APIs that extensions call directly: Connection Manager,
// ChatCompletionService, persona helpers, and assorted utils/script.js exports.
import { state, saveSettingsDebounced, currentPersona, connectionRequest } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { streamCompletion, completion, api } from '../api.js';
import { samplerParams } from '../prompt.js';
import { sendMessage } from '../chat.js';
import { stProfiles, applyProfile } from './dom.js';

// ---------------------------------------------------------------------------
// Generation services
// ---------------------------------------------------------------------------

/** Turn a streamCompletion into ST's stream shape: a function returning an async generator of { text }. */
function streamAsGenerator(body, signal) {
    return () => (async function* gen() {
        const queue = [];
        let done = false;
        let error = null;
        let wake = null;
        let text = '';
        let reasoning = '';
        streamCompletion(body, {
            signal,
            onText: t => { text += t; queue.push({ text, swipes: [], state: { reasoning } }); wake?.(); },
            onReasoning: r => { reasoning += r; },
        }).then(() => { done = true; wake?.(); }, err => { error = err; done = true; wake?.(); });
        for (;;) {
            if (queue.length) { yield queue.shift(); continue; }
            if (error) throw error;
            if (done) return;
            await new Promise(r => { wake = r; });
            wake = null;
        }
    })();
}

function connectionFor(profileId) {
    const p = (state.settings.connection.profiles || []).find(x => x.id === profileId);
    const c = p || state.settings.connection;
    return connectionRequest(c);
}

function paramsFrom(payload = {}, maxTokens) {
    const params = { ...samplerParams() };
    const map = { temperature: 'temperature', top_p: 'top_p', top_k: 'top_k', min_p: 'min_p', frequency_penalty: 'frequency_penalty', presence_penalty: 'presence_penalty', repetition_penalty: 'repetition_penalty', max_tokens: 'max_tokens', seed: 'seed', stop: 'stop', reasoning_effort: 'reasoning_effort' };
    for (const [k, v] of Object.entries(map)) if (payload[k] !== undefined && payload[k] !== null) params[v] = payload[k];
    if (maxTokens) params.max_tokens = maxTokens;
    return params;
}

function toContent(messages) {
    return (messages || []).map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : (m.content || []).map(x => x.text || '').join(''), ...(m.name ? { name: m.name } : {}) }));
}

export const ConnectionManagerRequestService = {
    defaultSendRequestParams: { stream: false, signal: null, extractData: true, includePreset: true, includeInstruct: true },
    getSupportedProfiles: () => stProfiles(),
    getProfile: id => stProfiles().find(p => p.id === id),
    isProfileSupported: () => true,
    validateProfile: profile => profile,
    constructPrompt: messages => messages,
    async sendRequest(profileId, prompt, maxTokens, custom = {}, overridePayload = {}) {
        const messages = typeof prompt === 'string' ? [{ role: 'user', content: prompt }] : toContent(prompt);
        const body = { ...connectionFor(profileId), messages, params: paramsFrom(overridePayload, maxTokens) };
        if (custom.stream) return streamAsGenerator(body, custom.signal);
        const res = await completion(body, { signal: custom.signal });
        if (custom.extractData === false) return { choices: [{ message: { content: res.text, reasoning_content: res.reasoning } }] };
        return { content: res.text, reasoning: res.reasoning };
    },
    handleDropdown() {},
};

export const ChatCompletionService = {
    TYPE: 'openai',
    async presetToGeneratePayload(_preset = {}, overridePreset = {}, custom = {}) {
        return { ...paramsFrom({}), ...overridePreset, ...custom };
    },
    createRequestData(custom) { return { ...custom }; },
    async processRequest(custom, _options, extractData = true, signal = null) { return this.sendRequest(custom, extractData, signal); },
    async sendRequest(data = {}, extractData = true, signal = null) {
        const conn = state.settings.connection;
        const body = { ...connectionRequest(conn), model: data.model || conn.model, messages: toContent(data.messages), params: paramsFrom(data, data.max_tokens) };
        if (data.stream) return streamAsGenerator(body, signal);
        const res = await completion(body, { signal });
        return extractData ? { content: res.text, reasoning: res.reasoning } : { choices: [{ message: { content: res.text, reasoning_content: res.reasoning } }] };
    },
};

export const TextCompletionService = {
    TYPE: 'textgenerationwebui',
    async sendRequest() { throw new Error('Reverie only supports chat completion APIs'); },
};

// ---------------------------------------------------------------------------
// Personas, in SillyTavern's shape (avatar id → name / description)
// ---------------------------------------------------------------------------
export const getUserAvatars = async () => (state.settings.personas || []).map(p => p.id);
export const getUserAvatar = id => (state.settings.personas || []).find(p => p.id === id)?.avatar || 'icons/user.svg';
export async function setUserAvatar(id) {
    const { setActivePersona } = await import('../personas.js');
    if (await setActivePersona(id)) await eventSource.emit(event_types.SETTINGS_UPDATED);
}
export function setPersonaDescription(text) {
    const p = (state.settings.personas || []).find(x => x.id === state.settings.personaId);
    if (p) { p.description = text; saveSettingsDebounced(); }
}

/** Resolve ST thumbnail requests to Reverie file URLs. */
export function getThumbnailUrl(type, file) {
    if (!file) return 'icons/icon.svg';
    if (type === 'persona') return getUserAvatar(file);
    if (type === 'bg') return /^(files|https?:|data:)/.test(file) ? file : `files/backgrounds/${encodeURIComponent(file)}`;
    if (/^(files|https?:|data:|icons)/.test(file)) return file;
    return `files/avatars/${encodeURIComponent(file)}`;
}

// ---------------------------------------------------------------------------
// Misc exports from script.js / utils.js / others
// ---------------------------------------------------------------------------
export async function getPastCharacterChats(characterId) {
    const summary = state.characters[characterId] ?? state.characters.find(c => c.id === state.character?.id);
    if (!summary) return [];
    const chats = await api.get(`chats/${encodeURIComponent(summary.id)}`);
    return chats.map(c => ({ file_name: `${c.id}.jsonl`, file_id: c.id, chat_items: c.count, mes: c.preview, last_mes: c.updated, file_size: '' }));
}

export const sendMessageAsUser = (text, _bias, insertAt) => sendMessage(text, { generateAfter: false, insertAt });
export const extractTextFromHTML = html => new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.textContent || '';
export const escapeRegex = s => String(s).replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
export function regexFromString(input) {
    try {
        const m = String(input).match(/(\/?)(.+)\1([a-z]*)/i);
        if (m[3] && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(m[3])) return new RegExp(input);
        return new RegExp(m[2], m[3]);
    } catch { return undefined; }
}
export const isDataURL = s => /^data:([a-z]+\/[a-z0-9-+.]+(;[a-z-]+=[a-z0-9-]+)?)?(;base64)?,([a-z0-9!$&',()*+;=\-._~:@/?%\s]*)\s*$/i.test(String(s));
export const trimToStartSentence = s => String(s).replace(/^[^.!?…]*[.!?…]\s*/, m => (m.length < s.length ? '' : m));
export async function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
}
/** ST signature: saveBase64AsFile(base64, subFolder, fileName, extension) → URL path */
export async function saveBase64AsFile(base64, subFolder, fileName, extension = 'png') {
    const res = await fetch('/api/images/upload', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64, ch_name: subFolder, filename: fileName, format: extension }),
    });
    if (!res.ok) throw new Error('Image upload failed');
    return (await res.json()).path;
}

export const isFirefox = () => /firefox/i.test(navigator.userAgent);
export const currentUserAvatar = () => state.settings.personaId || currentPersona().id;
