// Prompt presets. Reverie's internal format is block-based (like Lumiverse "Loom"),
// and converts losslessly-enough to and from SillyTavern chat-completion presets.

export const ST_IDENTIFIER_TO_MARKER = {
    chatHistory: 'chat_history',
    worldInfoBefore: 'world_info_before',
    worldInfoAfter: 'world_info_after',
    charDescription: 'char_description',
    charPersonality: 'char_personality',
    personaDescription: 'persona_description',
    scenario: 'scenario',
    dialogueExamples: 'dialogue_examples',
    main: 'main_prompt',
    enhanceDefinitions: 'enhance_definitions',
    jailbreak: 'jailbreak',
    nsfw: 'nsfw_prompt',
};
export const MARKER_TO_ST = Object.fromEntries(Object.entries(ST_IDENTIFIER_TO_MARKER).map(([k, v]) => [v, k]));

export const MARKER_NAMES = {
    chat_history: 'Chat History',
    world_info_before: 'World Info (before)',
    world_info_after: 'World Info (after)',
    char_description: 'Character Description',
    char_personality: 'Character Personality',
    persona_description: 'Persona Description',
    scenario: 'Scenario',
    dialogue_examples: 'Example Dialogue',
    main_prompt: 'Main Prompt',
    enhance_definitions: 'Enhance Definitions',
    jailbreak: 'Post-History Instructions',
    nsfw_prompt: 'Auxiliary Prompt',
    category: 'Category',
};

// Markers whose content comes from the character/persona/lorebook rather than the block itself.
export const STRUCTURAL_MARKERS = new Set([
    'chat_history', 'world_info_before', 'world_info_after', 'char_description',
    'char_personality', 'persona_description', 'scenario', 'dialogue_examples',
]);

export const DEFAULT_SAMPLERS = {
    temperature: 1,
    top_p: 1,
    top_k: 0,
    min_p: 0,
    top_a: 0,
    frequency_penalty: 0,
    presence_penalty: 0,
    repetition_penalty: 1,
    max_tokens: 2048,
    context_size: 64000,
    seed: -1,
    stream: true,
    reasoning_effort: '',
};

export const DEFAULT_BEHAVIOR = {
    continueNudge: '[Continue your last message without repeating its original content.]',
    impersonationPrompt: "[Write your next reply from the point of view of {{user}}, using the chat history so far as a guideline for the writing style of {{user}}. Don't write as {{char}} or system. Don't describe actions of {{char}}.]",
    newChatPrompt: '[Start a new Chat]',
    newExampleChatPrompt: '[Example Chat]',
    groupNudge: '[Write the next reply only as {{char}}.]',
    sendIfEmpty: '',
};

export const DEFAULT_COMPLETION = {
    assistantPrefill: '',
    assistantImpersonation: '',
    continuePrefill: false,
    continuePostfix: ' ',
    namesBehavior: 0, // 0 none, 1 default, 2 in content
    squashSystemMessages: false,
};

export const DEFAULT_FORMATS = {
    wiFormat: '{0}',
    scenarioFormat: '{{scenario}}',
    personalityFormat: '{{personality}}',
};

let counter = 0;
export const blockId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function makeBlock(partial = {}) {
    return {
        id: partial.id || blockId(),
        name: partial.name || 'New prompt',
        content: partial.content ?? '',
        role: partial.role || 'system',
        enabled: partial.enabled ?? true,
        position: partial.position || 'pre_history',
        depth: Number.isFinite(partial.depth) ? partial.depth : 4,
        marker: partial.marker ?? null,
        injectionTrigger: Array.isArray(partial.injectionTrigger) ? partial.injectionTrigger : [],
        group: partial.group ?? null,
        color: partial.color ?? null,
        ...(partial.variables ? { variables: partial.variables } : {}),
        ...(partial.categoryMode ? { categoryMode: partial.categoryMode } : {}),
        ...(partial.placementBinding ? { placementBinding: partial.placementBinding } : {}),
        ...(partial.characterTagTrigger ? { characterTagTrigger: partial.characterTagTrigger } : {}),
    };
}

