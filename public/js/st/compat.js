// SillyTavern compatibility layer: getContext(), the module shim registry that extension
// imports resolve against, slash commands, popups, toastr and a few jQuery plugin stubs.
import { state, saveSettingsDebounced, saveSettings, saveChat, chatMetadata, charName, userName, currentPersona } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { substituteParams, registerMacro, unregisterMacro, variables } from '../macros.js';
import { setExtensionPrompt, extensionPrompts, extension_prompt_types, extension_prompt_roles, estimateTokens } from '../prompt.js';
import {
    addOneMessage, updateMessageBlock, printMessages, clearChat, generate, generateQuietPrompt, generateRaw,
    stopGeneration, sendMessage, sendSystemMessage, deleteMessage, scrollToBottom, swipeLeft, swipeRight, swipeTo,
} from '../chat.js';
import { formatMessage, renderToHtml } from '../render.js';
import { loadWorld, saveWorld } from '../worldinfo.js';
import { api } from '../api.js';
import { toastr, modal, el, escapeHtml, debounce, isMobile, toast } from '../ui.js';
import DOMPurify from '../../vendor/purify.js';
import {
    ConnectionManagerRequestService, ChatCompletionService, TextCompletionService, personaMaps, getUserAvatar, getUserAvatars,
    setUserAvatar, setPersonaDescription, getThumbnailUrl, getPastCharacterChats, sendMessageAsUser, extractTextFromHTML, escapeRegex,
    regexFromString, isDataURL, trimToStartSentence, bufferToBase64, saveBase64AsFile, isFirefox, currentUserAvatar,
} from './apis.js';
import { dragElement } from './dom.js';
export { installStDom } from './dom.js';

// ---------------------------------------------------------------------------
// Popups (Popup / callGenericPopup / callPopup)
// ---------------------------------------------------------------------------
export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };

export class Popup {
    constructor(content, type = POPUP_TYPE.TEXT, inputValue = '', options = {}) {
        this.content = content;
        this.type = type;
        this.inputValue = inputValue;
        this.options = options;
        this.dlg = document.createElement('div');
        this.result = undefined;
        this.value = undefined;
    }

    async show() {
        const body = el('div', { class: 'stack st-popup' });
        if (this.content instanceof Node) body.append(this.content);
        else if (this.content && typeof this.content === 'object' && this.content.jquery) body.append(...this.content.toArray());
        else body.innerHTML = String(this.content ?? '');
        let input = null;
        if (this.type === POPUP_TYPE.INPUT) {
            input = el(this.options.rows > 1 ? 'textarea' : 'input', { class: 'input', rows: this.options.rows || 1 });
            input.value = this.inputValue ?? '';
            body.append(input);
        }
        const ok = this.options.okButton === false ? null : (typeof this.options.okButton === 'string' ? this.options.okButton : 'OK');
        const cancel = this.type === POPUP_TYPE.TEXT || this.type === POPUP_TYPE.DISPLAY
            ? null
            : (typeof this.options.cancelButton === 'string' ? this.options.cancelButton : (this.options.cancelButton === false ? null : 'Cancel'));
        const buttons = [];
        for (const custom of this.options.customButtons || []) {
            const b = typeof custom === 'string' ? { text: custom, result: buttons.length + 2 } : custom;
            buttons.push({ label: b.text, value: b.result ?? POPUP_RESULT.AFFIRMATIVE });
        }
        if (cancel) buttons.push({ label: cancel, value: POPUP_RESULT.NEGATIVE });
        if (ok && this.type !== POPUP_TYPE.DISPLAY) buttons.push({ label: ok, value: POPUP_RESULT.AFFIRMATIVE, primary: true });
        this.dlg = body;
        await this.options.onOpen?.(this);
        const result = await modal({ content: body, buttons, wide: !!(this.options.wide || this.options.large), title: this.options.title || '' });
        this.result = result ?? POPUP_RESULT.CANCELLED;
        if (this.type === POPUP_TYPE.INPUT) this.value = this.result === POPUP_RESULT.AFFIRMATIVE ? input.value : (this.result === POPUP_RESULT.NEGATIVE ? false : null);
        else this.value = this.result;
        await this.options.onClose?.(this);
        return this.value;
    }

    async complete(result) {
        this.result = result;
        document.querySelector('.modal-wrap.open:last-child .modal-head .icon-btn')?.click();
    }

    static show = {
        input: (header, text, defaultValue = '', options = {}) => new Popup(`${header ? `<h3>${header}</h3>` : ''}${text ?? ''}`, POPUP_TYPE.INPUT, defaultValue, options).show(),
        confirm: (header, text, options = {}) => new Popup(`${header ? `<h3>${header}</h3>` : ''}${text ?? ''}`, POPUP_TYPE.CONFIRM, '', options).show(),
        text: (header, text, options = {}) => new Popup(`${header ? `<h3>${header}</h3>` : ''}${text ?? ''}`, POPUP_TYPE.TEXT, '', options).show(),
    };
}

export function callGenericPopup(content, type = POPUP_TYPE.TEXT, inputValue = '', options = {}) {
    return new Popup(content, type, inputValue, options).show();
}

export async function callPopup(text, type = 'text', inputValue = '', { okButton, rows, wide, large } = {}) {
    const map = { text: POPUP_TYPE.TEXT, confirm: POPUP_TYPE.CONFIRM, input: POPUP_TYPE.INPUT, alternate_greeting: POPUP_TYPE.TEXT, avatar_to_crop: POPUP_TYPE.TEXT };
    const value = await callGenericPopup(text, map[type] ?? POPUP_TYPE.TEXT, inputValue, { okButton, rows, wide, large });
    if (type === 'confirm') return value === POPUP_RESULT.AFFIRMATIVE;
    return value;
}

