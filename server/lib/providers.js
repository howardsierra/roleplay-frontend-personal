// Chat-completion providers. Everything is normalized to one streaming shape:
//   onText(str), onReasoning(str), and a final { usage } result.

export const CHAT_PROVIDERS = {
    openai: { label: 'OpenAI', base: 'https://api.openai.com/v1' },
    anthropic: { label: 'Anthropic (Claude)', base: 'https://api.anthropic.com/v1', native: 'anthropic' },
    openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', extended: true },
    google: { label: 'Google AI Studio (Gemini)', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    deepseek: { label: 'DeepSeek', base: 'https://api.deepseek.com/v1' },
    xai: { label: 'xAI (Grok)', base: 'https://api.x.ai/v1' },
    mistral: { label: 'Mistral', base: 'https://api.mistral.ai/v1' },
    nanogpt: { label: 'NanoGPT', base: 'https://nano-gpt.com/api/v1', extended: true },
    custom: { label: 'Custom (OpenAI-compatible)', base: '', extended: true },
};

// The provider's 401/403 means a bad API key, not that you're logged out of Reverie.
const upstreamStatus = status => (status >= 500 || status === 401 || status === 403 ? 502 : status);
const httpError = (status, message) => Object.assign(new Error(message), { status });

export function resolveBase(provider, baseUrl) {
    const def = CHAT_PROVIDERS[provider];
    if (!def) throw httpError(400, `Unknown provider: ${provider}`);
    const base = (baseUrl || def.base || '').trim().replace(/\/+$/, '');
    if (!base) throw httpError(400, 'This connection needs an API URL');
    if (!/^https?:\/\//i.test(base)) throw httpError(400, 'API URL must start with http:// or https://');
    return base;
}

function openaiHeaders(provider, key) {
    const headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = 'https://github.com/howardsierra/roleplay-frontend-personal';
        headers['X-Title'] = 'Reverie';
    }
    return headers;
}

function anthropicHeaders(key) {
    return {
        'Content-Type': 'application/json',
        'x-api-key': key || '',
        'anthropic-version': '2023-06-01',
    };
}

async function upstreamError(res) {
    let detail = '';
    try {
        const body = await res.text();
        try {
            const j = JSON.parse(body);
            detail = j.error?.message || j.error?.metadata?.raw || j.message || j.detail || body;
            if (typeof detail !== 'string') detail = JSON.stringify(detail);
        } catch { detail = body; }
    } catch { /* ignore */ }
    const hint = res.status === 401 || res.status === 403 ? ' (check the API key for this provider)' : '';
    return httpError(upstreamStatus(res.status), `Provider returned ${res.status}${hint}: ${String(detail).slice(0, 800)}`);
}

export async function listModels({ provider, baseUrl, key }) {
    const base = resolveBase(provider, baseUrl);
    const res = await fetch(`${base}/models${provider === 'anthropic' ? '?limit=1000' : ''}`, {
        headers: provider === 'anthropic' ? anthropicHeaders(key) : openaiHeaders(provider, key),
    });
    if (!res.ok) throw await upstreamError(res);
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json.data || json.models || []);
    return list
        .map(m => (typeof m === 'string' ? { id: m } : { id: m.id || m.name, name: m.display_name || m.name, context: m.context_length }))
        .filter(m => m.id)
        .map(m => ({ ...m, id: String(m.id).replace(/^models\//, '') }))
        .sort((a, b) => a.id.localeCompare(b.id));
}

// ---------- SSE parsing ----------
async function* sseEvents(body, signal) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body) {
        if (signal?.aborted) return;
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
            let event = 'message';
            const data = [];
            for (const line of block.split(/\r?\n/)) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
            }
            if (data.length) yield { event, data: data.join('\n') };
        }
    }
}