export function defaultPreset() {
    return {
        name: 'Reverie Default',
        source: 'reverie',
        blocks: [
            makeBlock({ name: 'Main Prompt', marker: 'main_prompt', content: "You are {{char}} in an immersive, never-ending roleplay with {{user}}. Write {{char}}'s next reply. Stay in character, write vivid prose with sensory detail, show emotions through action and dialogue, and never speak or act for {{user}}." }),
            makeBlock({ name: MARKER_NAMES.world_info_before, marker: 'world_info_before' }),
            makeBlock({ name: MARKER_NAMES.persona_description, marker: 'persona_description' }),
            makeBlock({ name: MARKER_NAMES.char_description, marker: 'char_description' }),
            makeBlock({ name: MARKER_NAMES.char_personality, marker: 'char_personality' }),
            makeBlock({ name: MARKER_NAMES.scenario, marker: 'scenario' }),
            makeBlock({ name: 'Formatting', content: 'Formatting: write narration in plain text, *actions and inner thoughts in italics*, and "dialogue in quotes". When a scene benefits from it, you may include rich visual elements (status panels, letters, maps, UIs, mini-games) as a self-contained ```html code block with inline CSS and JavaScript; they will be rendered live.', enabled: true }),
            makeBlock({ name: MARKER_NAMES.world_info_after, marker: 'world_info_after' }),
            makeBlock({ name: MARKER_NAMES.dialogue_examples, marker: 'dialogue_examples' }),
            makeBlock({ name: MARKER_NAMES.chat_history, marker: 'chat_history' }),
            makeBlock({ name: MARKER_NAMES.jailbreak, marker: 'jailbreak', content: '' }),
        ],
        samplers: { ...DEFAULT_SAMPLERS },
        behavior: { ...DEFAULT_BEHAVIOR },
        completion: { ...DEFAULT_COMPLETION },
        formats: { ...DEFAULT_FORMATS },
        stopStrings: [],
        customBody: { enabled: false, rawJson: '{}' },
        promptVariables: {},
        regex: [],
    };
}

export function normalizePreset(p) {
    const base = defaultPreset();
    return {
        ...p,
        name: p.name || 'Untitled preset',
        blocks: Array.isArray(p.blocks) ? p.blocks.map(makeBlock) : base.blocks,
        samplers: { ...DEFAULT_SAMPLERS, ...(p.samplers || {}) },
        behavior: { ...DEFAULT_BEHAVIOR, ...(p.behavior || {}) },
        completion: { ...DEFAULT_COMPLETION, ...(p.completion || {}) },
        formats: { ...DEFAULT_FORMATS, ...(p.formats || {}) },
        stopStrings: Array.isArray(p.stopStrings) ? p.stopStrings : [],
        customBody: p.customBody || { enabled: false, rawJson: '{}' },
        promptVariables: p.promptVariables || {},
        regex: Array.isArray(p.regex) ? p.regex : [],
    };
}

// ---------------- detection ----------------
export function detectPresetKind(json) {
    if (!json || typeof json !== 'object') return null;
    if (Array.isArray(json.blocks)) return 'lumiverse';
    if (Array.isArray(json.prompts) || Array.isArray(json.prompt_order)) return 'sillytavern';
    if ('temperature' in json && ('openai_max_tokens' in json || 'openai_max_context' in json)) return 'sillytavern';
    return null;
}

export function importPreset(json, fallbackName = 'Imported preset') {
    const kind = detectPresetKind(json);
    if (kind === 'lumiverse') return fromLumiverse(json, fallbackName);
    if (kind === 'sillytavern') return fromSillyTavern(json, fallbackName);
    throw new Error('This file does not look like a SillyTavern or Lumiverse chat-completion preset.');
}

