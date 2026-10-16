// Reverie's built-in agents. Prompts are Reverie's own, after the ideas in Marinara Engine's agent
// catalog (Narrative Director, Prose Guardian, Continuity Checker, trackers, CYOA, Lorebook Keeper,
// Echo Chamber).
import { state, saveChat, saveChatDebounced, userName, charName } from '../state.js';
import { api } from '../api.js';
import { eventSource, event_types } from '../events.js';
import { toast } from '../ui.js';
import { recordEdit } from '../history.js';
import { newEntry } from '../worldinfo.js';
import {
    defineAgent, callAgent, parseJson, transcript, storyBrief, patchSwipe, rerender, agentStore, chatAgents,
    oneShot, track, isOn, agentConfig,
} from './core.js';

const you = () => userName();
const them = () => charName();
const syncSwipeOf = async mes => (await import('../chat.js')).syncSwipe(mes);

// ================================================================ Narrative Director
export const DIRECTOR_MODES = {
    natural: 'Move the story forward along the threads already in play: raise the stakes, resolve something that has been hanging, or bring the next beat closer. Stay true to the current mood.',
    random: 'Introduce one plausible surprise that fits this world and moment: an arrival, a discovery, an interruption, a change in weather or circumstance. It must create new possibilities, not end the scene.',
};

export async function pushStory(mode = 'natural') {
    if (!state.character || !state.chatId) return toast('Open a chat first', 'warning');
    if (state.generating) return;
    const plot = isOn('plot') ? agentStore('plot').arc : null;
    const directive = await track('director', 'Director', () => callAgent([
        { role: 'system', content: `You are the narrative director of an ongoing roleplay. Decide what should happen in the very next reply.\n${DIRECTOR_MODES[mode] || DIRECTOR_MODES.natural}\nWrite 1-3 sentences addressed to the narrator, describing what happens next (not how to phrase it). Never write dialogue for ${you()} or decide ${you()}'s actions. Reply with the direction only.` },
        { role: 'user', content: `${storyBrief()}\n${plot ? `\nHidden long-term arc (steer toward it subtly):\n${formatPlot(plot)}\n` : ''}\nRecent story:\n${transcript(10)}` },
    ], { maxTokens: 400, temperature: 0.9 }));
    if (!directive) throw new Error('The director had no idea this time');
    agentStore('director').last = { mode, text: directive, at: Date.now() };
    oneShot('rv_director', `[Director's note for your next reply — make this happen naturally, never mention the note: ${directive}]`);
    const { sendMessage, generate } = await import('../chat.js');
    const box = document.getElementById('send_textarea');
    const text = box?.value.trim();
    if (text) { box.value = ''; await sendMessage(text); } else await generate('normal');
    return directive;
}

defineAgent({
    id: 'director', name: 'Narrative Director', short: 'Director', icon: 'compass', phase: 'manual',
    description: 'A “Push story” button by the message box: advance the current threads, or throw in a random event. Works with Secret Plot.',
});

// ================================================================ Secret Plot
export const formatPlot = p => [p.arc && `Arc: ${p.arc}`, p.protagonist && `${you()}'s arc: ${p.protagonist}`, p.beats?.length && `Next beats: ${p.beats.join('; ')}`, p.twist && `Hidden twist: ${p.twist}`].filter(Boolean).join('\n');

