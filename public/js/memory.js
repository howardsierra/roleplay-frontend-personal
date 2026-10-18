// Memory book: long stories outgrow the context window, and what falls out of it is forgotten. Every so
// often the older part of the chat is written up as a short memory (one per stretch of messages). Before
// each reply the memories that matter right now (named in the last few messages, or what happened just
// before the window starts) go back into the prompt, so the model remembers what it can no longer see.
// Memories live in the chat's metadata, so they travel with the chat and can be edited.
import { state, chatMetadata, saveChatDebounced, charName, userName } from './state.js';
import { messageId } from './message-ids.js';
import { eventSource, event_types } from './events.js';
import { el, icon, toast, modal, confirmDialog, field, textInput, textArea, toggle, slider } from './ui.js';

const DEFAULTS = { auto: true, chunk: 15, lag: 4, budget: 1500, maxUsed: 6 };

export function memorySettings() {
    state.settings.memory = { ...DEFAULTS, ...(state.settings.memory || {}) };
    return state.settings.memory;
}

/** This chat's memory book (created on first use unless `peek`). */
export function memoryBook({ peek = false } = {}) {
    const meta = peek ? state.chatMeta?.chat_metadata : chatMetadata();
    if (!meta) return { entries: [] };
    if (peek && !meta.rv_memory) return { entries: [] };
    meta.rv_memory ??= { entries: [] };
    meta.rv_memory.entries ??= [];
    return meta.rv_memory;
}

const isAssistantChat = () => !!state.character?.card?.data?.extensions?.reverie?.assistant;
const visible = (chat = state.chat) => chat.filter(m => !m.is_system && String(m.mes || '').trim());
const estimate = text => Math.ceil(String(text || '').length / 3.6);
const strip = t => String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

/** Where an entry's messages are now (1-based, in the visible story), or null if they were deleted. */
export function entryRange(entry, list = visible()) {
    const ids = list.map(m => messageId(m));
    const a = ids.indexOf(entry.fromId);
    const b = ids.indexOf(entry.toId);
    if (a < 0 && b < 0) return null;
    return { from: (a < 0 ? b : a) + 1, to: (b < 0 ? a : b) + 1 };
}

/** Index (in the visible story) just past the last message any memory covers. */
function coveredUntil(list = visible()) {
    const ids = list.map(m => messageId(m));
    let until = 0;
    for (const e of memoryBook({ peek: true }).entries) {
        if (e.manual) continue;
        const i = ids.indexOf(e.toId);
        until = Math.max(until, i >= 0 ? i + 1 : Math.min(e.toIndex ?? 0, list.length));
    }
    return until;
}

/** What the next memory would cover: messages [start, end) of the visible story. */
export function backlog() {
    const s = memorySettings();
    const list = visible();
    const start = coveredUntil(list);
    const end = Math.max(start, list.length - s.lag);
    return { start, end, size: end - start, total: list.length };
}

// ---------------------------------------------------------------- writing
const SYSTEM = 'You keep the memory book for a long, ongoing roleplay story. Summarize the excerpt into ONE memory entry that will remind the storyteller of these events much later, after the original messages are gone.\n'
    + 'Return only JSON: {"title": "...", "summary": "...", "keys": ["..."]}\n'
    + '- title: 3 to 8 words naming the episode.\n'
    + '- summary: 3 to 7 sentences of plain prose in past tense. Use names, not pronouns. Keep what matters later: what happened and where, decisions and promises, secrets revealed, injuries, things gained or lost, who went where, and how the characters\' feelings toward each other changed. No commentary, no quotes.\n'
    + '- keys: 3 to 8 lowercase names, places, objects or topics that, if mentioned later, should bring this memory back.';

let writing = null; // chatId being written for