// ---------------- SillyTavern ----------------
const num = (v, d) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function fromSillyTavern(st, fallbackName) {
    const prompts = Array.isArray(st.prompts) ? st.prompts : [];
    const byId = new Map(prompts.map(p => [p.identifier, p]));
    const orders = Array.isArray(st.prompt_order) ? st.prompt_order : [];
    const order = (orders.find(o => String(o.character_id) === '100001') || orders.reduce((a, b) => ((b.order?.length || 0) > (a?.order?.length || 0) ? b : a), null))?.order
        || prompts.map(p => ({ identifier: p.identifier, enabled: p.enabled !== false }));
    const seen = new Set();
    const blocks = [];
    const chatIdx = order.findIndex(o => o.identifier === 'chatHistory');

    const convert = (entry, idx, enabled) => {
        const p = byId.get(entry.identifier) || { identifier: entry.identifier, name: entry.identifier, marker: true };
        const marker = ST_IDENTIFIER_TO_MARKER[p.identifier] || null;
        const absolute = Number(p.injection_position) === 1;
        const position = absolute ? 'in_history' : (chatIdx >= 0 && idx > chatIdx ? 'post_history' : 'pre_history');
        return makeBlock({
            id: marker ? `${p.identifier}` : (p.identifier || blockId()),
            name: p.name || (marker ? MARKER_NAMES[marker] : p.identifier),
            content: p.content ?? '',
            role: ['system', 'user', 'assistant'].includes(p.role) ? p.role : 'system',
            enabled,
            position,
            depth: num(p.injection_depth, 4),
            marker,
            injectionTrigger: Array.isArray(p.injection_trigger) ? p.injection_trigger : [],
        });
    };

    order.forEach((entry, idx) => {
        if (seen.has(entry.identifier)) return;
        seen.add(entry.identifier);
        blocks.push(convert(entry, idx, entry.enabled !== false));
    });
    // Prompts that exist but are not in the order are kept, disabled.
    for (const p of prompts) {
        if (seen.has(p.identifier)) continue;
        seen.add(p.identifier);
        blocks.push(convert({ identifier: p.identifier }, Infinity, false));
    }

    const preset = normalizePreset({
        name: st.name || fallbackName,
        source: 'sillytavern',
        blocks,
        samplers: {
            temperature: num(st.temperature, 1),
            top_p: num(st.top_p, 1),
            top_k: num(st.top_k, 0),
            min_p: num(st.min_p, 0),
            top_a: num(st.top_a, 0),
            frequency_penalty: num(st.frequency_penalty, 0),
            presence_penalty: num(st.presence_penalty, 0),
            repetition_penalty: num(st.repetition_penalty, 1),
            max_tokens: num(st.openai_max_tokens, 2048),
            context_size: num(st.openai_max_context, 64000),
            seed: num(st.seed, -1),
            stream: st.stream_openai !== false,
            reasoning_effort: st.reasoning_effort && st.reasoning_effort !== 'auto' ? st.reasoning_effort : '',
        },
        behavior: {
            continueNudge: st.continue_nudge_prompt ?? DEFAULT_BEHAVIOR.continueNudge,
            impersonationPrompt: st.impersonation_prompt ?? DEFAULT_BEHAVIOR.impersonationPrompt,
            newChatPrompt: st.new_chat_prompt ?? DEFAULT_BEHAVIOR.newChatPrompt,
            newExampleChatPrompt: st.new_example_chat_prompt ?? DEFAULT_BEHAVIOR.newExampleChatPrompt,
            groupNudge: st.group_nudge_prompt ?? DEFAULT_BEHAVIOR.groupNudge,
            sendIfEmpty: st.send_if_empty ?? '',
        },
        completion: {
            assistantPrefill: st.assistant_prefill ?? '',
            assistantImpersonation: st.assistant_impersonation ?? '',
            continuePrefill: !!st.continue_prefill,
            continuePostfix: st.continue_postfix ?? ' ',
            namesBehavior: num(st.names_behavior, 0),
            squashSystemMessages: !!st.squash_system_messages,
        },
        formats: {
            wiFormat: st.wi_format ?? '{0}',
            scenarioFormat: st.scenario_format ?? '{{scenario}}',
            personalityFormat: st.personality_format ?? '{{personality}}',
        },
        regex: Array.isArray(st.extensions?.regex_scripts) ? st.extensions.regex_scripts : [],
    });
    preset.raw = st;
    return preset;
}

export function toSillyTavern(preset) {
    const raw = preset.raw && preset.source === 'sillytavern' ? structuredClone(preset.raw) : {};
    const prompts = [];
    const order = [];
    for (const b of preset.blocks) {
        const identifier = b.marker && MARKER_TO_ST[b.marker] ? MARKER_TO_ST[b.marker] : b.id;
        const structural = STRUCTURAL_MARKERS.has(b.marker);
        const entry = {
            identifier,
            name: b.name,
            system_prompt: !!b.marker,
            role: ['system', 'user', 'assistant'].includes(b.role) ? b.role : 'system',
            ...(structural ? { marker: true } : { content: b.content }),
            injection_position: b.position === 'in_history' ? 1 : 0,
            injection_depth: b.depth ?? 4,
            injection_trigger: b.injectionTrigger || [],
            forbid_overrides: false,
        };
        prompts.push(entry);
        order.push({ identifier, enabled: !!b.enabled });
    }
    const s = preset.samplers;
    return {
        ...raw,
        temperature: s.temperature,
        top_p: s.top_p,
        top_k: s.top_k,
        min_p: s.min_p,
        top_a: s.top_a,
        frequency_penalty: s.frequency_penalty,
        presence_penalty: s.presence_penalty,
        repetition_penalty: s.repetition_penalty,
        openai_max_tokens: s.max_tokens,
        openai_max_context: s.context_size,
        seed: s.seed,
        stream_openai: s.stream,
        reasoning_effort: s.reasoning_effort || 'auto',
        names_behavior: preset.completion.namesBehavior,
        send_if_empty: preset.behavior.sendIfEmpty,
        impersonation_prompt: preset.behavior.impersonationPrompt,
        new_chat_prompt: preset.behavior.newChatPrompt,
        new_example_chat_prompt: preset.behavior.newExampleChatPrompt,
        continue_nudge_prompt: preset.behavior.continueNudge,
        group_nudge_prompt: preset.behavior.groupNudge,
        wi_format: preset.formats.wiFormat,
        scenario_format: preset.formats.scenarioFormat,
        personality_format: preset.formats.personalityFormat,
        assistant_prefill: preset.completion.assistantPrefill,
        assistant_impersonation: preset.completion.assistantImpersonation,
        continue_prefill: preset.completion.continuePrefill,
        continue_postfix: preset.completion.continuePostfix,
        squash_system_messages: preset.completion.squashSystemMessages,
        prompts,
        prompt_order: [{ character_id: 100001, order }],
        extensions: { ...(raw.extensions || {}), regex_scripts: preset.regex || [] },
    };
}

