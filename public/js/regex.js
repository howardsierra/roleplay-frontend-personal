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
    const src = String(input);
    const m = src.match(/^\/([\s\S]+)\/([a-z]*)$/i);
    try {
        if (!m) return new RegExp(src);
        // ST accepts PCRE-style flags (x, X, U, A, J…): keep the ones JS knows, once each, and drop the rest.
        const flags = [...new Set(m[2])].filter(f => 'dgimsuyv'.includes(f)).filter(f => f !== 'v' || !m[2].includes('u')).join('');
        return new RegExp(m[1], flags);
    } catch {
        // Like ST's regexFromString: a pattern that won't compile with its flags is tried as one whole string.
        try { return new RegExp(src); } catch { return null; }
    }
}

// ST's sanitizeRegexMacro: a macro's value used inside a pattern matches itself literally.
function escapeRx(s) {
    return String(s).replace(/[\n\r\t\v\f\0.^$*+?{}[\]\\/|()]/g, c => ({ '\n': '\\n', '\r': '\\r', '\t': '\\t', '\v': '\\v', '\f': '\\f', '\0': '\\0' })[c] ?? `\\${c}`);
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
    else if (Number(script.substituteRegex) === SUBSTITUTE.ESCAPED) pattern = substituteParams(pattern, {}, { sanitize: escapeRx });
    const rx = parseRegex(pattern);
    if (!rx) return text;
    const trims = (script.trimStrings || []).map(t => substituteParams(t)).filter(Boolean);
    return text.replace(rx, (...args) => {
        const hasGroups = typeof args.at(-1) === 'object';
        const groups = args.slice(0, hasGroups ? -3 : -2);
        let out = String(script.replaceString ?? '').replace(/\{\{match\}\}/gi, '$0');
        // Every substituted capture ($0, $1, $<name>) has the trim strings removed, as in ST.
        out = out.replace(/\$(\d+)|\$<([^>]+)>/g, (_, idx, name) => {
            let value = name ? (hasGroups ? args.at(-1)?.[name] : '') : groups[Number(idx)];
            if (!value) return '';
            for (const trim of trims) value = value.split(trim).join('');
            return value;
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
        // ST semantics: "Alter chat display" (markdownOnly) runs when showing a message, "Alter outgoing prompt"
        // (promptOnly) when sending history; both ticked → both places; neither → baked into the saved message.
        if (script.markdownOnly || script.promptOnly) {
            if (!((script.markdownOnly && isMarkdown) || (script.promptOnly && isPrompt))) continue;
        } else if (isMarkdown || isPrompt) continue;
        if (isEdit && !script.runOnEdit) continue;
        if (typeof depth === 'number') {
            // ST: minDepth -1 is meaningful (a continued reply sits at depth -1); maxDepth starts at 0.
            const min = script.minDepth === null || script.minDepth === '' ? NaN : Number(script.minDepth);
            const max = script.maxDepth === null || script.maxDepth === '' ? NaN : Number(script.maxDepth);
            if (min >= -1 && depth < min) continue;
            if (max >= 0 && depth > max) continue;
        }
        out = runScript(script, out);
    }
    return out;
}
