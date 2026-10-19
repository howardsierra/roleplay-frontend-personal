// Builds the chat-completion message list from the active preset, character, persona, lore and chat.
import { placement, PERSONA_POSITION } from './personas.js';
import { messageId } from './message-ids.js';
import { state, currentPersona, charName, userName, chatMetadata } from './state.js';
import { substituteParams, readVariable, variables, setPromptLore } from './macros.js';
import { evaluateCondition, modelMatches } from './conditions.js';
import { points } from './rv-ext/points.js';
import { applyRegex, REGEX_PLACEMENT } from './regex.js';
import { stripReasoning, reasoningSettings } from './reasoning.js';
import { scanWorldInfo } from './worldinfo.js';
import { recallMemories, memoryReserve, memoryFloor, noteMemoryUse } from './memory.js';
import { eventSource, event_types } from './events.js';
import { STRUCTURAL_MARKERS, MARKER_NAMES, makeBlock } from './presets.js';

export const extension_prompt_types = { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 };
export const extension_prompt_roles = { SYSTEM: 0, USER: 1, ASSISTANT: 2 };
export const extensionPrompts = {};
let lastLoreHits = [];
let lastCutReport = null;
/** Lorebook entries activated by the most recent real (non-preview) prompt build. */
export const lastLore = () => lastLoreHits;
let lastPromptInfo = { firstIncluded: 0, contextSize: 0, maxResponse: 0, type: '' };
/** Facts about the last real prompt (for {{firstIncludedMessageId}}, {{maxPrompt}}, {{lastGenerationType}}). */
export const lastPrompt = () => lastPromptInfo;
/** What the most recent real prompt build left out, and why. */
export const lastCut = () => (lastCutReport?.chatId === state.chatId ? lastCutReport : null);

export function setExtensionPrompt(key, value, position = 0, depth = 4, scan = false, role = 0, filter = null) {
    extensionPrompts[key] = { value: String(value ?? ''), position: Number(position), depth: Number(depth), scan: !!scan, role: Number(role), filter };
}

const ROLE_NAMES = ['system', 'user', 'assistant'];
export const estimateTokens = text => Math.ceil(String(text ?? '').length / 3.6);

// Other tools name the structural blocks differently (Lumiverse, older ST exports, hand-made presets).
const MARKER_ALIASES = {
    persona: 'persona_description', user_persona: 'persona_description', personadescription: 'persona_description',
    description: 'char_description', character_description: 'char_description', chardescription: 'char_description',
    personality: 'char_personality', character_personality: 'char_personality', charpersonality: 'char_personality',
    world_scenario: 'scenario', char_scenario: 'scenario',
    examples: 'dialogue_examples', example_messages: 'dialogue_examples', mes_example: 'dialogue_examples', example_dialogue: 'dialogue_examples', chat_examples: 'dialogue_examples',
    world_info: 'world_info_before', wi_before: 'world_info_before', lore_before: 'world_info_before', worldinfobefore: 'world_info_before',
    wi_after: 'world_info_after', lore_after: 'world_info_after', worldinfoafter: 'world_info_after',
    history: 'chat_history', chathistory: 'chat_history',
    main: 'main_prompt', system_prompt: 'main_prompt',
    post_history: 'jailbreak', post_history_instructions: 'jailbreak', posthistoryinstructions: 'jailbreak',
};
const markerOf = block => {
    const m = block.marker;
    if (!m || typeof m !== 'string') return m || null;
    const k = m.toLowerCase();
    return MARKER_ALIASES[k] || k;
};