// ---------------------------------------------------------------------------
// Slash commands (a compact STscript subset: pipes, named args, {{pipe}})
// ---------------------------------------------------------------------------
export const ARGUMENT_TYPE = { STRING: 'string', NUMBER: 'number', RANGE: 'range', BOOLEAN: 'bool', VARIABLE_NAME: 'varname', CLOSURE: 'closure', SUBCOMMAND: 'subcommand', LIST: 'list', DICTIONARY: 'dictionary' };

export class SlashCommandArgument {
    static fromProps(props) { return Object.assign(new SlashCommandArgument(), props); }
    constructor(description, typeList, isRequired, acceptsMultiple, defaultValue, enumList) {
        Object.assign(this, { description, typeList, isRequired, acceptsMultiple, defaultValue, enumList });
    }
}
export class SlashCommandNamedArgument extends SlashCommandArgument {
    static fromProps(props) { return Object.assign(new SlashCommandNamedArgument(), props); }
    constructor(name, description, typeList, isRequired, acceptsMultiple, defaultValue, enumList) {
        super(description, typeList, isRequired, acceptsMultiple, defaultValue, enumList);
        this.name = name;
    }
}
export class SlashCommandEnumValue {
    constructor(value, description, type, typeIcon) { Object.assign(this, { value, description, type, typeIcon }); }
}
export class SlashCommand {
    static fromProps(props) { return Object.assign(new SlashCommand(), props); }
    constructor() {
        this.name = '';
        this.callback = null;
        this.helpString = '';
        this.aliases = [];
        this.namedArgumentList = [];
        this.unnamedArgumentList = [];
    }
}

const commands = new Map();
export const SlashCommandParser = {
    commands: Object.create(null),
    addCommandObject(cmd) {
        commands.set(cmd.name.toLowerCase(), cmd);
        this.commands[cmd.name] = cmd;
        for (const alias of cmd.aliases || []) {
            commands.set(String(alias).toLowerCase(), cmd);
            this.commands[alias] = cmd;
        }
    },
    removeCommand(name) {
        commands.delete(String(name).toLowerCase());
        delete this.commands[name];
    },
    addCommand(name, callback, aliases = [], helpString = '') {
        this.addCommandObject(SlashCommand.fromProps({ name, callback, aliases, helpString }));
    },
};

export function registerSlashCommand(name, callback, aliases = [], helpString = '') {
    SlashCommandParser.addCommand(name, callback, aliases, helpString);
}

function splitTopLevel(text, sep) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\' && text[i + 1] === sep) { cur += sep; i++; continue; }
        if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
        if (ch === '"') { quote = ch; cur += ch; continue; }
        if (ch === '{' && text[i + 1] === ':') depth++;
        if (ch === ':' && text[i + 1] === '}') depth = Math.max(0, depth - 1);
        if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
        cur += ch;
    }
    parts.push(cur);
    return parts;
}

function parseArgs(rest) {
    const named = {};
    let s = rest.trim();
    const rx = /^([\w-]+)=("(?:[^"\\]|\\.)*"|\{:[\s\S]*?:\}|\S+)\s*/;
    let m;
    while ((m = s.match(rx))) {
        let v = m[2];
        if (v.startsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
        named[m[1]] = v;
        s = s.slice(m[0].length);
    }
    return { named, unnamed: s };
}

const RETURN = Symbol('return');
const isClosure = v => typeof v === 'string' && /^\{:[\s\S]*:\}$/.test(v.trim());
const closureBody = v => v.trim().slice(2, -2);

/** Run a closure argument ({: ... :}) and return its pipe value. */
export async function runClosure(value, pipe = '') {
    if (!isClosure(value)) return value;
    return (await executeSlashCommands(closureBody(value), { pipe })).pipe;
}

export async function executeSlashCommands(text, { pipe = '' } = {}) {
    let value = pipe;
    const script = String(text ?? '').trim();
    if (!script.startsWith('/')) return { pipe: script, isError: false };
    for (const raw of splitTopLevel(script, '|')) {
        const piece = raw.trim();
        if (!piece || piece.startsWith('//') || piece.startsWith('#')) continue; // comments
        const m = piece.match(/^\/(\S+)\s*([\s\S]*)$/);
        if (!m) { value = substituteParams(piece, { pipe: value }); continue; }
        const cmd = commands.get(m[1].toLowerCase());
        if (!cmd) {
            toast(`Unknown command /${m[1]}`, 'warning');
            console.warn(`[Reverie] Unknown slash command /${m[1]}`);
            return { pipe: value, isError: true, errorMessage: `Unknown command /${m[1]}` };
        }
        const withPipe = m[2].replace(/\{\{pipe\}\}/gi, String(value ?? ''));
        const { named, unnamed } = parseArgs(withPipe);
        for (const k of Object.keys(named)) if (!isClosure(named[k])) named[k] = substituteParams(named[k]);
        let arg = isClosure(unnamed) ? unnamed.trim() : substituteParams(unnamed);
        if (!arg && value !== undefined && value !== '') arg = String(value);
        try {
            const out = await cmd.callback(named, arg);
            if (out && typeof out === 'object' && out[RETURN]) return { pipe: String(out.value ?? ''), isError: false };
            value = out === undefined || out === null ? '' : out;
        } catch (err) {
            console.error(err);
            toast(`/${m[1]}: ${err.message}`, 'error');
            return { pipe: value, isError: true, errorMessage: err.message };
        }
    }
    return { pipe: typeof value === 'string' ? value : JSON.stringify(value), isError: false };
}

export const executeSlashCommandsWithOptions = (text, options = {}) => executeSlashCommands(text, options);

