// {{macro}} substitution compatible with SillyTavern and the Lumiverse additions ({{var::}}).
import { state, chatMetadata, currentPersona, charName, userName, saveSettingsDebounced } from './state.js';
import { reasoningSettings } from './reasoning.js';

const customMacros = new Map(); // name -> fn(args, env) registered by extensions

// prompt.js imports this module, so it is loaded lazily (in the browser it is already in the module graph).
let promptModule = null;
if (typeof window !== 'undefined') import('./prompt.js').then(m => { promptModule = m; }).catch(() => {});

export function registerMacro(name, fn) {
    customMacros.set(String(name).toLowerCase(), typeof fn === 'function' ? fn : () => String(fn));
}
export function unregisterMacro(name) {
    customMacros.delete(String(name).toLowerCase());
}
/** Lumiverse feature macros ({{memories}}, {{memoriesRaw}}…) resolve to '' until a provider registers them here. */
export const registerMacroProvider = registerMacro;

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
const key = k => String(k ?? '').trim();

// ST addvar: a JSON array gets the value pushed (stored back as JSON), numbers add, anything else appends.
function addTo(store, k, v) {
    const cur = store[k];
    try {
        const arr = JSON.parse(stringify(cur));
        if (Array.isArray(arr)) { arr.push(v); store[k] = JSON.stringify(arr); return; }
    } catch { /* not an array */ }
    store[k] = Number.isFinite(Number(cur ?? 0)) && Number.isFinite(Number(v)) && cur !== '' ? num(cur) + num(v) : `${stringify(cur)}${v}`;
}

function scope(vars, save = () => {}) {
    return {
        get: k => stringify(vars()[key(k)]),
        set: (k, v) => { vars()[key(k)] = v; save(); return ''; },
        del: k => { delete vars()[key(k)]; save(); return ''; },
        has: k => key(k) in vars(),
        add: (k, v) => { addTo(vars(), key(k), v); save(); return ''; },
        inc: k => { const s = vars(); s[key(k)] = num(s[key(k)]) + 1; save(); return s[key(k)]; },
        dec: k => { const s = vars(); s[key(k)] = num(s[key(k)]) - 1; save(); return s[key(k)]; },
    };
}

export const variables = {
    local: scope(localVars),
    global: scope(globalVars, saveSettingsDebounced),
};

// ---------- helpers ----------
function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function splitList(args) {
    // {{random::a::b}} keeps items as written; {{random:a, b}} trims them (\, is a literal comma).
    if (args.includes('::')) return args.split('::');
    return args.split(/(?<!\\),/).map(s => s.replace(/\\,/g, ',').trim());
}

// Small seeded PRNG so {{pick}} is repeatable.
function seeded(seed) {
    let t = (seed + 0x6D2B79F5) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ST stores a hash of the chat id once, so picks survive renames and branches.
function chatIdHash() {
    const meta = chatMetadata();
    meta.chat_id_hash ??= hash(String(meta.main_chat ?? state.chatId ?? ''));
    return meta.chat_id_hash;
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

// ---------- dates ----------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Message timestamps come in several shapes: epoch numbers, ISO strings, ST's "September 3, 2023 4:21pm"
 * and "2023-09-03@16h21m05s(123ms)". Returns a Date, or null when unreadable.
 */
export function parseSendDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    const s = String(value).trim();
    if (typeof value === 'number' || /^\d+$/.test(s)) {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? new Date(n) : null;
    }
    let m = s.match(/^(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})\s?(am|pm)$/i);
    if (m) {
        const month = MONTHS.findIndex(x => x.slice(0, 3).toLowerCase() === m[1].slice(0, 3).toLowerCase());
        if (month >= 0) return new Date(Number(m[3]), month, Number(m[2]), (Number(m[4]) % 12) + (m[6].toLowerCase() === 'pm' ? 12 : 0), Number(m[5]));
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2}) ?@(\d{1,2})h ?(\d{1,2})m ?(\d{1,2})s(?: ?(\d{1,3})ms)?$/);
    if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7] || 0)));
    const t = Date.parse(s);
    return Number.isFinite(t) ? new Date(t) : null;
}

