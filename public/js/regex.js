// SillyTavern-compatible regex scripts (global, preset-bound, and character-scoped).
import { state } from './state.js';
import { substituteParams } from './macros.js';

export const REGEX_PLACEMENT = { MD_DISPLAY: 0, USER_INPUT: 1, AI_OUTPUT: 2, SLASH_COMMAND: 3, WORLD_INFO: 5, REASONING: 6 };
export const SUBSTITUTE = { NONE: 0, RAW: 1, ESCAPED: 2 };

export function newScript(partial = {}) {
    return {
        id: crypto.randomUUID(),
        scriptName: 'New script',
        findRegex: '',
        replaceString: '',
        trimStrings: [],
        placement: [REGEX_PLACEMENT.AI_OUTPUT],
        disabled: false,
        markdownOnly: false,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: SUBSTITUTE.NONE,
        minDepth: null,
        maxDepth: null,
        ...partial,
    };
}

export function parseRegex(input) {
    const m = String(input).match(/^\/([\s\S]+)\/([dgimsuyv]*)$/);
    try {
        return m ? new RegExp(m[1], m[2]) : new RegExp(String(input));
    } catch {
        return null;
    }
}

function escapeRx(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function allScripts() {
    const scripts = [...(state.settings.regex || [])];
    if (state.preset?.regex?.length) scripts.push(...state.preset.regex);
    if (state.settings.allowCharacterRegex) {
        const own = state.character?.card?.data?.extensions?.regex_scripts;
        if (Array.isArray(own)) scripts.push(...own);
    }
    return scripts.filter(s => s && !s.disabled && s.findRegex);
}

export function runScript(script, text) {
    if (!text) return text;
    let pattern = script.findRegex;
    if (Number(script.substituteRegex) === SUBSTITUTE.RAW) pattern = substituteParams(pattern);
    else if (Number(script.substituteRegex) === SUBSTITUTE.ESCAPED) pattern = pattern.replace(/\{\{[\s\S]*?\}\}/g, m => escapeRx(substituteParams(m)));
    const rx = parseRegex(pattern);
    if (!rx) return text;
    return text.replace(rx, (...args) => {
        const hasGroups = typeof args.at(-1) === 'object';
        const groups = args.slice(0, hasGroups ? -3 : -2);
        let match = groups[0];
        for (const trim of script.trimStrings || []) match = match.split(substituteParams(trim)).join('');
        let out = String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, '$0');
        out = out.replace(/\$(\d+)|\$<([^>]+)>/g, (_, idx, name) => {
            if (name) return (hasGroups ? args.at(-1)?.[name] : '') ?? '';
            const i = Number(idx);
            if (i === 0) return match;
            return groups[i] ?? '';
        });
        return substituteParams(out);
    });
}

/**
 * @param {string} text
 * @param {number} placement REGEX_PLACEMENT value
 * @param {{ isMarkdown?: boolean, isPrompt?: boolean, isEdit?: boolean, depth?: number }} opts
 */
export function applyRegex(text, placement, { isMarkdown = false, isPrompt = false, isEdit = false, depth } = {}) {
    if (typeof text !== 'string' || !text) return text;
    let out = text;
    for (const script of allScripts()) {
        if (!(script.placement || []).map(Number).includes(placement)) continue;
        // ST semantics: markdownOnly → display only; promptOnly → outgoing prompt only; neither → baked into the message.
        if (script.markdownOnly && !isMarkdown) continue;
        if (script.promptOnly && !isPrompt) continue;
        if (!script.markdownOnly && !script.promptOnly && (isMarkdown || isPrompt)) continue;
        if (isEdit && script.runOnEdit === false) continue;
        if (depth !== undefined && depth !== null) {
            const min = script.minDepth ?? -1;
            const max = script.maxDepth ?? -1;
            if (min >= 0 && depth < min) continue;
            if (max >= 0 && depth > max) continue;
        }
        out = runScript(script, out);
    }
    return out;
}