// ---------- OpenAI-compatible ----------
function buildOpenAIBody(provider, model, messages, p, stream) {
    const body = { model, messages, stream };
    const reasoningModel = provider === 'openai' && /^(o\d|gpt-5)/i.test(model);
    const set = (k, v) => { if (v !== undefined && v !== null && v !== '' && !Number.isNaN(v)) body[k] = v; };
    if (reasoningModel) {
        set('max_completion_tokens', p.max_tokens);
        set('reasoning_effort', p.reasoning_effort || undefined);
    } else {
        set('max_tokens', p.max_tokens);
        set('temperature', p.temperature);
        set('top_p', p.top_p);
        set('frequency_penalty', p.frequency_penalty || undefined);
        set('presence_penalty', p.presence_penalty || undefined);
        if (CHAT_PROVIDERS[provider]?.extended) {
            set('top_k', p.top_k || undefined);
            set('min_p', p.min_p || undefined);
            set('repetition_penalty', p.repetition_penalty && p.repetition_penalty !== 1 ? p.repetition_penalty : undefined);
            set('top_a', p.top_a || undefined);
        }
    }
    if (Array.isArray(p.stop) && p.stop.length) body.stop = p.stop.slice(0, 4);
    if (Number.isInteger(p.seed) && p.seed >= 0) body.seed = p.seed;
    if (provider === 'openrouter') {
        if (p.reasoning_effort) body.reasoning = { effort: p.reasoning_effort };
        body.include_reasoning = true;
        if (p.openrouter_providers?.length) body.provider = { order: p.openrouter_providers };
    } else if (p.reasoning_effort && !reasoningModel && ['xai', 'google', 'custom', 'nanogpt'].includes(provider)) {
        body.reasoning_effort = p.reasoning_effort;
    }
    if (stream && provider !== 'custom') body.stream_options = { include_usage: true };
    return body;
}

async function chatOpenAI({ provider, baseUrl, key, model, messages, params, stream, signal, onText, onReasoning }) {
    const base = resolveBase(provider, baseUrl);
    const body = { ...buildOpenAIBody(provider, model, messages, params, stream), ...(params.custom_body || {}) };
    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST', headers: openaiHeaders(provider, key), body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw await upstreamError(res);
    if (!stream) {
        const json = await res.json();
        if (json.error) throw httpError(502, json.error.message || JSON.stringify(json.error));
        const msg = json.choices?.[0]?.message || {};
        const reasoning = msg.reasoning_content || msg.reasoning || '';
        if (reasoning) onReasoning(reasoning);
        onText(typeof msg.content === 'string' ? msg.content : (msg.content || []).map(x => x.text || '').join(''));
        return { usage: json.usage, finish: json.choices?.[0]?.finish_reason };
    }
    let usage;
    let finish;
    for await (const { data } of sseEvents(res.body, signal)) {
        if (data === '[DONE]') break;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.error) throw httpError(502, json.error.message || JSON.stringify(json.error));
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) onReasoning(reasoning);
        if (typeof delta.content === 'string' && delta.content) onText(delta.content);
        if (choice.finish_reason) finish = choice.finish_reason;
    }
    return { usage, finish };
}

// ---------- Anthropic native ----------
const THINKING_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 16384, max: 32000 };

/** OpenAI-style content (string or parts with image_url) → Anthropic content blocks. */
function anthropicBlocks(content) {
    if (!Array.isArray(content)) return [{ type: 'text', text: String(content ?? '') }];
    const out = [];
    for (const part of content) {
        if (part?.type === 'text') out.push({ type: 'text', text: String(part.text ?? '') });
        else if (part?.type === 'image_url' || part?.type === 'image') {
            const url = part.image_url?.url || part.url || (part.data ? `data:${part.mime_type || 'image/png'};base64,${part.data}` : '');
            const m = String(url).match(/^data:([^;]+);base64,(.+)$/);
            if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
            else if (url) out.push({ type: 'image', source: { type: 'url', url } });
        }
    }
    return out;
}
const textOf = content => (Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : String(content ?? ''));

