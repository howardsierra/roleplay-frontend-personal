// Browser side of the Spindle (Lumiverse extension) host: connects to the server bridge, answers
// backend calls, runs extension frontends with a ctx, relays events, and wires backend macros and
// prompt interceptors into Reverie's generation.
import { state } from '../state.js';
import { api } from '../api.js';
import { eventSource, event_types } from '../events.js';
import { registerMacro, unregisterMacro } from '../macros.js';
import { lastLore } from '../prompt.js';
import { points } from '../rv-ext/points.js';
import { toast } from '../ui.js';
import { resolveHandler, setExtNames, isAssembling } from './backend-api.js';
import { createCtx } from './ctx.js';
import { installEventBridge, setBackendsListening, emitLumiverse } from './events.js';
import { activeChatId } from './dto.js';
import { refreshLumiverseVars } from './theme.js';
import { setHookState, hasHooks, setPullMacroResolver } from './hooks.js';

export const extensions = new Map(); // identifier -> { info, module, dispose, cleanup, error }
const backendListeners = new Map(); // identifier -> Set<fn>
let source = null;

// ---------------------------------------------------------------- bridge
function connect() {
    source?.close();
    source = new EventSource('api/spindle/stream');
    source.onmessage = e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        handle(msg);
    };
}

/**
 * Streaming handlers get `this.chunk(c)`: chunks are batched (~60ms) and posted in order, and the
 * final reply is only sent after every chunk has been delivered.
 */
function chunkSender(n) {
    let queue = Promise.resolve();
    let batch = [];
    let timer = null;
    const flush = () => {
        clearTimeout(timer);
        timer = null;
        if (!batch.length) return;
        // Coalesce consecutive token/reasoning chunks into one of each kind.
        const merged = [];
        for (const c of batch) {
            const last = merged.at(-1);
            if (last && last.type === c.type && (c.type === 'token' || c.type === 'reasoning')) last.token += c.token;
            else merged.push({ ...c });
        }
        batch = [];
        for (const chunk of merged) queue = queue.then(() => api.post('spindle/reply', { n, chunk }).catch(() => {}));
    };
    return {
        chunk(c) { if (!c) return; batch.push(c); timer ??= setTimeout(flush, 60); },
        async drain() { flush(); await queue; },
    };
}

async function handle(msg) {
    if (msg.type === 'call') {
        const fn = resolveHandler(msg.method);
        const stream = msg.stream ? chunkSender(msg.n) : null;
        let reply;
        try {
            if (!fn) throw Object.assign(new Error(`spindle.${msg.method} isn't available in Reverie`), { code: 'UNSUPPORTED' });
            reply = { n: msg.n, value: await fn.call(stream || {}, msg.ext, ...(msg.args || [])) };
        } catch (err) {
            reply = { n: msg.n, error: err?.message || String(err), code: err?.code };
        }
        if (stream) await stream.drain();
        api.post('spindle/reply', reply).catch(() => {});
        return;
    }
    if (msg.type === 'hooks') { setHookState(msg); return; }
    if (msg.type === 'world-changed') {
        // A backend changed a lorebook on the server: drop the cached copy, tell frontends.
        if (msg.id) state.worldsCache?.delete?.(msg.id);
        if (msg.event) emitLumiverse(msg.event, msg.payload || { id: msg.id }, { backend: false });
        return;
    }
    if (msg.type === 'to-frontend') {
        for (const fn of backendListeners.get(msg.ext) || []) {
            try { fn(msg.payload); } catch (err) { console.error(`[${msg.ext}] backend message handler`, err); }
        }
        return;
    }
    if (msg.type === 'macros') setMacros(msg.ext, msg.macros || []);
    if (msg.type === 'macro-value') setMacroValue(msg.ext, msg.name, msg.value);
}