/** moment's duration.humanize(): 'a few seconds', '5 minutes', 'a day'… optionally 'in …' / '… ago'. */
export function humanizeDuration(ms, withSuffix = false) {
    const abs = Math.abs(ms);
    const days = abs / 86400000;
    const r = Math.round;
    const [sec, min, hrs, d, mon, yrs] = [r(abs / 1000), r(abs / 60000), r(abs / 3600000), r(days), r(days * 4800 / 146097), r(days * 400 / 146097)];
    const text = sec < 45 ? 'a few seconds'
        : min <= 1 ? 'a minute' : min < 45 ? `${min} minutes`
        : hrs <= 1 ? 'an hour' : hrs < 22 ? `${hrs} hours`
        : d <= 1 ? 'a day' : d < 26 ? `${d} days`
        : mon <= 1 ? 'a month' : mon < 11 ? `${mon} months`
        : yrs <= 1 ? 'a year' : `${yrs} years`;
    if (!withSuffix) return text;
    return ms >= 0 ? `in ${text}` : `${text} ago`;
}

const LONG_FORMATS = { LTS: 'h:mm:ss A', LT: 'h:mm A', LLLL: 'dddd, MMMM D, YYYY h:mm A', LLL: 'MMMM D, YYYY h:mm A', LL: 'MMMM D, YYYY', L: 'MM/DD/YYYY' };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

/** A moment.format() subset (English), for {{datetimeformat}} and {{time_UTC±N}}. */
export function formatMoment(date, format, utc = false) {
    const g = utc
        ? { Y: date.getUTCFullYear(), M: date.getUTCMonth(), D: date.getUTCDate(), d: date.getUTCDay(), H: date.getUTCHours(), m: date.getUTCMinutes(), s: date.getUTCSeconds(), ms: date.getUTCMilliseconds() }
        : { Y: date.getFullYear(), M: date.getMonth(), D: date.getDate(), d: date.getDay(), H: date.getHours(), m: date.getMinutes(), s: date.getSeconds(), ms: date.getMilliseconds() };
    const h12 = g.H % 12 || 12;
    const tokens = {
        YYYY: g.Y, YY: pad(g.Y % 100), MMMM: MONTHS[g.M], MMM: MONTHS[g.M].slice(0, 3), MM: pad(g.M + 1), M: g.M + 1,
        Do: ordinal(g.D), DD: pad(g.D), D: g.D, dddd: DAYS[g.d], ddd: DAYS[g.d].slice(0, 3), dd: DAYS[g.d].slice(0, 2), d: g.d,
        HH: pad(g.H), H: g.H, hh: pad(h12), h: h12, mm: pad(g.m), m: g.m, ss: pad(g.s), s: g.s, SSS: pad(g.ms, 3),
        A: g.H < 12 ? 'AM' : 'PM', a: g.H < 12 ? 'am' : 'pm',
    };
    return String(format).replace(/\[([^\]]*)\]|LTS|LT|LLLL|LLL|LL|L|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a/g,
        (tok, literal) => (literal !== undefined ? literal : tok in LONG_FORMATS ? formatMoment(date, LONG_FORMATS[tok], utc) : String(tokens[tok])));
}

// ST: time since the user's message before the newest one (the one being answered doesn't count).
function idleDuration() {
    let takeNext = false;
    for (let i = state.chat.length - 1; i >= 0; i--) {
        const m = state.chat[i];
        if (m.is_system) continue;
        if (m.is_user && takeNext) {
            const date = parseSendDate(m.send_date);
            return date ? humanizeDuration(Date.now() - date.getTime()) : 'just now';
        }
        takeNext = true;
    }
    return 'just now';
}

