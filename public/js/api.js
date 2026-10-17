// Thin fetch wrapper for the Reverie server.

async function handle(res) {
    // Only Reverie's own login check sends people to the password screen.
    if (res.status === 401 && res.headers.get('X-Reverie-Auth') === 'login-required') {
        location.href = 'login.html';
        throw new Error('Not logged in');
    }
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(body?.error || body || `Request failed (${res.status})`);
    return body;
}

export const api = {
    get: (url, opts = {}) => fetch(`api/${url}`, opts).then(handle),
    post: (url, data, opts = {}) => fetch(`api/${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}), ...opts,
    }).then(handle),
    put: (url, data) => fetch(`api/${url}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data ?? {}),
    }).then(handle),
    del: url => fetch(`api/${url}`, { method: 'DELETE' }).then(handle),
    upload: (url, blob) => fetch(`api/${url}`, { method: 'POST', body: blob }).then(handle),
};

/** Stream a chat completion. Calls onText / onReasoning for each chunk. */
export async function streamCompletion(body, { onText, onReasoning, signal }) {
    const res = await fetch('api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
    });
    if (!res.ok) await handle(res);
    if (!String(res.headers.get('content-type') || '').includes('text/event-stream')) {
        throw new Error('The server answered with something other than a reply stream (a proxy or login page?)');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = {};
    const handleLine = line => {
        if (!line.startsWith('data:')) return; // comments / keep-alives
        let msg;
        try { msg = JSON.parse(line.slice(5).trim()); } catch { return; } // a garbled line shouldn't end the reply
        if (msg.error) throw new Error(msg.error);
        if (msg.t) onText?.(msg.t);
        if (msg.r) onReasoning?.(msg.r);
        if (msg.done) result = msg;
    };
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (line) handleLine(line);
        }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer.trim());
    // No "done" from the server: the connection dropped part-way (a timeout, a restart…).
    if (!result.done) throw new Error('The connection dropped before the reply was finished');
    return result;
}

/** One non-streamed reply. Inline thinking (<think>…</think>) is moved out of `text` into `reasoning`. */
export async function completion(body, { signal } = {}) {
    const res = await api.post('generate', { ...body, stream: false }, { signal });
    if (typeof res?.text === 'string') {
        const { splitReasoning } = await import('./reasoning.js');
        const split = splitReasoning(res.text);
        if (split.reasoning) {
            res.text = split.text.trim();
            res.reasoning = [res.reasoning, split.reasoning].filter(Boolean).join('\n\n');
        }
    }
    return res;
}
