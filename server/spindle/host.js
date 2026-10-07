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

// ---------------------------------------------------------------- runtime
class Runtime {
    constructor(ext) {
        this.ext = ext; // { name, manifest, dir }
        this.id = ext.manifest.identifier;
        this.handlers = []; // { kind, id, priority }
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
            try {
                const value = await this.handle(msg.method, msg.args);
                this.worker?.postMessage({ t: 'ret', n: msg.n, value });
            } catch (err) {
                this.worker?.postMessage({ t: 'ret', n: msg.n, error: err?.message || String(err) });
            }
        }
    }

    pushMacros() {
        bridge.broadcast({ type: 'macros', ext: this.id, macros: [...this.macros.values()].map(m => ({ name: m.def.name, value: m.value, pull: m.pull && m.value === undefined, description: m.def.description || '' })) });
    }

    /** Answer a call from the worker. */
    async handle(method, args) {
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
            case 'handlers.register': this.handlers.push(args[0]); return;
            case 'handlers.unregister': this.handlers = this.handlers.filter(h => h.id !== args[0].id); return;
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
            default:
                // Everything else (chats, characters, generation, images, UI…) is answered by the Reverie tab.
                return bridge.call(this.id, method, args);
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
