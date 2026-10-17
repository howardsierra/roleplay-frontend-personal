// Chat completion, model listing, image generation and API key storage.
// API keys live only on the server (data/secrets.json or environment variables).
import express from 'express';
import path from 'node:path';
import { DATA_DIR, DIRS, newId, readJson, writeJson, writeAtomic } from '../lib/storage.js';
import { CHAT_PROVIDERS, chatCompletion, listModels } from '../lib/providers.js';
import { IMAGE_PROVIDERS, generateImage } from '../lib/imagegen.js';

const router = express.Router();
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

// Environment fallbacks, handy on Railway: set e.g. OPENROUTER_API_KEY in the dashboard.
const ENV_KEYS = {
    openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openrouter: 'OPENROUTER_API_KEY',
    google: 'GOOGLE_API_KEY', deepseek: 'DEEPSEEK_API_KEY', xai: 'XAI_API_KEY', mistral: 'MISTRAL_API_KEY',
    nanogpt: 'NANOGPT_API_KEY', novelai: 'NOVELAI_API_KEY', custom: 'CUSTOM_API_KEY', custom_image: 'CUSTOM_IMAGE_API_KEY',
};

export async function getSecret(name) {
    const secrets = await readJson(SECRETS_FILE, {});
    return secrets[name] || (ENV_KEYS[name] && process.env[ENV_KEYS[name]]) || '';
}

/**
 * Key for a chat request. Saved custom endpoints each have their own key (custom_<id>);
 * the single "custom" key is the fallback, so keys saved before endpoints existed keep working.
 */
async function chatKey(provider, endpointId, baseUrl) {
    if (provider === 'custom' && /^[a-z0-9]{1,32}$/i.test(String(endpointId || ''))) {
        // A saved endpoint's key only goes to that endpoint's own server.
        const settings = await readJson(path.join(DATA_DIR, 'settings.json'), {});
        const saved = (settings.connection?.endpoints || []).find(e => e.id === endpointId);
        const host = u => { try { return new URL(u).host; } catch { return ''; } };
        if (saved?.baseUrl && baseUrl && host(saved.baseUrl) !== host(baseUrl)) return '';
        return (await getSecret(`custom_${endpointId}`)) || getSecret('custom');
    }
    return getSecret(provider);
}

const mask = v => (v ? `••••${String(v).slice(-4)}` : '');

router.get('/providers', (_req, res) => {
    res.json({
        chat: Object.fromEntries(Object.entries(CHAT_PROVIDERS).map(([k, v]) => [k, { label: v.label, base: v.base }])),
        image: Object.fromEntries(Object.entries(IMAGE_PROVIDERS).map(([k, v]) => [k, { label: v.label, base: v.base || '', needsKey: v.needsKey !== false }])),
    });
});

router.get('/secrets', async (_req, res) => {
    const secrets = await readJson(SECRETS_FILE, {});
    const out = {};
    for (const name of new Set([...Object.keys(ENV_KEYS), ...Object.keys(secrets)])) {
        out[name] = secrets[name] ? mask(secrets[name]) : (process.env[ENV_KEYS[name]] ? 'set via environment' : '');
    }
    res.json(out);
});

router.put('/secrets', async (req, res) => {
    const { name, value } = req.body || {};
    if (!name || !/^[a-z0-9_]+$/i.test(name)) return res.status(400).json({ error: 'Bad secret name' });
    const secrets = await readJson(SECRETS_FILE, {});
    if (value) secrets[name] = String(value).trim();
    else delete secrets[name];
    await writeJson(SECRETS_FILE, secrets);
    res.json({ name, masked: mask(secrets[name]) });
});

router.post('/models', async (req, res) => {
    const { provider, baseUrl, endpointId } = req.body || {};
    res.json(await listModels({ provider, baseUrl, key: await chatKey(provider, endpointId, baseUrl) }));
});

// The exact bodies recently sent to providers (no headers, so never API keys), for the Prompt Inspector.
const recentRequests = new Map(); // requestId -> { at, provider, url, body }
function rememberRequest(id, entry) {
    if (!id) return;
    recentRequests.set(String(id).slice(0, 64), { at: Date.now(), ...entry });
    while (recentRequests.size > 20) recentRequests.delete(recentRequests.keys().next().value);
}
router.get('/requests/:id', (req, res) => {
    const entry = recentRequests.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'That request is no longer kept (only the last 20 are)' });
    res.json(entry);
});

/** "fetch failed" says nothing: include the network cause (refused, timed out, DNS…). */
function explain(err) {
    const cause = err?.cause?.code || err?.cause?.message;
    const msg = err?.message || String(err);
    return cause && !msg.includes(cause) ? `${msg} (${cause})` : msg;
}

router.post('/generate', async (req, res) => {
    const { provider, baseUrl, endpointId, model, messages, params = {}, stream = true, requestId } = req.body || {};
    const onRequest = ({ url, body }) => rememberRequest(requestId, { provider, url, body });
    if (!model) return res.status(400).json({ error: 'Pick a model in the Connection panel first' });
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Nothing to send' });
    // Listen for the browser going away first, so a cancelled request never keeps running (and billing).
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const key = await chatKey(provider, endpointId, baseUrl);

    if (!stream) {
        let text = '';
        let reasoning = '';
        try {
            const result = await chatCompletion({
                provider, baseUrl, key, model, messages, params, stream: false, signal: controller.signal, onRequest,
                onText: t => { text += t; }, onReasoning: r => { reasoning += r; },
            });
            return res.json({ text, reasoning, ...result });
        } catch (err) {
            if (controller.signal.aborted) return;
            return res.status(err.status || 502).json({ error: explain(err) });
        }
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    // Keep idle connections (e.g. long thinking) alive through proxies.
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    try {
        const result = await chatCompletion({
            provider, baseUrl, key, model, messages, params, stream: true, signal: controller.signal, onRequest,
            onText: t => send({ t }), onReasoning: r => send({ r }),
        });
        send({ done: true, ...result });
    } catch (err) {
        if (!controller.signal.aborted) send({ error: explain(err) });
    } finally {
        clearInterval(ping);
        res.end();
    }
});

router.post('/images/generate', async (req, res) => {
    const opts = req.body || {};
    const secretName = opts.provider === 'custom' ? 'custom_image' : opts.provider;
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    const { buffer, ext } = await generateImage({ ...opts, key: await getSecret(secretName), signal: controller.signal });
    const name = `${Date.now().toString(36)}-${newId()}.${ext}`;
    await writeAtomic(path.join(DIRS.images, name), buffer);
    res.json({ url: `files/images/${name}`, name });
});

export default router;
