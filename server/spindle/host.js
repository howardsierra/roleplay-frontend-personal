// Spindle (Lumiverse extension) host for Reverie.
// Each extension backend runs in its own worker thread (worker.js). Calls it makes are answered
// here when they only need the server (storage, secrets, the CORS proxy, logging, macros), and
// otherwise forwarded to the open Reverie tab over the bridge (bridge.js), which owns the chat,
// characters and connection settings.
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, DIRS, readJson, writeJson } from '../lib/storage.js';
import { bridge } from './bridge.js';
import { worldBooksApi, presetsApi, resolveContent, NOT_HANDLED } from './content.js';

export const HOST_VERSION = '1.2.0';
const SPINDLE_DIR = path.join(DATA_DIR, 'spindle');
const WORKER = new URL('./worker.js', import.meta.url);

export const runtimes = new Map(); // identifier -> Runtime
// Native function calling isn't wired into Reverie's generation loop; Pocket falls back to tags.
const UNSUPPORTED_PERMISSIONS = new Set(['tools']);

// ---------------------------------------------------------------- helpers
function scoped(root, rel = '') {
    const clean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(root, clean);
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Path traversal is not allowed');
    return full;
}

async function listFiles(root, prefix = '') {
    const start = scoped(root, prefix);
    const out = [];
    async function walk(dir) {
        let entries = [];
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) await walk(full);
            else out.push(path.relative(root, full).split(path.sep).join('/'));
        }
    }
    try {
        const st = await fsp.stat(start);
        if (st.isDirectory()) await walk(start);
        else out.push(path.relative(root, start).split(path.sep).join('/'));
    } catch { /* missing */ }
    return out.sort();
}

function storageApi(root) {
    const ensure = async file => fsp.mkdir(path.dirname(file), { recursive: true });
    return {
        async read(p) { return fsp.readFile(scoped(root, p), 'utf8'); },
        async write(p, data) { const f = scoped(root, p); await ensure(f); await fsp.writeFile(f, typeof data === 'string' ? data : JSON.stringify(data)); },
        async readBinary(p) { return new Uint8Array(await fsp.readFile(scoped(root, p))); },
        async writeBinary(p, data) { const f = scoped(root, p); await ensure(f); await fsp.writeFile(f, Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data)); },
        async delete(p) { await fsp.rm(scoped(root, p), { recursive: true, force: true }); return true; },
        async list(prefix = '') { return listFiles(root, prefix); },
        async exists(p) { return fs.existsSync(scoped(root, p)); },
        async mkdir(p) { await fsp.mkdir(scoped(root, p), { recursive: true }); },
        async move(a, b) { const t = scoped(root, b); await ensure(t); await fsp.rename(scoped(root, a), t); },
        async stat(p) {
            try {
                const st = await fsp.stat(scoped(root, p));
                return { exists: true, isFile: st.isFile(), isDirectory: st.isDirectory(), sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
            } catch { return { exists: false, isFile: false, isDirectory: false, sizeBytes: 0, modifiedAt: null }; }
        },
        async getJson(p, opts = {}) {
            try { return JSON.parse(await fsp.readFile(scoped(root, p), 'utf8')); } catch { return opts?.fallback ?? null; }
        },
        async setJson(p, value, opts = {}) {
            const f = scoped(root, p);
            await ensure(f);
            await fsp.writeFile(f, JSON.stringify(value, null, opts?.indent ?? 0));
        },
    };
}

// Secrets live beside Reverie's own (data/spindle/secrets.json), encrypted with a key kept in
// data/spindle/.enclave-key so a copied backup without the key can't be read.
const ENCLAVE_FILE = path.join(SPINDLE_DIR, 'secrets.json');
const KEY_FILE = path.join(SPINDLE_DIR, '.enclave-key');
function enclaveKey() {
    fs.mkdirSync(SPINDLE_DIR, { recursive: true });
    if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    return Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'hex');
}
function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', enclaveKey(), iv);
    const data = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), data].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
    const [iv, tag, data] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', enclaveKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}
