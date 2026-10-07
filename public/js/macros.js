// {{macro}} substitution compatible with SillyTavern and the Lumiverse additions ({{var::}}).
import { state, chatMetadata, currentPersona, charName, userName, saveSettingsDebounced } from './state.js';

const customMacros = new Map(); // name -> fn(args, env) registered by extensions

export function registerMacro(name, fn) {
    customMacros.set(String(name).toLowerCase(), typeof fn === 'function' ? fn : () => String(fn));
}
export function unregisterMacro(name) {
    customMacros.delete(String(name).toLowerCase());
}

// ---------- variables ----------
function localVars() {
    const meta = chatMetadata();
    meta.variables ??= {};
    return meta.variables;
}
function globalVars() {
    state.settings.variables ??= { global: {} };
    return state.settings.variables.global;
}
const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0);
function stringify(v) {
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

export const variables = {
    local: {
        get: k => stringify(localVars()[k]),
        set: (k, v) => { localVars()[k] = v; return ''; },
        del: k => { delete localVars()[k]; return ''; },
        has: k => k in localVars(),
        add: (k, v) => {
            const cur = localVars()[k];
            localVars()[k] = Number.isFinite(Number(cur)) && Number.isFinite(Number(v)) && cur !== '' ? num(cur) + num(v) : `${stringify(cur)}${v}`;
            return '';
        },
        inc: k => { localVars()[k] = num(localVars()[k]) + 1; return localVars()[k]; },
        dec: k => { localVars()[k] = num(localVars()[k]) - 1; return localVars()[k]; },
    },
    global: {
        get: k => stringify(globalVars()[k]),
        set: (k, v) => { globalVars()[k] = v; saveSettingsDebounced(); return ''; },
        del: k => { delete globalVars()[k]; saveSettingsDebounced(); return ''; },
        has: k => k in globalVars(),
        add: (k, v) => {
            const cur = globalVars()[k];
            globalVars()[k] = Number.isFinite(Number(cur)) && Number.isFinite(Number(v)) && cur !== '' ? num(cur) + num(v) : `${stringify(cur)}${v}`;
            saveSettingsDebounced();
            return '';
        },
        inc: k => { globalVars()[k] = num(globalVars()[k]) + 1; saveSettingsDebounced(); return globalVars()[k]; },
        dec: k => { globalVars()[k] = num(globalVars()[k]) - 1; saveSettingsDebounced(); return globalVars()[k]; },
    },
};

// ---------- helpers ----------
function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function splitList(args) {
    // {{random::a::b}} or {{random:a,b}}
    if (args.includes('::')) return args.split('::');
    return args.split(/(?<!\\),/).map(s => s.replace(/\\,/g, ','));
}

function roll(formula) {
    const m = String(formula).trim().match(/^(\d*)d(\d+)\s*([+-]\s*\d+)?$/i);
    if (!m) {
        const n = parseInt(formula, 10);
        return Number.isFinite(n) && n > 0 ? 1 + Math.floor(Math.random() * n) : '';
    }
    const count = Math.min(parseInt(m[1] || '1', 10), 100);
    const sides = parseInt(m[2], 10);
    let total = 0;
    for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
    return total + (m[3] ? parseInt(m[3].replace(/\s/g, ''), 10) : 0);
}

function lastBy(pred) {
    for (let i = state.chat.length - 1; i >= 0; i--) if (pred(state.chat[i])) return state.chat[i].mes ?? '';
    return '';
}

function idleDuration() {
    const last = [...state.chat].reverse().find(m => m.is_user);
    if (!last?.send_date) return 'just now';
    const diff = Date.now() - new Date(last.send_date).getTime();
    if (!Number.isFinite(diff)) return 'a while';
    const mins = Math.round(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins} minutes`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours} hour${hours > 1 ? 's' : ''}`;
    const days = Math.round(hours / 24);
    return `${days} day${days > 1 ? 's' : ''}`;
}

/** Resolve a preset prompt variable ({{var::name}}) from Lumiverse-style block variables. */
function presetVar(name, defaultsOnly = false) {
    const preset = state.preset;
    if (!preset) return '';
    for (const block of preset.blocks || []) {
        for (const def of block.variables || []) {
            if (def.name !== name) continue;
            const stored = defaultsOnly ? undefined : preset.promptVariables?.[block.id]?.[name];
            const value = stored ?? def.defaultValue;
            if (def.type === 'select') return def.options?.find(o => o.id === value)?.value ?? String(value ?? '');
            if (def.type === 'multiselect') {
                const ids = Array.isArray(value) ? value : [];
                return (def.options || []).filter(o => ids.includes(o.id)).map(o => o.value).join(def.separator ?? '\n\n');
            }
            return String(value ?? '');
        }
    }
    return '';
}

function presetVarIsOn(name, keys) {
    const preset = state.preset;
    for (const block of preset?.blocks || []) {
        const def = (block.variables || []).find(d => d.name === name);
        if (!def) continue;
        const value = preset.promptVariables?.[block.id]?.[name] ?? def.defaultValue;
        const ids = Array.isArray(value) ? value : [];
        return keys.every(k => ids.includes(k)) ? 'true' : 'false';
    }
    return 'false';
}

export function buildEnv(extra = {}) {
    const d = state.character?.card?.data ?? {};
    const persona = currentPersona();
    return {
        user: userName(),
        char: charName(),
        description: d.description ?? '',
        personality: d.personality ?? '',
        scenario: d.scenario ?? '',
        persona: persona.description ?? '',
        mesExamples: d.mes_example ?? '',
        mesExamplesRaw: d.mes_example ?? '',
        system: d.system_prompt ?? '',
        charPrompt: d.system_prompt ?? '',
        charInstruction: d.post_history_instructions ?? '',
        charJailbreak: d.post_history_instructions ?? '',
        charVersion: d.character_version ?? '',
        creatorNotes: d.creator_notes ?? '',
        firstMessage: d.first_mes ?? '',
        model: state.settings.connection.model ?? '',
        input: '',
        original: '',
        group: charName(),
        ...extra,
    };
}

function evaluate(name, args, env, raw) {
    const lower = name.toLowerCase();
    if (customMacros.has(lower)) {
        try { return stringify(customMacros.get(lower)(args, env)); } catch { return ''; }
    }
    const simple = {
        user: env.user, char: env.char, bot: env.char, description: env.description, personality: env.personality,
        scenario: env.scenario, persona: env.persona, mesexamples: env.mesExamples, mesexamplesraw: env.mesExamplesRaw,
        system: env.system, charprompt: env.charPrompt, charinstruction: env.charInstruction,
        charjailbreak: env.charJailbreak, charversion: env.charVersion, char_version: env.charVersion,
        creatornotes: env.creatorNotes, charfirstmessage: env.firstMessage, model: env.model, input: env.input,
        original: env.original, group: env.group, charifnotgroup: env.char, groupnotmuted: env.char,
        persona_description: env.persona, chardescription: env.description, charpersonality: env.personality,
        charscenario: env.scenario,
    };
    if (lower in simple && args === undefined) return stringify(simple[lower]);
    const now = new Date();
    switch (lower) {
        case 'newline': return '\n';
        case 'noop': return '';
        case 'trim': return '';
        case 'lastmessage': return lastBy(() => true);
        case 'lastusermessage': return lastBy(m => m.is_user);
        case 'lastcharmessage': return lastBy(m => !m.is_user && !m.is_system);
        case 'lastmessageid': return String(Math.max(0, state.chat.length - 1));
        case 'firstincludedmessageid': return '0';
        case 'currentswipeid': return String((state.chat.at(-1)?.swipe_id ?? 0) + 1);
        case 'lastswipeid': return String(state.chat.at(-1)?.swipes?.length ?? 1);
        case 'idle_duration': return idleDuration();
        case 'time': return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        case 'date': return now.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
        case 'weekday': return now.toLocaleDateString([], { weekday: 'long' });
        case 'isotime': return now.toTimeString().slice(0, 5);
        case 'isodate': return now.toISOString().slice(0, 10);
        case 'datetimeformat': return now.toLocaleString();
        case 'random': {
            if (!args) return String(Math.random());
            const list = splitList(args);
            return list[Math.floor(Math.random() * list.length)] ?? '';
        }
        case 'pick': {
            if (!args) return '';
            const list = splitList(args);
            const seed = hash(`${state.chatId}|${raw}|${env.pickOffset ?? ''}`);
            return list[seed % list.length] ?? '';
        }
        case 'roll': return String(roll(args ?? '1d6'));
        case 'reverse': return [...String(args ?? '')].reverse().join('');
        case 'upper': case 'uppercase': return String(args ?? '').toUpperCase();
        case 'lower': case 'lowercase': return String(args ?? '').toLowerCase();
        case 'banned': return '';
        case 'getvar': return variables.local.get(args);
        case 'getglobalvar': return variables.global.get(args);
        case 'hasvar': return String(variables.local.has(args));
        case 'hasglobalvar': return String(variables.global.has(args));
        case 'incvar': return stringify(variables.local.inc(args));
        case 'decvar': return stringify(variables.local.dec(args));
        case 'incglobalvar': return stringify(variables.global.inc(args));
        case 'decglobalvar': return stringify(variables.global.dec(args));
        case 'deletevar': case 'flushvar': return variables.local.del(args);
        case 'deleteglobalvar': case 'flushglobalvar': return variables.global.del(args);
        case 'setvar': case 'addvar': case 'setglobalvar': case 'addglobalvar': {
            const i = args?.indexOf('::') ?? -1;
            if (i < 0) return '';
            const key = args.slice(0, i);
            const value = args.slice(i + 2);
            if (lower === 'setvar') return variables.local.set(key, value);
            if (lower === 'addvar') return variables.local.add(key, value);
            if (lower === 'setglobalvar') return variables.global.set(key, value);
            return variables.global.add(key, value);
        }
        case 'var': {
            const parts = String(args ?? '').split('::');
            if (parts[1] === 'ison') return presetVarIsOn(parts[0], (parts[2] || '').split(',').map(s => s.trim()).filter(Boolean));
            if (variables.local.has(parts[0])) return variables.local.get(parts[0]);
            return presetVar(parts[0]);
        }
        case 'vardefault': return presetVar(args, true);
        default: return null;
    }
}

const FIELD_MACROS = new Set(['description', 'personality', 'scenario', 'persona', 'mesexamples', 'system', 'charprompt',
    'charinstruction', 'charjailbreak', 'chardescription', 'charpersonality', 'charscenario', 'persona_description', 'charfirstmessage', 'creatornotes']);

// Left-to-right evaluation; a macro's arguments are expanded before the macro itself runs,
// so {{setvar::x::{{user}}}}{{getvar::x}} works as written.
function expand(text, env, depth = 0) {
    if (depth > 20 || !text.includes('{{')) return text;
    let out = '';
    let i = 0;
    while (i < text.length) {
        const open = text.indexOf('{{', i);
        if (open < 0) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, open);
        // Find the matching close, honouring nesting.
        let level = 0;
        let j = open;
        let close = -1;
        while (j < text.length) {
            if (text.startsWith('{{', j)) { level++; j += 2; continue; }
            if (text.startsWith('}}', j)) {
                level--;
                if (level === 0) { close = j; break; }
                j += 2;
                continue;
            }
            j++;
        }
        if (close < 0) {
            out += text.slice(open);
            break;
        }
        const raw = text.slice(open, close + 2);
        const body = expand(text.slice(open + 2, close), env, depth + 1);
        const m = body.match(/^\s*([\w.\-]+)\s*(?:(::|:|\s)([\s\S]*))?$/);
        let value = m ? evaluate(m[1], m[3], env, raw) : null;
        // Card/persona fields can contain macros of their own ({{char}} inside a description).
        if (value && m && FIELD_MACROS.has(m[1].toLowerCase()) && value.includes('{{')) value = expand(value, env, depth + 1);
        out += value === null ? `{{${body}}}` : value;
        i = close + 2;
    }
    return out;
}

export function substituteParams(text, extra = {}) {
    if (text === undefined || text === null) return '';
    let out = String(text);
    if (!out.includes('{{') && !/<(USER|BOT|CHAR|CHARIFNOTGROUP)>/i.test(out)) return out;
    const env = buildEnv(extra);
    out = out.replace(/<USER>/gi, env.user).replace(/<(BOT|CHAR|CHARIFNOTGROUP)>/gi, env.char);
    // {{// comments}} disappear entirely, {{trim}} eats surrounding whitespace.
    out = out.replace(/\{\{\/\/[\s\S]*?\}\}/g, '');
    out = out.replace(/\s*\{\{trim\}\}\s*/gi, '');
    return expand(out, env);
}