defineAgent({
    id: 'plot', name: 'Secret Plot', short: 'Plot', icon: 'masks-theater', phase: 'post',
    description: 'Keeps a hidden long-term story arc and quietly steers toward it. Peek at it (and edit it) in the Story tab.',
    defaults: { every: 8 },
    async run(ctx) {
        const store = agentStore('plot');
        const prev = store.arc;
        const out = parseJson(await callAgent([
            { role: 'system', content: `You are a story architect planning the hidden long-term arc of an ongoing roleplay. ${prev ? 'Revise the current plan to fit what has happened (keep what still works).' : 'Invent a compelling arc that grows out of the story so far.'} Never plan ${you()}'s choices; plan what the world and other characters do. Reply with JSON only: {"arc": "where the story is heading, 1-2 sentences", "protagonist": "the change ${you()}'s character could go through", "beats": ["the next 3 beats, short"], "twist": "one secret that will be revealed later"}` },
            { role: 'user', content: `${storyBrief()}\n${prev ? `\nCurrent plan:\n${formatPlot(prev)}\n` : ''}\nRecent story:\n${transcript(16)}` },
        ], { maxTokens: 700 }));
        if (store.locked) return; // you edited it by hand
        store.arc = { arc: String(out.arc || ''), protagonist: String(out.protagonist || ''), beats: (out.beats || []).map(String).slice(0, 5), twist: String(out.twist || ''), at: Date.now() };
        eventSource.emit('rv_story_changed');
    },
    inject(cfg) {
        const arc = cfg && agentStore('plot').arc;
        return [{ key: 'rv_secret_plot', value: arc ? `[Hidden story plan — steer toward it subtly over many replies; never reveal or rush it]\n${formatPlot(arc)}` : '' }];
    },
});

// ================================================================ Prose Guardian
let holding = false;
let received = false;
function setHold(on) {
    holding = on;
    document.body.classList.toggle('rv-prose-hold', on);
}

