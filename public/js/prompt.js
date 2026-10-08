// Builds the chat-completion message list from the active preset, character, persona, lore and chat.
import { placement, PERSONA_POSITION } from './personas.js';
import { messageId } from './message-ids.js';
import { state, currentPersona, charName, userName, chatMetadata } from './state.js';
import { substituteParams, readVariable, variables } from './macros.js';
import { evaluateCondition, modelMatches } from './conditions.js';
import { points } from './rv-ext/points.js';
import { applyRegex, REGEX_PLACEMENT } from './regex.js';
import { scanWorldInfo } from './worldinfo.js';
import { eventSource, event_types } from './events.js';
import { STRUCTURAL_MARKERS } from './presets.js';

export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const extensionPrompts = {};
let lastLoreHits = [];
/** Lorebook entries activated by the most recent real (non-preview) prompt build. */
export const lastLore = () => lastLoreHits;

export function setExtensionPrompt(key, value, position = 0, depth = 4, scan = false, role = 0, filter = null) {
    extensionPrompts[key] = { value: String(value ?? ''), position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role), filter };
}

const ROLE_NAMES = ['system', 'user', 'assistant'];
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 3.6);

function formatWith(template, value) {
    return String(template || '{0}').replace(/\{0\}/g, value);
}

function exampleMessages(preset) {
    const raw = state.character?.card?.data?.mes_example ?? '';
    if (!raw.trim()) return [];
    const text = substituteParams(raw);
    const chunks = text.split(/<START>/i).map(s => s.trim()).filter(Boolean);
    const header = substituteParams(preset.behavior.newExampleChatPrompt || '[Example Chat]');
    return chunks.map(chunk => ({ role: 'system', content: `${header}\n${chunk}` }));
}

function blockTriggered(block, type) {
    const trig = block.injectionTrigger || [];
    if (!trig.length) return true;
    return trig.includes(type) || (type === 'swipe' && trig.includes('regenerate'));
}

/** The model profile (Reverie presets) that matches the active model, if any. */
export function activeModelProfile(preset = state.preset) {
    const model = state.settings.connection.model;
    return (preset?.modelProfiles || []).find(p => p.enabled !== false && modelMatches(p.match, model)) || null;
}

/** Values preset conditions can test (see conditions.js). */
export function conditionContext(type, history) {
    const d = state.character?.card?.data ?? {};
    return {
        type,
        model: state.settings.connection.model || '',
        provider: state.settings.connection.provider || '',
        chat: { length: history.length, last: history.at(-1)?.mes ?? '' },
        char: { name: d.name ?? '', tags: d.tags ?? [] },
        user: { name: userName() },
        persona: { name: userName() },
        var: { get: name => readVariable(name) },
        global: { get: name => variables.global.get(name) },
        profile: activeModelProfile()?.name ?? '',
    };
}

function conditionMet(block, ctx) {
    if (!block.when?.trim()) return true;
    try {
        return evaluateCondition(block.when, ctx);
    } catch (err) {
        console.warn(`[Reverie] Condition on "${block.name}" ignored: ${err.message}`);
        return true;
    }
}

function tagTriggered(block) {
    const tags = block.characterTagTrigger;
    if (!Array.isArray(tags) || !tags.length) return true;
    const own = (state.character?.card?.data?.tags || []).map(t => t.toLowerCase());
    return tags.some(t => own.includes(String(t).toLowerCase()));
}

/**
 * @param {object} opts
 * @param {'normal'|'continue'|'impersonate'|'swipe'|'regenerate'|'quiet'} opts.type
 * @param {string} [opts.quietPrompt] extra instruction appended for quiet generations
 * @param {Array} [opts.chat] chat messages to use (defaults to state.chat)
 * @returns {Promise<{ messages: Array<{role, content}>, breakdown: Array, tokens: number }>}
 */