const SAMPLER_NAMES = {
    temperature: 'temperature', temp: 'temperature', top_p: 'top_p', top_k: 'top_k', min_p: 'min_p', top_a: 'top_a',
    frequency_penalty: 'frequency_penalty', freq_pen: 'frequency_penalty', presence_penalty: 'presence_penalty', pres_pen: 'presence_penalty',
    repetition_penalty: 'repetition_penalty', rep_pen: 'repetition_penalty', max_tokens: 'max_tokens', amount_gen: 'max_tokens',
    response_length: 'max_tokens', context_size: 'context_size', max_context: 'context_size', seed: 'seed',
};

/**
 * Commands Reverie implements natively that would otherwise be taken over by extensions which scrape
 * SillyTavern's own settings panels (e.g. Sampler Commands). Registered after extensions load.
 */
export function registerNativeOverrides() {
    const resolveName = raw => SAMPLER_NAMES[String(raw || '').trim().toLowerCase().replace(/[\s-]+/g, '_')];
    SlashCommandParser.addCommand('sampler-get', async args => {
        const key = resolveName(args.name);
        if (!key) throw new Error(`Unknown sampler "${args.name}". Try: ${[...new Set(Object.values(SAMPLER_NAMES))].join(', ')}`);
        return String(state.preset.samplers[key] ?? '');
    }, [], 'Get a sampler value: /sampler-get name=temperature');
    SlashCommandParser.addCommand('sampler-set', async (args, value) => {
        const key = resolveName(args.name);
        if (!key) throw new Error(`Unknown sampler "${args.name}"`);
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error('Value must be a number');
        state.preset.samplers[key] = n;
        (await import('../preset-store.js')).savePresetDebounced();
        await eventSource.emit(event_types.SETTINGS_UPDATED);
        return '';
    }, [], 'Set a sampler value: /sampler-set name=temperature 0.9');
}

