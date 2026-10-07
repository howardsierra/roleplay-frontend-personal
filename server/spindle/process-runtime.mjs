// Child-process runtime for spindle.backendProcesses (a Node port of Lumiverse's
// backend-process-runtime). The parent sends `init`, `message` and `stop`; the child answers with
// `ready`, `heartbeat`, `message`, `complete` and `fail`. Only process.send / process.on are used,
// because extension code may wipe other globals when it locks itself down.
let active = null;
const post = msg => process.send?.(msg);

function shutdown(kind, error) {
    if (active?.terminal) return;
    if (active) {
        active.terminal = true;
        try { active.cleanup?.(); } catch { /* ignore */ }
        active = null;
    }
    post(kind === 'fail' ? { type: 'fail', error } : { type: kind });
    setTimeout(() => process.exit(kind === 'fail' ? 1 : 0), 10);
}

process.on('message', async msg => {
    if (msg?.type === 'init') {
        try {
            const mod = await import(msg.process.entryUrl);
            const handler = typeof mod.default === 'function' ? mod.default : mod.run;
            if (typeof handler !== 'function') throw new Error('Process entry exports no default function');
            const a = { terminal: false, readySent: false, onMessage: new Set(), onStop: new Set() };
            active = a;
            const p = msg.process;
            const ctx = {
                processId: p.processId, entry: p.entry, kind: p.kind, key: p.key, payload: p.payload, userId: p.userId,
                ready() { if (!a.readySent) { a.readySent = true; post({ type: 'ready' }); } },
                heartbeat() { post({ type: 'heartbeat' }); },
                send(payload) { post({ type: 'message', payload }); },
                onMessage(h) { a.onMessage.add(h); return () => a.onMessage.delete(h); },
                complete() { shutdown('complete'); },
                fail(err) { shutdown('fail', String(err?.stack || err)); },
                onStop(h) { a.onStop.add(h); return () => a.onStop.delete(h); },
            };
            const cleanup = await handler(ctx);
            if (typeof cleanup === 'function') a.cleanup = cleanup;
        } catch (err) {
            shutdown('fail', String(err?.stack || err));
        }
    } else if (msg?.type === 'message') {
        for (const h of active?.onMessage ?? []) {
            try { h(msg.payload); } catch (err) { console.error(err); }
        }
    } else if (msg?.type === 'stop') {
        if (!active || active.onStop.size === 0) shutdown('stopped');
        else for (const h of active.onStop) h({ reason: msg.reason });
    }
});
process.on('disconnect', () => process.exit(0));