export async function buildPrompt({ type = 'normal', quietPrompt = '', chat = state.chat, dryRun = false } = {}) {
    const preset = state.preset;
    const data = state.character?.card?.data ?? {};
    const s = preset.samplers;
    const contextSize = state.settings.generation.maxContextOverride || s.context_size || 64000;
    const gen = state.settings.generation;

    // Visible history (hidden/system messages excluded).
    const history = chat.filter(m => !m.is_system);
    const lore = await scanWorldInfo(history, { contextTokens: contextSize });
    if (lore.activated.length) eventSource.emit(event_types.WORLD_INFO_ACTIVATED, lore.activated);
    if (!dryRun) lastLoreHits = lore.activated;

    const before = [];
    const after = [];
    const inChat = []; // { content, depth, role, order }
    const appends = []; // { role, content }
    const breakdown = [];
    let target = before;
    let sawHistory = false;

    const push = (role, content, label) => {
        content = String(content ?? '');
        if (!content.trim()) return;
        target.push({ role, content, __label: label });
        breakdown.push({ label, role, tokens: estimateTokens(content) });
    };

    // BEFORE_PROMPT extension prompts go first.
    for (const [key, ep] of Object.entries(extensionPrompts)) {
        if (ep.position === extension_prompt_types.BEFORE_PROMPT && ep.value) push(ROLE_NAMES[ep.role] || 'system', substituteParams(ep.value), `ext:${key}`);
    }

    const personaPlacement = placement();
    const condCtx = conditionContext(type, history);
    for (const block of preset.blocks) {
        if (!block.enabled || !blockTriggered(block, type) || !tagTriggered(block) || !conditionMet(block, condCtx)) continue;
        const role = block.role || 'system';
        const label = block.name;
        if (block.marker === 'chat_history') {
            sawHistory = true;
            target = after;
            continue;
        }
        let content = '';
        switch (block.marker) {
            case 'world_info_before': content = lore.before ? formatWith(preset.formats.wiFormat, lore.before) : ''; break;
            case 'world_info_after': content = lore.after ? formatWith(preset.formats.wiFormat, lore.after) : ''; break;
            case 'char_description': content = substituteParams(data.description); break;
            case 'char_personality': content = data.personality ? substituteParams(preset.formats.personalityFormat || '{{personality}}') : ''; break;
            case 'scenario': {
                const scenario = chatMetadata().scenario || data.scenario;
                content = scenario ? substituteParams(preset.formats.scenarioFormat || '{{scenario}}', { scenario }) : '';
                break;
            }
            case 'persona_description': content = personaPlacement.position === PERSONA_POSITION.IN_PROMPT ? substituteParams(currentPersona().description) : ''; break;
            case 'dialogue_examples':
                for (const ex of exampleMessages(preset)) push(ex.role, ex.content, 'Example dialogue');
                continue;
            case 'main_prompt': {
                const own = gen.preferCharPrompt && data.system_prompt?.trim();
                content = own ? substituteParams(data.system_prompt, { original: substituteParams(block.content) }) : substituteParams(block.content);
                break;
            }
            case 'jailbreak': {
                const own = gen.preferCharInstructions && data.post_history_instructions?.trim();
                content = own ? substituteParams(data.post_history_instructions, { original: substituteParams(block.content) }) : substituteParams(block.content);
                break;
            }
            default:
                content = substituteParams(block.content);
        }
        if (!content.trim()) continue;
        if (role === 'user_append' || role === 'assistant_append') {
            appends.push({ role: role.replace('_append', ''), content });
            continue;
        }
        if (block.position === 'in_history') {
            inChat.push({ content, depth: Number(block.depth) || 0, role, label });
            continue;
        }
        push(role, content, label);
    }

    // IN_PROMPT extension prompts sit right before the history.
    for (const [key, ep] of Object.entries(extensionPrompts)) {
        if (ep.position === extension_prompt_types.IN_PROMPT && ep.value) {
            before.push({ role: ROLE_NAMES[ep.role] || 'system', content: substituteParams(ep.value), __label: `ext:${key}` });
            breakdown.push({ label: `ext:${key}`, role: 'system', tokens: estimateTokens(ep.value) });
        }
        if (ep.position === extension_prompt_types.IN_CHAT && ep.value) inChat.push({ content: substituteParams(ep.value), depth: ep.depth, role: ROLE_NAMES[ep.role] || 'system', label: `ext:${key}` });
    }
    for (const d of lore.depth) inChat.push({ ...d, label: 'World Info @ depth' });

    // Author's note (per chat), ST-style at depth. The persona description can sit at its top or bottom.
    let an = substituteParams(chatMetadata().note_prompt || '');
    const personaText = substituteParams(currentPersona().description || '');
    if (personaText.trim() && personaPlacement.position === PERSONA_POSITION.AN_TOP) an = an.trim() ? `${personaText}\n${an}` : personaText;
    if (personaText.trim() && personaPlacement.position === PERSONA_POSITION.AN_BOTTOM) an = an.trim() ? `${an}\n${personaText}` : personaText;
    if (an.trim()) {
        inChat.push({ content: an, depth: Number(chatMetadata().note_depth ?? 4), role: ROLE_NAMES[Number(chatMetadata().note_role ?? 0)] || 'system', label: "Author's Note" });
    }
    if (personaText.trim() && personaPlacement.position === PERSONA_POSITION.AT_DEPTH) {
        inChat.push({ content: personaText, depth: personaPlacement.depth, role: ['system', 'user', 'assistant'][personaPlacement.role] || 'system', label: 'Persona Description @ depth' });
    }

    // ----- history -----
    const names = Number(preset.completion.namesBehavior);
    let historyMsgs = history.map((m, i) => {
        const depth = history.length - 1 - i;
        let content = applyRegex(m.mes ?? '', m.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true, depth });
        if (names === 2) content = `${m.name}: ${content}`;
        const out = { role: m.is_user ? 'user' : 'assistant', content, __src: { id: messageId(m), index: chat.indexOf(m) } };
        if (names === 1 && m.name) out.name = m.name.replace(/[^\w-]/g, '_').slice(0, 64);
        return out;
    });

    if (type === 'continue' && historyMsgs.length) {
        // The last message is being continued; it's handled below.
        historyMsgs = historyMsgs.slice(0, -1);
    }

    // Trim oldest history to fit the context window.
    const reserve = (s.max_tokens || 1024) + 64;
    const fixedTokens = [...before, ...after].reduce((n, m) => n + estimateTokens(m.content), 0)
        + inChat.reduce((n, m) => n + estimateTokens(m.content), 0);
    let budget = contextSize - reserve - fixedTokens;
    const kept = [];
    for (let i = historyMsgs.length - 1; i >= 0; i--) {
        const t = estimateTokens(historyMsgs[i].content) + 4;
        if (budget - t < 0 && kept.length) break;
        budget -= t;
        kept.unshift(historyMsgs[i]);
    }
    const dropped = historyMsgs.length - kept.length;

    // Depth injections (depth 0 = after the newest message).
    const withInjections = [...kept];
    const sortedInjections = [...inChat].sort((a, b) => b.depth - a.depth);
    for (const inj of sortedInjections) {
        const at = Math.max(0, withInjections.length - inj.depth);
        withInjections.splice(at, 0, { role: ['system', 'user', 'assistant'].includes(inj.role) ? inj.role : 'system', content: inj.content, injected: true, __label: inj.label });
    }

    const historyBlock = [];
    const newChat = substituteParams(preset.behavior.newChatPrompt);
    if (newChat.trim()) historyBlock.push({ role: 'system', content: newChat, __label: 'New chat prompt' });
    historyBlock.push(...withInjections.map(({ injected, ...m }) => m));

    // Type-specific tails.
    const tail = [];
    let prefill = '';
    const lastMsg = history.at(-1);
    if (type === 'continue' && lastMsg) {
        const cont = applyRegex(lastMsg.mes ?? '', lastMsg.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true, depth: 0 });
        if (preset.completion.continuePrefill) {
            prefill = cont + (preset.completion.continuePostfix ?? '');
        } else {
            historyBlock.push({ role: lastMsg.is_user ? 'user' : 'assistant', content: cont });
            tail.push({ role: 'system', content: substituteParams(preset.behavior.continueNudge, { lastChatMessage: cont }) });
        }
    } else if (type === 'impersonate') {
        tail.push({ role: 'system', content: substituteParams(quietPrompt || preset.behavior.impersonationPrompt) });
        prefill = substituteParams(preset.completion.assistantImpersonation);
    } else if (type === 'quiet') {
        if (quietPrompt) tail.push({ role: 'system', content: substituteParams(quietPrompt) });
    } else {
        if (lastMsg && !lastMsg.is_user && preset.behavior.sendIfEmpty?.trim()) {
            tail.push({ role: 'user', content: substituteParams(preset.behavior.sendIfEmpty) });
        }
        const profile = activeModelProfile(preset);
        prefill = substituteParams(profile?.assistantPrefill ?? preset.completion.assistantPrefill);
    }

    if (!sawHistory) {
        // Preset has no Chat History marker: history goes after everything else.
        before.push(...after.splice(0));
    }
    let messages = [...before, ...historyBlock, ...after, ...tail];

    // *_append roles attach to the last message of that role.
    for (const a of appends) {
        const idx = messages.findLastIndex(m => m.role === a.role);
        if (idx >= 0) messages[idx] = { ...messages[idx], content: `${messages[idx].content}\n${a.content}` };
        else messages.push({ role: a.role, content: a.content });
    }

    if (prefill.trim()) messages.push({ role: 'assistant', content: prefill });

    if (preset.completion.squashSystemMessages) {
        const squashed = [];
        for (const m of messages) {
            const last = squashed.at(-1);
            if (last && last.role === 'system' && m.role === 'system' && !m.name && !last.name) last.content += `\n${m.content}`;
            else squashed.push({ ...m });
        }
        messages = squashed;
    }

    messages = messages.filter(m => String(m.content).trim() || m === messages.at(-1));

    // Where each part came from, for the Prompt Inspector (hooks may rebuild the list, so also match by content).
    const labelOf = m => m.__label || (m.__src ? `Chat message ${m.__src.index + 1}` : '');
    const labelByContent = new Map(messages.map(m => [m.content, labelOf(m)]));
    // Reverie extension prompt hooks (rv.prompt.onBuild, Lumiverse interceptors). Hooks may add request params.
    const extraParams = {};
    for (const hook of points.promptHooks.list()) {
        try {
            const out = await hook(messages, { type, dryRun, chatLength: history.length, params: extraParams });
            if (Array.isArray(out)) messages = out;
        } catch (err) {
            console.error('Extension prompt hook failed', err);
        }
    }

    // Internal annotations (like __src) never reach the provider; labels are kept aside for the inspector.
    const labels = messages.map(m => labelOf(m) || labelByContent.get(m.content)
        || (m.role === 'assistant' && m === messages.at(-1) && prefill.trim() && m.content === prefill ? 'Prefill' : 'Added by an extension'));
    messages = messages.map(m => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('__'))));

    const eventData = { chat: messages, dryRun };
    await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
    messages = eventData.chat;

    const tokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
    breakdown.push({ label: `Chat history (${kept.length} msgs${dropped ? `, ${dropped} trimmed` : ''})`, role: 'mixed', tokens: kept.reduce((n, m) => n + estimateTokens(m.content), 0) });
    return { messages, labels: messages.length === labels.length ? labels : [], breakdown, tokens, prefill, lore: lore.activated, loreTotal: lore.total ?? lore.activated.length, extraParams };
}

export function samplerParams() {
    const s = { ...state.preset.samplers, ...(activeModelProfile()?.samplers || {}) };
    const params = {
        temperature: s.temperature,
        top_p: s.top_p,
        top_k: s.top_k,
        min_p: s.min_p,
        top_a: s.top_a,
        frequency_penalty: s.frequency_penalty,
        presence_penalty: s.presence_penalty,
        repetition_penalty: s.repetition_penalty,
        max_tokens: s.max_tokens,
        seed: s.seed,
        reasoning_effort: s.reasoning_effort || undefined,
        stop: (state.preset.stopStrings || []).map(x => substituteParams(x)).filter(Boolean),
    };
    if (state.preset.customBody?.enabled) {
        try { params.custom_body = JSON.parse(state.preset.customBody.rawJson || '{}'); } catch { /* ignore invalid json */ }
    }
    return params;
}

export { STRUCTURAL_MARKERS, charName, userName };
