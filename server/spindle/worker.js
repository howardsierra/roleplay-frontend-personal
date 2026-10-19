// Runs one Lumiverse (Spindle) extension backend in a worker thread and gives it the `spindle`
// global. Calls that need Reverie's data are sent to the main thread (server/spindle/host.js),
// which answers them itself or asks the open Reverie tab. Handlers (events, interceptors,
// macros, tools, frontend messages…) stay here and are invoked by the host.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { manifest, entry, granted, dir } = workerData;

/**
 * Bundles built for Bun may use import.meta.require. Node doesn't have it, so load a patched
 * copy (written next to the original, so relative imports keep working).
 */
function nodeReady(file) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes('import.meta.require')) return file;
    const out = file.replace(/\.m?js$/, '') + '.reverie-node.mjs';
    const patched = `import{createRequire as __rvCR}from"node:module";${src.replaceAll('import.meta.require', '__rvCR(import.meta.url)')}`;
    if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== patched) fs.writeFileSync(out, patched);
    return out;
}

let seq = 0;
const pending = new Map();

/** Make values safe for postMessage: functions are dropped, everything else is cloned. */
function plain(value, path = new Set()) {
    if (typeof value === 'function') return undefined;
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date) return value;
    if (path.has(value)) return undefined; // a cycle; shared (non-cyclic) references are kept
    path.add(value);
    let out;
    if (Array.isArray(value)) out = value.map(v => { const p = plain(v, path); return p === undefined ? null : p; });
    else {
        out = {};
        for (const [k, v] of Object.entries(value)) {
            const p = plain(v, path);
            if (p !== undefined) out[k] = p;
        }
    }
    path.delete(value);
    return out;
}

function call(method, args = []) {
    return new Promise((resolve, reject) => {
        const n = ++seq;
        pending.set(n, { resolve, reject, method });
        parentPort.postMessage({ t: 'call', n, method, args: plain(args) });
    });
}

const abortError = () => (typeof DOMException === 'function' ? new DOMException('The operation was aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' }));

/**
 * A streamed call: the host sends { t: 'chunk' } messages while it runs and a final 'ret' with the
 * aggregate. Yields the chunks as they arrive, then a terminal done chunk. Hosts (or Reverie tabs)
 * that can't stream just answer with the aggregate, which is replayed as one chunk.
 */
async function* callStream(method, input = {}) {
    const { signal, ...rest } = input || {};
    if (signal?.aborted) throw abortError();
    const queue = [];
    let wake = null;
    let finished = null; // { value } | { error }
    const n = ++seq;
    const notify = () => { const w = wake; wake = null; w?.(); };
    pending.set(n, {
        method,
        chunk: c => { queue.push(c); notify(); },
        resolve: value => { finished = { value }; notify(); },
        reject: error => { finished = { error }; notify(); },
    });
    const onAbort = () => { finished ??= { error: abortError() }; notify(); };
    signal?.addEventListener?.('abort', onAbort, { once: true });
    parentPort.postMessage({ t: 'call', n, method, args: plain([rest]) });
    let streamed = false;
    try {
        for (;;) {
            while (queue.length) {
                const c = queue.shift();
                if (c && (c.type === 'token' || c.type === 'reasoning') && c.token) { streamed = true; yield c; }
            }
            if (finished) break;
            await new Promise(r => { wake = r; });
        }
        if (finished.error) throw finished.error;
        const r = finished.value || {};
        if (!streamed) { yield* streamOf(r); return; }
        yield { type: 'done', content: r.content || '', reasoning: r.reasoning, finish_reason: r.finish_reason || 'stop', tool_calls: r.tool_calls, usage: r.usage };
    } finally {
        signal?.removeEventListener?.('abort', onAbort);
        pending.delete(n); // breaking out early: late chunks are dropped
    }
}
const post = (method, args = []) => parentPort.postMessage({ t: 'post', method, args: plain(args) });

// ---------------------------------------------------------------- handler registries
const listeners = new Map(); // event -> Set<fn>
const interceptors = new Map(); // id -> { fn, priority }
const macroHandlers = new Map(); // name -> fn
const tools = new Map(); // name -> handler
const frontendHandlers = new Set();
const oauthHandlers = new Set();
const commandHandlers = new Set();
const permissionChanged = new Set();
const permissionDenied = new Set();
const contentProcessors = new Map();
const worldInfoInterceptors = new Map();
const macroInterceptors = new Map();
const contextHandlers = new Map();
let handlerSeq = 0;