// ---------------------------------------------------------------- macros
// Pull-model macros (a backend handler) are resolved per distinct argument string and cached for
// the current generation; push-model macros hold the last value the backend sent.
const macros = new Map(); // name -> { ext, value, pull, byArgs: Map<argsKey, value> }
const argsKey = args => String(args ?? '').trim();
const macroReader = name => (args, _env) => {
    const m = macros.get(name);
    if (!m) return '';
    if (m.pull) {
        const key = argsKey(args);
        if (m.byArgs?.has(key)) return m.byArgs.get(key);
    }
    return m.value ?? '';
};
function setMacros(ext, list) {
    for (const [name, m] of [...macros]) if (m.ext === ext && !list.some(x => x.name === name)) { macros.delete(name); unregisterMacro(name); }
    for (const m of list) {
        macros.set(m.name, { ext, value: m.value, pull: m.pull, byArgs: macros.get(m.name)?.byArgs || new Map() });
        registerMacro(m.name, macroReader(m.name));
    }
}
function setMacroValue(ext, name, value) {
    const m = macros.get(name) || { ext, pull: false, byArgs: new Map() };
    m.value = value;
    macros.set(name, m);
    registerMacro(name, macroReader(name));
}

let macroGen = 0; // bumped per generation; pull values fetched in this generation aren't fetched again
const fetched = new Map(); // `${name}\u0000${argsKey}` -> generation it was fetched in

async function pullMacro(name, m, args) {
    const key = argsKey(args);
    const id = `${name}\u0000${key}`;
    if (fetched.get(id) === macroGen) return;
    fetched.set(id, macroGen);
    const res = await api.post(`spindle/${encodeURIComponent(m.ext)}/macro/${encodeURIComponent(name)}`, {
        commit: true,
        name,
        args: key ? key.split('::') : [],
        isScoped: false,
        body: '',
        env: { chat: { id: activeChatId() }, character: { id: state.character?.id || null }, extra: {} },
    }).catch(() => null);
    if (!res || res.value === undefined) return;
    (m.byArgs ??= new Map()).set(key, res.value);
    if (!key) m.value = res.value;
}

/** Every {{...}} body in `text`, nested ones included. */
function macroBodies(text) {
    const out = [];
    const stack = [];
    for (let i = 0; i < text.length - 1; i++) {
        if (text[i] === '{' && text[i + 1] === '{') { stack.push(i + 2); i++; } else if (text[i] === '}' && text[i + 1] === '}' && stack.length) { out.push(text.slice(stack.pop(), i)); i++; }
    }
    return out;
}

/**
 * Resolve the extension pull-macros used in `texts` before macros are expanded (Reverie's macro
 * engine is synchronous). Finds {{name}}, {{name::args}} (and {{name:args}} / {{name args}}) for
 * every registered pull macro, asks the extension once per distinct argument string, and caches
 * the answers for this generation so the macro handler can return them by args.
 * @param {string[]|string} texts preset block contents, notes, character fields…
 */
export async function preparePullMacros(texts) {
    const pulls = new Map([...macros].filter(([, m]) => m.pull).map(([name, m]) => [name.toLowerCase(), [name, m]]));
    if (!pulls.size) return;
    const { substituteParams } = await import('../macros.js');
    const wanted = new Map(); // id -> [name, m, args]
    for (const text of [].concat(texts || [])) {
        const t = String(text ?? '');
        if (!t.includes('{{')) continue;
        for (const body of macroBodies(t)) {
            const match = body.match(/^\s*([\w.\-]+)\s*(?:(::|:|\s)([\s\S]*))?$/);
            const hit = match && pulls.get(match[1].toLowerCase());
            if (!hit) continue;
            let args = match[3] ?? '';
            if (args.includes('{{')) { try { args = substituteParams(args); } catch { /* keep raw */ } }
            wanted.set(`${hit[0]}\u0000${argsKey(args)}`, [hit[0], hit[1], args]);
        }
    }
    await Promise.all([...wanted.values()].map(([name, m, args]) => pullMacro(name, m, args)));
}

/** Before each generation: a fresh cache, and bare {{name}} values refreshed. */
async function refreshPullMacros() {
    macroGen++;
    for (const m of macros.values()) if (m.pull) m.byArgs = new Map();
    const pulls = [...macros.entries()].filter(([, m]) => m.pull);
    await Promise.all(pulls.map(([name, m]) => pullMacro(name, m, '')));
}