async function summarize(messages, previous) {
    const { callAgent, parseJson, storyBrief } = await import('./agents/core.js');
    const lines = messages.map(m => `${m.name || (m.is_user ? userName() : charName())}: ${strip(m.mes).slice(0, 2400)}`).join('\n\n');
    const before = previous.slice(-3).map(e => `- ${e.title}: ${e.text}`).join('\n');
    const user = `${storyBrief()}\n\n${before ? `Earlier memories (context only, don't repeat them):\n${before}\n\n` : ''}Excerpt to remember:\n\n${lines}\n\nWrite the memory entry as JSON.`;
    const reply = await callAgent([{ role: 'system', content: SYSTEM }, { role: 'user', content: user }], { maxTokens: 800, temperature: 0.3 });
    let out;
    try { out = parseJson(reply); } catch { out = { title: '', summary: reply }; }
    const text = String(out.summary || out.text || '').trim();
    if (!text) throw new Error('The model returned an empty memory');
    return {
        title: String(out.title || '').trim().slice(0, 120) || 'Untitled memory',
        text,
        keys: (Array.isArray(out.keys) ? out.keys : []).map(k => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 12),
    };
}

/** Writes the memory for messages [start, end) of the visible story. */
async function writeRange(start, end) {
    const chatId = state.chatId;
    const meta = chatMetadata();
    const list = visible();
    const slice = list.slice(start, end);
    if (!slice.length) return null;
    const book = memoryBook();
    const written = await summarize(slice, book.entries.filter(e => !e.manual));
    if (state.chatId !== chatId || state.chatMeta?.chat_metadata !== meta) return null; // the chat changed meanwhile
    const entry = {
        id: `mem${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        ...written,
        fromId: messageId(slice[0]), toId: messageId(slice.at(-1)), toIndex: end,
        created: Date.now(), enabled: true, pinned: false,
    };
    book.entries.push(entry);
    saveChatDebounced();
    eventSource.emit('rv_memory_changed');
    return entry;
}

/**
 * Writes memories for what's waiting. auto: only full chunks, at most two at a time.
 * all: everything waiting (catching up an old story), reporting progress.
 */
export async function writeMemories({ auto = false, all = false, onProgress } = {}) {
    if (!state.chatId || writing === state.chatId) return 0;
    if (!state.settings.connection.model) { if (!auto) toast('Set up a connection first', 'warning'); return 0; }
    const s = memorySettings();
    const chunk = Math.max(4, Number(s.chunk) || DEFAULTS.chunk);
    writing = state.chatId;
    eventSource.emit('rv_memory_changed');
    let count = 0;
    try {
        for (let round = 0; round < (all ? 200 : auto ? 2 : 1); round++) {
            const { start, end, size } = backlog();
            if (auto && size < chunk) break;
            if (!auto && size < 2) { if (!count && !all) toast('Nothing new to remember yet: the newest messages are kept as they are', 'info'); break; }
            onProgress?.(count, Math.ceil(size / chunk) + count);
            const entry = await writeRange(start, Math.min(end, start + chunk));
            if (!entry) break;
            count++;
        }
    } catch (err) {
        if (!auto) toast(`Couldn't write a memory: ${err.message}`, 'error');
        else console.warn('[memory]', err);
    } finally {
        writing = null;
        eventSource.emit('rv_memory_changed');
    }
    return count;
}
export const isWriting = () => writing === state.chatId && !!writing;

// ---------------------------------------------------------------- recalling
const STOP = new Set('the and for are but not you your yours with that this from have has had was were will would could should what when where which while who whom why how all any can her him his she they them their there then than into onto out over under about after before again also just only very more most some such each other our ours its it\'s i\'m don\'t didn\'t won\'t can\'t said says like back down off upon been being does did done get got going went come came make made know knew think thought want wanted look looked felt feel one two now here well yes yeah okay'.split(' '));
const words = text => (String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{2,}/gu) || []).filter(w => !STOP.has(w));

/**
 * Picks the memories for a prompt. Memories whose messages are still in the prompt are skipped (the model
 * can read those). The memory just before the window always goes in, so the story doesn't jump; the rest
 * are ranked by how much the last few messages talk about them, and fill the budget.
 * @param {{ chat: object[], firstKept: number, budget: number }} args firstKept: chat index of the oldest
 *   message that fits in the prompt (Infinity when none do)
 */