// The macros that pull each part of the card/persona/lore in. A preset that has neither the block nor
// the macro would silently leave that part out, so it's added before the history instead.
const FIELD_SOURCES = {
    char_description: /\{\{\s*(?:description|chardescription)\s*\}\}/i,
    char_personality: /\{\{\s*(?:personality|charpersonality)\s*\}\}/i,
    scenario: /\{\{\s*(?:scenario|charscenario)\s*\}\}/i,
    persona_description: /\{\{\s*(?:persona|persona_description)\s*\}\}/i,
    dialogue_examples: /\{\{\s*mesexamples(?:raw)?\s*\}\}/i,
    world_info_before: /\{\{\s*(?:wibefore|lorebefore)\s*\}\}/i,
    world_info_after: /\{\{\s*(?:wiafter|loreafter)\s*\}\}/i,
};
function missingParts(preset) {
    const present = new Set();
    for (const b of preset.blocks) {
        // Blocks the user switched off still count: that part was left out on purpose.
        const m = markerOf(b);
        if (m) present.add(m);
        for (const [part, rx] of Object.entries(FIELD_SOURCES)) if (rx.test(b.content || '')) present.add(part);
    }
    for (const ep of Object.values(extensionPrompts)) {
        for (const [part, rx] of Object.entries(FIELD_SOURCES)) if (rx.test(ep.value || '')) present.add(part);
    }
    return new Set(Object.keys(FIELD_SOURCES).filter(p => !present.has(p)));
}

// ---------------- Lumiverse block semantics ----------------
/** A select variable bound to placements picks the block's role / position / depth (Lumiverse). */
function resolvePlacement(block, preset) {
    const binding = block.placementBinding;
    if (!binding?.variableId || !binding.options || typeof binding.options !== 'object') return block;
    const selector = (block.variables || []).find(v => v.id === binding.variableId && v.type === 'select');
    if (!selector) return block;
    const value = preset.promptVariables?.[block.id]?.[selector.name] ?? selector.defaultValue;
    const selected = Array.isArray(value) ? value[0] : value;
    const placement = selected !== undefined ? binding.options[selected] : null;
    if (!placement || !placement.role || !placement.position) return block;
    return { ...block, role: placement.role, position: placement.position, depth: Math.floor(Number(placement.depth) || 0) };
}

/** Lumiverse moves content blocks to their stated side of the chat history; radio categories keep one child on. */
function lumiverseBlocks(preset) {
    const blocks = preset.blocks.map(b => resolvePlacement(b, preset));
    let category = null;
    let radioOn = false;
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.marker === 'category') { category = b; radioOn = false; continue; }
        if (category?.categoryMode === 'radio' && b.enabled) {
            if (radioOn) blocks[i] = { ...b, enabled: false };
            radioOn = true;
        }
    }
    const at = blocks.findIndex(b => b.marker === 'chat_history');
    if (at < 0) return blocks;
    const movable = b => !b.marker && b.role !== 'user_append' && b.role !== 'assistant_append';
    const toAfter = (b, i) => i < at && movable(b) && (b.position === 'post_history' || b.position === 'in_history');
    const toBefore = (b, i) => i > at && movable(b) && b.position === 'pre_history';
    // Moved blocks go right next to the history, keeping their relative order.
    return [
        ...blocks.filter((b, i) => i < at && !toAfter(b, i)),
        ...blocks.filter(toBefore),
        blocks[at],
        ...blocks.filter(toAfter),
        ...blocks.filter((b, i) => i > at && !toBefore(b, i)),
    ];
}

function formatWith(template, value) {
    return String(template || '{0}').replace(/\{0\}/g, value);
}

/** Example dialogue blocks, with lorebook entries for the top/bottom of the examples formatted the same way (ST). */
function exampleMessages(preset, lore = {}) {
    const split = (text, label) => substituteParams(String(text || '')).split(/<START>/i).map(s => s.trim()).filter(Boolean).map(chunk => ({ chunk, label }));
    const chunks = [
        ...(lore.emTop || []).flatMap(t => split(t, 'World Info (before examples)')),
        ...split(chatMetadata().mes_example || state.character?.card?.data?.mes_example || '', 'Example dialogue'),
        ...(lore.emBottom || []).flatMap(t => split(t, 'World Info (after examples)')),
    ];
    // A preset can blank the header on purpose (ST sends nothing then).
    const header = substituteParams(preset.behavior.newExampleChatPrompt ?? '[Example Chat]');
    return chunks.map(({ chunk, label }) => ({ role: 'system', content: header.trim() ? `${header}\n${chunk}` : chunk, label }));
}

