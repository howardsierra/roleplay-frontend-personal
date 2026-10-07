// The `rv` object handed to a Reverie extension's activate(rv). Stable, versioned, and
// permission-checked: calls that need a permission the manifest didn't declare throw.
import { state, saveSettingsDebounced, saveChat, currentPersona, charName, userName, connectionRequest } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { completion, streamCompletion, api as http } from '../api.js';
import { samplerParams, setExtensionPrompt, extensionPrompts } from '../prompt.js';
import { substituteParams, registerMacro, unregisterMacro, variables } from '../macros.js';
import { sendMessage, addOneMessage, nowDate, updateMessageBlock } from '../chat.js';
import { SlashCommandParser, executeSlashCommands } from '../st/compat.js';
import { toast, modal, confirmDialog, el } from '../ui.js';
import { points, pointsChanged, plainMessage } from './points.js';

export const API_VERSION = 1;

export const PERMISSIONS = {
    generate: 'Send requests to your AI model',
    'chat.write': 'Add, send or edit messages in your chats',
    prompt: 'Add text to the prompt sent to the AI',
    storage: 'Store its own data on your Reverie server',
    network: 'Contact websites outside Reverie',
};

// Friendly event names → SillyTavern event names (raw ST names are accepted too).
const EVENTS = {
    'message:sent': event_types.MESSAGE_SENT,
    'message:received': event_types.MESSAGE_RECEIVED,
    'message:edited': event_types.MESSAGE_EDITED,
    'message:deleted': event_types.MESSAGE_DELETED,
    'message:swiped': event_types.MESSAGE_SWIPED,
    'message:rendered': event_types.CHARACTER_MESSAGE_RENDERED,
    'chat:changed': event_types.CHAT_CHANGED,
    'generation:started': event_types.GENERATION_STARTED,
    'generation:ended': event_types.GENERATION_ENDED,
    'stream:token': event_types.STREAM_TOKEN_RECEIVED,
    'persona:changed': event_types.PERSONA_CHANGED,
    'settings:changed': event_types.SETTINGS_UPDATED,
};

function extState(id) {
    state.settings.rvext ??= {};
    state.settings.rvext[id] ??= { enabled: true, settings: {} };
    state.settings.rvext[id].settings ??= {};
    return state.settings.rvext[id];
}

export function settingDefaults(manifest) {
    return Object.fromEntries((manifest.settings || []).map(s => [s.key, s.default ?? (s.type === 'toggle' ? false : '')]));
}



/**
 * @param {{ id: string, manifest: object }} ext
 * @param {Array<() => void>} disposers collected and run on deactivate
 */
