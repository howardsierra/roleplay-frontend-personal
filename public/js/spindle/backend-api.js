// Answers spindle.* calls from Lumiverse extension backends that need Reverie's data or UI.
// The server forwards them over the bridge; each handler gets (ext, ...args) and returns plain data.
import { state, saveChat, saveSettingsDebounced, currentPersona, connectionRequest } from '../state.js';
import { api, completion } from '../api.js';
import { eventSource, event_types } from '../events.js';
import { samplerParams } from '../prompt.js';
import { substituteParams, variables } from '../macros.js';
import { addOneMessage, updateMessageBlock, printMessages, nowDate, generate, syncSwipe, refreshSwipeControls } from '../chat.js';
import { toast, modal, confirmDialog, promptDialog, el } from '../ui.js';
import { scanWorldInfo } from '../worldinfo.js';
import { messageId } from '../message-ids.js';
import {
    activeChatId, isActiveChat, toChatId, loadChat, saveOtherChat, messageDto, rawMessage,
    characterDto, personaDto, chatDto, connectionDto, imageDto, personaById,
} from './dto.js';
import { emitLumiverse, nextGenerationId } from './events.js';
import { applyThemeOverride, clearThemeOverride, currentThemeInfo } from './theme.js';
import { generateThemeVariables } from './lumiverse-theme-engine.js';

const generateVariables = cfg => generateThemeVariables({ ...currentThemeInfo(), ...(cfg || {}) });

const notFound = what => Object.assign(new Error(`${what} not found`), { code: 'NOT_FOUND' });
const lastArgObject = args => (args.length && typeof args.at(-1) === 'object' && args.at(-1) !== null ? args.at(-1) : {});

// ---------------------------------------------------------------- messages
async function findMessage(lvChatId, id) {
    const chat = await loadChat(lvChatId);
    const index = chat.messages.findIndex(m => messageId(m) === id);
    if (index < 0) throw notFound('Message');
    return { chat, index, mes: chat.messages[index] };
}

async function commit(chat, index, { rerender = true } = {}) {
    if (chat.active) {
        if (rerender && index !== undefined) updateMessageBlock(index);
        await saveChat();
    } else await saveOtherChat(chat);
}