function enclaveApi(id) {
    const ns = key => {
        if (!/^[a-zA-Z0-9_\-.]{1,128}$/.test(String(key))) throw new Error('Invalid secret key');
        return `spindle:${id}:${key}`;
    };
    return {
        async put(key, value) { const all = await readJson(ENCLAVE_FILE, {}); all[ns(key)] = encrypt(String(value)); await writeJson(ENCLAVE_FILE, all); },
        async get(key) { const v = (await readJson(ENCLAVE_FILE, {}))[ns(key)]; try { return v ? decrypt(v) : null; } catch { return null; } },
        async has(key) { return ns(key) in (await readJson(ENCLAVE_FILE, {})); },
        async delete(key) { const all = await readJson(ENCLAVE_FILE, {}); const had = ns(key) in all; delete all[ns(key)]; await writeJson(ENCLAVE_FILE, all); return had; },
        async list() { const prefix = `spindle:${id}:`; return Object.keys(await readJson(ENCLAVE_FILE, {})).filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)); },
    };
}

async function corsFetch(url, init = {}) {
    const target = new URL(String(url));
    if (!/^https?:$/.test(target.protocol)) throw new Error('Only http(s) URLs are allowed');
    const res = await fetch(target, {
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body ?? undefined,
        signal: AbortSignal.timeout(init.timeoutMs || 30000),
    });
    const headers = Object.fromEntries(res.headers.entries());
    if (init.responseType === 'arraybuffer') {
        const buf = Buffer.from(await res.arrayBuffer());
        return { status: res.status, statusText: res.statusText, headers, body: buf.toString('base64'), encoding: 'base64' };
    }
    return { status: res.status, statusText: res.statusText, headers, body: await res.text() };
}

// Short-lived storage with TTL ("ephemeral_storage").
const ephemeral = new Map(); // `${id}:${key}` -> { value, expires }
function ephemeralApi(id) {
    const k = key => `${id}:${key}`;
    const alive = e => e && (!e.expires || e.expires > Date.now());
    return {
        async write(key, value, opts = {}) { ephemeral.set(k(key), { value, expires: opts.ttlMs ? Date.now() + opts.ttlMs : 0 }); return true; },
        async read(key) { const e = ephemeral.get(k(key)); return alive(e) ? e.value : null; },
        async delete(key) { return ephemeral.delete(k(key)); },
        async list() { return [...ephemeral.keys()].filter(x => x.startsWith(`${id}:`) && alive(ephemeral.get(x))).map(x => x.slice(id.length + 1)); },
        async getPoolStatus() { return { usedBytes: 0, maxBytes: 50 * 1024 * 1024, entries: [...ephemeral.keys()].filter(x => x.startsWith(`${id}:`)).length }; },
        async requestBlock() { return { granted: true }; },
        async releaseBlock() { return true; },
        async clear() { for (const x of [...ephemeral.keys()]) if (x.startsWith(`${id}:`)) ephemeral.delete(x); return true; },
    };
}

// ---------------------------------------------------------------- permissions
const PERMISSION_DENIED = 'PERMISSION_DENIED';
function requirePermission(rt, perm, method) {
    if (rt.granted.includes(perm)) return;
    throw Object.assign(new Error(`spindle.${method} needs the "${perm}" permission in spindle.json`), { code: PERMISSION_DENIED });
}
// Namespaces answered here from Reverie's stores, and the permission each needs.
const CONTENT_PERMISSIONS = { world_books: 'world_books', presets: 'presets' };

/** Tell the open tab(s) a lorebook changed on the server, and backends what changed. */
function contentChanged(name, payload, worldId, deleted = false) {
    emitAll(name, payload);
    bridge.broadcast({ type: 'world-changed', id: worldId, deleted, event: name, payload });
}
const contentApis = { world_books: worldBooksApi({ changed: contentChanged }), presets: presetsApi() };

// ---------------------------------------------------------------- runtime
class Runtime {
    constructor(ext) {
        this.ext = ext; // { name, manifest, dir }
        this.id = ext.manifest.identifier;
        this.handlers = []; // { kind, id, priority, timeoutMs?, required? }
        this.listening = new Set(); // events the backend has spindle.on() listeners for
        this.macros = new Map(); // name -> { def, value, pull }
        this.tools = new Map();
        this.status = 'starting';
        this.error = null;
        this.seq = 0;
        this.pending = new Map();
        this.storage = storageApi(path.join(SPINDLE_DIR, this.id, 'storage'));
        this.userStorage = storageApi(path.join(SPINDLE_DIR, this.id, 'user'));
        this.enclave = enclaveApi(this.id);
        this.ephemeral = ephemeralApi(this.id);
        this.oauthStates = new Map();
    }