export function recallMemories({ chat, firstKept, budget }) {
    const book = memoryBook({ peek: true });
    const result = { text: '', used: [], skipped: [], tokens: 0 };
    if (!book.entries.length || budget <= 0) return result;
    const s = memorySettings();
    const index = new Map(chat.map((m, i) => [messageId(m), i]));
    const recent = visible(chat).slice(-6);
    const query = words(recent.map(m => m.mes).join('\n'));
    const qset = new Set(query);
    const latest = new Set(words(recent.at(-1)?.mes));

    const outside = [];
    for (const e of book.entries) {
        if (e.enabled === false) continue;
        const start = index.get(e.fromId) ?? index.get(e.toId);
        // Wholly readable in the prompt already; one that's only partly visible still goes in.
        if (!e.manual && start !== undefined && start >= firstKept) continue;
        outside.push({ e, end: index.get(e.toId) ?? start ?? -1 });
    }
    if (!outside.length) return result;

    // Rarer words count for more (a name beats "door").
    const df = new Map();
    const docs = outside.map(({ e }) => new Set(words(`${e.title} ${e.text} ${(e.keys || []).join(' ')}`)));
    for (const d of docs) for (const w of d) df.set(w, (df.get(w) || 0) + 1);
    const idf = w => Math.log(1 + outside.length / (df.get(w) || 1));
    const lastBefore = outside.filter(o => !o.e.manual).sort((a, b) => b.end - a.end)[0]?.e;
    const scored = outside.map(({ e }, i) => {
        let score = 0;
        const why = [];
        const keyHits = (e.keys || []).filter(k => k && (qset.has(k) || recent.some(m => String(m.mes || '').toLowerCase().includes(k))));
        if (keyHits.length) { score += 3 * keyHits.length; why.push(`mentions ${keyHits.slice(0, 3).join(', ')}`); }
        let overlap = 0;
        for (const w of docs[i]) if (qset.has(w)) overlap += idf(w) * (latest.has(w) ? 1.5 : 1);
        score += overlap;
        if (!keyHits.length && overlap > 2) why.push('related to the last messages');
        if (e.pinned) { score += 1000; why.unshift('pinned'); }
        if (e === lastBefore) { score += 500; why.unshift('just before the visible chat'); }
        return { e, score, why: why.join('; ') || 'background' };
    }).sort((a, b) => b.score - a.score);

    const picked = [];
    let used = 0;
    for (const item of scored) {
        const cost = estimate(`${item.e.title}: ${item.e.text}`) + 6;
        const wanted = item.e.pinned || item.e === lastBefore || item.score >= 1.5;
        if (!wanted) { result.skipped.push({ id: item.e.id, title: item.e.title, reason: 'not related to the current scene' }); continue; }
        if (picked.length >= s.maxUsed && !item.e.pinned) { result.skipped.push({ id: item.e.id, title: item.e.title, reason: `limit of ${s.maxUsed} memories reached` }); continue; }
        if (used + cost > budget && !item.e.pinned) { result.skipped.push({ id: item.e.id, title: item.e.title, reason: 'memory budget full' }); continue; }
        used += cost;
        picked.push(item);
    }
    if (!picked.length) return result;
    // Oldest first, so it reads as a timeline.
    const order = new Map(book.entries.map((e, i) => [e.id, i]));
    picked.sort((a, b) => order.get(a.e.id) - order.get(b.e.id));
    result.used = picked.map(p => ({ id: p.e.id, title: p.e.title, why: p.why }));
    result.text = `[Memories of earlier events in this story, oldest first. They happened in the past; things may have changed since.]\n${picked.map(p => `• ${p.e.title}: ${p.e.text}`).join('\n')}`;
    result.tokens = estimate(result.text);
    return result;
}