defineAgent({
    id: 'prose', name: 'Prose Guardian', short: 'Polishing', icon: 'feather-pointed', phase: 'post', first: true, ignoreCadence: true,
    description: 'Rewrites each reply to remove banned words, clichés and repetition. The original is kept in the message\'s edit history.',
    defaults: { banned: 'ozone, a mix of, ministrations, shivers down, testament to, tapestry, palpable, dance of, couldn\'t help but, a hint of', prefer: '', avoid: 'phrases and sentence openings repeated from the previous replies; purple prose', hold: true },
    onGenerationStarted(type, cfg) {
        received = false;
        if (cfg.hold && ['normal', 'swipe', 'regenerate'].includes(type)) setHold(true);
    },
    async run(ctx, cfg) {
        try {
            if (ctx.type === 'continue') return;
            const { mes } = ctx;
            const original = mes.mes;
            if (!original.trim()) return;
            const previous = state.chat.slice(0, ctx.index).filter(m => !m.is_user && !m.is_system).slice(-2).map(m => m.mes).join('\n---\n');
            let out = await callAgent([
                { role: 'system', content: `You are a meticulous line editor for roleplay fiction. Revise the reply below.\n- Remove or replace these banned words/phrases: ${cfg.banned || '(none)'}\n- Avoid: ${cfg.avoid || 'repetition'}\n${cfg.prefer ? `- Prefer: ${cfg.prefer}\n` : ''}- Keep the meaning, events, dialogue content, formatting (asterisks, quotes, markdown, HTML) and length about the same. Change only what needs changing.\nReply with the revised text only — no notes, no quotes around it.` },
                { role: 'user', content: `${previous ? `Previous replies (for spotting repetition):\n${previous}\n\n` : ''}Reply to revise:\n${original}` },
            ], { maxTokens: Math.max(800, Math.ceil(original.length / 2.5)), temperature: 0.4 });
            out = out.replace(/^(here(?:'s| is) (?:the )?revised (?:text|reply)[:.]?\s*)/i, '').trim();
            // Guard against truncated or runaway rewrites.
            if (!out || out.length < original.length * 0.55 || out.length > original.length * 1.6) throw new Error('rewrite looked wrong, kept the original');
            if (out === original || mes.mes !== original || (mes.swipe_id ?? 0) !== ctx.swipeId) return;
            recordEdit(mes, original, out, 'Prose Guardian');
            mes.mes = out;
            await syncSwipeOf(mes);
            await rerender(mes);
            await saveChat();
        } finally {
            setHold(false);
        }
    },
    onError: () => setHold(false),
});
eventSource.on(event_types.MESSAGE_RECEIVED, () => { received = true; });
eventSource.on(event_types.GENERATION_ENDED, () => { if (holding && !received) setHold(false); });

// ================================================================ Continuity Checker
defineAgent({
    id: 'continuity', name: 'Continuity Checker', short: 'Continuity', icon: 'list-check', phase: 'post',
    description: 'Looks for slips — wrong names, clothes, injuries, time of day, who knows what — and lists them under the reply. Tick the fixes you want.',
    defaults: { every: 1 },
    async run(ctx) {
        const { mes } = ctx;
        const out = parseJson(await callAgent([
            { role: 'system', content: 'You check the newest reply of a roleplay for continuity errors against what the story already established: names, positions, clothing, injuries, objects held, time of day, weather, who is present, who knows what, and earlier facts. Ignore style. Only report clear contradictions. Reply with JSON only: {"issues": [{"problem": "short description", "quote": "the exact wrong text copied from the reply", "fix": "replacement text for that quote"}]} with at most 4 issues, or {"issues": []}.' },
            { role: 'user', content: `${storyBrief()}\n\nEarlier story:\n${transcript(14, ctx.index)}\n\nNewest reply:\n${mes.mes}` },
        ], { maxTokens: 700, temperature: 0.2 }));
        const issues = (out.issues || []).filter(i => i?.quote && mes.mes.includes(i.quote)).slice(0, 4)
            .map(i => ({ problem: String(i.problem || ''), quote: String(i.quote), fix: String(i.fix ?? '') }));
        patchSwipe(mes, ctx.swipeId, extra => { if (issues.length) extra.rv_continuity = { issues }; else delete extra.rv_continuity; });
        await rerender(mes);
    },
});

export async function applyContinuity(mes, picked) {
    const data = mes.extra?.rv_continuity;
    if (!data) return;
    let text = mes.mes;
    for (const i of picked) if (text.includes(i.quote)) text = text.replace(i.quote, i.fix);
    if (text !== mes.mes) {
        recordEdit(mes, mes.mes, text, 'Continuity Checker');
        mes.mes = text;
    }
    delete mes.extra.rv_continuity;
    await syncSwipeOf(mes);
    await rerender(mes);
    await saveChat();
}

// ================================================================ Trackers
export const TRACKER_SECTIONS = {
    world: { label: 'World', icon: 'earth-americas' },
    characters: { label: 'Characters', icon: 'users' },
    quests: { label: 'Quests', icon: 'flag' },
    inventory: { label: 'Inventory', icon: 'box-open' },
    relationships: { label: 'Relationships', icon: 'heart' },
};
const SCHEMA = {
    world: '"world": {"date": "", "time": "", "weather": "", "location": "", "present": ["names in the scene"], "notes": "anything else about the situation"}',
    characters: `"characters": [{"name": "", "mood": "", "outfit": "", "condition": "health/injuries", "doing": "current action", "thoughts": "a short hidden thought"}] (everyone in the scene except ${you()})`,
    quests: '"quests": [{"title": "", "status": "active|done|failed", "notes": ""}]',
    inventory: `"inventory": [{"item": "", "qty": 1, "notes": ""}] (what ${you()} carries)`,
    relationships: `"relationships": [{"name": "", "toward": "${you()}", "feeling": "short phrase", "score": 0}] (score -100..100)`,
};

/** The newest tracker snapshot at or before `upTo` (snapshots live on each reply, per swipe). */
export function trackerState(upTo = state.chat.length) {
    for (let i = Math.min(upTo, state.chat.length) - 1; i >= 0; i--) {
        const t = state.chat[i]?.extra?.rv_trackers;
        if (t) return { state: t, index: i };
    }
    return { state: null, index: -1 };
}
export const trackerLocks = () => (agentStore('trackers').locks ??= {});

const key = s => String(s || '').trim().toLowerCase();
const rowKey = { characters: 'name', quests: 'title', inventory: 'item', relationships: 'name' };
function mergeLocked(section, prev, next) {
    const locks = trackerLocks();
    if (section === 'world') {
        const out = { ...(next || {}) };
        for (const [k, v] of Object.entries(prev || {})) if (locks[`world.${k}`]) out[k] = v;
        return out;
    }
    const id = rowKey[section];
    const out = (Array.isArray(next) ? next : []).filter(r => r && r[id]);
    for (const row of prev || []) {
        const path = `${section}.${key(row[id])}`;
        if (!locks[path]) continue;
        const i = out.findIndex(r => key(r[id]) === key(row[id]));
        if (i >= 0) out[i] = row; else out.push(row);
    }
    return out;
}

export function formatTrackers(t, sections) {
    if (!t) return '';
    const lines = [];
    const on = s => sections[s] && t[s];
    if (on('world')) {
        const w = t.world;
        lines.push(['date', 'time', 'weather', 'location'].filter(k => w[k]).map(k => `${k[0].toUpperCase()}${k.slice(1)}: ${w[k]}`).join(' · '));
        if (w.present?.length) lines.push(`Present: ${w.present.join(', ')}`);
        if (w.notes) lines.push(`Notes: ${w.notes}`);
    }
    if (on('characters') && t.characters.length) lines.push('Characters:', ...t.characters.map(c => `- ${c.name}: ${['mood', 'outfit', 'condition', 'doing'].filter(k => c[k]).map(k => `${k} ${c[k]}`).join('; ')}`));
    if (on('quests') && t.quests.length) lines.push('Quests:', ...t.quests.map(q => `- [${q.status || 'active'}] ${q.title}${q.notes ? ` — ${q.notes}` : ''}`));
    if (on('inventory') && t.inventory.length) lines.push(`${you()} carries: ${t.inventory.map(i => `${i.item}${Number(i.qty) > 1 ? ` ×${i.qty}` : ''}`).join(', ')}`);
    if (on('relationships') && t.relationships.length) lines.push('Relationships:', ...t.relationships.map(r => `- ${r.name} → ${r.toward || you()}: ${r.feeling}${r.score != null ? ` (${r.score})` : ''}`));
    return lines.filter(Boolean).join('\n');
}

defineAgent({
    id: 'trackers', name: 'Trackers', short: 'Tracking', icon: 'chart-simple', phase: 'post',
    description: 'Keeps the story state — time, weather, location, who\'s here, moods, outfits, quests, inventory, relationships — in the Story tab. Edit or lock anything; the AI sees it every reply.',
    defaults: { every: 1, sections: { world: true, characters: true, quests: true, inventory: true, relationships: false }, inject: true },
    async run(ctx, cfg) {
        const sections = Object.entries(cfg.sections || {}).filter(([, on]) => on).map(([s]) => s);
        if (!sections.length) return;
        const prev = trackerState(ctx.index).state;
        const out = parseJson(await callAgent([
            { role: 'system', content: `You keep the state tracker of an ongoing roleplay. Update it to reflect the newest reply: change what changed, keep what didn't, add new things, drop characters who left the scene from "characters" (keep them in relationships). Be concise. Reply with JSON only, with exactly these keys:\n{${sections.map(s => SCHEMA[s]).join(',\n')}}` },
            { role: 'user', content: `${storyBrief()}\n\nCurrent tracker:\n${prev ? JSON.stringify(Object.fromEntries(sections.map(s => [s, prev[s]]))) : '(empty — start it)'}\n\nRecent story (the last message is the newest reply):\n${transcript(6, ctx.index + 1)}` },
        ], { maxTokens: 1400, temperature: 0.3 }));
        const next = { ...(prev || {}) };
        for (const s of sections) next[s] = mergeLocked(s, prev?.[s], out[s]);
        next.at = Date.now();
        patchSwipe(ctx.mes, ctx.swipeId, extra => { extra.rv_trackers = next; });
        eventSource.emit('rv_story_changed');
    },
    inject(cfg) {
        if (!cfg?.inject) return [{ key: 'rv_trackers', value: '' }];
        const text = formatTrackers(trackerState().state, cfg.sections || {});
        return [{ key: 'rv_trackers', value: text ? `[Current story state — stay consistent with it]\n${text}` : '' }];
    },
});

/** Edits to the newest snapshot from the Story tab. */
export async function editTrackers(fn) {
    const { index } = trackerState();
    let mes = state.chat[index];
    if (!mes) {
        // Nothing tracked yet: start on the newest reply.
        mes = state.chat.findLast(m => !m.is_user && !m.is_system);
        if (!mes) return;
    }
    mes.extra ??= {};
    const t = mes.extra.rv_trackers ??= {};
    fn(t);
    await syncSwipeOf(mes);
    saveChatDebounced();
    eventSource.emit('rv_story_changed');
}

// ================================================================ CYOA choices
defineAgent({
    id: 'cyoa', name: 'Choices', short: 'Choices', icon: 'signs-post', phase: 'post',
    description: 'Tappable “what you do next” options under the newest reply. Tap to send, or the pencil to edit first.',
    defaults: { every: 1, count: 4 },
    async run(ctx, cfg) {
        const n = Math.max(2, Math.min(6, Number(cfg.count) || 4));
        const out = parseJson(await callAgent([
            { role: 'system', content: `Suggest ${n} distinct things ${you()} could do or say next in this roleplay, each a complete action in ${you()}'s voice (first person, present tense, may include a short line of dialogue), max 30 words, ranging from cautious to bold. Reply with JSON only: {"choices": ["..."]}` },
            { role: 'user', content: `${storyBrief()}\n\nRecent story:\n${transcript(8, ctx.index + 1)}` },
        ], { maxTokens: 600, temperature: 0.95 }));
        const choices = (out.choices || []).map(String).map(s => s.trim()).filter(Boolean).slice(0, n);
        patchSwipe(ctx.mes, ctx.swipeId, extra => { extra.rv_choices = choices; });
        await rerender(ctx.mes);
    },
});

// ================================================================ Lorebook Keeper
const loreName = () => `Story lore — ${state.chatId}`;

/** The chat's own lorebook (created on first use); worldinfo.js adds it to the active lore. */
export async function storyLorebook({ create = false } = {}) {
    const a = chatAgents();
    if (a.loreBookId) {
        try { return await api.get(`worlds/${encodeURIComponent(a.loreBookId)}`); } catch { a.loreBookId = null; }
    }
    if (!create) return null;
    const world = await api.post('worlds', { name: loreName(), entries: {} });
    a.loreBookId = world.id;
    saveChatDebounced();
    return world;
}

defineAgent({
    id: 'lorekeeper', name: 'Lorebook Keeper', short: 'Lore', icon: 'book-bookmark', phase: 'post',
    description: 'Every few messages, suggests lorebook entries for new people, places, items and facts. You approve each one (in the Story tab); they go into this story\'s own lorebook.',
    defaults: { every: 8, auto: false },
    async run(ctx, cfg) {
        const book = await storyLorebook();
        const known = Object.values(book?.entries || {}).map(e => e.comment || (e.key || [])[0]).filter(Boolean);
        const out = parseJson(await callAgent([
            { role: 'system', content: 'You maintain the lorebook of an ongoing roleplay. From the recent story, propose entries for important NEW named people, places, items, factions or established facts that will matter later — or updates to existing entries when something changed. Skip trivia and anything already covered by the character description. Each entry: title, 2-5 trigger keywords, and 1-4 sentences of factual content in third person. Reply with JSON only: {"entries": [{"title": "", "keys": [""], "content": "", "update": "title of the existing entry this replaces, or null"}]} — at most 4, or {"entries": []}.' },
            { role: 'user', content: `${storyBrief()}\n\nExisting entries: ${known.join(', ') || '(none)'}\n\nRecent story:\n${transcript(16, ctx.index + 1)}` },
        ], { maxTokens: 1200, temperature: 0.4 }));
        const entries = (out.entries || []).filter(e => e?.title && e?.content).slice(0, 4).map(e => ({
            id: crypto.randomUUID(), title: String(e.title), keys: (e.keys || []).map(String).filter(Boolean).slice(0, 6), content: String(e.content), update: e.update ? String(e.update) : null,
        }));
        if (!entries.length) return;
        if (cfg.auto) {
            for (const e of entries) await acceptLore(e, { quiet: true });
            toast(`Lorebook Keeper added ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, 'success');
            return;
        }
        const store = agentStore('lorekeeper');
        store.pending = [...(store.pending || []), ...entries].slice(-12);
        eventSource.emit('rv_story_changed');
        toast(`${entries.length} lorebook suggestion${entries.length === 1 ? '' : 's'} — review them in the Story tab`, 'info', { title: 'Lorebook Keeper' });
    },
});

export async function acceptLore(entry, { quiet = false } = {}) {
    const book = await storyLorebook({ create: true });
    book.entries ??= {};
    const existing = entry.update && Object.values(book.entries).find(e => (e.comment || '').toLowerCase() === entry.update.toLowerCase());
    if (existing) Object.assign(existing, { key: entry.keys, content: entry.content, comment: entry.title });
    else {
        const uid = Math.max(-1, ...Object.keys(book.entries).map(Number).filter(Number.isFinite)) + 1;
        book.entries[uid] = newEntry(uid, { key: entry.keys, comment: entry.title, content: entry.content });
    }
    const { saveWorld } = await import('../worldinfo.js');
    await saveWorld(book);
    dismissLore(entry.id);
    if (!quiet) toast(`Added “${entry.title}” to ${book.name}`, 'success', { timeout: 2500 });
}
export function dismissLore(id) {
    const store = agentStore('lorekeeper');
    store.pending = (store.pending || []).filter(e => e.id !== id);
    saveChatDebounced();
    eventSource.emit('rv_story_changed');
}

// ================================================================ Echo Chamber
export const ECHO_STYLES = {
    ao3: 'AO3/Wattpad readers leaving comments — gushing, theorizing, keysmashing, begging for updates',
    social: 'Twitter/Reddit posts — hot takes, memes, ship wars, "THIS SCENE" reactions',
    hype: 'a hype squad — over-the-top encouragement and celebration',
    critics: 'constructive critique partners — sharp, specific, kind notes on craft',
    doom: 'harbingers — ominous predictions and suspicious theories about what will go wrong',
};
defineAgent({
    id: 'echo', name: 'Echo Chamber', short: 'Echo', icon: 'comments', phase: 'post',
    description: 'A pretend live audience reacting to your story in a little floating feed.',
    defaults: { every: 1, style: 'ao3', count: 5 },
    async run(ctx, cfg) {
        const out = parseJson(await callAgent([
            { role: 'system', content: `Write ${Math.max(2, Math.min(8, Number(cfg.count) || 5))} short reactions to the newest part of this story from ${ECHO_STYLES[cfg.style] || ECHO_STYLES.ao3}. Each has an invented username and 1-2 sentences, in-world spoilers welcome, no meta talk about AI. Reply with JSON only: {"reactions": [{"name": "", "text": ""}]}` },
            { role: 'user', content: `Story so far (the last message is the newest):\n${transcript(6, ctx.index + 1)}` },
        ], { maxTokens: 700, temperature: 1 }));
        const reactions = (out.reactions || []).filter(r => r?.text).map(r => ({ name: String(r.name || 'reader').slice(0, 24), text: String(r.text).slice(0, 280) }));
        agentStore('echo').last = reactions;
        eventSource.emit('rv_echo', reactions);
    },
});

export { isOn, agentConfig };