    // Everything the manifest asks for, minus what Reverie can't provide (extensions then use their fallbacks).
    get granted() { return (this.ext.manifest.permissions || []).filter(p => !UNSUPPORTED_PERMISSIONS.has(p)); }

    async start() {
        const m = this.ext.manifest;
        const entry = path.join(this.ext.dir, m.entry_backend || 'dist/backend.js');
        if (!fs.existsSync(entry)) {
            this.status = m.entry_frontend ? 'frontend-only' : 'error';
            if (!m.entry_frontend && !fs.existsSync(path.join(this.ext.dir, 'dist/frontend.js'))) this.error = 'No built backend (dist/backend.js) found';
            return;
        }
        await this.seedStorage();
        this.worker = new Worker(WORKER, {
            workerData: { manifest: m, entry, granted: this.granted, dir: path.resolve(this.ext.dir) },
            resourceLimits: { maxOldGenerationSizeMb: 512 },
        });
        this.worker.on('message', msg => this.onMessage(msg));
        this.worker.on('error', err => { this.status = 'error'; this.error = err.message; console.error(`[spindle:${this.id}]`, err); });
        this.worker.on('exit', code => { if (this.status !== 'stopped') { this.status = 'error'; this.error ||= `Stopped (exit ${code})`; } });
        await new Promise(resolve => {
            const done = () => { clearTimeout(t); resolve(); };
            const t = setTimeout(done, 15000);
            this.onReady = done;
        });
    }

    async seedStorage() {
        for (const seed of this.ext.manifest.storage_seed_files || []) {
            const from = scoped(this.ext.dir, seed.from);
            const to = scoped(path.join(SPINDLE_DIR, this.id, 'storage'), seed.to || seed.from);
            if (!fs.existsSync(from)) continue;
            if (fs.existsSync(to) && !seed.overwrite) continue;
            await fsp.mkdir(path.dirname(to), { recursive: true });
            await fsp.cp(from, to, { recursive: true, force: true });
        }
    }

    async stop() {
        this.status = 'stopped';
        try { this.worker?.postMessage({ t: 'shutdown' }); } catch { /* ignore */ }
        await this.worker?.terminate();
        this.worker = null;
        bridge.broadcast({ type: 'macros', ext: this.id, macros: [] });
        broadcastHookState();
    }

    invoke(kind, args, timeoutMs = 30000) {
        if (!this.worker) return Promise.reject(new Error(`${this.ext.manifest.name} isn't running`));
        return new Promise((resolve, reject) => {
            const n = ++this.seq;
            const timer = setTimeout(() => { this.pending.delete(n); reject(new Error(`${this.ext.manifest.name} timed out (${kind})`)); }, timeoutMs);
            this.pending.set(n, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
            this.worker.postMessage({ t: 'invoke', n, kind, args });
        });
    }

    emit(name, payload) {
        this.worker?.postMessage({ t: 'invoke', n: 0, kind: 'event', args: { name, payload } });
    }

    async onMessage(msg) {
        if (msg.t === 'ready') { this.status = 'running'; this.onReady?.(); return; }
        if (msg.t === 'failed') { this.status = 'error'; this.error = msg.error.split('\n')[0]; console.error(`[spindle:${this.id}] failed to start:\n${msg.error}`); this.onReady?.(); return; }
        if (msg.t === 'ret') {
            const p = this.pending.get(msg.n);
            if (!p) return;
            this.pending.delete(msg.n);
            if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.value);
            return;
        }
        if (msg.t === 'post') { this.handle(msg.method, msg.args).catch(err => console.error(`[spindle:${this.id}] ${msg.method}:`, err.message)); return; }
        if (msg.t === 'call') {
            const onChunk = /Stream$/.test(msg.method) ? chunk => this.worker?.postMessage({ t: 'chunk', n: msg.n, chunk }) : undefined;
            try {
                const value = await this.handle(msg.method, msg.args, onChunk);
                this.worker?.postMessage({ t: 'ret', n: msg.n, value });
            } catch (err) {
                this.worker?.postMessage({ t: 'ret', n: msg.n, error: err?.message || String(err), code: err?.code });
            }
        }
    }

