// Agents: small helper AIs that run around each reply (inspired by Marinara Engine's agents and
// Lumiverse's Council). Each agent has a phase:
//   - pre:    runs before a reply and adds context to the prompt
//   - post:   reads the finished reply and acts on it (rewrite, track, suggest)
//   - manual: runs when you press its button
// Agents are switched on per chat (with global defaults), can use their own model (one of your
// connection profiles) and run every N messages.
import { state, saveSettingsDebounced, chatMetadata, saveChatDebounced, charName, userName, currentPersona, connectionRequest } from '../state.js';
import { stripReasoning } from '../reasoning.js';
import { completion } from '../api.js';
import { eventSource, event_types } from '../events.js';
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../prompt.js';
import { el, icon, toast } from '../ui.js';

/** @type {Map<string, object>} id -> agent definition */
export const agents = new Map();
export function defineAgent(def) { agents.set(def.id, def); }

// ---------------------------------------------------------------- settings
export function agentSettings() {
    const s = (state.settings.agents ??= {});
    s.defaults ??= {}; // id -> on by default in new chats
    s.config ??= {}; // id -> per-agent options
    s.connection ??= ''; // '' = same as chat, else a connection profile name
    return s;
}
export function agentConfig(id) {
    const def = agents.get(id);
    const s = agentSettings();
    s.config[id] = { ...(def?.defaults || {}), ...(s.config[id] || {}) };
    return s.config[id];
}
export const saveAgentSettings = () => saveSettingsDebounced();

/** Per-chat state: which agents are on, plus anything agents keep for this chat. */
export function chatAgents() {
    const meta = chatMetadata();
    meta.rv_agents ??= { on: {} };
    meta.rv_agents.on ??= {};
    return meta.rv_agents;
}
export const agentsOff = () => !!chatAgents().off;
export function isOn(id) {
    if (!state.chatId || agentsOff()) return false;
    const chosen = chatAgents().on[id];
    return chosen ?? !!agentSettings().defaults[id];
}
export function setOn(id, on) {
    chatAgents().on[id] = !!on;
    saveChatDebounced();
    eventSource.emit('rv_agents_changed');
}
/** Storage an agent keeps for this chat. */
export function agentStore(id) {
    const a = chatAgents();
    a.data ??= {};
    a.data[id] ??= {};
    return a.data[id];
}

// ---------------------------------------------------------------- calling the model
function agentConnection() {
    const name = agentSettings().connection;
    const profile = name && (state.settings.connection.profiles || []).find(p => p.name === name);
    return connectionRequest(profile || state.settings.connection);
}

/** One request to the agent model. messages: [{role, content}] */
export async function callAgent(messages, { maxTokens = 1200, temperature = 0.7, signal } = {}) {
    const conn = agentConnection();
    if (!conn.model) throw new Error('No model selected (Settings → Connection)');
    const res = await completion({ ...conn, messages, params: { temperature, max_tokens: maxTokens } }, { signal });
    return stripReasoning(String(res.text || '')).trim(); // reasoning models may think inline
}

