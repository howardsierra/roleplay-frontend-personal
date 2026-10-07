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
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result = {};
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of block.split('\n')) {
                if (!line.startsWith('data: ')) continue;
                const msg = JSON.parse(line.slice(6));
                if (msg.error) throw new Error(msg.error);
                if (msg.t) onText?.(msg.t);
                if (msg.r) onReasoning?.(msg.r);
                if (msg.done) result = msg;
            }
        }
    }
    return result;
}

export async function completion(body, { signal } = {}) {
    return api.post('generate', { ...body, stream: false }, { signal });
}