// ST's parseMesExamples for chat completion: every block starts with <START>, trimmed, one per line group.
function normalizeExamples(text) {
    let src = String(text ?? '');
    if (!src || src === '<START>') return '';
    if (!src.startsWith('<START>')) src = `<START>\n${src.trim()}`;
    return src.split(/<START>/gi).slice(1).map(block => `<START>\n${block.trim()}\n`).join('');
}

// ---------- conditions and arithmetic (Lumiverse semantics) ----------
const FALSY = new Set(['', '0', 'false', 'null', 'undefined', 'no', 'off']);
const truthy = v => !FALSY.has(String(v ?? '').trim().toLowerCase());

/** {{if}} condition: optional leading !, .local / $global shorthands, ==, !=, >=, <=, >, < (numeric when both sides are). */
export function evaluateCondition(condition) {
    let c = String(condition ?? '').trim();
    let negate = false;
    if (c.startsWith('!')) { negate = true; c = c.slice(1).trim(); }
    c = c.replace(/(^|\s)\.([a-zA-Z][\w-]*)/g, (_, pre, name) => pre + variables.local.get(name))
        .replace(/(^|\s)\$([a-zA-Z][\w-]*)/g, (_, pre, name) => pre + variables.global.get(name));
    let result;
    if (c.includes('{{') && c.includes('}}')) result = false; // an unresolved macro: can't tell, so false
    else {
        let best = null;
        for (const op of ['==', '!=', '>=', '<=', '>', '<']) {
            const at = c.indexOf(op);
            if (at >= 0 && (!best || at < best.at || (at === best.at && op.length > best.op.length))) best = { op, at };
        }
        if (best) {
            const lv = c.slice(0, best.at).trim();
            const rv = c.slice(best.at + best.op.length).trim();
            const [ln, rn] = [parseFloat(lv), parseFloat(rv)];
            const [a, b] = !Number.isNaN(ln) && !Number.isNaN(rn) ? [ln, rn] : [lv, rv];
            result = { '==': a === b, '!=': a !== b, '>=': a >= b, '<=': a <= b, '>': a > b, '<': a < b }[best.op];
        } else result = truthy(c);
    }
    return negate ? !result : result;
}

/** + - * / % and parentheses; no eval. Bad input gives 0, like Lumiverse. */
function calc(expr) {
    const src = String(expr ?? '').replace(/\s+/g, '');
    let pos = 0;
    let depth = 0;
    const fail = () => { throw new Error('calc'); };
    const exprP = () => {
        if (++depth > 100) fail();
        let left = term();
        while (src[pos] === '+' || src[pos] === '-') left = src[pos++] === '+' ? left + term() : left - term();
        depth--;
        return left;
    };
    const term = () => {
        let left = unary();
        while ('*/%'.includes(src[pos] || '_')) {
            const op = src[pos++];
            const r = unary();
            left = op === '*' ? left * r : r === 0 ? 0 : op === '/' ? left / r : left % r;
        }
        return left;
    };
    const unary = () => {
        if (src[pos] === '-') { pos++; return -unary(); }
        if (src[pos] === '+') { pos++; return unary(); }
        if (src[pos] === '(') {
            pos++;
            const v = exprP();
            if (src[pos++] !== ')') fail();
            return v;
        }
        const start = pos;
        while (/[0-9.]/.test(src[pos] || '')) pos++;
        const n = parseFloat(src.slice(start, pos));
        if (start === pos || Number.isNaN(n)) fail();
        return n;
    };
    try {
        if (!src) return '0';
        const v = exprP();
        if (pos !== src.length || !Number.isFinite(v)) return '0';
        return String(Number.isInteger(v) ? v : Math.round(v * 1e6) / 1e6);
    } catch {
        return '0';
    }
}

/** Splits macro arguments on top-level :: (not the :: inside nested macros). */
function splitArgs(text) {
    const parts = [];
    let level = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.startsWith('{{', i)) { level++; i++; } else if (text.startsWith('}}', i)) { level--; i++; } else if (level === 0 && text.startsWith('::', i)) {
            parts.push(text.slice(start, i));
            start = i + 2;
            i++;
        }
    }
    parts.push(text.slice(start));
    return parts;
}

