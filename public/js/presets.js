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
    namesBehavior: 0, // ST: -1 none, 0 default (sendas lines get a name prefix), 1 "name" field, 2 in content
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
        ...(partial.when ? { when: String(partial.when) } : {}),
        // ST: order among in-chat prompts at the same depth (higher = closer to the end).
        ...(partial.injectionOrder !== undefined && partial.injectionOrder !== null && Number(partial.injectionOrder) !== 100 ? { injectionOrder: Number(partial.injectionOrder) } : {}),
        // ST: the card's own main prompt / post-history instructions can't replace this block.
        ...(partial.forbidOverrides ? { forbidOverrides: true } : {}),
        ...(partial.sealed ? { sealed: true } : {}),
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
        regex: Array.isArray(p.regex) ? p.regex.map(fromLumiverseRegex) : [],
        samplerOmit: Array.isArray(p.samplerOmit) ? p.samplerOmit : [],
        modelProfiles: Array.isArray(p.modelProfiles) ? p.modelProfiles.map(normalizeProfile) : [],
        meta: { author: '', version: '', description: '', homepage: '', ...(p.meta || {}) },
    };
}

export function normalizeProfile(x = {}) {
    return {
        id: x.id || blockId(),
        name: x.name || x.match || 'Profile',
        match: x.match || '',
        enabled: x.enabled !== false,
        samplers: x.samplers && typeof x.samplers === 'object' ? x.samplers : {},
        ...(x.assistantPrefill !== undefined && x.assistantPrefill !== null ? { assistantPrefill: String(x.assistantPrefill) } : {}),
    };
}

// ---------------- detection ----------------
export const REVERIE_PRESET_FORMAT = 'reverie-preset';

export function detectPresetKind(json) {
    if (!json || typeof json !== 'object') return null;
    if (json.format === REVERIE_PRESET_FORMAT) return 'reverie';
    if (json.type === 'marinara_preset' && json.data) return 'marinara';
    if (Array.isArray(json.blocks)) return 'lumiverse';
    if (Array.isArray(json.prompts) || Array.isArray(json.prompt_order)) return 'sillytavern';
    if ('temperature' in json && ('openai_max_tokens' in json || 'openai_max_context' in json)) return 'sillytavern';
    return null;
}

export function importPreset(json, fallbackName = 'Imported preset') {
    const kind = detectPresetKind(json);
    if (kind === 'reverie') return fromReverie(json, fallbackName);
    if (kind === 'lumiverse') return fromLumiverse(json, fallbackName);
    if (kind === 'sillytavern') return fromSillyTavern(json, fallbackName);
    if (kind === 'marinara') return fromMarinara(json, fallbackName);
    throw new Error('This file does not look like a SillyTavern, Lumiverse or Marinara preset.');
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
            injectionOrder: num(p.injection_order, 100),
            forbidOverrides: !!p.forbid_overrides,
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
    const rawPrompts = new Map((raw.prompts || []).map(p => [p.identifier, p]));
    const prompts = [];
    const order = [];
    for (const b of preset.blocks) {
        const identifier = b.marker && MARKER_TO_ST[b.marker] ? MARKER_TO_ST[b.marker] : b.id;
        const structural = STRUCTURAL_MARKERS.has(b.marker);
        const entry = {
            ...(rawPrompts.get(identifier) || {}), // keep fields Reverie doesn't use
            identifier,
            name: b.name,
            system_prompt: !!b.marker,
            role: ['system', 'user', 'assistant'].includes(b.role) ? b.role : 'system',
            ...(structural ? { marker: true } : { content: b.content }),
            injection_position: b.position === 'in_history' ? 1 : 0,
            injection_depth: b.depth ?? 4,
            injection_trigger: b.injectionTrigger || [],
            injection_order: b.injectionOrder ?? 100,
            forbid_overrides: !!b.forbidOverrides,
        };
        // ST has no append roles: they become plain prompts there.
        if (b.role === 'user_append' || b.role === 'assistant_append') entry.role = b.role.replace('_append', '');
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
        // Only the global order (100001) is rewritten; per-character orders stay as they were.
        prompt_order: [{ character_id: 100001, order }, ...(raw.prompt_order || []).filter(o => String(o.character_id) !== '100001')],
        extensions: { ...(raw.extensions || {}), regex_scripts: preset.regex || [] },
    };
}