function addTo(set, fn) {
    set.add(fn);
    return () => set.delete(fn);
}
/**
 * Register a hook with the host. `single`: Lumiverse keeps one handler of this kind per extension,
 * so a second registration replaces the first.
 */
function registerKind(map, kind, fn, priority = 100, opts = {}, single = false) {
    if (typeof fn !== 'function') throw new TypeError(`${kind} handler must be a function`);
    if (single) for (const old of [...map.keys()]) { map.delete(old); post('handlers.unregister', [{ kind, id: old }]); }
    const id = `${kind}-${++handlerSeq}`;
    const prio = Number.isFinite(Number(priority)) ? Number(priority) : 100;
    map.set(id, { fn, priority: prio });
    post('handlers.register', [{ kind, id, priority: prio, timeoutMs: Number(opts?.timeoutMs) || undefined, required: !!opts?.required }]);
    return () => { map.delete(id); post('handlers.unregister', [{ kind, id }]); };
}

// ---------------------------------------------------------------- backend processes
const processes = new Map(); // processId -> { child, handle, info }
const processMessage = new Set();
const processLifecycle = new Set();
const RUNTIME = new URL('./process-runtime.mjs', import.meta.url);
const frontendProcessMessage = new Set();
const frontendProcessLifecycle = new Set();

function spawnProcess(opts = {}) {
    const file = path.resolve(dir, String(opts.entry || ''));
    if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) return Promise.reject(new Error(`Process entry not found: ${opts.entry}`));
    if (opts.key && opts.replaceExisting !== false) {
        for (const p of processes.values()) if (p.info.key === opts.key && p.info.kind === opts.kind) p.handle.stop({ reason: 'replaced' });
    }
    return new Promise((resolve, reject) => {
        const processId = randomUUID();
        const info = { processId, entry: opts.entry, kind: opts.kind, key: opts.key, state: 'starting' };
        const life = (state, extra = {}) => {
            info.state = state;
            for (const h of processLifecycle) { try { h({ processId, kind: opts.kind, key: opts.key, state, ...extra }); } catch (err) { console.error(err); } }
        };
        const child = fork(RUNTIME, [], { cwd: dir, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
        let lastBeat = Date.now();
        let settled = false;
        const handle = {
            processId, entry: opts.entry, kind: opts.kind, key: opts.key, info,
            send: payload => { if (child.connected) child.send({ type: 'message', payload: plain(payload) }); },
            stop: async (o = {}) => {
                if (!child.connected) return;
                life('stopping');
                child.send({ type: 'stop', reason: o.reason });
                setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000);
            },
            refresh: async () => info,
        };
        processes.set(processId, { child, handle, info });
        life('starting');
        const startup = setTimeout(() => {
            if (settled) return;
            settled = true;
            life('timed_out', { error: 'startup timeout' });
            child.kill();
            reject(new Error('Process startup timed out'));
        }, Math.max(Number(opts.startupTimeoutMs) || 15000, 15000));
        const beatMs = Number(opts.heartbeatTimeoutMs) || 0;
        const watchdog = beatMs ? setInterval(() => {
            if (Date.now() - lastBeat > beatMs) { life('timed_out', { error: 'heartbeat timeout' }); child.kill(); }
        }, Math.min(beatMs, 10000)) : null;
        child.on('message', m => {
            lastBeat = Date.now();
            if (m?.type === 'ready' && !settled) { settled = true; clearTimeout(startup); life('running'); resolve(handle); }
            else if (m?.type === 'message') for (const h of processMessage) { try { h({ processId, kind: opts.kind, key: opts.key, payload: m.payload }); } catch (err) { console.error(err); } }
            else if (m?.type === 'fail') life('failed', { error: m.error });
            else if (m?.type === 'complete') life('completed');
            else if (m?.type === 'stopped') life('stopped');
        });
        child.on('exit', code => {
            clearTimeout(startup);
            if (watchdog) clearInterval(watchdog);
            processes.delete(processId);
            if (!['failed', 'timed_out', 'completed', 'stopped'].includes(info.state)) life(code ? 'failed' : 'stopped', { exitReason: `exit ${code}` });
            if (!settled) { settled = true; reject(new Error(`Process exited during startup (${code})`)); }
        });
        child.send({ type: 'init', process: { processId, entry: opts.entry, entryUrl: pathToFileURL(nodeReady(file)).href, kind: opts.kind, key: opts.key, payload: plain(opts.payload ?? {}), userId: opts.userId || 'owner' } });
    });
}
process.on('exit', () => { for (const p of processes.values()) p.child.kill(); });