    pushMacros() {
        bridge.broadcast({ type: 'macros', ext: this.id, macros: [...this.macros.values()].map(m => ({ name: m.def.name, value: m.value, pull: m.pull && m.value === undefined, description: m.def.description || '' })) });
    }

    /** Answer a call from the worker. */
    async handle(method, args, onChunk) {
        const [ns, fn] = method.includes('.') ? [method.slice(0, method.indexOf('.')), method.slice(method.indexOf('.') + 1)] : [method, ''];
        const local = {
            storage: this.storage,
            userStorage: this.userStorage,
            enclave: this.enclave,
            ephemeral: this.ephemeral,
        }[ns];
        if (local) {
            if (!local[fn]) throw new Error(`spindle.${method} isn't supported in Reverie`);
            // userStorage takes an optional trailing userId / { userId } we don't need.
            return local[fn](...args);
        }
        switch (method) {
            case 'handlers.register': this.handlers.push(args[0]); broadcastHookState(); return;
            case 'handlers.unregister': this.handlers = this.handlers.filter(h => h.id !== args[0].id); broadcastHookState(); return;
            case 'events.listen': this.listening.add(String(args[0])); broadcastHookState(); return;
            case 'events.unlisten': this.listening.delete(String(args[0])); broadcastHookState(); return;
            case 'registerMacro': this.macros.set(args[0].name, { def: args[0], value: this.macros.get(args[0].name)?.value, pull: !!args[0].pull }); this.pushMacros(); return;
            case 'unregisterMacro': this.macros.delete(args[0]); this.pushMacros(); return;
            case 'updateMacroValue': {
                const m = this.macros.get(args[0]) || { def: { name: args[0] }, pull: false };
                m.value = args[1];
                this.macros.set(args[0], m);
                bridge.broadcast({ type: 'macro-value', ext: this.id, name: args[0], value: args[1] });
                return;
            }
            case 'registerTool': this.tools.set(args[0].name, args[0]); return;
            case 'unregisterTool': this.tools.delete(args[0]); return;
            case 'sendToFrontend': bridge.broadcast({ type: 'to-frontend', ext: this.id, payload: args[0] }); return;
            case 'cors': return corsFetch(args[0], args[1]);
            case 'version.getBackend': return HOST_VERSION;
            case 'version.getFrontend': return HOST_VERSION;
            case 'permissions.getGranted': return this.granted;
            case 'oauth.getCallbackUrl': return `${bridge.origin()}/api/spindle-oauth/${encodeURIComponent(this.id)}/callback`;
            case 'oauth.createState': {
                const state = crypto.randomBytes(16).toString('hex');
                this.oauthStates.set(state, { data: args[0], at: Date.now() });
                return state;
            }
            case 'frontendCapabilities.declare':
            case 'events.track':
            case 'commands.register':
            case 'commands.unregister':
                return true;
            case 'users.isVisible': return true;
            case 'users.getRole': return 'owner';
            default: {
                if (contentApis[ns]) {
                    const handler = resolveContent(contentApis[ns], fn);
                    if (handler !== NOT_HANDLED) {
                        requirePermission(this, CONTENT_PERMISSIONS[ns], method);
                        return handler(...args);
                    }
                }
                // Everything else (chats, characters, generation, images, UI…) is answered by the Reverie tab.
                return bridge.call(this.id, method, args, undefined, onChunk);
            }
        }
    }
}

// ---------------------------------------------------------------- manager
const enabledFile = path.join(SPINDLE_DIR, 'state.json');
export async function spindleState() { return readJson(enabledFile, { disabled: [] }); }
export async function setDisabled(id, disabled) {
    const s = await spindleState();
    const set = new Set(s.disabled || []);
    if (disabled) set.add(id); else set.delete(id);
    await writeJson(enabledFile, { ...s, disabled: [...set] });
}

export async function listSpindleExtensions() {
    let names = [];
    try { names = await fsp.readdir(DIRS.extensions); } catch { return []; }
    const out = [];
    for (const name of names) {
        const dir = path.join(DIRS.extensions, name);
        const manifest = await readJson(path.join(dir, 'spindle.json'));
        if (manifest?.identifier) out.push({ name, dir, manifest });
    }
    return out;
}