// Prompt-size facts from the last real prompt build, falling back to the preset's samplers.
function promptFacts() {
    const last = promptModule?.lastPrompt?.() ?? {};
    const s = state.preset?.samplers ?? {};
    const context = last.contextSize || Number(state.settings.generation?.maxContextOverride) || Number(s.context_size) || 0;
    const response = last.maxResponse || Number(s.max_tokens) || 0;
    return { context, response, prompt: Math.max(0, context - response), firstIncluded: last.firstIncluded ?? 0, type: last.type ?? '' };
}

// Lumiverse feature macros Reverie doesn't have: resolve to nothing rather than leak into the prompt.
const LUMIVERSE_FEATURES = new Set(['memories', 'memoriesraw', 'entities', 'relationships', 'arc', 'memorysalience', 'databank',
    'lumiadef', 'lumiapersonality', 'lumiabehavior', 'lumiaquirks', 'lumiaooc', 'loomstyle', 'loomutils', 'loomretrofits',
    'loomsovhand', 'loomsummary', 'presetblock', 'persona_outlet', 'wi_marker', 'promptblockrole', 'promptblockposition', 'promptblockdepth']);

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

/** Chat variable if set, otherwise the preset's prompt variable (used by preset conditions). */
export function readVariable(name) {
    if (variables.local.has(name)) return variables.local.get(name);
    return presetVar(name);
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

// Lore from the prompt being built, for {{wiBefore}}, {{wiAfter}} and {{outlet::name}}.
let promptLore = { before: '', after: '', outlets: {} };
export function setPromptLore(lore) {
    promptLore = { before: lore?.before || '', after: lore?.after || '', outlets: lore?.outlets || {} };
}

export function buildEnv(extra = {}) {
    const d = state.character?.card?.data ?? {};
    const persona = currentPersona();
    const rs = reasoningSettings();
    return {
        user: userName(),
        char: charName(),
        description: d.description ?? '',
        personality: d.personality ?? '',
        // A chat can override the card's scenario.
        scenario: state.chatMeta?.chat_metadata?.scenario || d.scenario || '',
        persona: persona.description ?? '',
        charDepthPrompt: d.extensions?.depth_prompt?.prompt ?? '',
        wiBefore: promptLore.before,
        wiAfter: promptLore.after,
        mesExamples: normalizeExamples(d.mes_example),
        mesExamplesRaw: d.mes_example ?? '',
        system: d.system_prompt ?? '',
        charPrompt: d.system_prompt ?? '',
        charInstruction: d.post_history_instructions ?? '',
        charJailbreak: d.post_history_instructions ?? '',
        charVersion: d.character_version ?? '',
        creatorNotes: d.creator_notes ?? '',
        charTags: (Array.isArray(d.tags) ? d.tags : []).filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean),
        firstMessage: d.first_mes ?? '',
        model: state.settings.connection.model ?? '',
        input: globalThis.document?.getElementById('send_textarea')?.value ?? '',
        original: '',
        group: charName(),
        reasoningPrefix: rs.prefix || '<think>\n',
        reasoningSuffix: rs.suffix || '\n</think>',
        reasoningSeparator: rs.separator ?? '\n\n',
        ...extra,
    };
}