const grantedSet = new Set(granted);
const log = level => (...args) => console[level === 'info' ? 'log' : level](`[${manifest.name || manifest.identifier}]`, ...args);

const base = {
    manifest: Object.freeze({ ...manifest }),
    identifier: manifest.identifier,
    log: { info: log('info'), warn: log('warn'), error: log('error'), debug: log('info') },

    // The host is told which events have listeners, so high-volume ones (stream tokens) are only
    // forwarded to backends that asked for them.
    on(event, fn) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        const set = listeners.get(event);
        if (!set.size) post('events.listen', [event]);
        set.add(fn);
        return () => {
            if (!set.delete(fn) || set.size) return;
            post('events.unlisten', [event]);
        };
    },

    registerInterceptor(fn, priority = 100, opts) { return registerKind(interceptors, 'interceptor', fn, priority, opts); },
    registerMessageContentProcessor(fn, priority = 100) { return registerKind(contentProcessors, 'contentProcessor', fn, priority, {}, true); },
    registerWorldInfoInterceptor(fn, priority = 100) { return registerKind(worldInfoInterceptors, 'worldInfoInterceptor', fn, priority, {}, true); },
    registerMacroInterceptor(fn, priority = 100, opts) { return registerKind(macroInterceptors, 'macroInterceptor', fn, priority, opts, true); },
    registerContextHandler(fn, priority = 100, opts) { return registerKind(contextHandlers, 'contextHandler', fn, priority, opts, true); },

    registerMacro(def) {
        if (typeof def?.handler === 'function') macroHandlers.set(def.name, def.handler);
        post('registerMacro', [{ ...def, handler: undefined, pull: typeof def?.handler === 'function' }]);
        return () => base.unregisterMacro(def.name);
    },
    unregisterMacro(name) { macroHandlers.delete(name); post('unregisterMacro', [name]); },
    updateMacroValue(name, value) { post('updateMacroValue', [name, value == null ? '' : String(value)]); },

    registerTool(def, handler) {
        const fn = handler || def?.handler || def?.execute;
        if (fn) tools.set(def.name, fn);
        post('registerTool', [{ ...def, handler: undefined, execute: undefined }]);
        return () => base.unregisterTool(def.name);
    },
    unregisterTool(name) { tools.delete(name); post('unregisterTool', [name]); },

    sendToFrontend(payload, userId) { post('sendToFrontend', [payload, userId]); },
    onFrontendMessage(fn) { return addTo(frontendHandlers, fn); },

    permissions: {
        has: perm => grantedSet.has(perm),
        getGranted: async () => [...grantedSet],
        request: async () => true,
        onChanged: fn => addTo(permissionChanged, fn),
        onDenied: fn => addTo(permissionDenied, fn),
    },

    oauth: {
        onCallback: fn => addTo(oauthHandlers, fn),
        getCallbackUrl: () => call('oauth.getCallbackUrl'),
        createState: (...args) => call('oauth.createState', args),
    },

    commands: {
        register: (...defs) => call('commands.register', defs),
        unregister: (...args) => call('commands.unregister', args),
        onInvoked: fn => addTo(commandHandlers, fn),
    },

    backendProcesses: {
        spawn: spawnProcess,
        onMessage: fn => addTo(processMessage, fn),
        onLifecycle: fn => addTo(processLifecycle, fn),
        list: async () => [...processes.values()].map(p => p.info),
        stop: async (processId, opts) => processes.get(processId)?.handle.stop(opts),
    },

    // Frontend processes run in the Reverie tab (public/js/spindle/processes.js).
    frontendProcesses: {
        async spawn(opts = {}) {
            const info = await call('frontendProcesses.spawn', [opts]);
            return {
                processId: info.processId, kind: info.kind, key: info.key, info,
                send: payload => { call('frontendProcesses.send', [info.processId, payload]).catch(() => {}); },
                stop: o => call('frontendProcesses.stop', [info.processId, o]),
                refresh: () => call('frontendProcesses.get', [info.processId]),
            };
        },
        send(processId, payload) { call('frontendProcesses.send', [processId, payload]).catch(() => {}); },
        stop: (processId, opts) => call('frontendProcesses.stop', [processId, opts]),
        list: filter => call('frontendProcesses.list', [filter]),
        get: processId => call('frontendProcesses.get', [processId]),
        onMessage: fn => addTo(frontendProcessMessage, fn),
        onLifecycle: fn => addTo(frontendProcessLifecycle, fn),
    },

    frontendCapabilities: { declare: (...args) => { post('frontendCapabilities.declare', args); } },
    events: { track: (...args) => { post('events.track', args); } },
    version: { getBackend: () => call('version.getBackend'), getFrontend: () => call('version.getFrontend') },

    generate: {
        rawStream(input) { return callStream('generate.rawStream', input); },
        quietStream(input) { return callStream('generate.quietStream', input); },
        // AbortSignals can't cross the wire: an already-aborted signal rejects locally, others are dropped.
        raw(input = {}) { return withSignal('generate.raw', input); },
        quiet(input = {}) { return withSignal('generate.quiet', input); },
        batch(input = {}) { return withSignal('generate.batch', input); },
        observe: observeGeneration,
    },
};

