// Reverie ⇄ Lumiverse data shapes.
// Lumiverse addresses chats globally and messages by id; Reverie keeps chats per character and
// messages as SillyTavern-style arrays. A Lumiverse chat id is "<characterId>~<chatId>".
import { state, currentPersona } from '../state.js';
import { api } from '../api.js';
import { messageId } from '../message-ids.js';

export const SEP = '~';
export const toChatId = (charId, chatId) => (charId && chatId ? `${charId}${SEP}${chatId}` : null);
export function parseChatId(id) {
    const s = String(id ?? '');
    const i = s.indexOf(SEP);
    return i < 0 ? { charId: state.character?.id, chatId: s } : { charId: s.slice(0, i), chatId: s.slice(i + 1) };
}
export const activeChatId = () => toChatId(state.character?.id, state.chatId);
export const isActiveChat = id => !id || id === activeChatId() || id === state.chatId;

const seconds = d => {
    const t = typeof d === 'number' ? d : Date.parse(d);
    return Number.isFinite(t) ? Math.floor(t / 1000) : Math.floor(Date.now() / 1000);
};

/** A stored message in Lumiverse's raw shape (used in event payloads). */
export function rawMessage(m, index, chatId = activeChatId()) {
    if (!m) return null;
    const { spindle_metadata: _meta, ...extra } = m.extra || {};
    const swipes = m.swipes?.length ? [...m.swipes] : [m.mes ?? ''];
    return {
        id: messageId(m),
        chat_id: chatId,
        index_in_chat: index,
        is_user: !!m.is_user,
        name: m.name ?? '',
        content: m.mes ?? '',
        send_date: seconds(m.send_date),
        swipe_id: m.swipe_id ?? 0,
        swipes,
        swipe_dates: swipes.map((_, i) => seconds(m.swipe_info?.[i]?.send_date || m.send_date)),
        extra: { ...extra, hidden: !!m.is_system, reasoning: m.extra?.reasoning || undefined },
        parent_message_id: null,
        branch_id: null,
        created_at: seconds(m.send_date),
    };
}

/** The spindle.chat.getMessages shape: raw message plus role and metadata. */
export function messageDto(m, index, chatId) {
    const raw = rawMessage(m, index, chatId);
    const role = m.is_user ? 'user' : m.extra?.spindle_role === 'system' ? 'system' : 'assistant';
    return { ...raw, role, metadata: structuredClone(m.extra?.spindle_metadata || {}) };
}

export function characterDto(c) {
    if (!c) return null;
    const d = c.card?.data || c;
    return {
        id: c.id,
        name: d.name || c.name || '',
        description: d.description || '',
        personality: d.personality || '',
        scenario: d.scenario || '',
        first_mes: d.first_mes || '',
        mes_example: d.mes_example || '',
        creator_notes: d.creator_notes || '',
        system_prompt: d.system_prompt || '',
        post_history_instructions: d.post_history_instructions || '',
        tags: [...(d.tags || c.tags || [])],
        alternate_greetings: [...(d.alternate_greetings || [])],
        creator: d.creator || '',
        image_id: c.avatar || null,
        avatar_url: c.avatar ? `/api/v1/images/${encodeURIComponent(c.avatar)}` : null,
        world_book_ids: [],
        extensions: structuredClone(d.extensions || {}),
        created_at: seconds(c.created || Date.now()),
        updated_at: seconds(c.updated || Date.now()),
    };
}

const imageIdFromUrl = url => {
    const m = String(url || '').match(/(?:files\/images|files\/avatars|api\/v1\/images)\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : null;
};

export function personaDto(p) {
    if (!p) return null;
    return {
        id: p.id || 'default',
        name: p.name || 'User',
        title: p.title || '',
        description: p.description || '',
        image_id: imageIdFromUrl(p.avatar),
        attached_world_book_id: null,
        folder: '',
        is_default: p.id === state.settings.personaId,
        is_narrator: false,
        metadata: { ...(p.metadata || {}) },
        created_at: seconds(p.created || Date.now()),
        updated_at: seconds(p.updated || Date.now()),
    };
}

export function chatDto(charId, chatId, meta = {}) {
    if (!charId || !chatId) return null;
    return {
        id: toChatId(charId, chatId),
        character_id: charId,
        name: chatId,
        metadata: structuredClone(meta.chat_metadata || {}),
        created_at: seconds(meta.create_date || Date.now()),
        updated_at: seconds(Date.now()),
    };
}

export function connectionDto(c, { id = 'active', name = 'Active connection', isDefault = true } = {}) {
    return {
        id: c.id || id,
        name: c.name || name,
        provider: c.provider || '',
        api_url: c.baseUrl || '',
        model: c.model || '',
        preset_id: null,
        is_default: c.id ? false : isDefault,
        has_api_key: true,
        metadata: {},
        reasoning_bindings: null,
        created_at: 0,
        updated_at: 0,
    };
}

export function imageDto(name, { owner = null, mime } = {}) {
    if (!name) return null;
    const ext = String(name).split('.').pop().toLowerCase();
    return {
        id: name,
        original_filename: name,
        mime_type: mime || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm' }[ext] || 'image/png'),
        width: null,
        height: null,
        has_thumbnail: false,
        url: `/api/v1/images/${encodeURIComponent(name)}`,
        specificity: 'full',
        owner_extension_identifier: owner,
        owner_character_id: null,
        owner_chat_id: null,
        created_at: Math.floor(Date.now() / 1000),
    };
}

// ---------------------------------------------------------------- chat access
/** Load any chat: the open one from memory, others from the server. */
export async function loadChat(lvChatId) {
    if (isActiveChat(lvChatId)) return { charId: state.character?.id, chatId: state.chatId, meta: state.chatMeta, messages: state.chat, active: true };
    const { charId, chatId } = parseChatId(lvChatId);
    const chat = await api.get(`chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`);
    return { charId, chatId, meta: chat.meta || {}, messages: chat.messages || [], active: false };
}

export async function saveOtherChat(c) {
    await api.put(`chats/${encodeURIComponent(c.charId)}/${encodeURIComponent(c.chatId)}`, { meta: c.meta, messages: c.messages });
}

export const personaById = id => (state.settings.personas || []).find(p => p.id === id) || null;
export const activePersona = () => currentPersona();