export function toAnthropic(messages, { cacheSystem = true } = {}) {
    const system = [];
    let i = 0;
    while (i < messages.length && messages[i].role === 'system') system.push(textOf(messages[i++].content));
    const out = [];
    for (const m of messages.slice(i)) {
        const role = m.role === 'assistant' ? 'assistant' : 'user';
        // Mid-chat system prompts become user turns (Claude has no mid-chat system role).
        const content = m.content;
        const last = out.at(-1);
        const multimodal = Array.isArray(content) || Array.isArray(last?.content);
        if (last && last.role === role) {
            if (multimodal) last.content = [...anthropicBlocks(last.content), { type: 'text', text: '\n\n' }, ...anthropicBlocks(content)].filter(b => b.type !== 'text' || b.text);
            else last.content += `\n\n${content}`;
        } else out.push({ role, content: Array.isArray(content) ? anthropicBlocks(content) : String(content ?? '') });
    }
    if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '[Start]' });
    const systemText = system.join('\n\n').trim();
    const systemBlocks = systemText ? [{ type: 'text', text: systemText, ...(cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}) }] : undefined;
    return { system: systemBlocks, messages: out.filter(m => m.content !== '' || m === out.at(-1)) };
}

async function chatAnthropic({ baseUrl, key, model, messages, params: p, stream, signal, onText, onReasoning }) {
    const base = resolveBase('anthropic', baseUrl);
    const converted = toAnthropic(messages, { cacheSystem: p.cache_system !== false });
    // A trailing assistant message acts as a prefill; Claude rejects trailing whitespace there.
    const last = converted.messages.at(-1);
    if (last?.role === 'assistant' && typeof last.content === 'string') last.content = last.content.trimEnd();
    if (last?.role === 'assistant' && !last.content) converted.messages.pop();
    const body = {
        model,
        max_tokens: p.max_tokens || 4096,
        messages: converted.messages,
        stream,
    };
    if (converted.system) body.system = converted.system;
    const thinking = p.reasoning_effort && THINKING_BUDGET[p.reasoning_effort];
    if (thinking) {
        body.thinking = { type: 'enabled', budget_tokens: Math.min(thinking, Math.max(1024, body.max_tokens - 1)) };
        if (body.max_tokens <= body.thinking.budget_tokens) body.max_tokens = body.thinking.budget_tokens + 2048;
        // Extended thinking cannot be combined with an assistant prefill.
        if (converted.messages.at(-1)?.role === 'assistant') {
            const prefill = converted.messages.pop();
            const prev = converted.messages.at(-1);
            if (typeof prev.content === 'string') prev.content += `\n\n${textOf(prefill.content)}`;
            else prev.content.push({ type: 'text', text: textOf(prefill.content) });
        }
    } else {
        if (p.temperature != null) body.temperature = Math.min(1, p.temperature);
        else if (p.top_p != null) body.top_p = p.top_p;
        if (p.top_k) body.top_k = p.top_k;
    }
    if (Array.isArray(p.stop) && p.stop.length) body.stop_sequences = p.stop.filter(s => s.trim());
    Object.assign(body, p.custom_body || {});

    const res = await fetch(`${base}/messages`, { method: 'POST', headers: anthropicHeaders(key), body: JSON.stringify(body), signal });
    if (!res.ok) throw await upstreamError(res);
    if (!stream) {
        const json = await res.json();
        for (const block of json.content || []) {
            if (block.type === 'thinking') onReasoning(block.thinking);
            if (block.type === 'text') onText(block.text);
        }
        return { usage: json.usage, finish: json.stop_reason };
    }
    let usage;
    let finish;
    for await (const { data } of sseEvents(res.body, signal)) {
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.type === 'error') throw httpError(502, json.error?.message || 'Anthropic stream error');
        if (json.type === 'message_start') usage = json.message?.usage;
        if (json.type === 'content_block_delta') {
            if (json.delta?.type === 'text_delta') onText(json.delta.text);
            if (json.delta?.type === 'thinking_delta') onReasoning(json.delta.thinking);
        }
        if (json.type === 'message_delta') {
            usage = { ...usage, ...json.usage };
            finish = json.delta?.stop_reason;
        }
    }
    return { usage, finish };
}

export function chatCompletion(opts) {
    if (CHAT_PROVIDERS[opts.provider]?.native === 'anthropic') return chatAnthropic(opts);
    return chatOpenAI(opts);
}
