// Translates Reverie (SillyTavern-style) events into Lumiverse event names and payloads, and fans
// them out to Lumiverse extension frontends (ctx.events.on) and backends (spindle.on).
import { state, currentPersona } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { api } from '../api.js';
import { messageId } from '../message-ids.js';
import { activeChatId, rawMessage, characterDto, personaDto } from './dto.js';

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
    if (backend && backendsListening) api.post('spindle/event', { name, payload }).catch(() => {});
}

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

export function installEventBridge() {
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
    let seq = 0;
    on(event_types.STREAM_TOKEN_RECEIVED, text => {
        if (!current) return;
        // Frontends get every token; backends rarely need them, so they're spared the traffic.
        emitLumiverse('STREAM_TOKEN_RECEIVED', { generationId: current.generationId, chatId: current.chatId, token: String(text ?? ''), seq: ++seq, messageId: current.targetId != null ? messageId(state.chat[current.targetId]) : undefined }, { backend: false });
    });
    on(event_types.GENERATION_STOPPED, () => {
        if (!current) return;
        const m = current.targetId != null ? state.chat[current.targetId] : null;
        emitLumiverse('GENERATION_STOPPED', { generationId: current.generationId, chatId: current.chatId, content: m?.mes || '', messageId: m ? messageId(m) : undefined });
    });
    on(event_types.GENERATION_ENDED, () => {
        if (!current) return;
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
    on(event_types.SETTINGS_UPDATED, () => emitLumiverse('SETTINGS_UPDATED', {}, { backend: false }));
    on(event_types.PRESET_CHANGED, () => emitLumiverse('PRESET_CHANGED', { presetId: state.preset?.id || null }));
    on(event_types.WORLD_INFO_ACTIVATED, entries => emitLumiverse('WORLD_INFO_ACTIVATED', { entries: (entries || []).map(e => ({ id: e.uid, comment: e.comment, keys: e.key })) }));
}