// ---------------- Lumiverse (Loom) ----------------
const camelToSampler = {
    maxTokens: 'max_tokens', contextSize: 'context_size', temperature: 'temperature', topP: 'top_p', minP: 'min_p',
    topK: 'top_k', frequencyPenalty: 'frequency_penalty', presencePenalty: 'presence_penalty',
    repetitionPenalty: 'repetition_penalty', streaming: 'stream',
};

// Lumiverse only sends samplers when overrides are on; an empty value (or 0 for the sampling knobs) means
// "leave it to the model", except max tokens and temperature, which default to 16384 and 1.
const LUMI_ZERO_OMITS = new Set(['temperature', 'topP', 'minP', 'frequencyPenalty', 'presencePenalty', 'repetitionPenalty']);
const LUMI_SAMPLING = ['temperature', 'topP', 'minP', 'topK', 'frequencyPenalty', 'presencePenalty', 'repetitionPenalty'];

/** Lumiverse regex scripts (snake_case, string placements) → ST/Reverie script shape. */
export function fromLumiverseRegex(script) {
    if (!script || script.findRegex !== undefined) return script;
    const place = { user_input: 1, ai_output: 2, slash_command: 3, world_info: 5, reasoning: 6 };
    const targets = Array.isArray(script.target) ? script.target : script.target ? [script.target] : [];
    return {
        id: script.id || crypto.randomUUID(),
        scriptName: script.script_name || script.name || 'Imported script',
        findRegex: script.find_regex || '',
        replaceString: script.replace_string ?? '',
        trimStrings: script.trim_strings || [],
        placement: (script.placement || []).map(p => (typeof p === 'number' ? p : place[p])).filter(p => p !== undefined),
        disabled: !!script.disabled,
        markdownOnly: targets.includes('display'),
        promptOnly: targets.includes('prompt'),
        runOnEdit: script.run_on_edit !== false,
        substituteRegex: Number(script.substitute_regex ?? 0) || 0,
        minDepth: script.min_depth ?? null,
        maxDepth: script.max_depth ?? null,
    };
}

export function fromLumiverse(loom, fallbackName) {
    const samplers = { ...DEFAULT_SAMPLERS, max_tokens: 16384 };
    const so = loom.samplerOverrides || {};
    const omit = [];
    for (const [k, v] of Object.entries(so)) {
        if (!camelToSampler[k]) continue;
        if (v === null || v === undefined || (v === 0 && LUMI_ZERO_OMITS.has(k))) { if (LUMI_SAMPLING.includes(k) && k !== 'temperature') omit.push(camelToSampler[k]); continue; }
        samplers[camelToSampler[k]] = v;
    }
    if (so.temperature === 0) omit.push('temperature');
    // Overrides off: the model's own sampling defaults.
    if (!so.enabled) for (const k of LUMI_SAMPLING) if (!omit.includes(camelToSampler[k])) omit.push(camelToSampler[k]);
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
            // Sealed LumiHub blocks only hold a {{presetBlock::…}} placeholder outside Lumiverse.
            enabled: b.enabled !== false && !b.sealed,
        })),
        samplers,
        samplerOmit: [...new Set([...omit, 'top_a'])], // Lumiverse has no Top A
        behavior: {
            continueNudge: pb.continueNudge ?? DEFAULT_BEHAVIOR.continueNudge,
            impersonationPrompt: pb.impersonationPrompt ?? DEFAULT_BEHAVIOR.impersonationPrompt,
            newChatPrompt: pb.newChatPrompt ?? DEFAULT_BEHAVIOR.newChatPrompt,
            newExampleChatPrompt: DEFAULT_BEHAVIOR.newExampleChatPrompt,
            groupNudge: pb.groupNudge ?? DEFAULT_BEHAVIOR.groupNudge,
            sendIfEmpty: pb.sendIfEmpty || pb.emptySendNudge || '',
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
        regex: Array.isArray(loom.extensions?.regex_scripts) ? loom.extensions.regex_scripts.map(fromLumiverseRegex) : [],
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
        samplerOverrides: (() => {
            // Samplers left to the model go back as null, which is how Lumiverse says it.
            const off = new Set(preset.samplerOmit || []);
            const v = (key, value) => (off.has(key) ? null : value);
            return {
                enabled: true,
                maxTokens: s.max_tokens, contextSize: s.context_size, temperature: v('temperature', s.temperature), topP: v('top_p', s.top_p),
                minP: v('min_p', s.min_p), topK: v('top_k', s.top_k), frequencyPenalty: v('frequency_penalty', s.frequency_penalty),
                presencePenalty: v('presence_penalty', s.presence_penalty), repetitionPenalty: v('repetition_penalty', s.repetition_penalty), streaming: s.stream,
            };
        })(),
        customBody: preset.customBody,
        promptBehavior: { ...(raw.promptBehavior || {}), ...preset.behavior },
        completionSettings: { ...(raw.completionSettings || {}), ...preset.completion },
        advancedSettings: { ...(raw.advancedSettings || {}), seed: s.seed, customStopStrings: preset.stopStrings },
        promptVariables: preset.promptVariables,
        extensions: { ...(raw.extensions || {}), regex_scripts: preset.regex || [] },
    };
}

