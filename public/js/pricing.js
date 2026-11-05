// What replies cost (like SillyTavern's "max prompt cost"): prices come from the model list of providers that
// publish them (OpenRouter), are kept on this device for a day, and turn token counts into dollars.
import { api } from './api.js';
import { state, connectionRequest } from './state.js';
import { el, icon } from './ui.js';

const KEY = 'rv-model-prices';
const DAY = 24 * 60 * 60 * 1000;
let cache = null; // { at, provider, models: { id: { in, out, cacheRead, request } } }
let loading = null;

function readCache() {
    if (cache) return cache;
    try { cache = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { cache = null; }
    return cache;
}

/** Fetches the price list for the chat connection (at most once a day unless forced). */
export async function loadPrices({ force = false } = {}) {
    const conn = state.settings.connection;
    const c = readCache();
    if (!force && c && c.provider === conn.provider && Date.now() - c.at < DAY) return c;
    if (loading) return loading;
    loading = api.post('models', connectionRequest(conn)).then(list => {
        const models = Object.fromEntries((list || []).filter(m => m.price).map(m => [m.id, m.price]));
        cache = { at: Date.now(), provider: conn.provider, models };
        try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full */ }
        return cache;
    }).catch(() => readCache()).finally(() => { loading = null; });
    return loading;
}

/** The model's prices if known (synchronous: from the cached list). */
export function priceFor(model = state.settings.connection.model) {
    const c = readCache();
    return (model && c?.models?.[model]) || null;
}

/** Dollars for one reply's tokens, or null when the price isn't known. Cached prompt tokens use the cache price. */
export function costOf({ input = 0, output = 0, cached = 0 }, model) {
    const p = priceFor(model);
    if (!p || (p.in === null && p.out === null)) return null;
    const fresh = Math.max(0, input - (cached || 0));
    return fresh * (p.in || 0) + (cached || 0) * (p.cacheRead ?? p.in ?? 0) + output * (p.out || 0) + (p.request || 0);
}

export const money = x => (x == null ? '–' : x === 0 ? '$0' : x < 0.001 ? '<$0.001' : `$${x < 0.1 ? x.toFixed(4) : x.toFixed(2)}`);

/**
 * A small panel for Settings → Connection: the most a message can cost with the preset's context and reply
 * length, and what the open chat costs per message right now.
 */
export function costPanel() {
    const box = el('div', { class: 'cost-panel hint' });
    const fill = async (force = false) => {
        const conn = state.settings.connection;
        if (!conn.model) { box.replaceChildren(); return; }
        box.replaceChildren(icon('circle-notch', 'fa-spin'), ' Checking prices…');
        await loadPrices({ force });
        const p = priceFor(conn.model);
        if (!p) { box.replaceChildren(el('span', {}, `No price listed for ${conn.model} by this provider (OpenRouter lists them).`)); return; }
        if (!p.in && !p.out) { box.replaceChildren(icon('gift'), el('span', {}, ` ${conn.model} is free.`)); return; }
        const s = state.preset.samplers;
        const context = state.settings.generation.maxContextOverride || s.context_size || 0;
        const reply = s.max_tokens || 0;
        const maxPrompt = Math.max(0, context - reply) * (p.in || 0);
        const maxReply = reply * (p.out || 0);
        const lines = [
            el('div', {}, el('b', {}, `Up to ${money(maxPrompt + maxReply)} per message`), ` (prompt ${money(maxPrompt)} at the full ${context.toLocaleString()}-token context, reply ${money(maxReply)} at ${reply.toLocaleString()} tokens).`),
        ];
        if (state.character && state.chatId) {
            try {
                const { buildPrompt } = await import('./prompt.js');
                const built = await buildPrompt({ dryRun: true });
                lines.push(el('div', {}, `This chat sends ≈${built.tokens.toLocaleString()} tokens: `, el('b', {}, `≈${money(built.tokens * (p.in || 0))}`), ' per message, plus the reply (cached prompt tokens cost less).'));
            } catch { /* no estimate */ }
        }
        lines.push(el('div', { class: 'cost-rates' }, `${conn.model}: $${+((p.in || 0) * 1e6).toFixed(3)} in / $${+((p.out || 0) * 1e6).toFixed(3)} out per million tokens${p.cacheRead != null ? ` · cached input $${+(p.cacheRead * 1e6).toFixed(3)}` : ''}. Thinking counts as reply tokens. Estimates only.`));
        box.replaceChildren(...lines);
    };
    fill();
    return { node: box, refresh: fill };
}
