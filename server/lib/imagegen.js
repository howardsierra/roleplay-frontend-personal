// Image generation providers. Each returns { buffer, ext }.
import zlib from 'node:zlib';

export const IMAGE_PROVIDERS = {
    pollinations: { label: 'Pollinations (free, no key)', needsKey: false },
    openai: { label: 'OpenAI (gpt-image / DALL·E)', base: 'https://api.openai.com/v1' },
    openrouter: { label: 'OpenRouter (image models)', base: 'https://openrouter.ai/api/v1' },
    google: { label: 'Google (Gemini image / Imagen)', base: 'https://generativelanguage.googleapis.com/v1beta' },
    novelai: { label: 'NovelAI', base: 'https://image.novelai.net' },
    xai: { label: 'xAI (Grok image)', base: 'https://api.x.ai/v1' },
    nanogpt: { label: 'NanoGPT', base: 'https://nano-gpt.com/api/v1' },
    a1111: { label: 'Stable Diffusion WebUI / Forge (A1111 API)', base: 'http://127.0.0.1:7860', needsKey: false },
    comfyui: { label: 'ComfyUI', base: 'http://127.0.0.1:8188', needsKey: false },
    custom: { label: 'Custom (OpenAI-compatible images)', base: '' },
};

// The provider's 401/403 means a bad API key, not that you're logged out of Reverie.
const upstreamStatus = status => (status >= 500 || status === 401 || status === 403 ? 502 : status);
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function check(res) {
    if (res.ok) return res;
    let text = '';
    try { text = await res.text(); } catch { /* ignore */ }
    try {
        const j = JSON.parse(text);
        text = j.error?.message || j.message || j.detail || text;
    } catch { /* not json */ }
    throw httpError(upstreamStatus(res.status), `Image provider returned ${res.status}: ${String(text).slice(0, 600)}`);
}

function sniffExt(buf) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
    if (buf.subarray(0, 4).toString() === 'RIFF') return 'webp';
    return 'png';
}

function fromBase64(b64) {
    const clean = String(b64).replace(/^data:[^,]+,/, '');
    const buffer = Buffer.from(clean, 'base64');
    return { buffer, ext: sniffExt(buffer) };
}

async function fromUrl(url, signal) {
    if (url.startsWith('data:')) return fromBase64(url);
    const res = await check(await fetch(url, { signal }));
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, ext: sniffExt(buffer) };
}

function aspectRatio(w, h) {
    const r = w / h;
    const options = [['1:1', 1], ['3:4', 0.75], ['4:3', 4 / 3], ['9:16', 9 / 16], ['16:9', 16 / 9], ['2:3', 2 / 3], ['3:2', 1.5]];
    return options.reduce((best, cur) => (Math.abs(cur[1] - r) < Math.abs(best[1] - r) ? cur : best))[0];
}

// Minimal ZIP reader for NovelAI responses (first file only).
function firstZipEntry(buf) {
    if (buf.readUInt32LE(0) !== 0x04034b50) return buf; // not a zip, assume raw image
    const method = buf.readUInt16LE(8);
    let compSize = buf.readUInt32LE(18);
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const start = 30 + nameLen + extraLen;
    if (compSize === 0) {
        // Sizes in data descriptor: locate via central directory.
        const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        compSize = buf.readUInt32LE(cd + 20);
    }
    const data = buf.subarray(start, start + compSize);
    return method === 8 ? zlib.inflateRawSync(data) : data;
}

