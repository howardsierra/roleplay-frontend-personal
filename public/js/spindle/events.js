// Translates Reverie (SillyTavern-style) events into Lumiverse event names and payloads, and fans
// them out to Lumiverse extension frontends (ctx.events.on) and backends (spindle.on).
import { state, currentPersona } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { api } from '../api.js';
import { messageId } from '../message-ids.js';
import { activeChatId, rawMessage, characterDto, personaDto, chatDto, toChatId } from './dto.js';
import { backendListens } from './hooks.js';

const local = new Map(); // event -> Set<fn>
let backendsListening = false;
export const setBackendsListening = on => { backendsListening = on; };

export function onLumiverse(name, fn) {
    if (!local.has(name)) local.set(name, new Set());
    local.get(name).add(fn);
    return () => local.get(name)?.delete(fn);
}

/** Deliver to frontends (always) and backends (unless the event is frontend-only). */
export function emitLumiverse(name, payload = {}, { backend = true } = {}) {
    for (const fn of [...(local.get(name) || [])]) {
        try { fn(payload); } catch (err) { console.error(`[Lumiverse ${name}]`, err); }
    }
    window.dispatchEvent(new CustomEvent(`spindle:${name}`, { detail: payload }));
    if (backend && backendsListening && backendListens(name)) api.post('spindle/event', { name, payload }).catch(() => {});
}

/** Backend-only delivery (frontends already got the event another way). */
function emitBackend(name, payload) {
    if (backendsListening && backendListens(name)) api.post('spindle/event', { name, payload }).catch(() => {});
}

// Stream tokens reach backends batched (one POST per ~150ms), and only when a backend listens.
let tokenBatch = null; // { generationId, chatId, messageId, token, seq }
let tokenTimer = null;
function flushTokens() {
    clearTimeout(tokenTimer);
    tokenTimer = null;
    const b = tokenBatch;
    tokenBatch = null;
    if (b?.token) emitBackend('STREAM_TOKEN_RECEIVED', b);
}
function queueBackendToken(p) {
    if (!backendsListening || !backendListens('STREAM_TOKEN_RECEIVED')) return;
    if (tokenBatch && tokenBatch.generationId !== p.generationId) flushTokens();
    tokenBatch = tokenBatch ? { ...tokenBatch, token: tokenBatch.token + p.token, seq: p.seq } : { ...p };
    tokenTimer ??= setTimeout(flushTokens, 150);
}

// ---------------------------------------------------------------- CRUD seen through Reverie's API calls
// Reverie has no events for most library changes, so the API client is watched for them.
let apiWatched = false;
function watchApi() {
    if (apiWatched) return;
    apiWatched = true;
    const parts = url => String(url).split('?')[0].split('/').map(decodeURIComponent);
    const after = (method, fn) => {
        const orig = api[method];
        api[method] = async (url, ...args) => {
            const out = await orig(url, ...args);
            try { fn(parts(url), out, args[0]); } catch (err) { console.error('[Lumiverse events]', err); }
            return out;
        };
    };
    const created = (p, out) => {
        if (p[0] === 'characters' && out?.id && (p.length === 1 || p[1] === 'import' || p[1] === 'assistant' || p[2] === 'duplicate')) {
            emitLumiverse('CHARACTER_CREATED', { id: out.id, character: characterDto(out) });
            if (p[2] === 'duplicate') emitLumiverse('CHARACTER_DUPLICATED', { id: out.id, sourceId: p[1], character: characterDto(out) });
        } else if (p[0] === 'chats' && p.length === 2 && out?.id) {
            const chat = chatDto(p[1], out.id, out.meta || {});
            emitLumiverse('CHAT_CREATED', { id: chat.id, chat });
        } else if (p[0] === 'worlds' && p.length === 1 && out?.id) {
            emitLumiverse('WORLD_BOOK_CHANGED', { id: out.id, worldBook: worldDto(out) });
        }
    };
    after('post', created);
    after('upload', created);
    after('put', (p, out) => {
        if (p[0] === 'worlds' && p[1]) emitLumiverse('WORLD_BOOK_CHANGED', { id: p[1], worldBook: worldDto(out || { id: p[1] }) });
    });
    after('del', p => {
        if (p[0] === 'chats' && p.length === 3) emitLumiverse('CHAT_DELETED', { id: toChatId(p[1], p[2]) });
        else if (p[0] === 'worlds' && p[1]) emitLumiverse('WORLD_BOOK_DELETED', { id: p[1] });
        else if (p[0] === 'presets' && p[1]) emitLumiverse('PRESET_DELETED', { id: p[1] });
    });
}
const worldDto = w => ({ id: w.id, name: w.name || '', description: w.description || '', metadata: { ...(w.metadata || {}) }, created_at: Math.floor((w.created || Date.now()) / 1000), updated_at: Math.floor((w.updated || Date.now()) / 1000) });

