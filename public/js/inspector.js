// Generation details (per-reply timings + tokens) and the Prompt / Context Inspector.
import { state, saveSettingsDebounced, customEndpoint } from './state.js';
import { api } from './api.js';
import { buildPrompt, estimateTokens } from './prompt.js';
import { el, icon, toast, modal } from './ui.js';

// ---------------------------------------------------------------- captures
// What was sent for the last few generations, newest last. Kept in memory only.
const captures = [];

export function newRequestId() {
    return `rv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function recordCapture(capture) {
    captures.push({ at: Date.now(), ...capture });
    while (captures.length > 20) captures.shift();
}

/** The capture for a message (by its id and swipe), else the newest one. */
function findCapture(mesKey) {
    if (mesKey) {
        const hit = captures.findLast(c => c.mesKey === mesKey);
        if (hit) return hit;
    }
    return null;
}

export function connectionLabel(c = state.settings.connection) {
    const ep = customEndpoint(c);
    const provider = state.providers?.chat?.[c.provider]?.label || c.provider || '';
    return ep?.name ? `${provider} · ${ep.name}` : provider;
}

// ---------------------------------------------------------------- generation details row
const fmtDur = ms => {
    if (ms == null || !Number.isFinite(ms)) return '–';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s < 1 && ms > 0 ? (ms / 1000).toFixed(1) : s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
};
const fmtNum = n => (n == null ? '–' : Number(n).toLocaleString());

/** Builds extra.gen from the timings and the provider's usage report (estimates when there is none). */
export function generationStats({ startedAt, firstTextAt, endedAt, usage, promptTokens, outputText, reasoningText, requestId }) {
    const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? null;
    const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? null;
    const estimated = inTok == null || outTok == null;
    const input = inTok ?? promptTokens;
    const output = outTok ?? estimateTokens(`${reasoningText || ''}${outputText || ''}`);
    const think = firstTextAt ? firstTextAt - startedAt : endedAt - startedAt;
    return {
        think_ms: think,
        post_ms: firstTextAt ? endedAt - firstTextAt : 0,
        total_ms: endedAt - startedAt,
        in: input,
        out: output,
        total: usage?.total_tokens ?? input + output,
        cached: usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens ?? undefined,
        estimated,
        requestId,
    };
}

export function renderGenDetails(node, mes, id, { streaming }) {
    const block = node.querySelector('.mes_block');
    if (!block) return;
    let row = block.querySelector(':scope > .rv-gen');
    const gen = mes.extra?.gen;
    if (!gen || streaming || mes.is_user || !state.settings.appearance.genDetails) { row?.remove(); return; }
    if (!row) {
        row = el('div', { class: 'rv-gen' });
        block.append(row);
    }
    const open = !!state.settings.appearance.genDetailsOpen;
    const approx = gen.estimated ? '≈' : '';
    const stat = (label, value) => el('span', { class: 'rv-gen-stat' }, el('span', { class: 'rv-gen-k' }, label), ' ', el('b', {}, value));
    row.replaceChildren(...[
        el('button', { class: 'rv-gen-toggle', 'data-act': 'gen-toggle', title: open ? 'Hide generation details' : 'Show generation details' },
            icon(open ? 'chevron-down' : 'chevron-right'), open ? 'Hide generation details' : 'Show generation details'),
        open ? el('div', { class: 'rv-gen-body' },
            el('span', { class: 'rv-gen-title' }, 'Generation'),
            stat('Think:', fmtDur(gen.think_ms)),
            stat('Post:', fmtDur(gen.post_ms)),
            stat('Total:', fmtDur(gen.total_ms)),
            el('span', { class: 'rv-gen-sep' }),
            stat('In:', approx + fmtNum(gen.in)),
            stat('Out:', approx + fmtNum(gen.out)),
            stat('Total tok:', approx + fmtNum(gen.total)),
            gen.cached ? stat('Cached:', fmtNum(gen.cached)) : null,
            el('button', { class: 'rv-gen-inspect', 'data-act': 'inspect', title: 'Open the Prompt Inspector for this reply' }, icon('magnifying-glass'), 'Inspect'),
        ) : null,
    ].filter(Boolean));
}

export function toggleGenDetails() {
    state.settings.appearance.genDetailsOpen = !state.settings.appearance.genDetailsOpen;
    saveSettingsDebounced();
}

export const captureKey = (mesId, swipeId) => `${mesId}#${swipeId ?? 0}`;

// ---------------------------------------------------------------- inspector
const ROLE_ICON = { system: 'gear', user: 'user', assistant: 'feather' };

/**
 * Opens the Prompt / Context Inspector. With a message key, shows what was sent for that reply;
 * otherwise (or if it's no longer kept) shows a dry run of what the next message would send.
 */
export async function showInspector({ mesKey, gen } = {}) {
    if (!state.character) return toast('Open a chat first', 'warning');
    let cap = findCapture(mesKey);
    let dry = false;
    if (!cap) {
        const built = await buildPrompt({ type: 'normal', dryRun: true });
        dry = true;
        cap = {
            at: Date.now(), messages: built.messages, labels: built.labels, breakdown: built.breakdown, tokens: built.tokens,
            lore: built.lore, loreTotal: built.loreTotal, model: state.settings.connection.model, connection: connectionLabel(),
            body: null, type: 'dry run',
        };
    }
    const tokens = cap.tokens ?? cap.messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
    const requestId = cap.requestId || gen?.requestId;
    let provider = null; // { url, body } fetched lazily from the server
    const loadProvider = async () => {
        if (provider || !requestId) return provider;
        provider = await api.get(`requests/${encodeURIComponent(requestId)}`).catch(err => ({ error: err.message }));
        return provider;
    };

    const chip = (k, v) => el('div', { class: 'insp-chip' }, el('span', {}, k), el('b', {}, v));
    const header = el('div', { class: 'insp-chips' },
        chip('Model', cap.model || '–'),
        chip('Connection', cap.connection || '–'),
        chip('Messages', String(cap.messages.length)),
        chip('Stack estimate', `~${tokens.toLocaleString()} tok`),
        chip('Lore', `${cap.lore?.length || 0}/${cap.loreTotal ?? cap.lore?.length ?? 0} active`),
        chip('Captured', dry ? 'dry run (next message)' : new Date(cap.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })),
        cap.type && !dry ? chip('Type', cap.type) : null,
    );

    const search = el('input', { type: 'search', class: 'insp-search', placeholder: 'Search the prompt…' });
    const pane = el('div', { class: 'insp-pane' });
    const tabs = [
        ['stack', 'Prompt Stack', 'layer-group'],
        ['lore', 'Lore Activation', 'book-open'],
        ['provider', 'Provider Request', 'paper-plane'],
        ['raw', 'Raw JSON', 'code'],
    ];
    let current = 'stack';
    const tabBar = el('div', { class: 'insp-tabs', role: 'tablist' }, tabs.map(([id, label, ic]) =>
        el('button', { class: `insp-tab${id === current ? ' active' : ''}`, 'data-tab': id, role: 'tab', onclick: () => show(id) }, icon(ic), label)));

    const highlight = (text, q) => {
        const frag = document.createDocumentFragment();
        if (!q) { frag.append(text); return frag; }
        const lower = text.toLowerCase();
        let i = 0;
        for (let j = lower.indexOf(q); j >= 0; j = lower.indexOf(q, i)) {
            frag.append(text.slice(i, j), el('mark', {}, text.slice(j, j + q.length)));
            i = j + q.length;
        }
        frag.append(text.slice(i));
        return frag;
    };

    const renderStack = () => {
        const q = search.value.trim().toLowerCase();
        const items = cap.messages.map((m, i) => ({ m, i, label: cap.labels?.[i] || '' }))
            .filter(({ m, label }) => !q || String(m.content).toLowerCase().includes(q) || label.toLowerCase().includes(q) || m.role.includes(q));
        return el('div', { class: 'insp-stack' },
            q ? el('div', { class: 'insp-note' }, `${items.length} of ${cap.messages.length} messages match`) : null,
            items.map(({ m, i, label }) => el('details', { class: `insp-msg role-${m.role}`, open: !!q || cap.messages.length <= 6 },
                el('summary', {},
                    el('span', { class: 'insp-idx' }, `#${i + 1}`),
                    icon(ROLE_ICON[m.role] || 'circle'),
                    el('span', { class: 'insp-role' }, m.role + (m.name ? ` · ${m.name}` : '')),
                    label ? el('span', { class: 'insp-label' }, label) : null,
                    el('span', { class: 'insp-tok' }, `~${estimateTokens(m.content).toLocaleString()} tok`)),
                el('pre', {}, highlight(String(m.content), q)))));
    };

    const renderLore = () => {
        const lore = cap.lore || [];
        if (!lore.length) return el('div', { class: 'insp-empty' }, icon('book'), cap.loreTotal ? `None of the ${cap.loreTotal} lore entries were triggered.` : 'No lorebooks are active for this chat.');
        const pos = ['Before character', 'After character', 'Top of Author\'s Note', 'Bottom of Author\'s Note', 'At depth', 'Top of examples', 'Bottom of examples'];
        return el('div', { class: 'insp-lore' }, lore.map(e => el('details', { class: 'insp-lore-entry' },
            el('summary', {},
                e.constant ? el('span', { class: 'insp-badge' }, 'constant') : el('span', { class: 'insp-badge keyed' }, 'keyword'),
                el('b', {}, e.comment || (e.key || []).join(', ') || `Entry ${e.uid}`),
                el('span', { class: 'dim' }, `${e.book || ''} · ${pos[Number(e.position)] || 'Before character'}${Number(e.position) === 4 ? ` ${e.depth}` : ''} · order ${e.order}`),
                el('span', { class: 'insp-tok' }, `~${estimateTokens(e.content).toLocaleString()} tok`)),
            (e.key || []).length ? el('div', { class: 'insp-keys' }, e.key.map(k => el('span', { class: 'tag' }, k))) : null,
            el('pre', {}, String(e.content)))));
    };

    const renderProvider = async () => {
        const box = el('div', { class: 'insp-provider' });
        if (dry) {
            box.append(el('div', { class: 'insp-note' }, 'This is a dry run, so nothing was sent yet. Here is the body Reverie would hand to the server; the provider-specific request is captured once a reply is generated.'),
                el('pre', { class: 'insp-json' }, JSON.stringify({ model: cap.model, messages: cap.messages }, null, 2)));
            return box;
        }
        if (!requestId) {
            box.append(el('div', { class: 'insp-note' }, 'This reply was generated before request capture existed.'));
            return box;
        }
        box.append(el('div', { class: 'insp-note' }, icon('spinner', 'fa-spin'), ' Loading…'));
        const p = await loadProvider();
        box.replaceChildren();
        if (p?.error) box.append(el('div', { class: 'insp-note' }, p.error, '. Showing what Reverie sent to its server instead:'), el('pre', { class: 'insp-json' }, JSON.stringify(cap.body, null, 2)));
        else box.append(el('div', { class: 'insp-note' }, el('b', {}, 'POST '), p.url, ' · headers (and your API key) are never shown'), el('pre', { class: 'insp-json' }, JSON.stringify(p.body, null, 2)));
        return box;
    };

    const rawData = () => ({
        captured: new Date(cap.at).toISOString(), dryRun: dry, type: cap.type, model: cap.model, connection: cap.connection,
        estimateTokens: tokens, generation: gen || undefined, breakdown: cap.breakdown,
        lore: (cap.lore || []).map(e => ({ uid: e.uid, book: e.book, comment: e.comment, keys: e.key, constant: !!e.constant, position: e.position, order: e.order })),
        request: cap.body || { model: cap.model, messages: cap.messages },
    });

    async function show(id) {
        current = id;
        tabBar.querySelectorAll('.insp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
        search.classList.toggle('hidden', id !== 'stack');
        let content;
        if (id === 'stack') content = renderStack();
        else if (id === 'lore') content = renderLore();
        else if (id === 'provider') content = await renderProvider();
        else content = el('pre', { class: 'insp-json' }, JSON.stringify(rawData(), null, 2));
        if (current === id) pane.replaceChildren(content);
    }
    search.addEventListener('input', () => current === 'stack' && show('stack'));

    const copy = async (text, what) => {
        try { await navigator.clipboard.writeText(text); toast(`${what} copied`, 'success'); } catch { toast('Copy failed', 'error'); }
    };
    const stackText = () => cap.messages.map((m, i) => `### ${i + 1}. ${m.role}${cap.labels?.[i] ? ` — ${cap.labels[i]}` : ''}\n${m.content}`).join('\n\n');
    const content = el('div', { class: 'inspector' },
        el('div', { class: 'insp-head' },
            el('div', { class: 'insp-title' }, icon('magnifying-glass-chart'), el('h3', {}, 'Prompt / Context Inspector')),
            el('div', { class: 'insp-actions' },
                el('button', { class: 'btn', onclick: () => copy(stackText(), 'Prompt stack') }, icon('copy'), 'Copy stack'),
                el('button', { class: 'btn', onclick: async () => {
                    const p = dry ? null : await loadProvider();
                    copy(JSON.stringify(p?.body || cap.body || { model: cap.model, messages: cap.messages }, null, 2), 'Payload');
                } }, icon('file-code'), 'Copy payload'),
                el('button', { class: 'icon-btn insp-close', title: 'Close', 'data-close': '' }, icon('xmark')))),
        header, el('div', { class: 'insp-bar' }, tabBar, search), pane);
    show('stack');
    modal({
        content, buttons: [], wide: true, className: 'inspector-modal',
        onOpen: (body, close) => body.querySelector('[data-close]').addEventListener('click', () => close(null)),
    });
}