const chatApi = {
    async getMessages(_ext, lvChatId) {
        const chat = await loadChat(lvChatId || activeChatId());
        const before = chat.messages.map(m => m.rv_id);
        const out = chat.messages.map((m, i) => messageDto(m, i, toChatId(chat.charId, chat.chatId)));
        // New ids were assigned: persist them so they stay stable.
        if (chat.messages.some((m, i) => m.rv_id !== before[i])) chat.active ? saveChat() : saveOtherChat(chat);
        return out;
    },

    async appendMessage(ext, lvChatId, message = {}, options) {
        const chat = await loadChat(lvChatId || activeChatId());
        const role = message.role || 'assistant';
        const mes = {
            name: role === 'user' ? currentPersona().name || 'User' : role === 'system' ? 'System' : chat.messages.findLast?.(m => !m.is_user)?.name || state.character?.card?.data?.name || 'Assistant',
            is_user: role === 'user',
            is_system: false,
            send_date: nowDate(),
            mes: String(message.content ?? ''),
            extra: { spindle_metadata: message.metadata || {}, ...(role === 'system' ? { spindle_role: 'system' } : {}), spindle_ext: ext },
        };
        chat.messages.push(mes);
        const id = messageId(mes);
        const index = chat.messages.length - 1;
        const trigger = options === true || options?.triggerGeneration;
        let generationId;
        if (chat.active) {
            addOneMessage(mes, { forceId: index });
            refreshSwipeControls();
            await saveChat();
            emitLumiverse('MESSAGE_SENT', { chatId: activeChatId(), message: rawMessage(mes, index) });
            if (trigger) {
                generationId = nextGenerationId();
                setTimeout(() => generate('normal'), 0);
            }
        } else await saveOtherChat(chat);
        return { id, ...(generationId ? { generationId } : {}) };
    },

    async updateMessage(_ext, lvChatId, id, patch = {}) {
        const { chat, index, mes } = await findMessage(lvChatId || activeChatId(), id);
        const previousSwipeId = mes.swipe_id ?? 0;
        const swipeTouched = 'swipes' in patch || 'swipe_id' in patch || 'swipe_dates' in patch;
        if (Array.isArray(patch.swipes)) {
            mes.swipes = patch.swipes.map(String);
            mes.swipe_info = mes.swipes.map((_, i) => mes.swipe_info?.[i] || {});
        }
        if (patch.swipe_id !== undefined && mes.swipes?.length) mes.swipe_id = Math.max(0, Math.min(mes.swipes.length - 1, Number(patch.swipe_id)));
        if (swipeTouched && mes.swipes?.length) mes.mes = mes.swipes[mes.swipe_id ?? 0];
        if (patch.content !== undefined) {
            mes.mes = String(patch.content);
            if (mes.swipes?.length) mes.swipes[mes.swipe_id ?? 0] = mes.mes;
        }
        mes.extra ??= {};
        if (patch.metadata !== undefined) mes.extra.spindle_metadata = patch.metadata || {};
        if (patch.reasoning) {
            if (patch.reasoning.text !== undefined) mes.extra.reasoning = patch.reasoning.text || '';
            if (patch.reasoning.duration !== undefined) mes.extra.reasoning_duration = patch.reasoning.duration;
        }
        if (chat.active) syncSwipe(mes);
        await commit(chat, index);
        const payload = { chatId: toChatId(chat.charId, chat.chatId), message: rawMessage(mes, index, toChatId(chat.charId, chat.chatId)) };
        emitLumiverse('MESSAGE_EDITED', payload);
        if (swipeTouched) emitLumiverse('SWIPE_EDITED', { ...payload, previousSwipeId });
    },

    async deleteMessage(_ext, lvChatId, id) {
        const { chat, index } = await findMessage(lvChatId || activeChatId(), id);
        chat.messages.splice(index, 1);
        if (chat.active) { printMessages(); await saveChat(); } else await saveOtherChat(chat);
        emitLumiverse('MESSAGE_DELETED', { chatId: toChatId(chat.charId, chat.chatId), messageId: id });
    },

    async setMessageHidden(_ext, lvChatId, id, hidden) {
        const { chat, index, mes } = await findMessage(lvChatId || activeChatId(), id);
        mes.is_system = !!hidden;
        await commit(chat, index);
    },
    async setMessagesHidden(ext, lvChatId, ids = [], hidden) {
        for (const id of ids) await chatApi.setMessageHidden(ext, lvChatId, id, hidden);
    },
    async isMessageHidden(_ext, lvChatId, id) {
        return !!(await findMessage(lvChatId || activeChatId(), id)).mes.is_system;
    },
    async setStyleMode() { return true; },
};

// ---------------------------------------------------------------- chats, characters, personas
async function allChats(charId) {
    const list = await api.get(`chats/${encodeURIComponent(charId)}`).catch(() => []);
    return list.map(c => ({ ...chatDto(charId, c.id, {}), updated_at: Math.floor(c.updated / 1000) }));
}

const chatsApi = {
    async getActive() {
        return state.character && state.chatId ? chatDto(state.character.id, state.chatId, state.chatMeta) : null;
    },
    async get(_ext, lvChatId) {
        if (!lvChatId) return null;
        try {
            const chat = await loadChat(lvChatId);
            return chatDto(chat.charId, chat.chatId, chat.meta);
        } catch { return null; }
    },
    async list(_ext, opts = {}) {
        const charId = opts?.characterId || opts?.character_id;
        const ids = charId ? [charId] : state.characters.map(c => c.id);
        const data = (await Promise.all(ids.map(allChats))).flat();
        return { data: data.slice(opts.offset || 0, (opts.offset || 0) + (opts.limit || 100)), total: data.length };
    },
    async update(_ext, lvChatId, patch = {}) {
        const chat = await loadChat(lvChatId);
        if (patch.metadata) {
            chat.meta.chat_metadata = { ...(chat.meta.chat_metadata || {}), ...patch.metadata };
            if (chat.active) state.chatMeta = chat.meta;
        }
        chat.active ? await saveChat() : await saveOtherChat(chat);
        return chatDto(chat.charId, chat.chatId, chat.meta);
    },
};

