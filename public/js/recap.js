// "Previously on…": when you come back to a story after a while, a short recap of where things
// stand appears under the last message. Cached per chat so it is only written once per gap.
import { state, chatMetadata, saveChatDebounced, charName, userName } from './state.js';
import { eventSource, event_types } from './events.js';
import { el, icon, toast } from './ui.js';

const AWAY_MS = 6 * 60 * 60 * 1000;
const MIN_MESSAGES = 6;
let card = null; // { node, chatId }
let running = null; // chatId being recapped

function parseDate(value) {
    if (!value) return NaN;
    if (typeof value === 'number') return value;
    // SillyTavern writes dates like "October 8, 2026 3:22pm".
    const t = Date.parse(String(value).replace(/(\d)(am|pm)\b/i, '$1 $2'));
    return t;
}

const story = () => state.chat.filter(m => !m.is_system && String(m.mes || '').trim());

function lastActivity() {
    const last = state.chat.at(-1);
    return parseDate(last?.gen_finished || last?.send_date);
}

function transcript(messages) {
    const lines = [];
    let budget = 18000;
    for (let i = messages.length - 1; i >= 0 && budget > 0; i--) {
        const m = messages[i];
        const text = String(m.mes).replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1600);
        lines.unshift(`${m.name || (m.is_user ? userName() : charName())}: ${text}`);
        budget -= text.length;
    }
    return lines.join('\n\n');
}

const SYSTEM = 'You write the "Previously on…" recap shown to a reader returning to an ongoing roleplay story. '
    + 'In 3 to 5 sentences of plain prose, recap where the story stands: who is where, what just happened, what is unresolved or about to happen, and the mood between the characters. '
    + 'Refer to the characters by name, use past tense for events and present tense for the current situation, and stop at the latest moment. '
    + 'No headings, lists, quotes, or commentary — only the recap.';

function remove() {
    card?.node.remove();
    card = null;
}

function place(node) {
    const chat = document.getElementById('chat');
    if (!chat) return;
    chat.append(node);
}

function render(text, { loading = false, error = '' } = {}) {
    const chatId = state.chatId;
    const node = el('aside', { class: `rv-recap${loading ? ' loading' : ''}`, 'aria-live': 'polite' },
        el('div', { class: 'rv-recap-head' },
            icon('clapperboard'), el('span', { class: 'rv-recap-title' }, 'Previously on…'),
            el('div', { class: 'rv-recap-actions' },
                loading ? null : el('button', { class: 'icon-btn small', title: 'Write a fresh recap', onclick: () => showRecap({ force: true, fresh: true }) }, icon('rotate')),
                el('button', { class: 'icon-btn small', title: 'Dismiss', onclick: remove }, icon('xmark')))),
        loading
            ? el('div', { class: 'rv-recap-body' }, el('span', { class: 'rv-recap-shimmer' }), el('span', { class: 'rv-recap-shimmer short' }))
            : el('div', { class: 'rv-recap-body' }, error ? el('span', { class: 'dim' }, error) : text));
    card?.node.remove();
    card = { node, chatId };
    place(node);
    const box = document.getElementById('chat');
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight < 260) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}

/**
 * Shows the recap for the open chat. Without force it only appears after a long enough break.
 * fresh: ignore the cached recap and write a new one.
 */
export async function showRecap({ force = false, fresh = false } = {}) {
    if (!state.character || !state.chatId) return;
    const messages = story();
    if (!force) {
        if (state.settings.appearance.recap === false || messages.length < MIN_MESSAGES) return;
        const last = lastActivity();
        if (!Number.isFinite(last) || Date.now() - last < AWAY_MS) return;
    }
    if (messages.length < 2) return toast('There isn\'t enough story to recap yet', 'info');
    const meta = chatMetadata();
    const forIndex = state.chat.length - 1;
    if (!fresh && meta.rv_recap?.text && meta.rv_recap.forIndex === forIndex) return render(meta.rv_recap.text);
    if (!state.settings.connection.model) return force ? toast('Set up a connection first', 'warning') : undefined;
    const chatId = state.chatId;
    if (running === chatId) return;
    running = chatId;
    render('', { loading: true });
    try {
        const { generateRaw } = await import('./chat.js');
        const text = String(await generateRaw(`Story so far:\n\n${transcript(messages.slice(-40))}\n\nWrite the recap.`, null, false, false, SYSTEM) || '').trim();
        if (state.chatId !== chatId) return;
        if (!text) throw new Error('The model returned an empty recap');
        meta.rv_recap = { text, forIndex, at: Date.now() };
        saveChatDebounced();
        render(text);
    } catch (err) {
        if (state.chatId === chatId) render('', { error: `Couldn't write a recap: ${err.message}` });
    } finally {
        if (running === chatId) running = null;
    }
}

export function bindRecap() {
    eventSource.on(event_types.CHAT_CHANGED, () => { remove(); setTimeout(() => showRecap(), 400); });
    eventSource.on(event_types.MESSAGE_SENT, remove);
    eventSource.on(event_types.GENERATION_STARTED, type => { if (type !== 'quiet') remove(); });
    // A full re-render of the chat wipes the card; put it back.
    window.addEventListener('rv:messages-printed', () => { if (card && card.chatId === state.chatId) place(card.node); else remove(); });
}
