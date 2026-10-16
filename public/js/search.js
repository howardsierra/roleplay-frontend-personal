// Search every story: finds messages across all characters' chats and jumps to them.
import { api } from './api.js';
import { state } from './state.js';
import { el, icon, modal, debounce, escapeHtml, toast } from './ui.js';

function highlight(text, terms) {
    let html = escapeHtml(text);
    for (const t of terms) {
        if (!t) continue;
        const re = new RegExp(escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        html = html.replace(re, m => `<mark>${m}</mark>`);
    }
    return html;
}

/** Opens the chat and scrolls to (and briefly highlights) one message. */
export async function jumpToMessage(charId, chatId, index) {
    if (state.character?.id !== charId || state.chatId !== chatId) {
        if (state.generating) return toast('Wait for the current reply to finish', 'warning');
        const { openCharacter } = await import('./characters.js');
        await openCharacter(charId, { chatId });
    }
    requestAnimationFrame(() => {
        const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
        if (!node) return;
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.add('rv-flash');
        setTimeout(() => node.classList.remove('rv-flash'), 2400);
    });
}

export function openGlobalSearch(initial = '') {
    const input = el('input', { class: 'input', type: 'search', placeholder: 'Search all your stories…', autocomplete: 'off', value: initial });
    const status = el('div', { class: 'hint gsearch-status' }, 'Type at least two letters. All words must appear in the message.');
    const list = el('div', { class: 'gsearch-results' });
    let close = () => {};
    let seq = 0;
    const run = debounce(async () => {
        const q = input.value.trim();
        const mine = ++seq;
        if (q.length < 2) { list.replaceChildren(); status.textContent = 'Type at least two letters. All words must appear in the message.'; return; }
        status.textContent = 'Searching…';
        let res;
        try { res = await api.get(`chats/search?q=${encodeURIComponent(q)}`); } catch (err) { status.textContent = err.message; return; }
        if (mine !== seq) return;
        const { results, total, terms = [] } = res;
        status.textContent = total ? `${total} message${total === 1 ? '' : 's'}${total > results.length ? ` · showing the newest ${results.length}` : ''}` : 'No messages found.';
        // Group by story, newest first (the server already orders them).
        const groups = new Map();
        for (const r of results) {
            const key = `${r.charId}\u0000${r.chatId}`;
            if (!groups.has(key)) groups.set(key, { ...r, hits: [] });
            groups.get(key).hits.push(r);
        }
        list.replaceChildren(...[...groups.values()].map(g => el('section', { class: 'gsearch-group' },
            el('header', {},
                el('img', { src: g.avatar ? `files/avatars/${encodeURIComponent(g.avatar)}` : 'icons/icon.svg', alt: '', loading: 'lazy' }),
                el('div', {}, el('b', {}, g.charName || 'Unknown'), el('span', {}, g.chatId)),
                el('span', { class: 'gsearch-count' }, String(g.hits.length))),
            ...g.hits.map(h => el('button', { class: 'gsearch-hit', onclick: () => { close(); jumpToMessage(h.charId, h.chatId, h.index); } },
                el('span', { class: `gsearch-who${h.isUser ? ' you' : ''}` }, h.name || (h.isUser ? 'You' : g.charName)),
                el('span', { class: 'gsearch-snippet', html: highlight(h.snippet, terms) }))))));
    }, 250);
    input.addEventListener('input', run);
    modal({
        title: 'Search all stories',
        className: 'gsearch-modal',
        content: el('div', { class: 'stack' }, el('label', { class: 'gsearch-box' }, icon('magnifying-glass'), input), status, list),
        buttons: [],
        onOpen: (_b, c) => { close = c; setTimeout(() => input.focus(), 50); if (initial) run(); },
    });
}