export async function generateImage(opts) {
    const { provider, key, signal } = opts;
    const p = {
        prompt: String(opts.prompt || '').trim(),
        negative: String(opts.negative || '').trim(),
        width: Number(opts.width) || 1024,
        height: Number(opts.height) || 1024,
        steps: Number(opts.steps) || 28,
        scale: Number(opts.scale) || 6,
        seed: Number.isInteger(opts.seed) && opts.seed >= 0 ? opts.seed : Math.floor(Math.random() * 2 ** 31),
        sampler: opts.sampler || '',
        model: opts.model || '',
        quality: opts.quality || '',
    };
    if (!p.prompt) throw httpError(400, 'Image prompt is empty');
    const def = IMAGE_PROVIDERS[provider];
    if (!def) throw httpError(400, `Unknown image provider: ${provider}`);
    const base = String(opts.baseUrl || def.base || '').replace(/\/+$/, '');

    switch (provider) {
        case 'pollinations': {
            const params = new URLSearchParams({ width: p.width, height: p.height, seed: p.seed, nologo: 'true', private: 'true' });
            if (p.model) params.set('model', p.model);
            if (p.negative) params.set('negative_prompt', p.negative);
            return fromUrl(`https://image.pollinations.ai/prompt/${encodeURIComponent(p.prompt)}?${params}`, signal);
        }
        case 'openai':
        case 'xai':
        case 'nanogpt':
        case 'custom': {
            if (!base) throw httpError(400, 'Image API URL is required');
            const model = p.model || (provider === 'xai' ? 'grok-2-image' : 'gpt-image-1');
            const body = { model, prompt: p.negative ? `${p.prompt}\n\nAvoid: ${p.negative}` : p.prompt, n: 1 };
            if (provider !== 'xai') body.size = `${p.width}x${p.height}`;
            if (/dall-e/i.test(model) || provider !== 'openai') body.response_format = 'b64_json';
            if (p.quality) body.quality = p.quality;
            const res = await check(await fetch(`${base}/images/generations`, {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
                body: JSON.stringify(body),
            }));
            const json = await res.json();
            const item = json.data?.[0];
            if (item?.b64_json) return fromBase64(item.b64_json);
            if (item?.url) return fromUrl(item.url, signal);
            throw httpError(502, 'Image provider returned no image');
        }
        case 'openrouter': {
            const res = await check(await fetch(`${base}/chat/completions`, {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: p.model || 'google/gemini-2.5-flash-image',
                    modalities: ['image', 'text'],
                    image_config: { aspect_ratio: aspectRatio(p.width, p.height) },
                    messages: [{ role: 'user', content: `Generate an image: ${p.prompt}${p.negative ? `\nAvoid: ${p.negative}` : ''}` }],
                }),
            }));
            const json = await res.json();
            const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url;
            if (!url) throw httpError(502, `Model returned no image${json.choices?.[0]?.message?.content ? `: ${json.choices[0].message.content.slice(0, 300)}` : ''}`);
            return fromUrl(url, signal);
        }
        case 'google': {
            const model = p.model || 'gemini-2.5-flash-image';
            if (/^imagen/i.test(model)) {
                const res = await check(await fetch(`${base}/models/${model}:predict`, {
                    method: 'POST', signal,
                    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                    body: JSON.stringify({ instances: [{ prompt: p.prompt }], parameters: { sampleCount: 1, aspectRatio: aspectRatio(p.width, p.height) } }),
                }));
                const json = await res.json();
                const b64 = json.predictions?.[0]?.bytesBase64Encoded;
                if (!b64) throw httpError(502, 'Imagen returned no image (it may have been filtered)');
                return fromBase64(b64);
            }
            const res = await check(await fetch(`${base}/models/${model}:generateContent`, {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: `${p.prompt}${p.negative ? `\nAvoid: ${p.negative}` : ''}` }] }],
                    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], imageConfig: { aspectRatio: aspectRatio(p.width, p.height) } },
                }),
            }));
            const json = await res.json();
            const part = json.candidates?.[0]?.content?.parts?.find(x => x.inlineData || x.inline_data);
            const data = part?.inlineData?.data || part?.inline_data?.data;
            if (!data) throw httpError(502, 'Gemini returned no image (it may have been filtered)');
            return fromBase64(data);
        }
        case 'novelai': {
            const model = p.model || 'nai-diffusion-4-5-full';
            const v4 = /diffusion-4/.test(model);
            const parameters = {
                width: Math.round(p.width / 64) * 64,
                height: Math.round(p.height / 64) * 64,
                scale: p.scale,
                sampler: p.sampler || 'k_euler_ancestral',
                steps: Math.min(p.steps, 50),
                seed: p.seed,
                n_samples: 1,
                ucPreset: 0,
                qualityToggle: true,
                negative_prompt: p.negative,
                params_version: 3,
                noise_schedule: 'karras',
            };
            if (v4) {
                parameters.v4_prompt = { caption: { base_caption: p.prompt, char_captions: [] }, use_coords: false, use_order: true };
                parameters.v4_negative_prompt = { caption: { base_caption: p.negative, char_captions: [] }, legacy_uc: false };
            }
            const res = await check(await fetch(`${base}/ai/generate-image`, {
                method: 'POST', signal,
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({ input: p.prompt, model, action: 'generate', parameters }),
            }));
            const buffer = firstZipEntry(Buffer.from(await res.arrayBuffer()));
            return { buffer, ext: sniffExt(buffer) };
        }
        case 'a1111': {
            const headers = { 'Content-Type': 'application/json' };
            if (key) headers.Authorization = `Basic ${Buffer.from(key).toString('base64')}`;
            const res = await check(await fetch(`${base}/sdapi/v1/txt2img`, {
                method: 'POST', signal, headers,
                body: JSON.stringify({
                    prompt: p.prompt, negative_prompt: p.negative, width: p.width, height: p.height,
                    steps: p.steps, cfg_scale: p.scale, seed: p.seed, sampler_name: p.sampler || 'Euler a',
                    ...(p.model ? { override_settings: { sd_model_checkpoint: p.model } } : {}),
                }),
            }));
            const json = await res.json();
            if (!json.images?.[0]) throw httpError(502, 'WebUI returned no image');
            return fromBase64(json.images[0]);
        }
        case 'comfyui': {
            if (!opts.workflow) throw httpError(400, 'Paste a ComfyUI workflow (API format) in the image settings first');
            const fill = {
                '%prompt%': p.prompt, '%negative_prompt%': p.negative, '%width%': p.width, '%height%': p.height,
                '%seed%': p.seed, '%steps%': p.steps, '%scale%': p.scale, '%model%': p.model, '%sampler%': p.sampler,
            };
            let wf = String(opts.workflow);
            for (const [k, v] of Object.entries(fill)) {
                // Numeric placeholders may be quoted ("%seed%") or bare; strings are JSON-escaped.
                const asJson = JSON.stringify(v);
                wf = wf.split(`"${k}"`).join(asJson).split(k).join(typeof v === 'string' ? asJson.slice(1, -1) : String(v));
            }
            const prompt = JSON.parse(wf);
            const queued = await (await check(await fetch(`${base}/prompt`, {
                method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }),
            }))).json();
            const id = queued.prompt_id;
            for (let i = 0; i < 600; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (signal?.aborted) throw httpError(499, 'Cancelled');
                const hist = await (await check(await fetch(`${base}/history/${id}`, { signal }))).json();
                const outputs = hist[id]?.outputs;
                if (!outputs) continue;
                for (const node of Object.values(outputs)) {
                    const img = node.images?.[0];
                    if (img) {
                        const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || '', type: img.type || 'output' });
                        return fromUrl(`${base}/view?${q}`, signal);
                    }
                }
                throw httpError(502, 'ComfyUI finished but produced no image');
            }
            throw httpError(504, 'ComfyUI timed out');
        }
        default:
            throw httpError(400, `Unsupported image provider: ${provider}`);
    }
}