function withSignal(method, input) {
    const { signal, ...rest } = input || {};
    if (signal?.aborted) return Promise.reject(abortError());
    const p = call(method, [rest]);
    if (!signal?.addEventListener) return p;
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

/**
 * spindle.generate.observe(chatId) → GenerationObserver (Lumiverse worker-runtime semantics).
 * The older Reverie form observe({ onStart, onToken, onEnd, onStop }) still works and returns a disposer.
 */
function observeGeneration(chatIdOrHandlers) {
    if (chatIdOrHandlers && typeof chatIdOrHandlers === 'object') {
        const h = chatIdOrHandlers;
        const offs = [];
        if (h.onToken) offs.push(base.on('STREAM_TOKEN_RECEIVED', h.onToken));
        if (h.onStart) offs.push(base.on('GENERATION_STARTED', h.onStart));
        if (h.onEnd) offs.push(base.on('GENERATION_ENDED', h.onEnd));
        if (h.onStop) offs.push(base.on('GENERATION_STOPPED', h.onStop));
        const dispose = () => offs.splice(0).forEach(off => off());
        return Object.assign(dispose, { dispose });
    }
    const chatId = chatIdOrHandlers;
    const mine = p => chatId == null || p?.chatId === chatId;
    let start = [];
    let token = [];
    let end = [];
    let stop = [];
    let content = '';
    let reasoning = '';
    let generationId = null;
    const fire = (list, p) => { for (const fn of list) { try { fn(p); } catch (err) { console.error(`[${manifest.identifier}] observer handler failed:`, err); } } };
    const offs = [
        base.on('GENERATION_STARTED', p => { if (!mine(p)) return; generationId = p.generationId; content = ''; reasoning = ''; fire(start, p); }),
        base.on('STREAM_TOKEN_RECEIVED', p => {
            if (!mine(p)) return;
            if (p.type === 'reasoning') reasoning += p.token || ''; else content += p.token || '';
            fire(token, p);
        }),
        base.on('GENERATION_ENDED', p => { if (!mine(p)) return; generationId = null; fire(end, p); }),
        base.on('GENERATION_STOPPED', p => { if (!mine(p)) return; generationId = null; fire(stop, p); }),
    ];
    return {
        onStart(fn) { if (typeof fn === 'function') start.push(fn); },
        onToken(fn) { if (typeof fn === 'function') token.push(fn); },
        onEnd(fn) { if (typeof fn === 'function') end.push(fn); },
        onStop(fn) { if (typeof fn === 'function') stop.push(fn); },
        get content() { return content; },
        get reasoning() { return reasoning; },
        get generationId() { return generationId; },
        dispose() {
            offs.splice(0).forEach(off => off());
            start = []; token = []; end = []; stop = [];
        },
    };
}

function* streamOf(result) {
    const r = result || {};
    if (r.reasoning) yield { type: 'reasoning', token: r.reasoning };
    if (r.content) yield { type: 'token', token: r.content };
    yield { type: 'done', content: r.content || '', reasoning: r.reasoning, finish_reason: r.finish_reason || 'stop', tool_calls: r.tool_calls, usage: r.usage };
}

/** Any spindle.a.b(...) not defined above becomes an RPC to the host ("a.b"). */
function remote(path, target = {}) {
    return new Proxy(typeof target === 'function' ? target : Object.assign(function () {}, target), {
        get(t, key) {
            if (typeof key === 'symbol' || key === 'then') return undefined;
            if (key in t && key !== 'name' && key !== 'length') return typeof t[key] === 'object' && t[key] !== null && !Object.isFrozen(t[key]) ? remote(`${path}.${key}`, t[key]) : t[key];
            return remote(path ? `${path}.${key}` : key);
        },
        apply(_t, _this, args) {
            return call(path, args);
        },
    });
}

const spindle = new Proxy(base, {
    get(t, key) {
        if (typeof key === 'symbol') return t[key];
        if (key in t) {
            const v = t[key];
            if (v && typeof v === 'object' && !Object.isFrozen(v) && key !== 'log') return remote(key, v);
            return v;
        }
        return remote(key);
    },
});
globalThis.spindle = spindle;

// ---------------------------------------------------------------- host → worker
async function runSorted(map, initial, invoke) {
    let value = initial;
    for (const { fn } of [...map.values()].sort((a, b) => a.priority - b.priority)) value = (await invoke(fn, value)) ?? value;
    return value;
}

const invokers = {
    async event({ name, payload }) {
        for (const fn of listeners.get(name) || []) {
            try { await fn(payload, 'owner'); } catch (err) { console.error(`[${manifest.identifier}] ${name} handler failed:`, err); }
        }
        if (name === 'PERMISSION_CHANGED') for (const fn of permissionChanged) try { fn(payload); } catch { /* ignore */ }
    },
    async interceptor({ id, messages, context }) {
        const h = interceptors.get(id);
        return h ? h.fn(messages, context) : messages;
    },
    // Lumiverse hooks: one handler per call; the host chains them across extensions by priority.
    async contentProcessor({ id, ctx, payload }) {
        if (!id) return runSorted(contentProcessors, payload, (fn, v) => fn(v)); // older host shape
        const h = contentProcessors.get(id);
        return h ? h.fn(ctx) : undefined;
    },
    async worldInfoInterceptor({ id, ctx }) {
        const h = worldInfoInterceptors.get(id);
        return h ? h.fn(ctx) : undefined;
    },
    async macroInterceptor({ id, ctx }) {
        const h = macroInterceptors.get(id);
        return h ? h.fn(ctx) : undefined;
    },
    async contextHandler({ id, context }) {
        const h = contextHandlers.get(id);
        if (!h) return context;
        const controller = new AbortController();
        return h.fn(context, controller.signal);
    },
    async macro({ name, ctx }) {
        const fn = macroHandlers.get(name);
        return fn ? String((await fn(ctx)) ?? '') : '';
    },
    async tool({ name, args, context }) {
        const fn = tools.get(name);
        if (!fn) throw new Error(`Unknown tool ${name}`);
        return fn(args, context);
    },
    async frontendMessage({ payload, userId }) {
        const fp = payload?.__rvFrontendProcess;
        if (fp) {
            const { event, ...rest } = fp;
            for (const fn of event === 'message' ? frontendProcessMessage : frontendProcessLifecycle) {
                try { await fn(rest); } catch (err) { console.error(`[${manifest.identifier}] frontend process handler failed:`, err); }
            }
            return;
        }
        for (const fn of frontendHandlers) {
            try { await fn(payload, userId); } catch (err) { console.error(`[${manifest.identifier}] frontend message handler failed:`, err); }
        }
    },
    async oauth({ params }) {
        let out = null;
        for (const fn of oauthHandlers) out = (await fn(params)) ?? out;
        return out;
    },
    async command({ payload }) { for (const fn of commandHandlers) await fn(payload); },
};

parentPort.on('message', async msg => {
    if (msg.t === 'shutdown') { for (const p of processes.values()) p.child.kill(); return; }
    if (msg.t === 'chunk') {
        pending.get(msg.n)?.chunk?.(msg.chunk);
        return;
    }
    if (msg.t === 'ret') {
        const p = pending.get(msg.n);
        if (!p) return;
        pending.delete(msg.n);
        if (msg.error) p.reject(Object.assign(new Error(msg.error), { code: msg.code }));
        else p.resolve(msg.value);
        return;
    }
    if (msg.t === 'invoke') {
        try {
            const value = await invokers[msg.kind](msg.args);
            parentPort.postMessage({ t: 'ret', n: msg.n, value: plain(value) });
        } catch (err) {
            parentPort.postMessage({ t: 'ret', n: msg.n, error: err?.message || String(err) });
        }
    }
});

process.on('unhandledRejection', err => console.error(`[${manifest.identifier}] unhandled rejection:`, err));

try {
    await import(pathToFileURL(nodeReady(entry)).href);
    parentPort.postMessage({ t: 'ready' });
} catch (err) {
    parentPort.postMessage({ t: 'failed', error: err?.stack || String(err) });
}