function blockTriggered(block, type) {
    const trig = block.injectionTrigger || [];
    if (!trig.length) return true;
    return trig.includes(type);
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
// The built-in Assistant isn't a roleplay: its chats skip the preset's roleplay rules, prefill, lore and notes
// (Marinara does the same for its assistant) but keep the preset's sampling.
const isAssistantChat = () => !!state.character?.card?.data?.extensions?.reverie?.assistant;
function assistantPreset(preset) {
    return {
        ...preset,
        blocks: [
            makeBlock({ name: 'Assistant prompt', marker: 'main_prompt', content: '{{charPrompt}}' }),
            makeBlock({ name: MARKER_NAMES.persona_description, marker: 'persona_description' }),
            makeBlock({ name: MARKER_NAMES.chat_history, marker: 'chat_history' }),
        ],
        behavior: { ...preset.behavior, newChatPrompt: '', sendIfEmpty: '' },
        completion: { ...preset.completion, assistantPrefill: '', continuePrefill: false, squashSystemMessages: false },
        modelProfiles: [],
    };
}

export async function buildPrompt({ type = 'normal', quietPrompt = '', chat = state.chat, dryRun = false, skipWIAN = false, maxTokens } = {}) {
    const assistant = isAssistantChat();
    const preset = assistant ? assistantPreset(state.preset) : state.preset;
    if (assistant) skipWIAN = true;
    const data = state.character?.card?.data ?? {};
    const meta = chatMetadata();
    const s = preset.samplers;
    const contextSize = state.settings.generation.maxContextOverride || s.context_size || 64000;
    const responseTokens = maxTokens || s.max_tokens || 1024;
    const gen = state.settings.generation;
    const isContinue = type === 'continue';

    // Visible history (hidden/system messages excluded; narrator messages stay, sent as system).
    const history = chat.filter(m => !m.is_system);
    // Regex depth like ST: on continue the message being continued is -1.
    const depthOf = i => history.length - 1 - i - (isContinue ? 1 : 0);
    // Each message as the model will see it: prompt regex applied, thinking removed.
    const texts = history.map((m, i) => applyRegex(m.is_user ? (m.mes ?? '') : stripReasoning(m.mes ?? ''), m.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true, depth: depthOf(i) }));

    // Extension prompts whose filter (if any) says they apply now.
    const activeExt = [];
    for (const [key, ep] of Object.entries(extensionPrompts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (!ep.value) continue;
        if (typeof ep.filter === 'function') {
            try { if (!await ep.filter()) continue; } catch { continue; }
        }
        activeExt.push([key, ep]);
    }

    // Author's Note: every N of your messages (ST's interval; 1 = always, 0 = off), at its position.
    const noteInterval = meta.note_interval ?? 1;
    const userCount = noteInterval === 1 ? 1 : chat.filter(m => m.is_user).length;
    const noteFires = !skipWIAN && Number(noteInterval) > 0 && userCount > 0
        && (userCount >= noteInterval ? userCount % noteInterval : noteInterval - userCount) === 0;

    // Lore is matched against the history as the model will see it, plus extension prompts marked for
    // scanning and the quiet prompt.
    const injections = activeExt.filter(([, ep]) => ep.scan).map(([, ep]) => substituteParams(ep.value));
    if (quietPrompt) injections.push(substituteParams(quietPrompt));
    if (noteFires && state.settings.worlds.scanAuthorsNote && meta.note_prompt) injections.push(substituteParams(meta.note_prompt));
    const lore = skipWIAN
        ? { before: '', after: '', anTop: '', anBottom: '', emTop: [], emBottom: [], outlets: {}, depth: [], activated: [], skipped: [], total: 0 }
        : await scanWorldInfo(history, { contextTokens: contextSize, maxTokens: responseTokens, dryRun, scanLines: texts, injections, type });
    // {{wiBefore}}, {{wiAfter}} and {{outlet::name}} in any block or note.
    setPromptLore(lore);
    if (lore.activated.length) eventSource.emit(event_types.WORLD_INFO_ACTIVATED, lore.activated);
    if (!dryRun && !skipWIAN) lastLoreHits = lore.activated;

    const before = [];
    const after = [];
    // In-chat injections: { content, depth, role, order, key, label }. key orders extension prompts like
    // ST does (by name); preset blocks come first in their own order.
    const inChat = [];
    const appends = []; // { role, content }
    const breakdown = [];
    let target = before;
    let sawHistory = false;
    let mainIndex = -1; // where the main prompt sits in `before`

    const push = (role, content, label, extra = {}) => {
        content = String(content ?? '');
        if (!content.trim()) return;
        target.push({ role, content, __label: label, ...extra });
        breakdown.push({ label, role, tokens: estimateTokens(content) });
    };

    const personaPlacement = placement();
    const condCtx = conditionContext(type, history);
    const part = name => {
        switch (name) {
            case 'world_info_before': return lore.before ? formatWith(preset.formats.wiFormat, lore.before) : '';
            case 'world_info_after': return lore.after ? formatWith(preset.formats.wiFormat, lore.after) : '';
            case 'char_description': return substituteParams(data.description);
            case 'char_personality': return data.personality ? substituteParams(preset.formats.personalityFormat || '{{personality}}') : '';
            case 'scenario': {
                const scenario = meta.scenario || data.scenario;
                return scenario ? substituteParams(preset.formats.scenarioFormat || '{{scenario}}', { scenario }) : '';
            }
            case 'persona_description': return personaPlacement.position === PERSONA_POSITION.IN_PROMPT ? substituteParams(currentPersona().description) : '';
            default: return '';
        }
    };
    // Example dialogue (with the lorebook's before/after-examples entries) is kept aside: like ST it only
    // goes in while there's room after the chat history, unless pinned.
    const examples = { at: null, list: null, items: [] };
    const placeExamples = list => {
        if (examples.list) return;
        examples.list = list;
        examples.at = list.length;
        examples.items = exampleMessages(preset, lore);
    };
    const missing = assistant ? new Set() : missingParts(preset);
    const lumiverse = preset.source === 'lumiverse';
    for (const block of lumiverse ? lumiverseBlocks(preset) : preset.blocks) {
        if (!block.enabled || !blockTriggered(block, type) || !tagTriggered(block) || !conditionMet(block, condCtx)) continue;
        const role = block.role || 'system';
        const label = block.name;
        const marker = markerOf(block);
        if (marker === 'chat_history') {
            sawHistory = true;
            target = after;
            continue;
        }
        let content = '';
        switch (marker) {
            case 'world_info_before': case 'world_info_after': case 'char_description': case 'char_personality':
            case 'scenario': case 'persona_description':
                content = part(marker);
                break;
            case 'dialogue_examples':
                placeExamples(target);
                continue;
            case 'main_prompt': {
                // A card's own prompt replaces the preset's unless the preset forbids it (ST's forbid_overrides).
                // Lumiverse never does this (the card's prompt is only reachable through {{system}}).
                const own = !lumiverse && !block.forbidOverrides && gen.preferCharPrompt && (meta.system_prompt || data.system_prompt)?.trim();
                content = own ? substituteParams(meta.system_prompt || data.system_prompt, { original: substituteParams(block.content) }) : substituteParams(block.content);
                if (block.position !== 'in_history' && target === before) mainIndex = before.length;
                break;
            }
            case 'jailbreak': {
                const own = !lumiverse && !block.forbidOverrides && gen.preferCharInstructions && data.post_history_instructions?.trim();
                content = own ? substituteParams(data.post_history_instructions, { original: substituteParams(block.content) }) : substituteParams(block.content);
                break;
            }
            default:
                content = substituteParams(block.content);
        }
        if (!content.trim()) continue;
        if (role === 'user_append' || role === 'assistant_append') {
            appends.push({ role: role.replace('_append', ''), content, depth: Math.max(0, Number(block.depth) || 0), raw: substituteParams(block.content) });
            continue;
        }
        if (block.position === 'in_history') {
            inChat.push({ content, depth: Number(block.depth) || 0, role, order: Number(block.injectionOrder ?? 100), key: '', label });
            continue;
        }
        push(role, content, label);
    }

    // Lumiverse adds the card's post-history instructions after everything unless a block already uses them.
    if (lumiverse && data.post_history_instructions?.trim()
        && !preset.blocks.some(b => b.enabled && /\{\{\s*(?:charPostHistoryInstructions|jailbreak|charJailbreak)\s*\}\}/i.test(b.content || ''))) {
        const saved = target;
        target = after;
        push('system', substituteParams(data.post_history_instructions), "Character's post-history instructions");
        target = saved;
    }

    // Parts of the card, persona or lore the preset has no place for still go in, ahead of the history,
    // in SillyTavern's default order.
    if (missing.size) {
        const fallback = [];
        for (const name of ['world_info_before', 'persona_description', 'char_description', 'char_personality', 'scenario', 'world_info_after']) {
            if (!missing.has(name)) continue;
            const text = part(name);
            if (text.trim()) fallback.push({ role: 'system', content: text, __label: `${MARKER_NAMES[name] || name} (added: not in preset)` });
        }
        before.push(...fallback);
        for (const f of fallback) breakdown.push({ label: f.__label, role: 'system', tokens: estimateTokens(f.content) });
        if (missing.has('dialogue_examples')) placeExamples(before);
    }

    // Extension prompts (Summarize, Vectors, /inject…): BEFORE_PROMPT right before the main prompt and IN_PROMPT
    // right after it, as in ST; without a main prompt, at the very top / just before the history.
    const extBefore = [];
    const extAfter = [];
    for (const [key, ep] of activeExt) {
        const msg = { role: ROLE_NAMES[ep.role] || 'system', content: substituteParams(ep.value), __label: `ext:${key}` };
        if (ep.position === extension_prompt_types.BEFORE_PROMPT) extBefore.push(msg);
        else if (ep.position === extension_prompt_types.IN_PROMPT) extAfter.push(msg);
        else if (ep.position === extension_prompt_types.IN_CHAT && !(skipWIAN && key.startsWith('customDepthWI'))) {
            inChat.push({ content: msg.content, depth: ep.depth, role: msg.role, order: 100, key, label: `ext:${key}` });
        }
    }

    // Author's Note: lore and the persona can sit at its top or bottom (only when the note goes in).
    let an = '';
    const personaText = substituteParams(currentPersona().description || '');
    if (noteFires) {
        an = substituteParams(meta.note_prompt || '');
        if (lore.anTop) an = an.trim() ? `${lore.anTop}\n${an}` : lore.anTop;
        if (lore.anBottom) an = an.trim() ? `${an}\n${lore.anBottom}` : lore.anBottom;
        if (personaText.trim() && personaPlacement.position === PERSONA_POSITION.AN_TOP) an = an.trim() ? `${personaText}\n${an}` : personaText;
        if (personaText.trim() && personaPlacement.position === PERSONA_POSITION.AN_BOTTOM) an = an.trim() ? `${an}\n${personaText}` : personaText;
    }
    if (an.trim()) {
        const anRole = ROLE_NAMES[Number(meta.note_role ?? 0)] || 'system';
        const anPos = Number(meta.note_position ?? extension_prompt_types.IN_CHAT);
        if (anPos === extension_prompt_types.IN_PROMPT) extAfter.push({ role: anRole, content: an, __label: "Author's Note" });
        else if (anPos === extension_prompt_types.BEFORE_PROMPT) extBefore.push({ role: anRole, content: an, __label: "Author's Note" });
        else inChat.push({ content: an, depth: Number(meta.note_depth ?? 4), role: anRole, order: 100, key: '2_floating_prompt', label: "Author's Note" });
    }
    if (!skipWIAN) {
        // Character's Note (the card's depth_prompt): a reminder near the end of the chat.
        const charNote = data.extensions?.depth_prompt;
        if (charNote?.prompt?.trim()) {
            const role = ['system', 'user', 'assistant'].includes(charNote.role) ? charNote.role : ROLE_NAMES[Number(charNote.role)] || 'system';
            inChat.push({ content: substituteParams(charNote.prompt), depth: Number(charNote.depth ?? 4) || 0, role, order: 100, key: 'DEPTH_PROMPT', label: "Character's Note" });
        }
        for (const d of lore.depth) inChat.push({ ...d, order: 100, key: `customDepthWI_${d.depth}_${d.role}`, label: 'World Info @ depth' });
    }
    if (personaText.trim() && personaPlacement.position === PERSONA_POSITION.AT_DEPTH) {
        inChat.push({ content: personaText, depth: personaPlacement.depth, role: ROLE_NAMES[personaPlacement.role] || 'system', order: 100, key: 'PERSONA_DESCRIPTION', label: 'Persona Description @ depth' });
    }
    const placeAround = (list, at) => {
        for (const m of list) breakdown.push({ label: m.__label, role: m.role, tokens: estimateTokens(m.content) });
        before.splice(at, 0, ...list);
        if (examples.list === before && examples.at >= at) examples.at += list.length;
    };
    if (mainIndex >= 0) {
        placeAround(extAfter, mainIndex + 1);
        placeAround(extBefore, mainIndex);
    } else {
        placeAround(extAfter, before.length);
        placeAround(extBefore, 0);
    }

    // ----- history -----
    const names = Number(preset.completion.namesBehavior);
    const rs = reasoningSettings();
    let reasoningAdded = 0;
    let historyMsgs = history.map((m, i) => {
        const narrator = m.extra?.type === 'narrator';
        let content = texts[i];
        if (names === 2 && !narrator) content = `${m.name}: ${content}`;
        // ST's default: name lines from someone other than you that were sent "as" a character.
        else if (names === 0 && m.force_avatar && !m.is_user && !narrator && m.name !== charName()) content = `${m.name}: ${content}`;
        const out = { role: narrator ? 'system' : m.is_user ? 'user' : 'assistant', content, __src: { id: messageId(m), index: chat.indexOf(m) } };
        if (names === 1 && m.name && !narrator) out.name = m.name.replace(/[^\w-]/g, '_').slice(0, 64);
        return out;
    });
    // ST's "Add reasoning to prompts": the newest N replies keep their thinking, wrapped in the prefix/suffix.
    if (rs.addToPrompts) {
        for (let i = history.length - 1; i >= 0 && reasoningAdded < (Number(rs.maxAdditions) || 1); i--) {
            const m = history[i];
            const thinking = m.is_user ? '' : m.extra?.reasoning;
            if (!thinking || (isContinue && i === history.length - 1)) continue;
            const r = applyRegex(thinking, REGEX_PLACEMENT.REASONING, { isPrompt: true, depth: depthOf(i) });
            historyMsgs[i].content = `${substituteParams(rs.prefix || '<think>\n')}${r}${substituteParams(rs.suffix || '\n</think>')}${substituteParams(rs.separator ?? '\n\n')}${historyMsgs[i].content}`;
            reasoningAdded++;
        }
    }

    // The message being continued goes at the very end (after the post-history instructions), as in ST.
    let continued = null;
    if (isContinue && historyMsgs.length) continued = historyMsgs.pop();

    // Trim oldest history to fit the context window.
    const reserve = responseTokens + 64;
    const fixedTokens = [...before, ...after].reduce((n, m) => n + estimateTokens(m.content), 0)
        + inChat.reduce((n, m) => n + estimateTokens(m.content), 0) + (continued ? estimateTokens(continued.content) + 4 : 0)
        + (gen.pinExamples ? examples.items.reduce((n, m) => n + estimateTokens(m.content) + 4, 0) : 0);
    let budget = contextSize - reserve - fixedTokens;
    // Room for memories of what no longer fits (taken from the history's share).
    const historyTokens = historyMsgs.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
    // Pinned / hand-added memories and the synopsis always get a small floor; the rest only when history overflows.
    const memReserve = Math.min(historyTokens > budget ? memoryReserve() : memoryFloor(), Math.max(0, Math.floor(budget / 3)));
    budget -= memReserve;
    const kept = [];
    for (let i = historyMsgs.length - 1; i >= 0; i--) {
        const t = estimateTokens(historyMsgs[i].content) + 4;
        if (budget - t < 0 && kept.length) break;
        budget -= t;
        kept.unshift(historyMsgs[i]);
    }
    const dropped = historyMsgs.length - kept.length;

    // Example dialogue fills what's left, one whole example at a time.
    let examplesDropped = 0;
    if (examples.list) {
        const fit = [];
        for (const ex of examples.items) {
            const t = estimateTokens(ex.content) + 4;
            if (!gen.pinExamples && budget - t < 0) { examplesDropped++; continue; }
            if (!gen.pinExamples) budget -= t;
            fit.push({ role: ex.role, content: ex.content, __label: ex.label, __noSquash: true });
            breakdown.push({ label: ex.label, role: ex.role, tokens: estimateTokens(ex.content) });
        }
        examples.list.splice(examples.at, 0, ...fit);
    }

    // Memories of the story before the oldest message that fit.
    const firstKept = kept.length ? kept[0].__src.index : Infinity;
    const mem = recallMemories({ chat, firstKept: dropped ? firstKept : -1, budget: memReserve });
    if (!dryRun) noteMemoryUse(mem);

    // Depth injections, merged like ST: at each depth, one message per injection order and role (lower
    // order first; within it assistant, user, then system, nearest the bottom). Preset blocks come first,
    // then extension prompts by name (Author's Note, Character's Note, persona, lore).
    const withInjections = [...kept];
    const depths = [...new Set(inChat.map(i => Math.max(0, Number(i.depth) || 0)))].sort((a, b) => b - a);
    for (const depth of depths) {
        const here = inChat.filter(i => Math.max(0, Number(i.depth) || 0) === depth);
        const orders = [...new Set(here.map(i => i.order))].sort((a, b) => a - b);
        const msgs = [];
        for (const order of orders) {
            for (const role of ['assistant', 'user', 'system']) {
                const group = here.filter(i => i.order === order && (ROLE_NAMES.includes(i.role) ? i.role : 'system') === role)
                    .sort((a, b) => (a.key ? 1 : 0) - (b.key ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
                const content = group.map(g => String(g.content).trim()).filter(Boolean).join('\n');
                if (content) msgs.push({ role, content, __label: [...new Set(group.map(g => g.label))].join(' + '), __noSquash: false });
            }
        }
        const at = Math.max(0, withInjections.length - depth);
        withInjections.splice(at, 0, ...msgs);
    }

    const historyBlock = [];
    const newChat = substituteParams(preset.behavior.newChatPrompt ?? '');
    // A preset that places {{memories}} itself gets them there instead.
    const memoriesInPreset = preset.blocks.some(b => b.enabled && /\{\{\s*memories(?:raw)?\s*\}\}/i.test(b.content || ''));
    if (mem.text && !memoriesInPreset) {
        historyBlock.push({ role: 'system', content: mem.text, __label: `Memories (${mem.used.length})` });
        breakdown.push({ label: `Memories (${mem.used.length})`, role: 'system', tokens: mem.tokens });
    }
    if (newChat.trim()) historyBlock.push({ role: 'system', content: newChat, __label: 'New chat prompt', __noSquash: true });
    historyBlock.push(...withInjections);

    // Type-specific parts.
    const tail = [];
    let prefill = '';
    const lastMsg = history.at(-1);
    const profile = assistant ? null : activeModelProfile(preset);
    const assistantPrefill = substituteParams(profile?.assistantPrefill ?? preset.completion.assistantPrefill ?? '');
    if (isContinue && continued) {
        const cont = continued.content;
        if (preset.completion.continuePrefill && !lastMsg?.is_user) {
            // The model picks up mid-message; the preset's prefill (if any) goes in front, as in ST.
            prefill = assistantPrefill.trim() ? `${assistantPrefill}\n\n${cont}` : cont;
        } else {
            tail.push({ role: continued.role, content: cont, __label: 'Message being continued' });
            tail.push({ role: 'system', content: substituteParams(preset.behavior.continueNudge, { lastChatMessage: cont }), __label: 'Continue nudge' });
            prefill = assistantPrefill;
        }
    } else if (type === 'impersonate') {
        // Lumiverse sends it as your turn; ST as a system note.
        tail.push({ role: preset.source === 'lumiverse' ? 'user' : 'system', content: substituteParams(preset.behavior.impersonationPrompt), __label: 'Impersonation prompt' });
        if (quietPrompt) tail.push({ role: 'system', content: substituteParams(quietPrompt), __label: 'Quiet prompt' });
        prefill = substituteParams(preset.completion.assistantImpersonation);
    } else if (type === 'quiet') {
        if (quietPrompt) tail.push({ role: 'system', content: substituteParams(quietPrompt), __label: 'Quiet prompt' });
    } else {
        // "Send if empty": stands in for your turn when the chat ends on the character (part of the history).
        if (lastMsg && !lastMsg.is_user && preset.behavior.sendIfEmpty?.trim()) {
            historyBlock.push({ role: 'user', content: substituteParams(preset.behavior.sendIfEmpty), __label: 'Send if empty' });
        }
        prefill = assistantPrefill;
    }

    if (!sawHistory) {
        // Preset has no Chat History marker: history goes after everything else.
        before.push(...after.splice(0));
    }
    let messages = [...before, ...historyBlock, ...after, ...tail];

    // *_append blocks (Lumiverse): grouped by role and depth, joined as written, and added to the depth-th
    // chat message of that role from the end; nothing happens if there's no such message.
    const appendGroups = new Map();
    for (const a of appends) {
        const key = `${a.role}|${a.depth}`;
        if (!appendGroups.has(key)) appendGroups.set(key, { ...a, parts: [] });
        appendGroups.get(key).parts.push(a.raw ?? a.content);
    }
    for (const g of appendGroups.values()) {
        let seen = 0;
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role !== g.role || !messages[i].__src) continue;
            if (seen++ === g.depth) {
                messages[i] = { ...messages[i], content: `${messages[i].content}\n${g.parts.join('')}` };
                break;
            }
        }
    }

    if (prefill.trim()) messages.push({ role: 'assistant', content: prefill, __label: isContinue ? 'Continue prefill' : 'Prefill' });

    if (preset.completion.squashSystemMessages) {
        // ST keeps the new-chat and example separators apart.
        const squashed = [];
        for (const m of messages) {
            const last = squashed.at(-1);
            if (last && last.role === 'system' && m.role === 'system' && !m.name && !last.name && !m.__noSquash && !last.__noSquash) last.content += `\n${m.content}`;
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
    const labels = messages.map(m => labelOf(m) || labelByContent.get(m.content) || 'Added by an extension');
    messages = messages.map(m => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('__'))));

    const eventData = { chat: messages, dryRun };
    await eventSource.emit(event_types.CHAT_COMPLETION_PROMPT_READY, eventData);
    messages = eventData.chat;

    const tokens = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
    breakdown.push({ label: `Chat history (${kept.length} msgs${dropped ? `, ${dropped} trimmed` : ''})`, role: 'mixed', tokens: kept.reduce((n, m) => n + estimateTokens(m.content), 0) });
    if (!dryRun) lastPromptInfo = { firstIncluded: kept.length ? kept[0].__src.index : chat.length, contextSize, maxResponse: responseTokens, type };

    // What didn't make it in, and why.
    const cut = {
        chatId: state.chatId,
        history: dropped ? { dropped, total: historyMsgs.length, upTo: kept.length ? kept[0].__src.index : history.length } : null,
        examples: examplesDropped ? { dropped: examplesDropped, total: examples.items.length } : null,
        lore: (lore.skipped || []).map(e => ({ uid: e.uid, book: e.book, title: e.comment || (e.key || []).join(', ') || `Entry ${e.uid}`, reason: e.reason, tokens: estimateTokens(e.content) })),
        memories: { used: mem.used, skipped: mem.skipped },
        authorsNote: meta.note_prompt?.trim() && !noteFires && !skipWIAN ? `Author's Note skipped this turn (every ${noteInterval} of your messages)` : null,
    };
    if (!dryRun) lastCutReport = cut;
    return { messages, labels: messages.length === labels.length ? labels : [], breakdown, tokens, prefill, lore: lore.activated, loreTotal: lore.total ?? lore.activated.length, cut, extraParams };
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
    // Samplers the preset leaves to the model (Lumiverse's "unset") aren't sent at all.
    for (const k of state.preset.samplerOmit || []) delete params[k];
    if (state.preset.customBody?.enabled) {
        try { params.custom_body = JSON.parse(state.preset.customBody.rawJson || '{}'); } catch { /* ignore invalid json */ }
    }
    return params;
}

export { STRUCTURAL_MARKERS, charName, userName };