// ---------------- Marinara Engine ----------------
// { type: 'marinara_preset', data: { preset: { sectionOrder, groupOrder, wrapFormat }, sections, groups, choiceBlocks } }.
// Sections become blocks (wrapped in the preset's XML / Markdown headers the way Marinara wraps them), groups become
// category headers, and choice blocks become preset options ({{POV}} → {{var::POV}}).
const MARINARA_MARKERS = {
    persona: ['persona_description'], lorebook: ['world_info_before'], world_info_before: ['world_info_before'],
    world_info_after: ['world_info_after'], chat_history: ['chat_history'], dialogue_examples: ['dialogue_examples'],
};
const snake = n => String(n || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section';

export function fromMarinara(json, fallbackName) {
    const { preset: mp = {}, sections = [], groups = [], choiceBlocks = [] } = json.data || {};
    const wrap = mp.wrapFormat || 'xml';
    const byId = new Map(sections.map(x => [x.id, x]));
    const groupById = new Map(groups.map(g => [g.id, g]));
    const flag = v => v === true || v === 'true';
    const choiceNames = choiceBlocks.map(c => c.variableName).filter(Boolean);
    const withVars = text => choiceNames.reduce((t, name) => t.replace(new RegExp(`\\{\\{\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'g'), `{{var::${name}}}`), String(text || ''));
    const wrapText = (text, name) => {
        const t = String(text || '').trim();
        if (!t || wrap === 'none') return t;
        if (wrap === 'xml') return `<${snake(name)}>\n${t.split('\n').map(l => `    ${l}`).join('\n')}\n</${snake(name)}>`;
        return `## ${name}\n${t}`;
    };
    const blocks = [];
    let lastGroup = null;
    const order = (mp.sectionOrder?.length ? mp.sectionOrder : sections.map(x => x.id)).map(id => byId.get(id)).filter(Boolean);
    for (const sec of order) {
        const group = sec.groupId ? groupById.get(sec.groupId) : null;
        if (group && group !== lastGroup) blocks.push(makeBlock({ name: group.name, marker: 'category', enabled: group.enabled !== false && !flag(group.enabled === 'false') }));
        lastGroup = group;
        const enabled = sec.enabled !== false && sec.enabled !== 'false';
        const base = {
            name: sec.name || 'Section',
            role: ['system', 'user', 'assistant'].includes(sec.role) ? sec.role : 'system',
            enabled,
            position: sec.injectionPosition === 'depth' ? 'in_history' : 'pre_history',
            depth: num(sec.injectionDepth, 4),
            injectionOrder: num(sec.injectionOrder, 100),
            forbidOverrides: flag(sec.forbidOverrides),
        };
        const markerType = flag(sec.isMarker) ? (typeof sec.markerConfig === 'string' ? JSON.parse(sec.markerConfig || '{}') : sec.markerConfig || {}).type : null;
        if (markerType === 'character') {
            for (const marker of ['char_description', 'char_personality', 'scenario']) blocks.push(makeBlock({ ...base, name: MARKER_NAMES[marker], marker }));
        } else if (markerType && MARINARA_MARKERS[markerType]) {
            for (const marker of MARINARA_MARKERS[markerType]) blocks.push(makeBlock({ ...base, name: MARKER_NAMES[marker] || base.name, marker }));
        } else if (markerType === 'chat_summary' || markerType === 'recalled_scenes') {
            blocks.push(makeBlock({ ...base, content: '{{memories}}' }));
        } else if (markerType) {
            blocks.push(makeBlock({ ...base, enabled: false, content: `[Marinara-only section: ${markerType}]` }));
        } else {
            const skip = flag(sec.skipWrap);
            blocks.push(makeBlock({ ...base, marker: sec.identifier === 'main' ? 'main_prompt' : null, content: skip ? withVars(sec.content) : wrapText(withVars(sec.content), sec.name) }));
        }
    }
    if (!blocks.some(b => b.marker === 'chat_history')) blocks.push(makeBlock({ name: MARKER_NAMES.chat_history, marker: 'chat_history' }));
    // Choice blocks → one options block with select variables.
    if (choiceBlocks.length) {
        const defaults = mp.defaultChoices || {};
        const variables = choiceBlocks.map(c => {
            const options = (c.options || []).map(o => ({ id: o.id || blockId(), label: o.label || o.value, value: o.value ?? '' }));
            const chosen = defaults[c.variableName];
            const pick = v => options.find(o => o.value === v || o.label === v || o.id === v)?.id;
            return c.multiSelect
                ? { id: c.id || blockId(), name: c.variableName, label: c.question || c.variableName, type: 'multiselect', options, separator: c.separator ?? ', ', defaultValue: (Array.isArray(chosen) ? chosen : chosen ? [chosen] : []).map(pick).filter(Boolean) }
                : { id: c.id || blockId(), name: c.variableName, label: c.question || c.variableName, type: 'select', options, defaultValue: pick(Array.isArray(chosen) ? chosen[0] : chosen) ?? options[0]?.id };
        });
        blocks.unshift(makeBlock({ name: 'Preset options', content: '', enabled: true, variables }));
    }
    const p = mp.parameters || {};
    const preset = normalizePreset({
        name: mp.name || fallbackName,
        source: 'marinara',
        description: mp.description || '',
        blocks,
        samplers: {
            ...DEFAULT_SAMPLERS,
            ...(Number.isFinite(p.temperature) ? { temperature: p.temperature } : {}),
            ...(Number.isFinite(p.topP) ? { top_p: p.topP } : {}),
            ...(Number.isFinite(p.maxTokens) ? { max_tokens: p.maxTokens } : {}),
            ...(Number.isFinite(p.maxContext) ? { context_size: p.maxContext } : {}),
        },
        meta: { author: mp.author || '' },
    });
    preset.raw = json;
    return preset;
}

// ---------------- Reverie (.rvpreset.json) ----------------
// A superset of the block format: conditional blocks (`when`), model profiles, metadata,
// prompt variables and bundled regex — everything travels in one file.
export function fromReverie(json, fallbackName) {
    const { format, formatVersion, exportedAt, id, created, updated, raw, ...rest } = json;
    if (formatVersion > 1) console.warn('[Reverie] This preset was made with a newer Reverie; some features may be ignored.');
    return normalizePreset({ ...rest, name: rest.name || fallbackName, source: 'reverie' });
}

export function toReverie(preset) {
    const { id, created, updated, raw, source, ...rest } = structuredClone(preset);
    return { format: REVERIE_PRESET_FORMAT, formatVersion: 1, exportedAt: new Date().toISOString(), ...rest };
}