/** Tokens to keep aside for memories when fitting the history. */
export function memoryReserve() {
    const book = memoryBook({ peek: true });
    if (!book.entries.some(e => e.enabled !== false)) return 0;
    const all = book.entries.filter(e => e.enabled !== false).reduce((n, e) => n + estimate(`${e.title}: ${e.text}`) + 6, 0);
    return Math.min(Number(memorySettings().budget) || 0, all + 30);
}

let lastUse = { chatId: null, used: [], skipped: [] };
export const lastMemoryUse = () => (lastUse.chatId === state.chatId ? lastUse : { used: [], skipped: [] });
export function noteMemoryUse(mem) { lastUse = { chatId: state.chatId, used: mem.used, skipped: mem.skipped }; }

// ---------------------------------------------------------------- the Memory tab
async function editEntry(entry) {
    const draft = { title: entry?.title || '', text: entry?.text || '', keys: (entry?.keys || []).join(', ') };
    const ok = await modal({
        title: entry ? 'Edit memory' : 'New memory',
        content: el('div', { class: 'stack' },
            field('Title', textInput(draft.title, v => { draft.title = v; })),
            field('What happened', textArea(draft.text, v => { draft.text = v; }, { rows: 7 })),
            field('Keywords', textInput(draft.keys, v => { draft.keys = v; }, { placeholder: 'names, places, objects' }), 'When the chat mentions one of these, this memory comes back.')),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true, icon: 'check' }],
    });
    if (!ok || !draft.text.trim()) return;
    const fields = { title: draft.title.trim() || 'Untitled memory', text: draft.text.trim(), keys: draft.keys.split(',').map(k => k.trim().toLowerCase()).filter(Boolean) };
    if (entry) Object.assign(entry, fields);
    else memoryBook().entries.push({ id: `mem${Date.now().toString(36)}`, ...fields, manual: true, enabled: true, pinned: false, created: Date.now() });
    saveChatDebounced();
    eventSource.emit('rv_memory_changed');
}

async function rewrite(entry) {
    const list = visible();
    const r = entryRange(entry, list);
    if (!r || entry.manual) return toast('The messages for this memory are gone', 'warning');
    toast('Rewriting memory…', 'info', { timeout: 1500 });
    try {
        const book = memoryBook();
        Object.assign(entry, await summarize(list.slice(r.from - 1, r.to), book.entries.slice(0, book.entries.indexOf(entry)).filter(e => !e.manual)));
        saveChatDebounced();
        eventSource.emit('rv_memory_changed');
    } catch (err) {
        toast(`Couldn't rewrite it: ${err.message}`, 'error');
    }
}

