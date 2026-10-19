// Lumiverse frontend processes: ctx.processes.register(kind, handler) on the frontend, supervised by
// the backend through spindle.frontendProcesses.spawn/send/stop/list/get. Process messages and
// lifecycle changes travel to the backend over the extension's frontend→backend channel, tagged so
// the worker routes them to frontendProcesses.onMessage / onLifecycle rather than onFrontendMessage.
import { api } from '../api.js';

const handlers = new Map(); // ext -> Map<kind, handler>
const procs = new Map(); // processId -> record

const notify = (ext, body) => api.post(`spindle/${encodeURIComponent(ext)}/message`, { payload: { __rvFrontendProcess: body } }).catch(() => {});

export function registerFrontendProcess(ext, kind, handler) {
    const k = String(kind || '').trim();
    if (!k) throw new Error('process kind is required');
    if (typeof handler !== 'function') throw new TypeError('process handler must be a function');
    if (!handlers.has(ext)) handlers.set(ext, new Map());
    handlers.get(ext).set(k, handler);
    return () => { if (handlers.get(ext)?.get(k) === handler) handlers.get(ext).delete(k); };
}

function info(r) {
    return {
        processId: r.processId, kind: r.kind, key: r.key, state: r.state, userId: 'owner', metadata: { ...(r.metadata || {}) },
        startedAt: r.startedAt, readyAt: r.readyAt || null, lastHeartbeatAt: r.lastBeat || null, endedAt: r.endedAt || null,
        exitReason: r.exitReason || null, error: r.error || null,
    };
}

function lifecycle(r, state, extra = {}) {
    r.state = state;
    Object.assign(r, extra);
    notify(r.ext, { event: 'lifecycle', ...info(r) });
}

async function finish(r, state, extra = {}) {
    if (r.done) return;
    r.done = true;
    clearTimeout(r.startup);
    clearInterval(r.watchdog);
    try { await r.cleanup?.(); } catch (err) { console.error(`[${r.ext}] process cleanup`, err); }
    procs.delete(r.processId);
    lifecycle(r, state, { endedAt: Date.now(), exitReason: extra.exitReason || state, ...extra });
    if (!r.readyAt) r.reject?.(new Error(extra.error || `Process ${state} before it was ready`));
}

/** spindle.frontendProcesses.spawn → resolves with the process info once the handler calls ready(). */
export function spawnFrontendProcess(ext, opts = {}) {
    const kind = String(opts.kind || '').trim();
    const handler = handlers.get(ext)?.get(kind);
    if (!handler) return Promise.reject(new Error(`No frontend process registered for kind "${kind}"`));
    if (opts.key !== undefined && opts.replaceExisting) {
        for (const r of [...procs.values()]) if (r.ext === ext && r.kind === kind && r.key === opts.key) stopFrontendProcess(ext, r.processId, { reason: 'replaced' });
    }
    const processId = crypto.randomUUID ? crypto.randomUUID() : `fp-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const r = { ext, processId, kind, key: opts.key, metadata: opts.metadata || {}, startedAt: Date.now(), state: 'starting', messages: new Set(), stops: new Set() };
    procs.set(processId, r);
    return new Promise((resolve, reject) => {
        r.reject = reject;
        lifecycle(r, 'starting');
        r.startup = setTimeout(() => finish(r, 'timed_out', { error: 'startup timeout' }), Math.max(1000, Number(opts.startupTimeoutMs) || 15000));
        const beatMs = Number(opts.heartbeatTimeoutMs) || 15000;
        const process = {
            processId, kind, key: opts.key, payload: opts.payload, metadata: { ...(opts.metadata || {}) },
            ready() {
                if (r.readyAt || r.done) return;
                r.readyAt = r.lastBeat = Date.now();
                clearTimeout(r.startup);
                r.watchdog = setInterval(() => { if (Date.now() - r.lastBeat > beatMs) finish(r, 'timed_out', { error: 'heartbeat timeout' }); }, Math.min(beatMs, 5000));
                lifecycle(r, 'running');
                resolve(info(r));
            },
            heartbeat() { r.lastBeat = Date.now(); },
            send(payload) { if (!r.done) notify(ext, { event: 'message', processId, kind, key: opts.key, payload }); },
            onMessage(fn) { r.messages.add(fn); return () => r.messages.delete(fn); },
            onStop(fn) { r.stops.add(fn); return () => r.stops.delete(fn); },
            complete() { finish(r, 'completed'); },
            fail(error) { finish(r, 'failed', { error: error instanceof Error ? error.message : String(error ?? 'failed') }); },
        };
        Promise.resolve().then(() => handler(process)).then(cleanup => { if (typeof cleanup === 'function') r.cleanup = cleanup; }, err => finish(r, 'failed', { error: err?.message || String(err) }));
    });
}

export function sendToFrontendProcess(ext, processId, payload) {
    const r = procs.get(processId);
    if (!r || r.ext !== ext) return false;
    for (const fn of r.messages) { try { fn(payload); } catch (err) { console.error(`[${ext}] process message handler`, err); } }
    return true;
}

export async function stopFrontendProcess(ext, processId, opts = {}) {
    const r = procs.get(processId);
    if (!r || r.ext !== ext || r.done) return;
    lifecycle(r, 'stopping');
    for (const fn of r.stops) { try { fn({ reason: opts?.reason || 'stopped' }); } catch (err) { console.error(err); } }
    // Give the handler a moment to call complete() itself.
    setTimeout(() => finish(r, 'stopped', { exitReason: opts?.reason || 'stopped' }), 3000);
}

export function listFrontendProcesses(ext, filter = {}) {
    return [...procs.values()].filter(r => r.ext === ext && (!filter?.kind || r.kind === filter.kind) && (!filter?.state || r.state === filter.state)).map(info);
}
export const getFrontendProcess = (ext, processId) => { const r = procs.get(processId); return r && r.ext === ext ? info(r) : null; };

/** The extension's frontend is going away. */
export function disposeFrontendProcesses(ext) {
    for (const r of [...procs.values()]) if (r.ext === ext) finish(r, 'stopped', { exitReason: 'frontend_unloaded' });
    handlers.delete(ext);
}