// ---------------------------------------------------------------- generations
let genSeq = 0;
let pendingGenId = null;
let current = null; // { generationId, chatId, type, targetId }
export function nextGenerationId() {
    pendingGenId = `gen-${Date.now().toString(36)}-${++genSeq}`;
    return pendingGenId;
}
export const currentGeneration = () => current;

const msgPayload = id => {
    const i = Number(id);
    const m = state.chat[i];
    return m ? { chatId: activeChatId(), message: rawMessage(m, i), messageId: messageId(m) } : null;
};

let knownIds = [];
const snapshotIds = () => { knownIds = state.chat.map(m => messageId(m)); };

let bridgeInstalled = false;
export function installEventBridge() {
    if (bridgeInstalled) return;
    bridgeInstalled = true;
    watchApi();
    const on = (type, fn) => eventSource.on(type, (...args) => { try { fn(...args); } catch (err) { console.error(err); } });

    on(event_types.CHAT_CHANGED, () => {
        snapshotIds();
        const chatId = activeChatId();
        emitLumiverse('CHAT_SWITCHED', { chatId });
        emitLumiverse('CHAT_CHANGED', { chatId, chat: chatId ? { id: chatId, character_id: state.character?.id } : null, changedFields: [] });
    });
    on(event_types.MESSAGE_SENT, id => { const p = msgPayload(id); if (p) emitLumiverse('MESSAGE_SENT', p); snapshotIds(); });
    on(event_types.MESSAGE_RECEIVED, (id, type) => {
        const p = msgPayload(id);
        if (current) { current.targetId = Number(id); current.type = type || current.type; }
        if (p && type !== 'swipe' && type !== 'regenerate' && type !== 'continue') emitLumiverse('MESSAGE_SENT', p);
        if (p && (type === 'swipe' || type === 'regenerate')) emitLumiverse('MESSAGE_SWIPED', { ...p, action: 'added', swipeId: p.message.swipe_id });
        snapshotIds();
    });
    on(event_types.MESSAGE_EDITED, id => { const p = msgPayload(id); if (p) emitLumiverse('MESSAGE_EDITED', p); });
    on(event_types.MESSAGE_UPDATED, id => { const p = msgPayload(id); if (p) emitLumiverse('MESSAGE_EDITED', p); });
    on(event_types.MESSAGE_SWIPED, id => {
        const p = msgPayload(id);
        if (p && !state.generating) emitLumiverse('MESSAGE_SWIPED', { ...p, action: 'navigated', swipeId: p.message.swipe_id });
    });
    on(event_types.MESSAGE_SWIPE_DELETED, ({ messageId: idx, swipeId } = {}) => {
        const p = msgPayload(idx);
        if (p) emitLumiverse('MESSAGE_SWIPED', { ...p, action: 'deleted', swipeId: swipeId ?? 0, previousSwipeId: swipeId ?? 0 });
    });
    on(event_types.MESSAGE_DELETED, () => {
        const now = new Set(state.chat.map(m => messageId(m)));
        for (const id of knownIds) if (!now.has(id)) emitLumiverse('MESSAGE_DELETED', { chatId: activeChatId(), messageId: id });
        snapshotIds();
    });
    on(event_types.CHARACTER_MESSAGE_RENDERED, id => { const p = msgPayload(id); if (p) emitLumiverse('CHARACTER_MESSAGE_RENDERED', { chatId: p.chatId, messageId: p.messageId, content: p.message.content, is_user: false }); });
    on(event_types.USER_MESSAGE_RENDERED, id => { const p = msgPayload(id); if (p) emitLumiverse('USER_MESSAGE_RENDERED', { chatId: p.chatId, messageId: p.messageId, content: p.message.content, is_user: true }); });

    on(event_types.GENERATION_STARTED, type => {
        if (type === 'quiet') return; // Lumiverse only reports chat generations
        const generationId = pendingGenId || `gen-${Date.now().toString(36)}-${++genSeq}`;
        pendingGenId = null;
        const last = state.chat.at(-1);
        const swiping = type === 'swipe' || type === 'regenerate' || type === 'continue';
        current = { generationId, chatId: activeChatId(), type, targetId: swiping ? state.chat.length - 1 : null };
        streamed = '';
        seq = 0;
        emitLumiverse('GENERATION_STARTED', {
            generationId,
            chatId: current.chatId,
            model: state.settings.connection.model || '',
            generationType: type,
            targetMessageId: swiping && last ? messageId(last) : undefined,
            targetSwipeId: swiping && last ? (last.swipes?.length || 1) : undefined,
            characterId: state.character?.id,
            characterName: state.character?.card?.data?.name,
        });
    });
    // Reverie (like SillyTavern) reports the whole text so far; Lumiverse sends each new chunk.
    let seq = 0;
    let streamed = '';
    on(event_types.STREAM_TOKEN_RECEIVED, text => {
        if (!current) return;
        const full = String(text ?? '');
        const token = full.startsWith(streamed) ? full.slice(streamed.length) : full;
        streamed = full;
        if (!token) return;
        const payload = { generationId: current.generationId, chatId: current.chatId, token, seq: ++seq, messageId: current.targetId != null ? messageId(state.chat[current.targetId]) : undefined };
        emitLumiverse('STREAM_TOKEN_RECEIVED', payload, { backend: false });
        queueBackendToken(payload);
    });
    on(event_types.GENERATION_STOPPED, () => {
        if (!current) return;
        flushTokens();
        const m = current.targetId != null ? state.chat[current.targetId] : null;
        emitLumiverse('GENERATION_STOPPED', { generationId: current.generationId, chatId: current.chatId, content: m?.mes || '', messageId: m ? messageId(m) : undefined });
    });
    on(event_types.GENERATION_ENDED, () => {
        if (!current) return;
        flushTokens();
        const g = current;
        current = null;
        seq = 0;
        const m = g.targetId != null ? state.chat[g.targetId] : null;
        emitLumiverse('GENERATION_ENDED', {
            generationId: g.generationId,
            chatId: g.chatId,
            messageId: m && !m.is_user ? messageId(m) : undefined,
            content: m && !m.is_user ? m.mes : undefined,
            generationType: g.type,
        });
    });

    on(event_types.CHARACTER_EDITED, () => { if (state.character) emitLumiverse('CHARACTER_EDITED', { id: state.character.id, character: characterDto(state.character) }); });
    on(event_types.CHARACTER_DELETED, data => emitLumiverse('CHARACTER_DELETED', { id: data?.id ?? data }));
    on(event_types.PERSONA_CHANGED, () => emitLumiverse('PERSONA_CHANGED', { persona: personaDto(currentPersona()) }));
    // Reverie saves settings often: frontends hear every save, backends one per second at most.
    let settingsTimer = null;
    on(event_types.SETTINGS_UPDATED, () => {
        emitLumiverse('SETTINGS_UPDATED', { keys: [] }, { backend: false });
        if (settingsTimer) return;
        settingsTimer = setTimeout(() => { settingsTimer = null; emitBackend('SETTINGS_UPDATED', { keys: [] }); }, 1000);
    });
    const personaChanged = (id, deleted = false) => {
        const p = (state.settings.personas || []).find(x => x.id === id);
        emitLumiverse('PERSONA_CHANGED', deleted || !p ? { id, deleted: true } : { id, persona: personaDto(p) });
    };
    on(event_types.PERSONA_CREATED, data => personaChanged(data?.avatarId || state.settings.personaId));
    on(event_types.PERSONA_UPDATED, id => personaChanged(typeof id === 'object' ? id?.id : id));
    on(event_types.PERSONA_DELETED, data => personaChanged(data?.avatarId, true));
    on(event_types.CHAT_RENAMED, id => {
        const chatId = toChatId(state.character?.id, id);
        emitLumiverse('CHAT_CHANGED', { chatId, chat: chatId ? { id: chatId, character_id: state.character?.id } : null, changedFields: ['name'] });
    });
    on(event_types.PRESET_CHANGED, () => emitLumiverse('PRESET_CHANGED', { presetId: state.preset?.id || null }));
    on(event_types.WORLD_INFO_ACTIVATED, entries => emitLumiverse('WORLD_INFO_ACTIVATED', { entries: (entries || []).map(e => ({ id: e.uid, comment: e.comment, keys: e.key })) }));
}