function evaluate(name, args, env, raw, offset = 0) {
    const lower = name.toLowerCase();
    if (customMacros.has(lower)) {
        try { return stringify(customMacros.get(lower)(args, env)); } catch { return ''; }
    }
    const simple = {
        user: env.user, char: env.char, bot: env.char, description: env.description, personality: env.personality,
        scenario: env.scenario, persona: env.persona, mesexamples: env.mesExamples, mesexamplesraw: env.mesExamplesRaw,
        system: env.system, charprompt: env.charPrompt, charinstruction: env.charInstruction,
        charjailbreak: env.charJailbreak, charversion: env.charVersion, char_version: env.charVersion,
        creatornotes: env.creatorNotes, charcreatornotes: env.creatorNotes, charfirstmessage: env.firstMessage, model: env.model, input: env.input,
        group: env.group, charifnotgroup: env.char, groupnotmuted: env.char, notchar: env.user,
        persona_description: env.persona, chardescription: env.description, charpersonality: env.personality,
        charscenario: env.scenario, chardepthprompt: env.charDepthPrompt, charposthistoryinstructions: env.charInstruction,
        wibefore: env.wiBefore, lorebefore: env.wiBefore, wiafter: env.wiAfter, loreafter: env.wiAfter,
        reasoningprefix: env.reasoningPrefix, reasoningsuffix: env.reasoningSuffix, reasoningseparator: env.reasoningSeparator,
    };
    if (lower in simple && args === undefined) return stringify(simple[lower]);
    if (LUMIVERSE_FEATURES.has(lower) || lower.startsWith('lumiacouncil')) return '';
    const now = new Date();
    const list = () => splitArgs(String(args ?? ''));
    switch (lower) {
        case 'newline': return '\n';
        case 'space': return ' ';
        case 'noop': return '';
        case 'trim': return '';
        case 'comment': case 'note': return '';
        // {{original}} expands once per substitution, like ST.
        case 'original': {
            if (env.__originalUsed) return '';
            env.__originalUsed = true;
            return stringify(env.original);
        }
        case 'lastmessage': return lastBy(() => true);
        case 'lastusermessage': return lastBy(m => m.is_user);
        case 'lastcharmessage': return lastBy(m => !m.is_user && !m.is_system);
        case 'lastmessageid': return String(Math.max(0, state.chat.length - 1));
        case 'firstincludedmessageid': return String(promptFacts().firstIncluded);
        case 'lastgenerationtype': return promptFacts().type;
        case 'maxprompt': case 'maxprompttokens': return String(promptFacts().prompt);
        case 'maxcontext': case 'maxcontexttokens': return String(promptFacts().context);
        case 'maxresponse': case 'maxresponsetokens': return String(promptFacts().response);
        case 'ismobile': return String(!!globalThis.matchMedia?.('(max-width: 820px)')?.matches);
        case 'currentswipeid': return String((state.chat.at(-1)?.swipe_id ?? 0) + 1);
        case 'lastswipeid': return String(state.chat.at(-1)?.swipes?.length ?? 1);
        case 'idle_duration': return idleDuration();
        case 'time': return now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        case 'date': return now.toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
        case 'weekday': return now.toLocaleDateString([], { weekday: 'long' });
        case 'isotime': return formatMoment(now, 'HH:mm');
        case 'isodate': return formatMoment(now, 'YYYY-MM-DD');
        case 'datetimeformat': return args === undefined ? now.toLocaleString() : formatMoment(now, args.replace(/^\s+/, ''));
        case 'timediff': {
            const [a, b] = list().map(parseSendDate);
            return a && b ? humanizeDuration(a.getTime() - b.getTime(), true) : '';
        }
        case 'random': {
            if (!args) return String(Math.random());
            const items = splitList(args);
            return items[Math.floor(Math.random() * items.length)] ?? '';
        }
        case 'pick': {
            // Same chat + same macro + same place → same pick; two identical picks elsewhere can differ.
            if (!args) return '';
            const items = splitList(args);
            const seed = hash(`${chatIdHash()}-${raw}-${offset}-${env.pickOffset ?? ''}`);
            return items[Math.floor(seeded(seed) * items.length)] ?? '';
        }
        case 'roll': return String(roll(args ?? '1d6'));
        case 'reverse': return [...String(args ?? '')].reverse().join('');
        case 'upper': case 'uppercase': return String(args ?? '').toUpperCase();
        case 'lower': case 'lowercase': return String(args ?? '').toLowerCase();
        case 'len': case 'length': return String(String(args ?? '').length);
        case 'replace': {
            // Lumiverse order: {{replace::find::with::text}}
            const [find = '', repl = '', text = ''] = list();
            return find ? text.split(find).join(repl) : text;
        }
        case 'chartags': return env.charTags.join(', ');
        case 'hastag': {
            const needle = String(args ?? '').trim().toLowerCase();
            return needle && env.charTags.some(t => t.toLowerCase() === needle) ? 'true' : '';
        }
        // Lumiverse logic helpers: 'true' or '' (so they compose with {{if}}).
        case 'eq': case 'ne': {
            const [a = '', b = ''] = list().map(x => x.trim());
            const [na, nb] = [parseFloat(a), parseFloat(b)];
            const same = !Number.isNaN(na) && !Number.isNaN(nb) ? na === nb : a === b;
            return same === (lower === 'eq') ? 'true' : '';
        }
        case 'gt': case 'lt': case 'gte': case 'lte': {
            const [a, b] = list().map(parseFloat);
            if (Number.isNaN(a) || Number.isNaN(b)) return '';
            return { gt: a > b, lt: a < b, gte: a >= b, lte: a <= b }[lower] ? 'true' : '';
        }
        case 'and': { const xs = list(); return args !== undefined && xs.every(truthy) ? 'true' : ''; }
        case 'or': return list().some(truthy) && args !== undefined ? 'true' : '';
        case 'not': return truthy(args) ? '' : 'true';
        case 'default': case 'fallback': case 'coalesce': {
            if (args === undefined) return '';
            const [a = '', b = ''] = list();
            return truthy(a) ? a : b;
        }
        case 'calc': case 'math': return calc(args);
        case 'if': return evaluateCondition(args) ? 'true' : '';
        case 'unless': return evaluateCondition(args) ? '' : 'true';
        case 'else': case 'elseif': case 'elif': case 'case': return '';
        case 'banned': return '';
        case 'getvar': case 'getchatvar': return variables.local.get(args);
        case 'getglobalvar': return variables.global.get(args);
        case 'hasvar': return String(variables.local.has(args));
        case 'hasglobalvar': return String(variables.global.has(args));
        case 'incvar': return stringify(variables.local.inc(args));
        case 'decvar': return stringify(variables.local.dec(args));
        case 'incglobalvar': return stringify(variables.global.inc(args));
        case 'decglobalvar': return stringify(variables.global.dec(args));
        case 'deletevar': case 'flushvar': return variables.local.del(args);
        case 'deleteglobalvar': case 'flushglobalvar': return variables.global.del(args);
        case 'setvar': case 'setchatvar': case 'addvar': case 'setglobalvar': case 'addglobalvar': {
            const i = args?.indexOf('::') ?? -1;
            if (i < 0) return '';
            const k = args.slice(0, i);
            const value = args.slice(i + 2);
            if (lower === 'setvar' || lower === 'setchatvar') return variables.local.set(k, value);
            if (lower === 'addvar') return variables.local.add(k, value);
            if (lower === 'setglobalvar') return variables.global.set(k, value);
            return variables.global.add(k, value);
        }
        case 'var': {
            const parts = String(args ?? '').split('::');
            const k = parts[0].trim();
            if (parts[1] === 'ison') return presetVarIsOn(k, (parts[2] || '').split(',').map(s => s.trim()).filter(Boolean));
            if (variables.local.has(k)) return variables.local.get(k);
            return presetVar(k);
        }
        case 'vardefault': return presetVar(String(args ?? '').trim(), true);
        case 'outlet': return promptLore.outlets[String(args ?? '').trim()] ?? '';
        default: return null;
    }
}

