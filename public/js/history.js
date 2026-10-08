// Per-message edit history: every edit (yours or an extension's) keeps the previous text, per swipe
// (it lives in mes.extra, which Reverie already stores per swipe). Viewable as a word diff, restorable.
import { state, saveChat } from './state.js';
import { eventSource, event_types } from './events.js';
import { el, icon, toast, modal } from './ui.js';

const MAX_VERSIONS = 30;

/** Keeps previousText when a message changes to nextText. kind: 'edit' | 'restore' | an extension's name. */
export function recordEdit(mes, previousText, nextText, kind = 'edit') {
    if (!mes || previousText == null || previousText === nextText) return;
    mes.extra ??= {};
    const list = mes.extra.rv_history ??= [];
    if (list.at(-1)?.text === previousText) return;
    list.push({ text: String(previousText), at: Date.now(), kind });
    if (list.length > MAX_VERSIONS) list.splice(0, list.length - MAX_VERSIONS);
}

export const hasHistory = mes => !!mes?.extra?.rv_history?.length;

// ---------------------------------------------------------------- word diff
function tokenize(text) {
    return String(text).match(/\s+|[\p{L}\p{N}'’_-]+|[^\s\p{L}\p{N}]/gu) || [];
}

/** Returns [{ type: 'same'|'add'|'del', text }] turning a into b. LCS on words, lines for huge texts. */
export function diffWords(a, b) {
    let x = tokenize(a), y = tokenize(b);
    if (x.length * y.length > 4e6) { x = String(a).split(/(?<=\n)/); y = String(b).split(/(?<=\n)/); }
    // Trim the common prefix/suffix first; edits are usually local.
    let start = 0;
    while (start < x.length && start < y.length && x[start] === y[start]) start++;
    let endX = x.length, endY = y.length;
    while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
    const xs = x.slice(start, endX), ys = y.slice(start, endY);
    const n = xs.length, m = ys.length;
    const table = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        table[i * (m + 1) + j] = xs[i] === ys[j] ? table[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(table[(i + 1) * (m + 1) + j], table[i * (m + 1) + j + 1]);
    }
    const out = [];
    const push = (type, text) => { const last = out.at(-1); if (last?.type === type) last.text += text; else out.push({ type, text }); };
    if (start) push('same', x.slice(0, start).join(''));
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (xs[i] === ys[j]) { push('same', xs[i]); i++; j++; }
        else if (table[(i + 1) * (m + 1) + j] >= table[i * (m + 1) + j + 1]) push('del', xs[i++]);
        else push('add', ys[j++]);
    }
    while (i < n) push('del', xs[i++]);
    while (j < m) push('add', ys[j++]);
    if (endX < x.length) push('same', x.slice(endX).join(''));
    return out;
}

function diffView(a, b) {
    const parts = diffWords(a, b);
    const added = parts.filter(p => p.type === 'add').reduce((n, p) => n + tokenize(p.text).filter(t => t.trim()).length, 0);
    const removed = parts.filter(p => p.type === 'del').reduce((n, p) => n + tokenize(p.text).filter(t => t.trim()).length, 0);
    return {
        added, removed,
        node: el('div', { class: 'hist-diff' }, parts.map(p => p.type === 'same' ? p.text : el(p.type === 'add' ? 'ins' : 'del', {}, p.text))),
    };
}

const when = at => new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const kindLabel = k => (k === 'edit' ? 'Your edit' : k === 'restore' ? 'Restored' : k ? `Changed by ${k}` : 'Edit');

/** Opens the history for chat message `id` (current swipe). */
export async function showHistory(id, { onRestore } = {}) {
    const mes = state.chat[id];
    if (!mes) return;
    const versions = [...(mes.extra?.rv_history || []).map((v, i) => ({ ...v, index: i })), { text: mes.mes, at: null, current: true }];
    if (versions.length < 2) return toast('This message hasn\'t been edited', 'info');

    // Show newest first: each version is compared with the one before it.
    const list = el('div', { class: 'hist-list' });
    let close = () => {};
    for (let k = versions.length - 1; k >= 0; k--) {
        const v = versions[k];
        const prev = versions[k - 1];
        const diff = prev ? diffView(prev.text, v.text) : null;
        // What made this version: the edit recorded on the version before it.
        const how = prev ? kindLabel(prev.kind) : 'Original';
        const item = el('details', { class: `hist-item${v.current ? ' current' : ''}`, open: k === versions.length - 1 },
            el('summary', {},
                el('span', { class: 'hist-dot' }),
                el('b', {}, v.current ? 'Current' : `Version ${k + 1}`),
                el('span', { class: 'dim' }, how + (prev ? ` · ${when(prev.at)}` : '')),
                diff ? el('span', { class: 'hist-stats' }, diff.added ? el('span', { class: 'add' }, `+${diff.added}`) : null, diff.removed ? el('span', { class: 'del' }, `−${diff.removed}`) : null) : null),
            el('div', { class: 'hist-body' },
                diff ? diff.node : el('div', { class: 'hist-diff' }, v.text),
                el('div', { class: 'hist-actions' },
                    el('button', { class: 'btn small', onclick: async () => {
                        try { await navigator.clipboard.writeText(v.text); toast('Copied', 'success', { timeout: 1500 }); } catch { toast('Copy failed', 'error'); }
                    } }, icon('copy'), 'Copy'),
                    v.current ? null : el('button', { class: 'btn small primary', onclick: async () => {
                        recordEdit(mes, mes.mes, v.text, 'restore');
                        mes.mes = v.text;
                        await onRestore?.(mes);
                        await saveChat();
                        await eventSource.emit(event_types.MESSAGE_EDITED, id);
                        await eventSource.emit(event_types.MESSAGE_UPDATED, id);
                        toast(`Restored version ${k + 1}`, 'success');
                        close();
                    } }, icon('clock-rotate-left'), 'Restore this version'))));
        list.append(item);
    }
    modal({
        title: 'Edit history', wide: true, className: 'history-modal',
        content: el('div', { class: 'hist' },
            el('p', { class: 'dim hist-intro' }, `${versions.length - 1} earlier version${versions.length > 2 ? 's' : ''} of this ${mes.swipes?.length > 1 ? 'swipe' : 'message'}. Restoring keeps the current text in the history too.`),
            list),
        buttons: [{ label: 'Close', value: null }],
        onOpen: (_body, c) => { close = c; },
    });
}