export async function startExtension(ext) {
    const id = ext.manifest.identifier;
    if (runtimes.has(id)) await runtimes.get(id).stop();
    const rt = new Runtime(ext);
    runtimes.set(id, rt);
    await rt.start();
    return rt;
}

export async function stopExtension(id) {
    const rt = runtimes.get(id);
    if (!rt) return;
    await rt.stop();
    runtimes.delete(id);
}

export async function startAll() {
    const { disabled = [] } = await spindleState();
    for (const ext of await listSpindleExtensions()) {
        if (disabled.includes(ext.manifest.identifier)) continue;
        startExtension(ext).catch(err => console.error(`[spindle:${ext.manifest.identifier}]`, err));
    }
}

/** Fan an event out to every running backend. */
export function emitAll(name, payload) {
    for (const rt of runtimes.values()) rt.emit(name, payload);
}

/** Run every registered prompt interceptor, lowest priority first. */
export async function runInterceptors(messages, context) {
    const all = [];
    for (const rt of runtimes.values()) {
        for (const h of rt.handlers) if (h.kind === 'interceptor') all.push({ rt, h });
    }
    all.sort((a, b) => a.h.priority - b.h.priority);
    let parameters = {};
    const breakdown = [];
    for (const { rt, h } of all) {
        const m = rt.ext.manifest;
        const timeout = Math.min(300000, Math.max(1000, Number(m.interceptorTimeoutMs ?? m.interceptor_timeout_ms ?? 10000)));
        try {
            const out = await rt.invoke('interceptor', { id: h.id, messages, context }, timeout);
            if (Array.isArray(out)) messages = out;
            else if (out && Array.isArray(out.messages)) {
                messages = out.messages;
                if (out.parameters && rt.granted.includes('generation_parameters')) parameters = { ...parameters, ...out.parameters };
                for (const b of out.breakdown || []) breakdown.push({ ...b, extension: m.name });
            }
        } catch (err) {
            console.warn(`[spindle:${rt.id}] interceptor skipped: ${err.message}`);
        }
    }
    return { messages, parameters, breakdown };
}

// ---------------------------------------------------------------- hook state & Lumiverse hook chains
/** What the browser needs to know to skip round-trips: registered hook kinds and listened-to events. */
export function hookState() {
    const kinds = {};
    const events = new Set();
    for (const rt of runtimes.values()) {
        for (const h of rt.handlers) kinds[h.kind] = (kinds[h.kind] || 0) + 1;
        for (const e of rt.listening) events.add(e);
    }
    return { kinds, events: [...events] };
}
let hookTimer = null;
function broadcastHookState() {
    clearTimeout(hookTimer);
    hookTimer = setTimeout(() => bridge.broadcast({ type: 'hooks', ...hookState() }), 50);
}
bridge.onConnect(send => send({ type: 'hooks', ...hookState() }));

function handlersOf(kind) {
    const all = [];
    for (const rt of runtimes.values()) for (const h of rt.handlers) if (h.kind === kind) all.push({ rt, h });
    // Lower priority first; registration order breaks ties (sort is stable).
    return all.sort((a, b) => a.h.priority - b.h.priority);
}
const budget = (h, fallback = 10000) => Math.min(120000, Math.max(1000, Number(h.timeoutMs) || fallback));

/**
 * Context handlers (before prompt assembly). Each gets the previous one's context; a result with
 * cancelGeneration: true stops the chain. Errors/timeouts keep the previous context unless the
 * handler registered { required: true }, which cancels the generation.
 */
export async function runContextHandlers(context = {}) {
    let current = context;
    for (const { rt, h } of handlersOf('contextHandler')) {
        try {
            const out = await rt.invoke('contextHandler', { id: h.id, context: current }, budget(h));
            if (out && typeof out === 'object' && !Array.isArray(out)) current = out;
            if (current?.cancelGeneration) return { context: current, cancelled: true, by: rt.id };
        } catch (err) {
            console.warn(`[spindle:${rt.id}] context handler skipped: ${err.message}`);
            if (h.required) return { context: current, cancelled: true, by: rt.id, error: err.message };
        }
    }
    return { context: current, cancelled: false };
}

/**
 * World info interceptors (before activation), with Lumiverse's chain rules: a disable vote anywhere
 * wins over enable/force, content overrides are last-write-wins, each handler sees the previous
 * handlers' effect on the entry list. ctx.entries are WorldInfoInterceptorEntry DTOs.
 */
