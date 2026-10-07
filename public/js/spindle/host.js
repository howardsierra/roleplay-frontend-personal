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
import { resolveHandler, setExtNames } from './backend-api.js';
import { createCtx } from './ctx.js';
import { installEventBridge, setBackendsListening } from './events.js';
import { activeChatId } from './dto.js';
import { refreshLumiverseVars } from './theme.js';

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

async function handle(msg) {
    if (msg.type === 'call') {
        const fn = resolveHandler(msg.method);
        let reply;
        try {
            if (!fn) throw new Error(`spindle.${msg.method} isn't available in Reverie`);
            reply = { n: msg.n, value: await fn(msg.ext, ...(msg.args || [])) };
        } catch (err) {
            reply = { n: msg.n, error: err?.message || String(err) };
        }
        api.post('spindle/reply', reply).catch(() => {});
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
const macros = new Map(); // name -> { ext, value, pull }
function setMacros(ext, list) {
    for (const [name, m] of [...macros]) if (m.ext === ext && !list.some(x => x.name === name)) { macros.delete(name); unregisterMacro(name); }
    for (const m of list) {
        macros.set(m.name, { ext, value: m.value, pull: m.pull });
        registerMacro(m.name, () => macros.get(m.name)?.value ?? '');
    }
}
function setMacroValue(ext, name, value) {
    const m = macros.get(name) || { ext, pull: false };
    m.value = value;
    macros.set(name, m);
    registerMacro(name, () => macros.get(name)?.value ?? '');
}

/** Pull-model macros are refreshed right before each generation. */
async function refreshPullMacros() {
    const pulls = [...macros.entries()].filter(([, m]) => m.pull);
    await Promise.all(pulls.map(async ([name, m]) => {
        const res = await api.post(`spindle/${encodeURIComponent(m.ext)}/macro/${encodeURIComponent(name)}`, {
            commit: true, args: [], env: { chat: { id: activeChatId() }, character: { id: state.character?.id || null }, extra: {} },
        }).catch(() => null);
        if (res && res.value !== undefined) m.value = res.value;
    }));
}

// ---------------------------------------------------------------- interceptors
function installInterceptor() {
    points.promptHooks.add(async (messages, info) => {
        if (!extensions.size || info.type === 'quiet') return messages;
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
    setBackendsListening(true);
    eventSource.on(event_types.GENERATION_STARTED, () => refreshPullMacros());
    eventSource.on(event_types.SETTINGS_UPDATED, () => refreshLumiverseVars());
    window.addEventListener('rv:theme-applied', () => refreshLumiverseVars());
    for (const info of list) if (info.enabled) await startLumiverse(info);
}