export function memoryTab() {
    if (!state.chatId) return el('div', { class: 'empty' }, 'Open a story first.');
    const s = memorySettings();
    const book = memoryBook({ peek: true });
    const list = visible();
    const { start, size } = backlog();
    const use = lastMemoryUse();
    const usedIds = new Map(use.used.map(u => [u.id, u.why]));
    const chunk = Math.max(4, Number(s.chunk) || DEFAULTS.chunk);
    const busy = isWriting();

    const status = busy
        ? el('p', { class: 'hint' }, icon('spinner', 'fa-spin'), ' Writing a memory…')
        : el('p', { class: 'hint' }, book.entries.length
            ? `${book.entries.length} memor${book.entries.length === 1 ? 'y' : 'ies'} covering messages 1–${start} of ${list.length}. `
            : `No memories yet. `,
        s.auto && !isAssistantChat()
            ? (size >= chunk ? 'The next one is written after the next reply.' : `The next one is written after ${chunk - size} more message${chunk - size === 1 ? '' : 's'}.`)
            : 'Automatic memories are off.');

    const catchUp = el('button', { class: 'btn small', disabled: busy || size < 2, onclick: async () => {
        catchUp.disabled = true;
        const n = await writeMemories({ all: true, onProgress: (done, total) => { catchUp.textContent = `Writing ${done + 1} of ${total}…`; } });
        if (n) toast(`Wrote ${n} memor${n === 1 ? 'y' : 'ies'}`, 'success');
    } }, icon('book-medical'), size > chunk ? `Catch up (${size} messages)` : 'Remember now');

    const entries = [...book.entries].reverse().map(e => {
        const r = entryRange(e, list);
        const why = usedIds.get(e.id);
        return el('details', { class: `memory-entry${e.enabled === false ? ' off' : ''}` },
            el('summary', {},
                el('span', { class: 'memory-title' }, e.pinned ? icon('thumbtack') : null, e.title),
                el('span', { class: 'memory-meta' },
                    why ? el('span', { class: 'memory-badge used', title: why }, 'used') : null,
                    e.manual ? 'added by you' : r ? `msgs ${r.from}–${r.to}` : 'messages deleted')),
            el('div', { class: 'memory-text' }, e.text),
            why ? el('p', { class: 'hint' }, `In the last reply: ${why}.`) : null,
            (e.keys || []).length ? el('div', { class: 'memory-keys' }, e.keys.map(k => el('span', { class: 'tag' }, k))) : null,
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', onclick: () => editEntry(e) }, icon('pen'), 'Edit'),
                e.manual ? null : el('button', { class: 'btn small', onclick: () => rewrite(e) }, icon('rotate'), 'Rewrite'),
                el('button', { class: `btn small${e.pinned ? ' active' : ''}`, title: 'Always include this memory', onclick: () => { e.pinned = !e.pinned; saveChatDebounced(); eventSource.emit('rv_memory_changed'); } }, icon('thumbtack'), e.pinned ? 'Pinned' : 'Pin'),
                el('button', { class: 'btn small', onclick: () => { e.enabled = e.enabled === false; saveChatDebounced(); eventSource.emit('rv_memory_changed'); } }, icon(e.enabled === false ? 'eye' : 'eye-slash'), e.enabled === false ? 'Turn on' : 'Turn off'),
                el('button', { class: 'btn small danger', onclick: async () => {
                    if (!await confirmDialog(`Delete the memory “${e.title}”? Its messages will be summarized again next time.`, { okLabel: 'Delete', danger: true })) return;
                    book.entries.splice(book.entries.indexOf(e), 1);
                    saveChatDebounced();
                    eventSource.emit('rv_memory_changed');
                } }, icon('trash-can'))));
    });

    const save = () => { state.settings.memory = s; import('./state.js').then(m => m.saveSettingsDebounced()); };
    return el('div', { class: 'stack memory-tab' },
        el('p', { class: 'hint' }, 'Older parts of the story are written up as short memories. Once the original messages no longer fit in the prompt, the memories that matter right now go in instead.'),
        status,
        el('div', { class: 'row gap wrap' },
            catchUp,
            el('button', { class: 'btn small', onclick: () => editEntry(null) }, icon('plus'), 'Add memory')),
        entries.length ? el('div', { class: 'stack' }, entries) : null,
        el('details', { class: 'memory-settings' },
            el('summary', {}, 'Memory settings'),
            el('div', { class: 'stack' },
                toggle('Write memories automatically', s.auto, v => { s.auto = v; save(); }, 'Uses the agents\' connection (Settings → Agents).'),
                slider('Messages per memory', s.chunk, { min: 4, max: 40, step: 1, onChange: v => { s.chunk = v; save(); } }),
                slider('Newest messages left alone', s.lag, { min: 0, max: 20, step: 1, onChange: v => { s.lag = v; save(); }, hint: 'So a scene isn\'t summed up while it\'s still going.' }),
                slider('Memory budget (tokens)', s.budget, { min: 200, max: 6000, step: 100, onChange: v => { s.budget = v; save(); } }),
                slider('Most memories per reply', s.maxUsed, { min: 1, max: 20, step: 1, onChange: v => { s.maxUsed = v; save(); } }))));
}

export function bindMemory() {
    eventSource.on(event_types.MESSAGE_RECEIVED, (_id, type) => {
        if (type === 'quiet' || type === 'impersonate') return;
        if (!memorySettings().auto || isAssistantChat()) return;
        // After the reply is shown, without holding anything up.
        setTimeout(() => writeMemories({ auto: true }), 1500);
    });
}
