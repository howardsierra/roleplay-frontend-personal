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

// ---------------------------------------------------------------- permission (ST's allowed-regex lists)
// Scripts that come inside a character card or a preset only run once you've allowed them for that card or
// preset; you're asked the first time one is opened. Your global scripts always run.
export function regexConsent() {
    state.settings.regexConsent ??= { characters: {}, presets: {} };
    state.settings.regexConsent.characters ??= {};
    state.settings.regexConsent.presets ??= {};
    return state.settings.regexConsent;
}
const usable = list => (Array.isArray(list) ? list.filter(s => s && s.findRegex) : []);
export const characterScripts = (character = state.character) => usable(character?.card?.data?.extensions?.regex_scripts);
export const presetScripts = (preset = state.preset) => usable(preset?.regex);

/** 'allowed' | 'blocked' | 'ask' for the current character's or preset's own scripts. */
export function regexPermission(kind, id) {
    const v = regexConsent()[kind === 'preset' ? 'presets' : 'characters'][id];
    return v === true ? 'allowed' : v === false ? 'blocked' : 'ask';
}
export function setRegexPermission(kind, id, allowed) {
    regexConsent()[kind === 'preset' ? 'presets' : 'characters'][id] = !!allowed;
    import('./state.js').then(m => m.saveSettingsDebounced());
}

const asking = new Set();
/**
 * Asks once whether a character's (or preset's) bundled regex scripts may run. Resolves true when they may.
 * @param {'character'|'preset'} kind
 */
export async function askRegexPermission(kind, { id, name, scripts }) {
    if (!id || !scripts?.length) return false;
    const now = regexPermission(kind, id);
    if (now !== 'ask') return now === 'allowed';
    if (asking.has(`${kind}:${id}`)) return false;
    asking.add(`${kind}:${id}`);
    try {
        const { el, modal } = await import('./ui.js');
        const what = kind === 'preset' ? `The preset “${name}”` : `The character “${name}”`;
        const allowed = await modal({
            title: 'Allow regex scripts?',
            content: el('div', { class: 'stack' },
                el('p', {}, `${what} comes with ${scripts.length} regex script${scripts.length === 1 ? '' : 's'}. They can change how messages look, what's sent to the AI and what's saved in the chat.`),
                el('ul', { class: 'regex-consent-list' }, scripts.slice(0, 12).map(s => el('li', {}, el('b', {}, s.scriptName || 'Untitled'), el('code', {}, ` ${String(s.findRegex).slice(0, 80)}`)))),
                scripts.length > 12 ? el('p', { class: 'hint' }, `…and ${scripts.length - 12} more.`) : null,
                el('p', { class: 'hint' }, 'You can change this later in Settings → Regex.')),
            buttons: [{ label: 'Don\'t allow', value: false }, { label: 'Allow', value: true, primary: true, icon: 'check' }],
            dismissable: false,
        });
        // Closing the box decides nothing: you'll be asked again next time.
        if (allowed === null || allowed === undefined) return false;
        setRegexPermission(kind, id, !!allowed);
        return !!allowed;
    } finally {
        asking.delete(`${kind}:${id}`);
    }
}

export function allScripts() {
    const scripts = [...(state.settings.regex || [])];
    if (state.preset?.id && regexPermission('preset', state.preset.id) === 'allowed') scripts.push(...presetScripts());
    if (state.character?.id && regexPermission('character', state.character.id) === 'allowed') scripts.push(...characterScripts());
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
