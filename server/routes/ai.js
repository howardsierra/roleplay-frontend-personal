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

async function getSecret(name) {
    const secrets = await readJson(SECRETS_FILE, {});
    return secrets[name] || (ENV_KEYS[name] && process.env[ENV_KEYS[name]]) || '';
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
    const { provider, baseUrl } = req.body || {};
    res.json(await listModels({ provider, baseUrl, key: await getSecret(provider) }));
});

router.post('/generate', async (req, res) => {
    const { provider, baseUrl, model, messages, params = {}, stream = true } = req.body || {};
    if (!model) return res.status(400).json({ error: 'Pick a model in the Connection panel first' });
    if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'Nothing to send' });
    const key = await getSecret(provider);
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableFinished) controller.abort(); });

    if (!stream) {
        let text = '';
        let reasoning = '';
        try {
            const result = await chatCompletion({
                provider, baseUrl, key, model, messages, params, stream: false, signal: controller.signal,
                onText: t => { text += t; }, onReasoning: r => { reasoning += r; },
            });
            return res.json({ text, reasoning, ...result });
        } catch (err) {
            if (controller.signal.aborted) return;
            return res.status(err.status || 502).json({ error: err.message });
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
            provider, baseUrl, key, model, messages, params, stream: true, signal: controller.signal,
            onText: t => send({ t }), onReasoning: r => send({ r }),
        });
        send({ done: true, ...result });
    } catch (err) {
        if (!controller.signal.aborted) send({ error: err.message || String(err) });
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