/** Pulls a JSON object/array out of a model reply (tolerates code fences and chatter around it). */
export function parseJson(text) {
    const s = String(text || '').replace(/```(?:json)?/gi, '');
    const start = s.search(/[[{]/);
    if (start < 0) throw new Error('The agent didn\'t return JSON');
    const open = s[start];
    const close = open === '{' ? '}' : ']';
    const end = s.lastIndexOf(close);
    if (end <= start) throw new Error('The agent returned incomplete JSON');
    return JSON.parse(s.slice(start, end + 1));
}

const strip = t => String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim();

/** The last `n` visible messages as "Name: text". */
export function transcript(n = 8, upTo = state.chat.length) {
    return state.chat.slice(0, upTo).filter(m => !m.is_system && String(m.mes || '').trim()).slice(-n)
        .map(m => `${m.name || (m.is_user ? userName() : charName())}: ${strip(m.mes).slice(0, 2400)}`).join('\n\n');
}

/** A compact description of the story's cast for agent prompts. */
export function storyBrief() {
    const d = state.character?.card?.data || {};
    const persona = currentPersona();
    return [
        `Character: ${d.name || charName()}`,
        d.description ? `About ${d.name}: ${strip(d.description).slice(0, 1500)}` : '',
        (chatMetadata().scenario || d.scenario) ? `Scenario: ${strip(chatMetadata().scenario || d.scenario).slice(0, 800)}` : '',
        `The user plays: ${persona.name || userName()}${persona.description ? ` — ${strip(persona.description).slice(0, 600)}` : ''}`,
    ].filter(Boolean).join('\n');
}

// ---------------------------------------------------------------- message helpers
/** Changes the stored extra data of one swipe of a message, wherever that swipe is now. */
export function patchSwipe(mes, swipeId, fn) {
    if (!state.chat.includes(mes)) return false;
    if ((mes.swipe_id ?? 0) === swipeId) {
        mes.extra ??= {};
        fn(mes.extra);
        if (mes.swipe_info?.[swipeId]) mes.swipe_info[swipeId].extra = structuredClone(mes.extra);
    } else {
        const info = mes.swipe_info?.[swipeId];
        if (!info) return false;
        info.extra ??= {};
        fn(info.extra);
    }
    return true;
}

export async function rerender(mes) {
    const id = state.chat.indexOf(mes);
    if (id < 0) return;
    const { updateMessageBlock } = await import('../chat.js');
    updateMessageBlock(id);
}

// ---------------------------------------------------------------- status chip
const running = new Map(); // id -> label
let chip = null;
function paintStatus() {
    chip ??= document.getElementById('agent-status');
    if (!chip) return;
    chip.classList.toggle('hidden', !running.size);
    chip.replaceChildren(icon('spinner', 'fa-spin'), el('span', {}, [...running.values()].join(', ')));
    chip.title = 'Agents at work';
}
export async function track(id, label, fn) {
    running.set(id, label);
    paintStatus();
    try { return await fn(); } finally { running.delete(id); paintStatus(); }
}

// ---------------------------------------------------------------- scheduling
/** Should an every-N agent run now? `every` counts messages (yours and theirs). */
function due(id, every) {
    if (!every || every <= 1) return true;
    const store = agentStore(id);
    const count = state.chat.filter(m => !m.is_system).length;
    if (store.lastRunAt == null) return count >= every;
    return count - store.lastRunAt >= every;
}
const markRun = id => { agentStore(id).lastRunAt = state.chat.filter(m => !m.is_system).length; };

let postChain = Promise.resolve();
/** 'rv_reply_final' (index, type): the reply is in its final form, after any agent that rewrites it. */
const replyFinal = (targetId, type) => eventSource.emit('rv_reply_final', targetId, type);
async function runPost(targetId, type) {
    const mes = state.chat[targetId];
    if (!mes || mes.is_user || !state.chatId) return replyFinal(targetId, type);
    const ctx = { mes, swipeId: mes.swipe_id ?? 0, index: targetId, type, chatId: state.chatId };
    const list = [...agents.values()].filter(a => a.phase === 'post' && isOn(a.id));
    // "first" agents (e.g. the prose rewrite) run before the rest, which then see the final text.
    const first = list.filter(a => a.first);
    const rest = list.filter(a => !a.first);
    const run = async a => {
        if (state.chatId !== ctx.chatId) return;
        const cfg = agentConfig(a.id);
        if (!a.ignoreCadence && !due(a.id, Number(cfg.every) || 1)) return;
        try {
            await track(a.id, a.short || a.name, () => a.run(ctx, cfg));
            markRun(a.id);
            saveChatDebounced();
        } catch (err) {
            console.warn(`[agents] ${a.name} failed`, err);
            toast(`${a.name}: ${err.message}`, 'warning', { title: 'Agent failed', timeout: 5000 });
            a.onError?.(ctx, err);
        }
    };
    for (const a of first) await run(a);
    replyFinal(targetId, type);
    await Promise.all(rest.map(run));
}

/** Prompt sections agents contribute; recomputed right before every reply. */
function syncInjections(type) {
    for (const a of agents.values()) {
        for (const inj of a.inject?.(isOn(a.id) && state.chatId ? agentConfig(a.id) : null, type) || []) {
            setExtensionPrompt(inj.key, inj.value || '', inj.inChat ? extension_prompt_types.IN_CHAT : extension_prompt_types.IN_PROMPT, inj.depth ?? 0, false, extension_prompt_roles.SYSTEM);
        }
    }
}

// One-shot notes for the next reply (Push Story, regenerate feedback).
const oneShots = new Map();
export function oneShot(key, text) { oneShots.set(key, text); }
function syncOneShots(type) {
    const real = ['normal', 'swipe', 'regenerate', 'continue'].includes(type);
    for (const [key, text] of oneShots) setExtensionPrompt(key, real ? text : '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
    if (real) {
        // Consumed by this reply; cleared when it ends (the prompt is built in between).
        for (const k of oneShots.keys()) consumed.add(k);
        oneShots.clear();
    }
}
const consumed = new Set();

export function bindAgents() {
    eventSource.on(event_types.GENERATION_STARTED, type => {
        syncInjections(type);
        syncOneShots(type);
        for (const a of agents.values()) if (isOn(a.id)) a.onGenerationStarted?.(type, agentConfig(a.id));
    });
    eventSource.on(event_types.GENERATION_ENDED, () => {
        for (const k of consumed) setExtensionPrompt(k, '', extension_prompt_types.IN_CHAT, 0);
        consumed.clear();
    });
    eventSource.on(event_types.MESSAGE_RECEIVED, (id, type) => {
        if (type === 'quiet' || type === 'impersonate') return;
        // Don't hold up the reply: post agents run after it's shown.
        postChain = postChain.then(() => runPost(id, type)).catch(err => console.error('[agents]', err));
    });
    eventSource.on(event_types.CHAT_CHANGED, () => {
        oneShots.clear();
        syncInjections('normal');
        for (const a of agents.values()) a.onChatChanged?.();
    });
}

/** Runs a post agent on demand (e.g. "re-run" buttons) against the latest reply. */
export async function runNow(id) {
    const a = agents.get(id);
    const index = state.chat.findLastIndex(m => !m.is_user && !m.is_system);
    if (!a || index < 0) return;
    const mes = state.chat[index];
    const ctx = { mes, swipeId: mes.swipe_id ?? 0, index, type: 'manual', chatId: state.chatId };
    try {
        await track(a.id, a.short || a.name, () => a.run(ctx, agentConfig(id)));
        markRun(id);
        saveChatDebounced();
    } catch (err) {
        toast(`${a.name}: ${err.message}`, 'warning', { title: 'Agent failed' });
    }
}
