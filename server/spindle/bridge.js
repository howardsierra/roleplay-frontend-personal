// Server ⇄ browser channel for Spindle extensions. The server pushes over Server-Sent Events;
// the browser answers calls with POST /api/spindle/reply. Reverie is single-user, so a call goes
// to the most recently connected tab and the first answer wins.
const clients = new Set(); // { res, at }
const pending = new Map(); // n -> { resolve, reject, timer }
let seq = 0;
let lastOrigin = '';

export const bridge = {
    connect(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\n\n');
        const client = { res, at: Date.now() };
        clients.add(client);
        lastOrigin = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(client); });
    },

    connected: () => clients.size > 0,
    origin: () => lastOrigin || `http://localhost:${process.env.PORT || 8000}`,

    broadcast(msg) {
        const data = `data: ${JSON.stringify(msg)}\n\n`;
        for (const c of clients) c.res.write(data);
    },

    /** Ask the open Reverie tab to perform `method` for extension `ext`. */
    call(ext, method, args, timeoutMs = method.startsWith('generate') || method.startsWith('imageGen') ? 600000 : 60000) {
        const newest = [...clients].sort((a, b) => b.at - a.at)[0];
        if (!newest) return Promise.reject(new Error('Open Reverie in a browser tab for this to work'));
        return new Promise((resolve, reject) => {
            const n = ++seq;
            const timer = setTimeout(() => { pending.delete(n); reject(new Error(`Reverie didn't answer ${method} in time`)); }, timeoutMs);
            pending.set(n, { resolve, reject, timer });
            newest.res.write(`data: ${JSON.stringify({ type: 'call', n, ext, method, args })}\n\n`);
        });
    },

    reply({ n, value, error }) {
        const p = pending.get(Number(n));
        if (!p) return;
        pending.delete(Number(n));
        clearTimeout(p.timer);
        if (error) p.reject(new Error(error)); else p.resolve(value);
    },
};