// ---------------- Lumiverse (Loom) ----------------
const camelToSampler = {
    maxTokens: 'max_tokens', contextSize: 'context_size', temperature: 'temperature', topP: 'top_p', minP: 'min_p',
    topK: 'top_k', frequencyPenalty: 'frequency_penalty', presencePenalty: 'presence_penalty',
    repetitionPenalty: 'repetition_penalty', streaming: 'stream',
};

export function fromLumiverse(loom, fallbackName) {
    const samplers = { ...DEFAULT_SAMPLERS };
    for (const [k, v] of Object.entries(loom.samplerOverrides || {})) {
        if (camelToSampler[k] && v !== null && v !== undefined) samplers[camelToSampler[k]] = v;
    }
    const pb = loom.promptBehavior || {};
    const cs = loom.completionSettings || {};
    const adv = loom.advancedSettings || {};
    if (Number.isFinite(adv.seed)) samplers.seed = adv.seed;
    const preset = normalizePreset({
        name: loom.name || fallbackName,
        source: 'lumiverse',
        description: loom.description || '',
        blocks: (loom.blocks || []).map(b => makeBlock({
            ...b,
            role: b.role || 'system',
            position: b.position || 'pre_history',
            depth: num(b.depth, 4),
            enabled: b.enabled !== false,
        })),
        samplers,
        behavior: {
            continueNudge: pb.continueNudge ?? DEFAULT_BEHAVIOR.continueNudge,
            impersonationPrompt: pb.impersonationPrompt ?? DEFAULT_BEHAVIOR.impersonationPrompt,
            newChatPrompt: pb.newChatPrompt ?? DEFAULT_BEHAVIOR.newChatPrompt,
            newExampleChatPrompt: DEFAULT_BEHAVIOR.newExampleChatPrompt,
            groupNudge: pb.groupNudge ?? DEFAULT_BEHAVIOR.groupNudge,
            sendIfEmpty: pb.sendIfEmpty ?? pb.emptySendNudge ?? '',
        },
        completion: {
            assistantPrefill: cs.assistantPrefill ?? '',
            assistantImpersonation: cs.assistantImpersonation ?? '',
            continuePrefill: !!cs.continuePrefill,
            continuePostfix: cs.continuePostfix ?? ' ',
            namesBehavior: num(cs.namesBehavior, 0),
            squashSystemMessages: !!cs.squashSystemMessages,
        },
        stopStrings: Array.isArray(adv.customStopStrings) ? adv.customStopStrings : [],
        customBody: loom.customBody?.enabled ? loom.customBody : { enabled: false, rawJson: '{}' },
        promptVariables: loom.promptVariables || {},
        regex: Array.isArray(loom.extensions?.regex_scripts) ? loom.extensions.regex_scripts : [],
    });
    preset.raw = loom;
    return preset;
}

export function toLumiverse(preset) {
    const raw = preset.raw && preset.source === 'lumiverse' ? structuredClone(preset.raw) : {};
    const s = preset.samplers;
    return {
        ...raw,
        name: preset.name,
        description: preset.description || raw.description || '',
        schemaVersion: raw.schemaVersion || 1,
        blocks: preset.blocks.map(b => ({ isLocked: false, ...b })),
        samplerOverrides: {
            enabled: true,
            maxTokens: s.max_tokens, contextSize: s.context_size, temperature: s.temperature, topP: s.top_p,
            minP: s.min_p, topK: s.top_k, frequencyPenalty: s.frequency_penalty, presencePenalty: s.presence_penalty,
            repetitionPenalty: s.repetition_penalty, streaming: s.stream,
        },
        customBody: preset.customBody,
        promptBehavior: { ...(raw.promptBehavior || {}), ...preset.behavior },
        completionSettings: { ...(raw.completionSettings || {}), ...preset.completion },
        advancedSettings: { ...(raw.advancedSettings || {}), seed: s.seed, customStopStrings: preset.stopStrings },
        promptVariables: preset.promptVariables,
        extensions: { ...(raw.extensions || {}), regex_scripts: preset.regex || [] },
    };
}