function registerBuiltins() {
    const add = (name, callback, aliases = [], helpString = '') => SlashCommandParser.addCommand(name, callback, aliases, helpString);
    add('send', async (_a, text) => { await sendMessage(text, { generateAfter: false }); return ''; }, [], 'Send a message as you without generating.');
    add('trigger', async args => {
        const run = generate('normal');
        if (isTrueBoolean(args.await ?? 'false')) await run;
        return '';
    }, [], 'Ask the character to reply.');
    // ---- prompt injections (/inject id= position=chat|before|after|none depth= role= scan= ephemeral=) ----
    const positions = { chat: 1, before: 2, after: 0, none: -1 };
    const roles = { system: 0, user: 1, assistant: 2 };
    const ephemeral = new Set();
    add('inject', async (args, text) => {
        const id = args.id || `inject_${Date.now()}`;
        setExtensionPrompt(`inject_${id}`, text, positions[args.position ?? 'after'] ?? 0, Number(args.depth ?? 4), isTrueBoolean(args.scan ?? 'false'), roles[args.role ?? 'system'] ?? 0);
        if (isTrueBoolean(args.ephemeral ?? 'false')) ephemeral.add(`inject_${id}`);
        else ephemeral.delete(`inject_${id}`);
        return '';
    });
    add('flushinject', async (_a, id) => {
        for (const key of Object.keys(extensionPrompts)) {
            if (key.startsWith('inject_') && (!id || key === `inject_${id}`)) delete extensionPrompts[key];
        }
        return '';
    }, ['flushinjects']);
    add('listinjects', async () => JSON.stringify(Object.fromEntries(Object.entries(extensionPrompts).filter(([k]) => k.startsWith('inject_')).map(([k, v]) => [k.slice(7), v]))));
    eventSource.on(event_types.GENERATION_ENDED, () => {
        for (const key of ephemeral) delete extensionPrompts[key];
        ephemeral.clear();
    });
    // ---- control flow ----
    const compare = (a, b, rule) => {
        const na = Number(a);
        const nb = Number(b);
        const num = !Number.isNaN(na) && !Number.isNaN(nb) && a !== '' && b !== '';
        switch (rule) {
            case 'eq': return num ? na === nb : a === b;
            case 'neq': return num ? na !== nb : a !== b;
            case 'lt': return num && na < nb;
            case 'gt': return num && na > nb;
            case 'lte': return num && na <= nb;
            case 'gte': return num && na >= nb;
            case 'in': return String(a).includes(String(b));
            case 'nin': return !String(a).includes(String(b));
            case 'not': return !a || a === 'false' || a === '0';
            default: return !!a && a !== 'false' && a !== '0';
        }
    };
    const resolve = v => {
        if (v === undefined) return '';
        if (variables.local.has(v)) return variables.local.get(v);
        if (variables.global.has(v)) return variables.global.get(v);
        return v;
    };
    add('if', async (args, body) => {
        const ok = compare(resolve(args.left), resolve(args.right), args.rule || (args.right === undefined ? 'truthy' : 'eq'));
        if (ok) return runClosure(body);
        if (args.else) return runClosure(args.else);
        return '';
    });
    add('return', async (_a, value) => ({ [RETURN]: true, value }));
    add('run', async (_a, body) => runClosure(body));
    add('times', async (_a, text) => {
        const [count, ...rest] = String(text).split(/\s+/);
        let out = '';
        for (let i = 0; i < Math.min(Number(count) || 0, 100); i++) out = await runClosure(rest.join(' ').replace(/\{\{timesIndex\}\}/g, i));
        return out;
    });
    // ---- messages ----
    const range = (text, fallback) => {
        const [a, b] = String(text || fallback).split('-').map(Number);
        return [a, Number.isNaN(b) ? a : b];
    };
    const setHidden = async (text, hidden) => {
        const [from, to] = range(text, state.chat.length - 1);
        for (let i = Math.max(0, from); i <= Math.min(to, state.chat.length - 1); i++) state.chat[i].is_system = hidden;
        printMessages();
        await saveChat();
        return '';
    };
    add('hide', (_a, text) => setHidden(text, true));
    add('unhide', (_a, text) => setHidden(text, false));
    add('messages', async (args, text) => {
        const [from, to] = range(text, `0-${state.chat.length - 1}`);
        const names = args.names !== 'off';
        return state.chat.slice(from, to + 1).filter(m => args.hidden === 'on' || !m.is_system).map(m => (names ? `${m.name}: ${m.mes}` : m.mes)).join('\n\n');
    }, ['message']);
    add('lastmessageid', async () => String(state.chat.length - 1));
    add('continue', async () => { generate('continue'); return ''; }, ['cont']);
    add('impersonate', async (args, text) => {
        const run = generate('impersonate', { quietPrompt: text && !isClosure(text) ? text : '' });
        if (isTrueBoolean(args.await ?? 'true')) await run;
        return '';
    }, ['imp']);
    add('swipe', async () => { await swipeRight(); return ''; });
    add('gen', async (args, text) => (await generateQuietPrompt(text)) ?? '', ['generate']);
    add('genraw', async (args, text) => (await generateRaw(text, null, false, false, args.system || '')) ?? '');
    add('sys', async (_a, text) => { sendSystemMessage(text); return ''; }, ['nar', 'narrator']);
    add('sendas', async (args, text) => {
        const mes = { name: args.name || charName(), is_user: false, is_system: false, send_date: new Date().toISOString(), mes: text, extra: {} };
        state.chat.push(mes);
        addOneMessage(mes);
        await saveChat();
        return '';
    });
    add('echo', async (args, text) => { toast(text, args.severity || 'info'); return text; });
    add('setinput', async (_a, text) => { const ta = document.getElementById('send_textarea'); ta.value = text; ta.dispatchEvent(new Event('input')); return ''; });
    add('setvar', async (args, text) => variables.local.set(args.key ?? args.name, text) || text);
    add('getvar', async (args, text) => variables.local.get(args.key ?? args.name ?? text));
    add('addvar', async (args, text) => { variables.local.add(args.key ?? args.name, text); return variables.local.get(args.key ?? args.name); });
    add('incvar', async (_a, text) => String(variables.local.inc(text)));
    add('decvar', async (_a, text) => String(variables.local.dec(text)));
    add('flushvar', async (_a, text) => variables.local.del(text));
    add('setglobalvar', async (args, text) => variables.global.set(args.key ?? args.name, text) || text);
    add('getglobalvar', async (args, text) => variables.global.get(args.key ?? args.name ?? text));
    add('addglobalvar', async (args, text) => { variables.global.add(args.key ?? args.name, text); return variables.global.get(args.key ?? args.name); });
    add('newchat', async () => { const m = await import('../characters.js'); await m.newChat(); return ''; });
    add('imagine', async (_a, text) => {
        const m = await import('../imagegen.js');
        const url = await m.generateImage(text);
        const mes = { name: charName(), is_user: false, is_system: false, send_date: new Date().toISOString(), mes: '', extra: { media: [{ url, title: text, type: 'image' }] } };
        state.chat.push(mes);
        addOneMessage(mes);
        await saveChat();
        return url;
    }, ['sd', 'img', 'image']);
    add('bg', async (_a, text) => {
        chatMetadata().custom_background = text;
        await saveChat();
        (await import('../themes.js')).applyTheme();
        return '';
    }, ['background']);
    add('stop', async () => String(stopGeneration()));
    add('help', async () => {
        const names = [...new Set([...commands.values()].map(c => c.name))].sort();
        toast(names.map(n => `/${n}`).join('  '), 'info', { title: 'Commands', timeout: 12000 });
        return '';
    }, ['?']);
}

// ---------------------------------------------------------------------------
// Misc helpers extensions expect
// ---------------------------------------------------------------------------
export class ModuleWorkerWrapper {
    constructor(callback) {
        this.callback = callback;
        this.promise = null;
    }
    async update(...args) {
        if (this.promise) return this.promise;
        this.promise = Promise.resolve(this.callback(...args)).finally(() => { this.promise = null; });
        return this.promise;
    }
}

export async function renderExtensionTemplateAsync(extensionName, templateId, templateData = {}, sanitize = true) {
    const url = `/scripts/extensions/${extensionName}/${templateId}.html`;
    const res = await fetch(url);
    if (!res.ok) return '';
    let html = await res.text();
    html = html.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (m, key) => (key in templateData ? String(templateData[key]) : m));
    return sanitize ? DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true }) : html;
}

