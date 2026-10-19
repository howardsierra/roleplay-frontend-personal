// HTTP endpoints for the Lumiverse hooks the browser runs during generation and message writes
// (context handlers, world info interceptors, macro interceptors, message content processors).
// Mounted under /api/spindle/hooks. Every endpoint is fail-safe: errors answer with a pass-through.
import express from 'express';
import { hookState, runContextHandlers, runWorldInfoInterceptors, runMacroInterceptors, runContentProcessors } from './host.js';

export const spindleHooksRouter = express.Router();

spindleHooksRouter.get('/', (_req, res) => res.json(hookState()));

spindleHooksRouter.post('/context', async (req, res) => {
    const context = req.body?.context || {};
    try { res.json(await runContextHandlers(context)); } catch (err) { res.json({ context, cancelled: false, error: err.message }); }
});

spindleHooksRouter.post('/world-info', async (req, res) => {
    try { res.json(await runWorldInfoInterceptors(req.body?.ctx || {})); } catch (err) { res.json({ disabled: [], enabled: [], forced: [], mutated: {}, disableRecursion: false, error: err.message }); }
});

spindleHooksRouter.post('/macro', async (req, res) => {
    const ctx = req.body?.ctx || {};
    try { res.json(await runMacroInterceptors(ctx)); } catch (err) { res.json({ text: String(ctx.template ?? ''), error: err.message }); }
});

spindleHooksRouter.post('/content', async (req, res) => {
    const ctx = req.body?.ctx || {};
    try { res.json(await runContentProcessors(ctx)); } catch (err) { res.json({ content: String(ctx.content ?? ''), extra: ctx.extra || {}, changed: false, error: err.message }); }
});
