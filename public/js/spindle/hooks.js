// Lumiverse generation hooks run from Reverie's pipeline: context handlers (before prompt assembly),
// world info interceptors (before lore activation), macro interceptors (per template, before macros
// are evaluated) and message content processors (before a message is saved). The handlers live in
// extension backends; these helpers ask the server to run each chain. All of them are fail-safe:
// on any error or timeout they hand back their input unchanged, and they skip the round-trip when
// no backend registered that kind of hook.
import { state } from '../state.js';
import { api } from '../api.js';
import { messageId } from '../message-ids.js';
import { activeChatId } from './dto.js';

let kinds = {}; // hook kind -> count of registered handlers
let backendEvents = new Set(); // events some backend has spindle.on() listeners for
let known = false; // whether the server has told us yet (until then, assume hooks may exist)

/** Called by host.js when the server reports which hooks/listeners backends registered. */
export function setHookState(msg = {}) {
    kinds = msg.kinds || {};
    backendEvents = new Set(msg.events || []);
    known = true;
}
export const hasHooks = kind => (known ? (kinds[kind] || 0) > 0 : false);
/** Whether some backend listens for `name` (unknown until the server reports; then assume yes). */
export const backendListens = name => !known || backendEvents.has(name);

async function post(path, body, timeoutMs) {
    const res = await fetch(`api/spindle/hooks/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`hooks/${path}: ${res.status}`);
    return res.json();
}

const chatTurn = (chat = state.chat) => chat.filter(m => !m.is_system).length;

// ---------------------------------------------------------------- context handlers
/**
 * Run context handlers before prompt assembly.
 * @param {object} promptContext extra fields to send (merged over chatId/generationType/dryRun/userId)
 * @returns {Promise<{ context: object, cancelled: boolean }>} cancelled → stop the generation.
 */
export async function runContextHandlers(promptContext = {}) {
    const context = {
        chatId: activeChatId(),
        characterId: state.character?.id || null,
        personaId: state.settings.personaId || null,
        generationType: promptContext.type || promptContext.generationType || 'normal',
        dryRun: !!promptContext.dryRun,
        userId: 'owner',
        ...promptContext,
    };
    delete context.type;
    if (!hasHooks('contextHandler')) return { context, cancelled: false };
    try {
        const res = await post('context', { context }, 130000);
        return { context: res?.context && typeof res.context === 'object' ? res.context : context, cancelled: !!res?.cancelled };
    } catch (err) {
        console.warn('Lumiverse context handlers skipped:', err.message);
        return { context, cancelled: false };
    }
}

// ---------------------------------------------------------------- world info interceptors
const ROLES = ['system', 'user', 'assistant'];
function entryDto(e) {
    return {
        id: String(e.id ?? `${e.book || 'wi'}:${e.uid}`),
        world_book_id: e.book || '',
        comment: e.comment || '',
        disabled: !!e.disable,
        constant: !!e.constant,
        extensions: { ...(e.extensions || {}) },
        key: [...(e.key || [])],
        keysecondary: [...(e.keysecondary || [])],
        position: Number(e.position ?? 0),
        depth: Number(e.depth ?? 4),
        priority: Number(e.order ?? 100),
        probability: Number(e.probability ?? 100),
        use_probability: e.useProbability !== false,
        content: String(e.content ?? ''),
        automation_id: e.automationId || null,
        selective: e.selective !== false,
        selective_logic: Number(e.selectiveLogic) || 0,
        match_whole_words: !!e.matchWholeWords,
        case_sensitive: !!e.caseSensitive,
        use_regex: false,
        prevent_recursion: !!e.preventRecursion,
        exclude_recursion: !!e.excludeRecursion,
        delay_until_recursion: !!e.delayUntilRecursion,
        exclude_greeting: false,
        scan_depth: e.scanDepth === null || e.scanDepth === undefined || e.scanDepth === '' ? null : Number(e.scanDepth),
        order_value: Number(e.order ?? 100),
        role: ROLES[Number(e.role)] ?? 'system',
        ...(e.source ? { book_source: e.source } : {}),
    };
}

/**
 * Run world info interceptors over the candidate entries before activation.
 * @param {object[]} entries Reverie lore entries (as built in scanWorldInfo: { id, uid, book, key, content, constant, disable, ... })
 * @param {{ chatMessages?: object[], type?: string, dryRun?: boolean }} [opts]
 * @returns {Promise<{ entries: object[], disableRecursion: boolean, selectionContent: Map<string,string> }>}
 *   entries: disabled ones removed, forced ones constant, content overrides applied (new objects; input untouched).
 */
export async function runWorldInfoInterceptors(entries = [], { chatMessages = state.chat, type = 'normal', dryRun = false } = {}) {
    const passthrough = { entries, disableRecursion: false, selectionContent: new Map() };
    if (!entries.length || !hasHooks('worldInfoInterceptor')) return passthrough;
    const ids = entries.map(e => String(e.id ?? `${e.book || 'wi'}:${e.uid}`));
    const firstAi = chatMessages.findIndex(m => !m.is_user && !m.is_system);
    const ctx = {
        chatId: activeChatId(),
        characterId: state.character?.id || null,
        userId: 'owner',
        generationType: type,
        dryRun: !!dryRun,
        entries: entries.map(entryDto),
        messages: chatMessages.map((m, i) => ({
            id: messageId(m),
            role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
            content: String(m.mes ?? ''),
            is_user: !!m.is_user,
            is_greeting: i === firstAi && !chatMessages.slice(0, i).some(x => x.is_user),
            swipe_id: m.swipe_id ?? 0,
            index_in_chat: i,
        })),
        chatTurn: chatTurn(chatMessages),
        chatMetadata: structuredClone(state.chatMeta?.chat_metadata || {}),
        activationSettings: {
            globalScanDepth: Number.isFinite(Number(state.settings.worlds?.scanDepth)) ? Number(state.settings.worlds.scanDepth) : null,
            maxRecursionPasses: Number(state.settings.worlds?.maxRecursionSteps) || 0,
        },
    };
    let res;
    try {
        res = await post('world-info', { ctx }, 60000);
    } catch (err) {
        console.warn('Lumiverse world info interceptors skipped:', err.message);
        return passthrough;
    }
    const disabled = new Set(res?.disabled || []);
    const forced = new Set(res?.forced || []);
    const mutated = res?.mutated || {};
    const selectionContent = new Map();
    const out = [];
    entries.forEach((e, i) => {
        const id = ids[i];
        if (disabled.has(id)) return;
        const m = mutated[id];
        if (!forced.has(id) && !m) { out.push(e); return; }
        const next = { ...e };
        if (forced.has(id)) next.constant = true;
        if (m?.content !== undefined) next.content = m.content;
        if (m?.selectionContent !== undefined) selectionContent.set(id, m.selectionContent);
        out.push(next);
    });
    return { entries: out, disableRecursion: !!res?.disableRecursion, selectionContent };
}

// ---------------------------------------------------------------- macro interceptors
/**
 * Run macro interceptors on a template before Reverie evaluates its macros (substituteParams is
 * synchronous, so call this first and pass the result on).
 * @param {string} template
 * @param {{ phase?: 'prompt'|'display'|'response'|'other', sourceHint?: string, commit?: boolean, dynamicMacros?: object }} [opts]
 * @returns {Promise<string>}
 */
export async function runMacroInterceptors(template, { phase = 'prompt', sourceHint, commit = phase === 'prompt', dynamicMacros = {} } = {}) {
    const text = String(template ?? '');
    if (!text.includes('{{') || !hasHooks('macroInterceptor')) return text;
    const d = state.character?.card?.data || {};
    const env = {
        commit,
        names: { user: state.settings.personas?.find?.(p => p.id === state.settings.personaId)?.name || 'User', char: d.name || '' },
        character: { id: state.character?.id || null, name: d.name || '', description: d.description || '', personality: d.personality || '', scenario: d.scenario || '', firstMessage: d.first_mes || '', alternateGreetings: [...(d.alternate_greetings || [])] },
        chat: { id: activeChatId(), messageCount: state.chat.length, greetingIndex: 0 },
        system: { model: state.settings.connection?.model || '' },
        variables: { local: { ...(state.chatMeta?.chat_metadata?.variables || {}) }, global: { ...(state.settings.variables?.global || {}) }, chat: { ...(state.chatMeta?.chat_metadata?.chat_variables || {}) } },
        dynamicMacros,
        extra: {},
    };
    try {
        const res = await post('macro', { ctx: { template: text, env, commit, phase, sourceHint, userId: 'owner' } }, 30000);
        return typeof res?.text === 'string' ? res.text : text;
    } catch (err) {
        console.warn('Lumiverse macro interceptors skipped:', err.message);
        return text;
    }
}

/**
 * Character fields a preset references, offered to macro interceptors one by one with the
 * Lumiverse source hint `prompt_source:character.<field>`. Returns a copy of `data`.
 */
export async function interceptCharacterFields(data = {}) {
    if (!hasHooks('macroInterceptor')) return data;
    const out = { ...data };
    const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions', 'creator_notes'];
    await Promise.all(fields.map(async f => {
        if (typeof out[f] === 'string' && out[f].includes('{{')) out[f] = await runMacroInterceptors(out[f], { phase: 'prompt', sourceHint: `prompt_source:character.${f}` });
    }));
    return out;
}

// ---------------------------------------------------------------- extension pull macros
let pullResolver = null;
/** host.js plugs in the resolver (it owns the macro registry); kept here so callers import a light module. */
export const setPullMacroResolver = fn => { pullResolver = fn; };
/**
 * Resolve extension pull-macros used in `texts` (per distinct argument string) before macro
 * expansion. No-op when no Lumiverse extension registered one.
 * @param {string[]|string} texts
 */
export async function preparePullMacros(texts) {
    if (!pullResolver) return;
    try { await pullResolver(texts); } catch (err) { console.warn('Lumiverse macros skipped:', err.message); }
}

// ---------------------------------------------------------------- message content processors
/**
 * Run message content processors before a message is written (or rendered, origin 'render').
 * @param {{ content: string, isUser?: boolean, origin?: 'create'|'update'|'swipe_add'|'swipe_update'|'render', message?: object, messageId?: string, swipeIndex?: number, extra?: object }} input
 * @returns {Promise<{ content: string, extra: object, changed: boolean }>} extra is the patch merged over input.extra.
 */
export async function runContentProcessors(input = {}) {
    const content = String(input.content ?? input.message?.mes ?? '');
    const extra = input.extra || {};
    const passthrough = { content, extra, changed: false };
    if (!hasHooks('contentProcessor')) return passthrough;
    const isUser = input.isUser ?? !!input.message?.is_user;
    const origin = input.origin || 'create';
    const ctx = {
        chatId: activeChatId(),
        messageId: input.messageId ?? (input.message && origin !== 'create' ? messageId(input.message) : undefined),
        content,
        isUser,
        extra: origin === 'render' ? { role: isUser ? 'user' : 'assistant', is_user: isUser, ...extra } : extra,
        origin,
        ...(input.swipeIndex !== undefined ? { swipeIndex: input.swipeIndex } : {}),
        userId: 'owner',
    };
    try {
        const res = await post('content', { ctx }, 30000);
        if (!res || typeof res.content !== 'string') return passthrough;
        return { content: res.content, extra: res.extra || extra, changed: !!res.changed };
    } catch (err) {
        console.warn('Lumiverse content processors skipped:', err.message);
        return passthrough;
    }
}