const FIELD_MACROS = new Set(['description', 'personality', 'scenario', 'persona', 'mesexamples', 'system', 'charprompt',
    'charinstruction', 'charjailbreak', 'chardescription', 'charpersonality', 'charscenario', 'persona_description', 'charfirstmessage', 'creatornotes', 'chardepthprompt']);

/** Next {{…}} at or after `from`, honouring nesting: { open, close } (close -1 when unclosed), or null. */
function nextMacro(text, from) {
    const open = text.indexOf('{{', from);
    if (open < 0) return null;
    let level = 0;
    for (let j = open; j < text.length;) {
        if (text.startsWith('{{', j)) { level++; j += 2; continue; }
        if (text.startsWith('}}', j)) {
            if (--level === 0) return { open, close: j };
            j += 2;
            continue;
        }
        j++;
    }
    return { open, close: -1 };
}

const macroName = body => (body.match(/^\s*(\/?)#?([\w.\-]+)/) || []).slice(1, 3).join('').toLowerCase();
const macroArgs = body => body.match(/^\s*\/?#?[\w.\-]+\s*(?:(?:::|:|\s)([\s\S]*))?$/)?.[1];
const BLOCKS = new Set(['if', 'unless', 'switch', 'escape']);
const SEPARATORS = { if: ['elseif', 'elif', 'else'], unless: ['else'], switch: ['case', 'default', '/case', '/default'], escape: [] };

/** For a block opener ending at `from`: the matching {{/kind}} and the top-level separators in between, or null. */
function findBlock(text, from, kind) {
    const marks = [];
    let level = 0;
    for (let pos = from; ;) {
        const tok = nextMacro(text, pos);
        if (!tok || tok.close < 0) return null;
        const body = text.slice(tok.open + 2, tok.close);
        const name = macroName(body);
        if (kind !== 'escape' && BLOCKS.has(name) && name !== 'escape') level++;
        else if (name === `/${kind}` && level === 0) return { end: tok.open, after: tok.close + 2, marks };
        else if (kind !== 'escape' && level > 0 && name.startsWith('/') && BLOCKS.has(name.slice(1))) level--;
        else if (level === 0 && SEPARATORS[kind].includes(name)) marks.push({ name, args: macroArgs(body), open: tok.open, after: tok.close + 2 });
        pos = tok.close + 2;
    }
}

// Lumiverse scoped blocks: only the chosen branch is expanded, so macros in the others never run.
function runBlock(kind, args, text, start, block, env, depth, base, top) {
    const sub = (from, to) => expand(text.slice(from, to), env, depth + 1, base + from, top);
    const ends = [...block.marks.map(m => m.open), block.end];
    if (kind === 'escape') return text.slice(start, block.end);
    const cond = a => evaluateCondition(expand(String(a ?? ''), env, depth + 1, base, false));
    if (kind === 'if') {
        if (cond(args)) return sub(start, ends[0]);
        for (let k = 0; k < block.marks.length; k++) {
            const mark = block.marks[k];
            if (mark.name === 'else' || cond(mark.args)) return sub(mark.after, ends[k + 1]);
        }
        return '';
    }
    if (kind === 'unless') {
        const elseMark = block.marks[0];
        if (!cond(args)) return sub(start, elseMark ? elseMark.open : block.end);
        return elseMark ? sub(elseMark.after, block.end) : '';
    }
    // switch: {{case::a::b}} matches any listed value; {{default}} if none does.
    const value = expand(String(args ?? ''), env, depth + 1, base, false).trim();
    let fallback = null;
    for (let k = 0; k < block.marks.length; k++) {
        const mark = block.marks[k];
        if (mark.name === 'default') fallback ??= k;
        if (mark.name === 'case' && splitArgs(mark.args ?? '').some(v => expand(v, env, depth + 1, base, false).trim() === value)) return sub(mark.after, ends[k + 1]);
    }
    return fallback === null ? '' : sub(block.marks[fallback].after, ends[fallback + 1]);
}

// Left-to-right evaluation; a macro's arguments are expanded before the macro itself runs,
// so {{setvar::x::{{user}}}}{{getvar::x}} works as written. `base` is this text's offset in the original
// (for {{pick}}); `top` marks text at the outer level, whose macro values get env.sanitize (escaped regex).
function expand(text, env, depth = 0, base = 0, top = true) {
    if (depth > 20 || !text.includes('{{')) return text;
    const finish = v => (top && env.sanitize ? env.sanitize(v) : v);
    let out = '';
    let i = 0;
    while (i < text.length) {
        const tok = nextMacro(text, i);
        if (!tok) {
            out += text.slice(i);
            break;
        }
        out += text.slice(i, tok.open);
        if (tok.close < 0) {
            out += text.slice(tok.open);
            break;
        }
        const { open, close } = tok;
        const rawBody = text.slice(open + 2, close);
        i = close + 2;
        // {{// comment}} vanishes whole, nested macros and all.
        if (rawBody.trimStart().startsWith('//')) continue;
        const name = macroName(rawBody);
        if (name === 'comment' || name === 'note') continue;
        if (BLOCKS.has(name)) {
            const block = name === 'escape' && macroArgs(rawBody) !== undefined ? null : findBlock(text, i, name);
            if (block) {
                // Values inside the chosen branch were already sanitized as they expanded.
                out += runBlock(name, macroArgs(rawBody), text, i, block, env, depth, base, top);
                i = block.after;
                continue;
            }
            // {{escape::text}} emits its argument without running the macros in it.
            if (name === 'escape') { out += macroArgs(rawBody) ?? ''; continue; }
        }
        if (name.startsWith('/') && BLOCKS.has(name.slice(1))) continue; // a stray block close
        if (name === 'switch') { out += finish(inlineSwitch(macroArgs(rawBody), env, depth, base)); continue; }
        const body = expand(rawBody, env, depth + 1, base + open + 2, false);
        const utc = body.match(/^\s*time_utc([-+]\d+)\s*$/i);
        let value;
        if (utc) {
            // moment's utcOffset(): small numbers are hours, bigger ones minutes.
            const n = parseInt(utc[1], 10);
            value = formatMoment(new Date(Date.now() + (Math.abs(n) < 16 ? n * 60 : n) * 60000), 'LT', true);
        } else {
            const m = body.match(/^\s*([\w.\-]+)\s*(?:(::|:|\s)([\s\S]*))?$/);
            value = m ? evaluate(m[1], m[3], env, text.slice(open, close + 2), base + open) : null;
            // Card/persona fields can contain macros of their own ({{char}} inside a description).
            if (value && m && FIELD_MACROS.has(m[1].toLowerCase()) && value.includes('{{')) value = expand(value, env, depth + 1, 0, false);
        }
        out += value === null ? `{{${body}}}` : finish(value);
    }
    return out;
}

// {{switch::value::case1::result1::case2::result2::default}}: only the chosen result is expanded.
function inlineSwitch(args, env, depth, base) {
    const parts = splitArgs(String(args ?? ''));
    const run = t => expand(t ?? '', env, depth + 1, base, false);
    const value = run(parts[0]).trim();
    for (let k = 1; k + 1 < parts.length; k += 2) if (run(parts[k]).trim() === value) return run(parts[k + 1]);
    return (parts.length - 1) % 2 === 1 ? run(parts.at(-1)) : '';
}

/**
 * @param {string} text
 * @param {object} extra values that override the environment (e.g. { original })
 * @param {{ sanitize?: (value: string) => string }} opts sanitize: applied to every substituted value
 *   (regex "Escaped" mode passes a regex escaper), including <USER>/<BOT>.
 */
export function substituteParams(text, extra = {}, { sanitize } = {}) {
    if (text === undefined || text === null) return '';
    let out = String(text);
    if (!out.includes('{{') && !/<(USER|BOT|CHAR|CHARIFNOTGROUP)>/i.test(out)) return out;
    const env = buildEnv(extra);
    env.sanitize = sanitize;
    const fix = v => (sanitize ? sanitize(v) : v);
    out = out.replace(/<USER>/gi, () => fix(env.user)).replace(/<(BOT|CHAR|CHARIFNOTGROUP)>/gi, () => fix(env.char));
    // {{trim}} eats the newlines right around it (ST).
    out = out.replace(/(?:\r?\n)*\{\{trim\}\}(?:\r?\n)*/gi, '');
    return expand(out, env);
}