async function loadCharacter(id) {
    if (!id) return null;
    if (state.character?.id === id) return state.character;
    return api.get(`characters/${encodeURIComponent(id)}`).catch(() => null);
}

const charactersApi = {
    async get(_ext, id) { return characterDto(await loadCharacter(id)); },
    async list(_ext, opts = {}) {
        const all = await Promise.all(state.characters.map(c => loadCharacter(c.id)));
        const data = all.filter(Boolean).map(characterDto);
        const offset = opts?.offset || 0;
        return { data: data.slice(offset, offset + (opts?.limit || 200)), total: data.length };
    },
    async update(_ext, id, patch = {}) {
        const c = await loadCharacter(id);
        if (!c) throw notFound('Character');
        const card = structuredClone(c.card);
        for (const k of ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'system_prompt', 'post_history_instructions', 'tags', 'alternate_greetings', 'creator']) {
            if (patch[k] !== undefined) card.data[k] = patch[k];
        }
        if (patch.extensions) card.data.extensions = { ...(card.data.extensions || {}), ...patch.extensions };
        const saved = await api.put(`characters/${encodeURIComponent(id)}`, { card });
        if (state.character?.id === id) state.character = saved;
        return characterDto(saved);
    },
};

const personasApi = {
    async getActive() { return personaDto(currentPersona()); },
    async get(_ext, id) { return personaDto(personaById(id)); },
    async list(_ext, opts = {}) {
        const data = (state.settings.personas || []).map(personaDto);
        const offset = opts?.offset || 0;
        return { data: data.slice(offset, offset + (opts?.limit || 200)), total: data.length };
    },
    async getDefault() { return personaDto(currentPersona()); },
    async switchActive(_ext, id) {
        if (!personaById(id)) throw notFound('Persona');
        state.settings.personaId = id;
        saveSettingsDebounced();
        await eventSource.emit(event_types.PERSONA_CHANGED, id);
    },
};

// ---------------------------------------------------------------- variables
const scoped = (lvChatId, fn) => {
    if (!isActiveChat(lvChatId)) throw new Error('Chat variables are only available for the open chat');
    return fn();
};
const localVars = {
    get: (_e, chatId, key) => scoped(chatId, () => variables.local.get(key)),
    set: (_e, chatId, key, value) => scoped(chatId, () => { variables.local.set(key, value); saveChat(); }),
    delete: (_e, chatId, key) => scoped(chatId, () => { variables.local.del(key); saveChat(); }),
    has: (_e, chatId, key) => scoped(chatId, () => variables.local.has(key)),
    list: (_e, chatId) => (isActiveChat(chatId) ? { ...(state.chatMeta.chat_metadata?.variables || {}) } : {}),
};
const globalVars = {
    get: (_e, key) => variables.global.get(key),
    set: (_e, key, value) => { variables.global.set(key, value); },
    delete: (_e, key) => { variables.global.del(key); },
    has: (_e, key) => variables.global.has(key),
    list: () => ({ ...(state.settings.variables?.global || {}) }),
};

// ---------------------------------------------------------------- generation
const textOf = content => (Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : String(content ?? ''));