export async function runWorldInfoInterceptors(ctx = {}) {
    const entries = Array.isArray(ctx.entries) ? ctx.entries : [];
    const ids = new Set(entries.map(e => e.id));
    const disabled = new Set();
    const enabled = new Set();
    const forced = new Set();
    const mutated = {}; // id -> { content?, selectionContent?, outputOrder? }
    let disableRecursion = false;
    const working = () => entries.map(e => {
        const off = disabled.has(e.id);
        const out = { ...e };
        if (off) out.disabled = true;
        else if (enabled.has(e.id) && e.disabled) out.disabled = false;
        if (!off && forced.has(e.id)) out.constant = true;
        if (mutated[e.id]?.content !== undefined) out.content = mutated[e.id].content;
        if (mutated[e.id]?.outputOrder === 'insertion') out.outputOrder = 'insertion';
        return out;
    });
    const settings = ctx.activationSettings || { globalScanDepth: null, maxRecursionPasses: 0 };
    for (const { rt, h } of handlersOf('worldInfoInterceptor')) {
        try {
            const res = await rt.invoke('worldInfoInterceptor', {
                id: h.id,
                ctx: { ...ctx, entries: working(), activationSettings: { ...settings, maxRecursionPasses: disableRecursion ? 0 : settings.maxRecursionPasses } },
            }, budget(h));
            if (!res || typeof res !== 'object') continue;
            for (const id of res.disabled || []) disabled.add(String(id));
            for (const id of res.enabled || []) enabled.add(String(id));
            for (const id of res.forced || []) forced.add(String(id));
            for (const m of res.mutated || []) {
                if (!m || !ids.has(m.id)) continue;
                const cur = (mutated[m.id] ||= {});
                if (m.content !== undefined) cur.content = String(m.content);
                if (m.selectionContent !== undefined) cur.selectionContent = String(m.selectionContent);
                if (m.outputOrder === 'insertion' || m.outputOrder === 'selection') cur.outputOrder = m.outputOrder;
            }
            if (res.activationOverrides?.disableRecursion === true) disableRecursion = true;
        } catch (err) {
            console.warn(`[spindle:${rt.id}] world info interceptor skipped: ${err.message}`);
        }
    }
    return {
        disabled: [...disabled],
        enabled: [...enabled].filter(id => !disabled.has(id)),
        forced: [...forced].filter(id => !disabled.has(id)),
        mutated,
        disableRecursion,
    };
}

/** Macro interceptors: each receives the previous template; a string or { text } replaces it. */
export async function runMacroInterceptors(ctx = {}) {
    let template = String(ctx.template ?? '');
    for (const { rt, h } of handlersOf('macroInterceptor')) {
        if (!template.includes('{{')) break;
        try {
            const res = await rt.invoke('macroInterceptor', { id: h.id, ctx: { ...ctx, template } }, budget(h));
            if (typeof res === 'string') template = res;
            else if (res && typeof res.text === 'string') template = res.text;
        } catch (err) {
            console.warn(`[spindle:${rt.id}] macro interceptor skipped: ${err.message}`);
        }
    }
    return { text: template };
}

/** Message content processors: each sees the previous patch; content replaces, extra shallow-merges. */
export async function runContentProcessors(ctx = {}) {
    let content = String(ctx.content ?? '');
    let extra = ctx.extra && typeof ctx.extra === 'object' ? { ...ctx.extra } : {};
    let changed = false;
    const keepsExtra = !['swipe_add', 'swipe_update', 'render'].includes(ctx.origin);
    for (const { rt, h } of handlersOf('contentProcessor')) {
        try {
            const res = await rt.invoke('contentProcessor', { id: h.id, ctx: { ...ctx, content, extra } }, budget(h));
            if (!res || typeof res !== 'object') continue;
            if (typeof res.content === 'string' && res.content !== content) { content = res.content; changed = true; }
            if (keepsExtra && res.extra && typeof res.extra === 'object') { extra = { ...extra, ...res.extra }; changed = true; }
        } catch (err) {
            console.warn(`[spindle:${rt.id}] content processor skipped: ${err.message}`);
        }
    }
    return { content, extra, changed };
}
