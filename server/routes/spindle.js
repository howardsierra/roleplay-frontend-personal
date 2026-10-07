// HTTP side of the Spindle (Lumiverse extension) host: the browser bridge, events,
// prompt interceptors, macros, frontend messages, OAuth callbacks and extension management.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { bridge } from '../spindle/bridge.js';
import { HOST_VERSION, runtimes, listSpindleExtensions, startExtension, stopExtension, setDisabled, spindleState, emitAll, runInterceptors } from '../spindle/host.js';
import { DIRS, safeName, within } from '../lib/storage.js';

export const spindleRouter = express.Router();
export const spindleServe = express.Router();

spindleRouter.get('/stream', (req, res) => bridge.connect(req, res));
spindleRouter.post('/reply', (req, res) => { bridge.reply(req.body || {}); res.json({ ok: true }); });

/** Extensions with their runtime status, plus the macros and tools their backends registered. */
spindleRouter.get('/', async (_req, res) => {
    const { disabled = [] } = await spindleState();
    const list = await listSpindleExtensions();
    res.json(list.map(ext => {
        const rt = runtimes.get(ext.manifest.identifier);
        return {
            name: ext.name,
            manifest: ext.manifest,
            enabled: !disabled.includes(ext.manifest.identifier),
            status: rt?.status || 'stopped',
            error: rt?.error || null,
            hasFrontend: fs.existsSync(path.join(ext.dir, ext.manifest.entry_frontend || 'dist/frontend.js')),
            macros: rt ? [...rt.macros.values()].map(m => ({ name: m.def.name, value: m.value, pull: m.pull && m.value === undefined, description: m.def.description || '' })) : [],
            tools: rt ? [...rt.tools.values()] : [],
        };
    }));
});

spindleRouter.post('/:id/enable', async (req, res) => {
    const id = String(req.params.id);
    const enabled = !!req.body?.enabled;
    await setDisabled(id, !enabled);
    if (enabled) {
        const ext = (await listSpindleExtensions()).find(e => e.manifest.identifier === id);
        if (!ext) return res.status(404).json({ error: 'Not installed' });
        await startExtension(ext);
    } else await stopExtension(id);
    res.json({ ok: true, status: runtimes.get(id)?.status || 'stopped' });
});

spindleRouter.post('/:id/restart', async (req, res) => {
    const ext = (await listSpindleExtensions()).find(e => e.manifest.identifier === req.params.id);
    if (!ext) return res.status(404).json({ error: 'Not installed' });
    await startExtension(ext);
    res.json({ ok: true, status: runtimes.get(ext.manifest.identifier)?.status });
});

/** A Reverie event, translated to Lumiverse's names by the browser, fanned out to every backend. */
spindleRouter.post('/event', (req, res) => {
    const { name, payload } = req.body || {};
    if (name) emitAll(String(name), payload ?? {});
    res.json({ ok: true });
});

spindleRouter.post('/intercept', async (req, res) => {
    const { messages = [], context = {} } = req.body || {};
    res.json(await runInterceptors(messages, context));
});

/** Message from an extension's frontend (ctx.sendToBackend) to its backend. */
spindleRouter.post('/:id/message', async (req, res) => {
    const rt = runtimes.get(req.params.id);
    if (!rt) return res.status(404).json({ error: 'Not running' });
    const payload = req.body?.payload;
    if (payload?.type === 'message_tag_intercepted') emitAll('MESSAGE_TAG_INTERCEPTED', { extensionId: rt.id, identifier: rt.id, ...payload });
    rt.invoke('frontendMessage', { payload, userId: 'owner' }).catch(err => console.warn(`[spindle:${rt.id}]`, err.message));
    res.json({ ok: true });
});

/** Pull-model macros: ask the backend for a value right now. */
spindleRouter.post('/:id/macro/:name', async (req, res) => {
    const rt = runtimes.get(req.params.id);
    if (!rt) return res.json({ value: '' });
    try {
        res.json({ value: await rt.invoke('macro', { name: req.params.name, ctx: req.body || {} }, 5000) });
    } catch (err) {
        res.json({ value: '', error: err.message });
    }
});

/** Tool / command invocation from the browser. */
spindleRouter.post('/:id/tool/:name', async (req, res) => {
    const rt = runtimes.get(req.params.id);
    if (!rt) return res.status(404).json({ error: 'Not running' });
    res.json({ result: await rt.invoke('tool', { name: req.params.name, args: req.body?.args || {}, context: req.body?.context || {} }, 120000) });
});

spindleRouter.post('/:id/command', async (req, res) => {
    const rt = runtimes.get(req.params.id);
    if (!rt) return res.status(404).json({ error: 'Not running' });
    await rt.invoke('command', { payload: req.body || {} });
    res.json({ ok: true });
});

/** OAuth redirect target (the provider sends the user's browser to /api/spindle-oauth/<id>/callback). */
export const oauthRouter = express.Router();
oauthRouter.get('/:id/callback', async (req, res) => {
    const rt = runtimes.get(req.params.id);
    let html = null;
    let ok = !!rt;
    if (rt) {
        try {
            const out = await rt.invoke('oauth', { params: { ...req.query } }, 60000);
            html = typeof out === 'string' ? out : out?.html || null;
        } catch (err) { ok = false; console.warn(`[spindle:${rt.id}] oauth`, err.message); }
    }
    res.type('html').send(html || `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0c0a13;color:#ece7f5;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center"><div><h2>${ok ? '✦ Connected' : 'Something went wrong'}</h2><p>You can close this window and go back to Reverie.</p></div><script>setTimeout(()=>window.close(),1500)</script>`);
});

/** Lumiverse URL shapes some extensions hardcode. */
export const lumiverseAliases = express.Router();
lumiverseAliases.get('/system/info', (_req, res) => res.json({ backend: { version: HOST_VERSION }, frontend: { version: HOST_VERSION }, host: 'reverie' }));
lumiverseAliases.get(['/images/:id', '/image-gen/results/:id'], (req, res, next) => {
    // Gallery images first, then character avatars (a character's image_id is its avatar file).
    const name = safeName(req.params.id);
    const file = [within(DIRS.images, name), within(DIRS.avatars, name)].find(f => fs.existsSync(f));
    if (!file) return next();
    res.set('Cache-Control', 'private, max-age=86400');
    res.sendFile(file);
});

// Frontend bundles and assets: /lv-extensions/<folder>/<file>
spindleServe.get(/^\/lv-extensions\/([^/]+)\/(.+)$/, (req, res, next) => {
    const base = within(DIRS.extensions, safeName(decodeURIComponent(req.params[0])));
    const rel = decodeURIComponent(req.params[1]).replace(/^\/+/, '');
    const file = path.resolve(base, rel);
    if (!file.startsWith(base + path.sep) || rel.split('/').includes('.git')) return res.status(403).end();
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next();
    res.set('Cache-Control', 'no-cache');
    if (/\.m?js$/.test(file)) res.type('application/javascript');
    res.sendFile(file);
});