/** Lumiverse message parts → OpenAI-style content (images become image_url data URLs). */
function toProviderMessages(messages = []) {
    return messages.map(m => {
        const out = { role: ['system', 'user', 'assistant'].includes(m.role) ? m.role : 'user' };
        if (Array.isArray(m.content)) {
            const hasImage = m.content.some(p => p?.type === 'image');
            out.content = hasImage
                ? m.content.filter(p => p?.type === 'text' || p?.type === 'image').map(p => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime_type || 'image/png'};base64,${p.data}` } }))
                : textOf(m.content);
        } else out.content = String(m.content ?? '');
        if (m.name) out.name = m.name;
        return out;
    });
}

function connectionFor(id) {
    const c = state.settings.connection;
    const p = id && (c.profiles || []).find(x => x.id === id);
    return p || c;
}

async function runGeneration(input = {}, kind = 'raw') {
    const conn = connectionFor(input.connection_id);
    const params = { ...samplerParams(), ...(input.parameters || {}) };
    if (input.reasoning?.source === 'off') delete params.reasoning_effort;
    const custom = {};
    for (const k of ['response_format', 'tools', 'tool_choice']) if (params[k] !== undefined) { custom[k] = params[k]; delete params[k]; }
    if (Object.keys(custom).length) params.custom_body = { ...(params.custom_body || {}), ...custom };
    let messages = input.messages;
    if (!messages?.length && kind === 'quiet' && input.prompt) messages = [{ role: 'user', content: input.prompt }];
    const body = {
        ...connectionRequest(conn),
        provider: input.provider || conn.provider,
        model: input.model || params.model || conn.model,
        messages: toProviderMessages(messages || []),
        params,
    };
    delete params.model;
    const res = await completion(body);
    return { content: res.text || '', reasoning: res.reasoning || undefined, finish_reason: res.finish || res.finish_reason || 'stop', usage: res.usage };
}

const generateApi = {
    raw: (_e, input) => runGeneration(input, 'raw'),
    quiet: (_e, input) => runGeneration(input, 'quiet'),
    async batch(_e, input) {
        const requests = input?.requests || [];
        return Promise.all(requests.map((r, index) => runGeneration(r).then(x => ({ index, success: true, ...x }), err => ({ index, success: false, error: err.message }))));
    },
    async dryRun() {
        const { buildPrompt } = await import('../prompt.js');
        const { messages, breakdown } = await buildPrompt({ type: 'normal', dryRun: true });
        return { messages, breakdown, parameters: samplerParams() };
    },
};

const connectionsApi = {
    async list() {
        const c = state.settings.connection;
        return [connectionDto(c), ...(c.profiles || []).map(p => connectionDto(p, { isDefault: false }))];
    },
    async get(_e, id) {
        if (!id || id === 'active') return connectionDto(state.settings.connection);
        const p = (state.settings.connection.profiles || []).find(x => x.id === id);
        return p ? connectionDto(p, { isDefault: false }) : null;
    },
};

// ---------------------------------------------------------------- images
const imageConnection = () => {
    const i = state.settings.image;
    return { id: 'image-active', name: `Reverie image settings (${i.provider})`, provider: i.provider, api_url: i.baseUrl || '', model: i.model || '', is_default: true, has_api_key: true, default_parameters: { width: i.width, height: i.height, steps: i.steps, cfg_scale: i.scale, negative_prompt: i.negative }, metadata: {}, created_at: 0, updated_at: 0 };
};
const fileName = url => decodeURIComponent(String(url || '').split('/').pop().split('?')[0]);

async function uploadDataUrl(dataUrl, name = 'image.png') {
    const blob = await (await fetch(dataUrl)).blob();
    const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const res = await api.upload(`images?name=${encodeURIComponent(/\.\w+$/.test(name) ? name : `${name}.${ext}`)}`, blob);
    return res.name;
}

const imageOwners = () => (state.settings.spindleImageOwners ??= {});

const imagesApi = {
    async get(_e, id) {
        if (!id) return null;
        const exists = await fetch(`/api/v1/images/${encodeURIComponent(id)}`, { method: 'HEAD' }).then(r => r.ok).catch(() => false);
        return exists ? imageDto(id, { owner: imageOwners()[id] || null }) : null;
    },
    async list(_e, opts = {}) {
        let all = (await api.get('images')).map(x => imageDto(x.name, { owner: imageOwners()[x.name] || null }));
        if (opts?.onlyOwned) all = all.filter(x => x.owner_extension_identifier);
        const offset = opts?.offset || 0;
        return { data: all.slice(offset, offset + (opts?.limit || 50)), total: all.length };
    },
    async uploadFromDataUrl(ext, dataUrl, opts) {
        const name = await uploadDataUrl(dataUrl, typeof opts === 'string' ? opts : opts?.originalFilename || 'image');
        imageOwners()[name] = ext;
        saveSettingsDebounced();
        return imageDto(name, { owner: ext });
    },
    async upload(ext, input = {}) {
        const data = input.data || input.base64;
        const dataUrl = String(data).startsWith('data:') ? data : `data:${input.mime_type || input.mimeType || 'image/png'};base64,${data}`;
        return imagesApi.uploadFromDataUrl(ext, dataUrl, { originalFilename: input.original_filename || input.filename || 'image' });
    },
    async delete(_e, id) {
        await api.del(`images/${encodeURIComponent(id)}`);
        delete imageOwners()[id];
        return true;
    },
};

const imageGenApi = {
    async listConnections() { return [imageConnection()]; },
    async getConnection(_e, id) { return !id || id === 'image-active' ? imageConnection() : null; },
    async getProviders() { return [{ id: state.settings.image.provider, name: state.settings.image.provider, capabilities: {} }]; },
    async getModels() { return state.settings.image.model ? [{ id: state.settings.image.model, label: state.settings.image.model }] : []; },
    async generate(ext, input = {}) {
        const p = input.parameters || {};
        const i = state.settings.image;
        const res = await api.post('images/generate', {
            provider: i.provider, model: input.model || i.model, baseUrl: i.baseUrl,
            prompt: input.prompt || '', negative: input.negativePrompt ?? input.negative_prompt ?? i.negative,
            width: p.width || i.width, height: p.height || i.height, steps: p.steps || i.steps, scale: p.cfg_scale || p.scale || i.scale,
            sampler: p.sampler || i.sampler, quality: i.quality, workflow: i.workflow, seed: p.seed ?? i.seed ?? -1,
        });
        const name = fileName(res.url);
        imageOwners()[name] = ext;
        saveSettingsDebounced();
        return { imageId: name, imageUrl: `/api/v1/images/${encodeURIComponent(name)}`, provider: i.provider, model: input.model || i.model };
    },
};

// ---------------------------------------------------------------- world info & macros
const worldApi = {
    async getActivated(_e, lvChatId) {
        if (!isActiveChat(lvChatId)) return [];
        const res = await scanWorldInfo(state.chat.filter(m => !m.is_system)).catch(() => null);
        return (res?.activated || []).map(e => ({ id: `${e.world || 'wi'}:${e.uid}`, comment: e.comment || '', keys: e.key || [], source: 'keyword', bookId: e.world || null, bookSource: 'global', content: e.content }));
    },
    entries: {
        async get(_e, id) {
            const res = await scanWorldInfo(state.chat.filter(m => !m.is_system)).catch(() => null);
            const e = (res?.activated || []).find(x => `${x.world || 'wi'}:${x.uid}` === id);
            return e ? { id, content: e.content, comment: e.comment || '', key: e.key || [], priority: e.order ?? 100 } : null;
        },
        async list() { return { data: [], total: 0 }; },
    },
    async list() { return { data: [], total: 0 }; },
    async getGlobal() { return [...(state.settings.worlds?.active || [])]; },
};

const macrosApi = {
    async resolve(_e, template, _opts) {
        // Unknown macros are left as written.
        return { text: substituteParams(String(template ?? '')), diagnostics: [] };
    },
};

// ---------------------------------------------------------------- UI
const toastApi = {};
for (const type of ['info', 'success', 'warning', 'error']) toastApi[type] = (ext, message, opts = {}) => { toast(String(message), type, { title: opts?.title || extName(ext) }); };

let extNames = {};
export const setExtNames = names => { extNames = names; };
const extName = id => extNames[id] || id;

const modalApi = {
    async confirm(ext, opts = {}) {
        const confirmed = await confirmDialog(opts.message || '', { title: opts.title || extName(ext), okLabel: opts.confirmLabel, danger: opts.variant === 'danger' });
        return { confirmed: !!confirmed };
    },
    async prompt(ext, opts = {}) {
        const value = await promptDialog(opts.message || opts.title || '', opts.defaultValue || opts.value || '', { title: opts.title || extName(ext), multiline: !!opts.multiline, placeholder: opts.placeholder || '' });
        return { value, cancelled: value === null };
    },
    async open(ext, opts = {}) {
        const body = el('div', { class: 'stack' });
        for (const item of opts.items || opts.content || []) {
            if (typeof item === 'string') body.append(el('p', {}, item));
            else if (item?.type === 'text' || item?.type === 'paragraph') body.append(el('p', {}, item.text || item.content || ''));
            else if (item?.type === 'heading') body.append(el('h4', {}, item.text || ''));
            else if (item?.text) body.append(el('p', {}, item.text));
        }
        if (opts.body) body.append(el('p', {}, String(opts.body)));
        await modal({ title: opts.title || extName(ext), content: body });
        return { dismissedBy: 'user' };
    },
};

const textEditorApi = {
    async open(ext, opts = {}) {
        const value = await promptDialog(opts.title || 'Edit text', opts.value ?? opts.text ?? '', { title: opts.title || extName(ext), multiline: true });
        return { text: value ?? opts.value ?? '', cancelled: value === null };
    },
};

const uiApi = {
    async openDrawerTab(_e, tab) {
        const { openSettings } = await import('../panels/settings.js');
        const map = { imagegen: 'images', connections: 'connection', extensions: 'extensions', presets: 'preset', personas: 'persona' };
        if (map[tab]) openSettings(map[tab]);
        else document.dispatchEvent(new CustomEvent('spindle:open-tab', { detail: { tab } }));
        return true;
    },
    async openSettings(_e, view) { const { openSettings } = await import('../panels/settings.js'); openSettings(view === 'extensions' ? 'extensions' : undefined); return true; },
    async closeSettings() { document.querySelector('#right-nav-panel .drawer-close')?.click(); return true; },
    async closeDrawer() { return true; },
    async getDrawerTabs() { return []; },
    async getSettingsTabs() { return []; },
    async openCommandPalette() { return false; },
    async closeCommandPalette() { return false; },
};

const themeApi = {
    getCurrent: () => currentThemeInfo(),
    generateVariables: (_e, cfg) => generateVariables(cfg),
    apply: (ext, overrides) => applyThemeOverride(ext, overrides),
    applyPalette: (ext, palette) => applyThemeOverride(ext, { variables: generateVariables({ ...currentThemeInfo(), ...(palette?.accent ? { accent: palette.accent } : {}) }) }),
    clear: ext => clearThemeOverride(ext),
    extractColors: async () => ({ colors: [] }),
};

const tokensApi = {
    countText: (_e, text) => ({ total_tokens: Math.ceil(String(text ?? '').length / 3.6), approximate: true }),
    countMessages: (_e, messages = []) => ({ total_tokens: messages.reduce((n, m) => n + Math.ceil(textOf(m.content).length / 3.6) + 4, 0), approximate: true }),
    countChat: () => ({ total_tokens: state.chat.reduce((n, m) => n + Math.ceil(String(m.mes || '').length / 3.6) + 4, 0), approximate: true }),
};

const pushApi = {
    getStatus: () => ({ available: 'Notification' in window && Notification.permission === 'granted', subscriptionCount: 0 }),
    async send(ext, payload = {}) {
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(payload.title || extName(ext), { body: payload.body || '', tag: payload.tag });
        else toast(payload.body || payload.title || '', 'info', { title: payload.title || extName(ext) });
        return { sent: 1 };
    },
};

const empty = () => [];
const council = { getMembers: empty, getAvailableLumiaItems: empty, getConfig: () => ({ enabled: false }) };
const dlc = { getCatalog: () => ({ lumiaItems: [], packs: [] }) };
const memories = new Proxy({}, { get: () => new Proxy(() => [], { get: () => async () => [], apply: async () => [] }) });

/** method path ("chat.getMessages") → handler(ext, ...args) */
export const backendApi = {
    chat: chatApi,
    chats: chatsApi,
    characters: charactersApi,
    personas: personasApi,
    variables: { local: localVars, chat: localVars, global: globalVars },
    generate: generateApi,
    connections: connectionsApi,
    images: imagesApi,
    imageGen: imageGenApi,
    world_books: worldApi,
    macros: macrosApi,
    toast: Object.assign((ext, message, opts) => toastApi[opts?.type || 'info'](ext, message, opts), toastApi),
    modal: modalApi,
    prompt: { input: modalApi.prompt },
    textEditor: textEditorApi,
    ui: uiApi,
    theme: themeApi,
    tokens: tokensApi,
    push: pushApi,
    council,
    dlc,
    memories,
};

export function resolveHandler(method) {
    let node = backendApi;
    for (const part of method.split('.')) {
        if (node == null) return null;
        node = node[part];
    }
    return typeof node === 'function' ? node : null;
}

export { lastArgObject, toProviderMessages };