export function createApi(ext, disposers) {
    const { id, manifest } = ext;
    const perms = new Set(manifest.permissions || []);
    const need = perm => {
        if (!perms.has(perm)) throw new Error(`${manifest.name || id} needs the "${perm}" permission (add it to reverie-extension.json).`);
    };
    const track = dispose => { disposers.push(dispose); return dispose; };
    const changed = new Set();

    const rv = {
        apiVersion: API_VERSION,
        id,
        manifest: structuredClone(manifest),
        baseUrl: `/rv-extensions/${encodeURIComponent(ext.name)}/`,

        settings: {
            get(key) {
                const all = { ...settingDefaults(manifest), ...extState(id).settings };
                return key === undefined ? all : all[key];
            },
            set(key, value) {
                extState(id).settings[key] = value;
                saveSettingsDebounced();
                for (const fn of changed) fn(key, value);
            },
            onChange(fn) {
                changed.add(fn);
                return track(() => changed.delete(fn));
            },
        },

        storage: {
            async get(key) { need('storage'); return (await http.get(`ext-data/${encodeURIComponent(id)}`))[key]; },
            async set(key, value) { need('storage'); await http.put(`ext-data/${encodeURIComponent(id)}`, { [key]: value }); },
            async delete(key) { need('storage'); await http.put(`ext-data/${encodeURIComponent(id)}`, { [key]: null }); },
            async all() { need('storage'); return http.get(`ext-data/${encodeURIComponent(id)}`); },
        },

        events: {
            on(name, fn) {
                const ev = EVENTS[name] || name;
                eventSource.on(ev, fn);
                return track(() => eventSource.removeListener(ev, fn));
            },
            names: Object.keys(EVENTS),
        },

        chat: {
            messages: () => state.chat.map(plainMessage),
            character: () => (state.character ? { id: state.character.id, name: charName(), tags: [...(state.character.card.data.tags || [])], description: state.character.card.data.description } : null),
            persona: () => ({ name: userName(), description: currentPersona().description || '' }),
            id: () => state.chatId,
            getVar: key => variables.local.get(key),
            setVar(key, value) { variables.local.set(key, value); saveChat(); },
            async send(text, { generate = true } = {}) { need('chat.write'); await sendMessage(text, { generateAfter: generate }); },
            async addMessage({ name, text, isUser = false, hidden = false, avatar } = {}) {
                need('chat.write');
                const mes = { name: name || (isUser ? userName() : charName()), is_user: isUser, is_system: hidden, send_date: nowDate(), mes: String(text ?? ''), extra: { rvext: id }, ...(avatar ? { force_avatar: avatar } : {}) };
                state.chat.push(mes);
                addOneMessage(mes);
                await saveChat();
                return state.chat.length - 1;
            },
            async editMessage(index, text) {
                need('chat.write');
                const m = state.chat[index];
                if (!m) throw new Error('No such message');
                m.mes = String(text);
                if (m.swipes) m.swipes[m.swipe_id ?? 0] = m.mes;
                updateMessageBlock(index);
                await saveChat();
            },
        },

        /** Generate text. `prompt` (string) or `messages` ([{role, content}]). Optional onToken for streaming. */
        async generate({ prompt, messages, system, maxTokens, onToken, signal } = {}) {
            need('generate');
            const msgs = messages || [
                ...(system ? [{ role: 'system', content: substituteParams(system) }] : []),
                { role: 'user', content: substituteParams(String(prompt ?? '')) },
            ];
            const c = state.settings.connection;
            const body = { ...connectionRequest(c), messages: msgs, params: { ...samplerParams(), ...(maxTokens ? { max_tokens: maxTokens } : {}) } };
            if (onToken) {
                let text = '';
                await streamCompletion(body, { signal, onText: t => { text += t; onToken(t, text); } });
                return text;
            }
            return (await completion(body, { signal })).text;
        },

        prompt: {
            inject(key, text, { position = 'depth', depth = 4, role = 'system' } = {}) {
                need('prompt');
                const pos = { before: 2, after: 0, depth: 1 }[position] ?? 1;
                const roleId = { system: 0, user: 1, assistant: 2 }[role] ?? 0;
                const full = `rvext_${id}_${key}`;
                setExtensionPrompt(full, text, pos, depth, false, roleId);
                return track(() => { delete extensionPrompts[full]; });
            },
            remove(key) { delete extensionPrompts[`rvext_${id}_${key}`]; },
            /** fn(messages, ctx) runs on every prompt build; mutate or return a new array. */
            onBuild(fn) { need('prompt'); return track(points.promptHooks.add(fn)); },
        },

        ui: {
            toast: (msg, type = 'info') => toast(String(msg), type, { title: manifest.name }),
            modal: opts => modal(opts),
            confirm: (msg, opts) => confirmDialog(msg, opts),
            el,
            addPanel(def) { return contribute('sheetTabs', { ...def, id: `${id}:${def.id || 'panel'}`, ext: id }); },
            addComposerButton(def) { return contribute('composerButtons', { ...def, id: `${id}:${def.id || 'btn'}`, ext: id }); },
            addMessageAction(def) { return contribute('messageActions', { ...def, id: `${id}:${def.id || 'action'}`, ext: id }); },
            addMenuItem(def) { return contribute('menuItems', { ...def, id: `${id}:${def.id || 'item'}`, ext: id }); },
        },

        /** Render ```lang fenced blocks from the AI with your own code (native DOM, no iframe). */
        renderers: {
            register(lang, render) { return contribute('renderers', { lang: String(lang).toLowerCase(), render, ext: id }); },
        },

        commands: {
            register({ name, help = '', run }) {
                SlashCommandParser.addCommand(name, (args, value) => run(args, value), [], help);
                return track(() => SlashCommandParser.removeCommand(name));
            },
            run: script => executeSlashCommands(script),
        },

        macros: {
            register(name, fn) {
                registerMacro(name, fn);
                return track(() => unregisterMacro(name));
            },
        },

        /** fetch() that requires the "network" permission (requests go straight from the browser). */
        async fetch(url, init) {
            need('network');
            return fetch(url, init);
        },
    };

    function contribute(kind, item) {
        const dispose = points[kind].add(item);
        pointsChanged(kind);
        return track(() => { dispose(); pointsChanged(kind); });
    }

    return Object.freeze(rv);
}