// ---------------------------------------------------------------- interceptors
function installInterceptor() {
    points.promptHooks.add(async (messages, info) => {
        // spindle.assemble builds prompts outside the interceptor pipeline (and may run inside it).
        if ((!extensions.size && !hasHooks('interceptor')) || info.type === 'quiet' || isAssembling()) return messages;
        const lvMessages = messages.map(m => {
            const { __src, ...rest } = m;
            return __src ? { ...rest, __isChatHistory: true, sourceMessageId: __src.id, sourceIndexInChat: __src.index } : rest;
        });
        const context = {
            chatId: activeChatId(),
            connectionId: 'active',
            personaId: state.settings.personaId || null,
            characterId: state.character?.id || null,
            generationType: info.type,
            dryRun: !!info.dryRun,
            userId: 'owner',
            activatedWorldInfo: (lastLore() || []).map(e => ({ id: e.uid, comment: e.comment, keys: e.key })),
        };
        const res = await api.post('spindle/intercept', { messages: lvMessages, context }).catch(err => { console.warn('Lumiverse interceptors failed', err); return null; });
        if (!res?.messages) return messages;
        if (res.parameters && info.params) Object.assign(info.params, { custom_body: { ...(info.params.custom_body || {}), ...res.parameters } });
        return res.messages.map(m => {
            const { __isChatHistory, __isWorldInfoEntry, sourceMessageId, sourceIndexInChat, ...rest } = m;
            return rest;
        });
    });
}

// ---------------------------------------------------------------- frontends
async function startFrontend(info) {
    const id = info.manifest.identifier;
    if (extensions.has(id) || !info.hasFrontend) return;
    const record = { info, module: null, dispose: null, cleanup: null, error: null };
    extensions.set(id, record);
    const listeners = new Set();
    backendListeners.set(id, listeners);
    const channel = {
        send: payload => api.post(`spindle/${encodeURIComponent(id)}/message`, { payload }).catch(err => console.warn(`[${id}]`, err.message)),
        onMessage: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    };
    const { ctx, dispose } = createCtx({ id, manifest: info.manifest, granted: info.granted }, channel);
    record.dispose = dispose;
    try {
        const entry = info.manifest.entry_frontend || 'dist/frontend.js';
        record.module = await import(`/lv-extensions/${encodeURIComponent(info.name)}/${entry}?v=${encodeURIComponent(info.manifest.version || '0')}`);
        const out = await record.module.setup?.(ctx);
        if (typeof out === 'function') record.cleanup = out;
    } catch (err) {
        record.error = err?.message || String(err);
        console.error(`Lumiverse extension ${id} frontend failed`, err);
        toast(`${info.manifest.name}: ${record.error}`, 'error', { title: 'Extension failed' });
    }
}

export async function stopFrontend(id) {
    const record = extensions.get(id);
    if (!record) return;
    try { await record.cleanup?.(); } catch (err) { console.error(err); }
    try { await record.module?.teardown?.(); } catch (err) { console.error(err); }
    record.dispose?.();
    extensions.delete(id);
    backendListeners.delete(id);
    for (const [name, m] of [...macros]) if (m.ext === id) { macros.delete(name); unregisterMacro(name); }
}

export async function listLumiverse() {
    return api.get('spindle').catch(() => []);
}

export async function startLumiverse(info) {
    info.granted ??= (info.manifest.permissions || []).filter(p => p !== 'tools');
    if (info.macros?.length) setMacros(info.manifest.identifier, info.macros);
    await startFrontend(info);
}

export async function setLumiverseEnabled(info, enabled) {
    const res = await api.post(`spindle/${encodeURIComponent(info.manifest.identifier)}/enable`, { enabled });
    if (enabled) await startLumiverse(info); else await stopFrontend(info.manifest.identifier);
    return res;
}

export async function loadLumiverseExtensions() {
    const list = await listLumiverse();
    if (!list.length) return;
    setExtNames(Object.fromEntries(list.map(x => [x.manifest.identifier, x.manifest.name])));
    refreshLumiverseVars();
    connect();
    installEventBridge();
    installInterceptor();
    setPullMacroResolver(preparePullMacros);
    setBackendsListening(true);
    eventSource.on(event_types.GENERATION_STARTED, () => refreshPullMacros());
    eventSource.on(event_types.SETTINGS_UPDATED, () => refreshLumiverseVars());
    window.addEventListener('rv:theme-applied', () => refreshLumiverseVars());
    for (const info of list) if (info.enabled) await startLumiverse(info);
}