export function renderExtensionTemplate(extensionName, templateId, templateData = {}) {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/scripts/extensions/${extensionName}/${templateId}.html`, false);
    xhr.send();
    let html = xhr.status === 200 ? xhr.responseText : '';
    html = html.replace(/\{\{\{?\s*([\w.]+)\s*\}?\}\}/g, (m, key) => (key in templateData ? String(templateData[key]) : m));
    return DOMPurify.sanitize(html, { ADD_TAGS: ['style'], FORCE_BODY: true });
}

export const getRequestHeaders = () => ({ 'Content-Type': 'application/json' });
export const delay = ms => new Promise(r => setTimeout(r, ms));
export const uuidv4 = () => crypto.randomUUID();
export const isTrueBoolean = v => ['on', 'true', '1', 'yes'].includes(String(v).trim().toLowerCase());
export const isFalseBoolean = v => ['off', 'false', '0', 'no'].includes(String(v).trim().toLowerCase());
export const getStringHash = (str, seed = 0) => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};
export async function waitUntilCondition(cond, timeout = 1000, interval = 100) {
    const start = Date.now();
    while (!cond()) {
        if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
        await delay(interval);
    }
}
export const getBase64Async = file => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
});
export const onlyUnique = (v, i, a) => a.indexOf(v) === i;
export const copyText = text => navigator.clipboard?.writeText(text);
export const t = (strings, ...values) => (Array.isArray(strings) ? strings.reduce((acc, s, i) => acc + s + (values[i] ?? ''), '') : String(strings));

// ST's lib.js libraries are loaded as globals in index.html.
const libs = () => ({
    DOMPurify, showdown: window.showdown, lodash: window._, Handlebars: window.Handlebars, moment: window.moment,
    localforage: window.localforage, Popper: window.Popper, Fuse: window.Fuse,
});

function characterFields() {
    const d = state.character?.card?.data || {};
    return {
        system: d.system_prompt || '', mesExamples: d.mes_example || '', description: d.description || '', personality: d.personality || '',
        persona: currentPersona().description || '', scenario: d.scenario || '', jailbreak: d.post_history_instructions || '',
        version: d.character_version || '', charDepthPrompt: d.extensions?.depth_prompt?.prompt || '', creatorNotes: d.creator_notes || '',
    };
}

function stCharacter(summary) {
    const full = state.character?.id === summary.id ? state.character.card.data : null;
    const d = full || { name: summary.name, tags: summary.tags, creator_notes: summary.notes };
    return {
        name: d.name,
        avatar: summary.avatar || `${summary.id}.png`,
        description: d.description ?? '',
        personality: d.personality ?? '',
        scenario: d.scenario ?? '',
        first_mes: d.first_mes ?? '',
        mes_example: d.mes_example ?? '',
        creatorcomment: d.creator_notes ?? '',
        tags: d.tags ?? [],
        chat: state.character?.id === summary.id ? state.chatId : undefined,
        data: full ? structuredClone(full) : { name: d.name, tags: d.tags ?? [], extensions: {} },
        fav: summary.fav,
        _rvId: summary.id,
        shallow: !full,
    };
}

function characterIndex() {
    return state.characters.findIndex(c => c.id === state.character?.id);
}

export function getContext() {
    const characters = state.characters.map(stCharacter);
    const idx = characterIndex();
    return {
        chat: state.chat,
        characters,
        groups: [],
        name1: userName(),
        name2: charName(),
        characterId: idx >= 0 ? idx : undefined,
        this_chid: idx >= 0 ? idx : undefined,
        groupId: null,
        chatId: state.chatId,
        getCurrentChatId: () => state.chatId,
        getRequestHeaders,
        reloadCurrentChat: () => printMessages(),
        saveSettingsDebounced,
        onlineStatus: state.settings.connection.model || 'no_connection',
        maxContext: Number(state.preset?.samplers?.context_size || 0),
        chatMetadata: chatMetadata(),
        saveMetadataDebounced: () => saveChat(),
        saveMetadata: () => saveChat(),
        updateChatMetadata: (data, reset) => {
            const meta = chatMetadata();
            if (reset) for (const k of Object.keys(meta)) delete meta[k];
            Object.assign(meta, data);
        },
        eventSource,
        eventTypes: event_types,
        event_types,
        addOneMessage: (mes, opts = {}) => addOneMessage(mes, { forceId: opts.forceId ?? state.chat.indexOf(mes) }),
        deleteLastMessage: () => deleteMessage(state.chat.length - 1),
        deleteMessage,
        generate: type => generate(type || 'normal'),
        stopGeneration,
        getTokenCount: text => estimateTokens(text),
        getTokenCountAsync: async text => estimateTokens(text),
        getTextTokens: () => [],
        tokenizers: { NONE: 0 },
        extensionPrompts,
        setExtensionPrompt,
        saveChat: () => saveChat(),
        saveChatConditional: () => saveChat(),
        openCharacterChat: async id => (await import('../characters.js')).openChat(id),
        sendSystemMessage: (_type, text) => sendSystemMessage(text),
        activateSendButtons: () => {},
        deactivateSendButtons: () => {},
        substituteParams: (text, _n1, _n2, original) => substituteParams(text, original !== undefined ? { original } : {}),
        substituteParamsExtended: (text, extra = {}) => substituteParams(text, extra),
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        SlashCommandNamedArgument,
        SlashCommandEnumValue,
        ARGUMENT_TYPE,
        executeSlashCommands: text => executeSlashCommands(text),
        executeSlashCommandsWithOptions,
        registerSlashCommand,
        registerMacro,
        unregisterMacro,
        registerHelper: () => {},
        registerDebugFunction: () => {},
        renderExtensionTemplate,
        renderExtensionTemplateAsync,
        callPopup,
        callGenericPopup,
        Popup,
        POPUP_TYPE,
        POPUP_RESULT,
        showLoader: () => document.body.classList.add('loading'),
        hideLoader: () => document.body.classList.remove('loading'),
        loader: { show: () => document.body.classList.add('loading'), hide: () => document.body.classList.remove('loading') },
        mainApi: 'openai',
        extensionSettings: state.settings.extension_settings,
        ModuleWorkerWrapper,
        getTokenizerModel: () => state.settings.connection.model,
        generateQuietPrompt,
        generateRaw,
        writeExtensionField: async (characterId, key, value) => {
            const summary = state.characters[characterId];
            if (!summary) return;
            const c = await api.get(`characters/${encodeURIComponent(summary.id)}`);
            c.card.data.extensions = { ...(c.card.data.extensions || {}), [key]: value };
            await api.put(`characters/${encodeURIComponent(summary.id)}`, { card: c.card });
            if (state.character?.id === summary.id) state.character.card = c.card;
        },
        getThumbnailUrl,
        ConnectionManagerRequestService,
        ChatCompletionService,
        TextCompletionService,
        getCharacterCardFields: () => characterFields(),
        unshallowCharacter: async () => {},
        getExtensionManifest: async name => (await import('./extensions-loader.js')).loaded.get(String(name).replace(/^third-party\//, ''))?.manifest,
        selectCharacterById: async id => (await import('../characters.js')).openCharacter(state.characters[id]?.id),
        messageFormatting: (mes, _name, _isSystem, isUser, messageId) => renderToHtml(mes, { isUser, message: state.chat[messageId], depth: Number.isFinite(messageId) ? state.chat.length - 1 - messageId : undefined }),
        updateMessageBlock: (id, mes) => updateMessageBlock(id, mes),
        shouldSendOnEnter: () => !isMobile(),
        isMobile,
        t,
        translate: text => text,
        getCurrentLocale: () => navigator.language || 'en',
        addLocaleData: () => {},
        tags: [],
        tagMap: {},
        menuType: state.character ? 'character_edit' : '',
        createCharacterData: {},
        chatCompletionSettings: presetAsOai(),
        textCompletionSettings: {},
        powerUserSettings: powerUser(),
        getCharacters: async () => (await import('../characters.js')).loadCharacters(),
        uuidv4,
        humanizedDateTime: () => new Date().toISOString().replace(/[:.]/g, '-'),
        scrollChatToBottom: () => scrollToBottom(true),
        swipe: { left: swipeLeft, right: swipeRight, to: (id, s) => swipeTo(id, s) },
        variables,
        loadWorldInfo: async name => {
            const list = await api.get('worlds');
            const w = list.find(x => x.name === name);
            return w ? loadWorld(w.id) : null;
        },
        saveWorldInfo: async (name, data) => {
            const list = await api.get('worlds');
            const w = list.find(x => x.name === name);
            if (w) await saveWorld({ ...data, id: w.id, name });
            else await api.post('worlds', { ...data, name });
        },
        getWorldInfoNames: () => [],
        printMessages,
        clearChat,
        getPresetManager: () => null,
        getChatCompletionModel: () => state.settings.connection.model,
        symbols: { ignore: Symbol.for('ignore') },
        constants: { unset: Symbol.for('unset') },
        accountStorage: {
            getItem: k => localStorage.getItem(`rv-acc-${k}`),
            setItem: (k, v) => localStorage.setItem(`rv-acc-${k}`, v),
            removeItem: k => localStorage.removeItem(`rv-acc-${k}`),
        },
    };
}

function presetAsOai() {
    const p = state.preset;
    if (!p) return {};
    return {
        temp_openai: p.samplers.temperature,
        top_p_openai: p.samplers.top_p,
        openai_max_context: p.samplers.context_size,
        openai_max_tokens: p.samplers.max_tokens,
        stream_openai: p.samplers.stream,
        chat_completion_source: state.settings.connection.provider,
        openai_model: state.settings.connection.model,
        assistant_prefill: p.completion.assistantPrefill,
    };
}

/** Persistent power_user object (extensions mutate it and then call saveSettingsDebounced). */
function powerUser() {
    const pu = (state.settings.power_user ??= {});
    Object.assign(pu, personaMaps(), {
        user_avatar: currentUserAvatar(),
        persona_description: currentPersona().description,
        custom_css: state.settings.appearance.customCss,
        chat_display: state.settings.appearance.chatStyle,
        prefer_character_prompt: state.settings.generation.preferCharPrompt,
        prefer_character_jailbreak: state.settings.generation.preferCharInstructions,
        movingUIState: pu.movingUIState || {},
        avatar_style: 0,
        expand_message_actions: false,
    });
    return pu;
}

// ---------------------------------------------------------------------------
// Module shim registry: what `import { x } from '../../../../script.js'` resolves to.
// ---------------------------------------------------------------------------
const watchers = new Set();
const missingWarned = new Set();

function missing(module, name) {
    const key = `${module}:${name}`;
    if (!missingWarned.has(key)) {
        missingWarned.add(key);
        console.warn(`[Reverie] Extension imported "${name}" from ${module}, which Reverie does not provide. It will be a no-op.`);
    }
    const stub = new Proxy(function noop() {}, {
        get: (_t, prop) => (prop === Symbol.toPrimitive ? () => '' : prop === 'then' ? undefined : prop === 'length' ? 0 : stub),
        apply: () => undefined,
        construct: () => ({}),
    });
    return stub;
}

const live = () => {
    const ctx = getContext();
    return {
        // script.js
        eventSource, event_types, saveSettingsDebounced, saveSettings, getRequestHeaders,
        chat: state.chat, characters: ctx.characters, this_chid: ctx.characterId, name1: ctx.name1, name2: ctx.name2,
        substituteParams: ctx.substituteParams, substituteParamsExtended: ctx.substituteParamsExtended,
        generateQuietPrompt, generateRaw, addOneMessage: ctx.addOneMessage, saveChatConditional: ctx.saveChat, saveChatDebounced: ctx.saveChat,
        saveChat: ctx.saveChat, reloadCurrentChat: ctx.reloadCurrentChat, callPopup, chat_metadata: chatMetadata(),
        sendSystemMessage: ctx.sendSystemMessage, system_message_types: { GENERIC: 'generic', NARRATOR: 'narrator', HELP: 'help' },
        setExtensionPrompt, extension_prompt_types, extension_prompt_roles, getCurrentChatId: ctx.getCurrentChatId,
        updateMessageBlock: ctx.updateMessageBlock, messageFormatting: ctx.messageFormatting, deleteLastMessage: ctx.deleteLastMessage,
        Generate: ctx.generate, stopGeneration, getCharacters: ctx.getCharacters, selectCharacterById: ctx.selectCharacterById,
        main_api: 'openai', online_status: ctx.onlineStatus, is_send_press: state.generating, menu_type: ctx.menuType,
        max_context: ctx.maxContext, amount_gen: state.preset?.samplers?.max_tokens, default_avatar: 'icons/icon.svg',
        getThumbnailUrl, animation_duration: 125, animation_easing: 'ease-in-out', user_avatar: currentUserAvatar(), default_user_avatar: 'icons/user.svg',
        activateSendButtons: ctx.activateSendButtons, deactivateSendButtons: ctx.deactivateSendButtons, saveMetadata: ctx.saveMetadata,
        updateChatMetadata: ctx.updateChatMetadata, printMessages, clearChat, scrollChatToBottom: ctx.scrollChatToBottom,
        isStreamingEnabled: () => state.preset?.samplers?.stream !== false, getTokenCount: ctx.getTokenCount,
        getTokenCountAsync: ctx.getTokenCountAsync, appendMediaToMessage: () => {}, setCharacterId: () => {}, setCharacterName: () => {},
        getGeneratingApi: () => state.settings.connection.provider, getGeneratingModel: () => state.settings.connection.model,
        getChatCompletionModel: ctx.getChatCompletionModel, chat_completion_sources: {},
        // extensions.js
        extension_settings: state.settings.extension_settings, getContext, renderExtensionTemplate, renderExtensionTemplateAsync,
        saveMetadataDebounced: ctx.saveMetadataDebounced, ModuleWorkerWrapper, doExtrasFetch: fetch.bind(window), getApiUrl: () => '',
        modules: [], extensionNames: [], writeExtensionField: ctx.writeExtensionField,
        // popup.js
        Popup, POPUP_TYPE, POPUP_RESULT, callGenericPopup,
        // slash commands
        SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, ARGUMENT_TYPE, SlashCommandEnumValue,
        executeSlashCommands: ctx.executeSlashCommands, executeSlashCommandsWithOptions, registerSlashCommand,
        // utils.js
        debounce, delay, uuidv4, getBase64Async, escapeHtml, isTrueBoolean, isFalseBoolean, getStringHash, waitUntilCondition,
        onlyUnique, copyText, debounce_timeout: { quick: 100, short: 200, standard: 300, relaxed: 1000, extended: 5000 },
        download: (content, name, type) => import('../ui.js').then(m => m.download(name, content, type)),
        getSortableDelay: () => (isMobile() ? 750 : 50), trimToEndSentence: s => s, stringFormat: (f, ...a) => f.replace(/\{(\d+)\}/g, (m, i) => a[i] ?? m),
        // i18n
        t, translate: ctx.translate, getCurrentLocale: ctx.getCurrentLocale,
        // power-user / openai / world-info
        power_user: ctx.powerUserSettings, oai_settings: ctx.chatCompletionSettings, world_info: {}, world_names: [],
        loadWorldInfo: ctx.loadWorldInfo, saveWorldInfo: ctx.saveWorldInfo, isMobile,
        // lib.js
        ...libs(), tags: [], tag_map: {}, groups: [], selected_group: null, is_group_generating: false,
        // personas.js
        getUserAvatar, getUserAvatars, setUserAvatar, setPersonaDescription, isPersonaLocked: () => false, togglePersonaLock: async () => {},
        convertCharacterToPersona: async () => {}, setUserName: async () => {},
        // misc script.js / utils.js / others
        getPastCharacterChats, sendMessageAsUser, showSwipeButtons: () => {}, hideSwipeButtons: () => {}, setSendButtonState: () => {},
        setExternalAbortController: () => {}, reloadMarkdownProcessor: () => {}, extractMessageBias: () => '',
        extractTextFromHTML, escapeRegex, regexFromString, isDataURL, trimToStartSentence, bufferToBase64, saveBase64AsFile,
        isFirefox, dragElement, loadMovingUIState: () => {}, registerDebugFunction: () => {},
        getGroupPastChats: async () => [], findGroupMemberId: () => null,
        textgen_types: {}, textgenerationwebui_settings: {}, SECRET_KEYS: {}, secret_state: {}, writeSecret: async () => {},
        getWorldInfoPrompt: async () => ({ worldInfoString: '', worldInfoBefore: '', worldInfoAfter: '' }),
        openWorldInfoEditor: () => import('../panels/settings.js').then(m => m.openSettings('lore')),
        resolveVariable: name => variables.local.get(name) || variables.global.get(name) || name,
        evalBoolean: () => false, parseBooleanOperands: () => [],
        enumIcons: {}, commonEnumProviders: new Proxy({}, { get: () => () => [] }), enumTypes: { enum: 0, command: 1, namedArgument: 2, macro: 3 },
        SlashCommandAbortController: class { constructor() { this.signal = { aborted: false }; } abort() { this.signal.aborted = true; } },
        SlashCommandClosure: class {}, SlashCommandClosureResult: class {}, SlashCommandScope: class {}, SlashCommandBreakController: class {},
        SlashCommandNamedArgumentAssignment: class {},
        ConnectionManagerRequestService, ChatCompletionService, TextCompletionService,
        MacrosParser: { registerMacro, unregisterMacro }, macros: { register: (n, o) => registerMacro(n, o?.handler ?? o) },
        accountStorage: ctx.accountStorage, loader: ctx.loader, getPresetManager: () => null, ToolManager: { registerFunctionTool() {}, unregisterFunctionTool() {}, isToolCallingSupported: () => false },
        timestampToMoment: ts => (window.moment ? window.moment(ts) : new Date(ts)),
        sortMoments: (a, b) => (b?.valueOf?.() ?? 0) - (a?.valueOf?.() ?? 0),
        parseJsonFile: file => file.text().then(JSON.parse), getFileText: file => file.text(),
        getCharaFilename: id => state.characters[id ?? characterIndex()]?.avatar?.replace(/\.[^.]+$/, '') ?? '',
        loadFileToDocument: async (url, type) => {
            const node = type === 'css' ? Object.assign(document.createElement('link'), { rel: 'stylesheet', href: url }) : Object.assign(document.createElement('script'), { src: url });
            document.head.append(node);
            await new Promise(r => { node.onload = r; node.onerror = r; });
        },
        getMessageTimeStamp: () => new Date().toLocaleString(), humanizedDateTime: () => new Date().toISOString().replace(/[:.]/g, '-'),
        getGroupChat: async () => null, appendFileContent: async () => {}, uploadFileAttachment: async () => null,
        loadExtensionSettings: async () => {}, getExtensionManifest: ctx.getExtensionManifest,
        quickReplyApi: undefined, QuickReplySet: undefined,
        hljs: undefined, seedrandom: undefined, droll: undefined, morphdom: undefined, slideToggle: undefined, chalk: undefined, yaml: undefined,
        SVGInject: undefined, Readability: undefined, isProbablyReaderable: undefined, diff_match_patch: undefined, css: undefined, Bowser: undefined, DiffMatchPatch: undefined,
    };
};

let liveCache = null;
globalThis.__RV_SHIM__ = {
    get(module, name) {
        liveCache ??= live();
        if (name === 'default') {
            if (/st-context\.js$/.test(module)) return { getContext };
            return liveCache;
        }
        if (name in liveCache) return liveCache[name];
        return missing(module, name);
    },
    watch(fn) {
        watchers.add(fn);
    },
    notify() {
        liveCache = live();
        for (const fn of watchers) {
            try { fn(); } catch { /* ignore */ }
        }
    },
};

// ---------------------------------------------------------------------------
// Install globals
// ---------------------------------------------------------------------------
export function installCompat() {
    registerBuiltins();
    window.SillyTavern = { getContext, libs: libs() };
    if (window.Fuse === undefined) import('../../vendor/fuse.js').then(m => { window.Fuse = m.default; window.SillyTavern.libs.Fuse = m.default; }).catch(() => {});
    window.dragElement = dragElement;
    window.toastr = toastr;
    window.Popup = Popup;
    window.callPopup = callPopup;
    window.DOMPurify ??= DOMPurify;

    const $ = window.jQuery;
    if ($) {
        for (const plugin of ['select2', 'sortable', 'draggable', 'resizable', 'autocomplete', 'tooltip', 'transition', 'nanogallery2']) {
            $.fn[plugin] ??= function stub() { return this; };
        }
    }

    // ST "inline drawer" collapsibles used throughout extension settings HTML.
    document.addEventListener('click', e => {
        const toggle = e.target.closest('.inline-drawer-toggle');
        if (!toggle) return;
        const drawer = toggle.closest('.inline-drawer');
        const content = drawer?.querySelector(':scope > .inline-drawer-content');
        if (!content) return;
        const open = !drawer.classList.contains('open');
        drawer.classList.toggle('open', open);
        content.style.display = open ? 'block' : 'none';
        const ic = toggle.querySelector('.inline-drawer-icon');
        ic?.classList.toggle('down', !open);
        ic?.classList.toggle('up', open);
        ic?.classList.toggle('fa-circle-chevron-down', !open);
        ic?.classList.toggle('fa-circle-chevron-up', open);
    });

    for (const ev of [event_types.CHAT_CHANGED, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_SENT, event_types.MESSAGE_DELETED,
        event_types.SETTINGS_UPDATED, event_types.CHARACTER_EDITED, event_types.PRESET_CHANGED, event_types.GENERATION_STARTED, event_types.GENERATION_ENDED]) {
        eventSource.on(ev, () => globalThis.__RV_SHIM__.notify());
    }
}

/** RPC handler for interactive iframes in messages (window.Reverie / TavernHelper-style API). */
export async function frameRpc(method, args) {
    switch (method) {
        case 'send': await sendMessage(args[0]); return true;
        case 'sendSilently': await sendMessage(args[0], { generateAfter: false }); return true;
        case 'setInput': {
            const ta = document.getElementById('send_textarea');
            ta.value = args[0];
            ta.dispatchEvent(new Event('input'));
            ta.focus();
            return true;
        }
        case 'generate': generate('normal'); return true;
        case 'slash': return (await executeSlashCommands(args[0])).pipe;
        case 'getVar': return variables.local.get(args[0]);
        case 'setVar': variables.local.set(args[0], args[1]); saveChat(); return true;
        case 'getGlobalVar': return variables.global.get(args[0]);
        case 'setGlobalVar': variables.global.set(args[0], args[1]); return true;
        case 'getVariables': return structuredClone(chatMetadata().variables || {});
        case 'assignVariables': Object.assign(chatMetadata().variables ??= {}, args[0] || {}); saveChat(); return true;
        case 'getChat': return state.chat.map((m, i) => ({ message_id: i, name: m.name, role: m.is_user ? 'user' : 'assistant', is_user: m.is_user, message: m.mes, mes: m.mes }));
        case 'lastMessageId': return state.chat.length - 1;
        case 'getContext': return { name1: userName(), name2: charName(), chatId: state.chatId, characterId: state.character?.id, chatLength: state.chat.length };
        case 'toast': toast(args[0], args[1]); return true;
        case 'generateImage': return (await import('../imagegen.js')).generateImage(args[0]);
        default: throw new Error(`Unknown method ${method}`);
    }
}
