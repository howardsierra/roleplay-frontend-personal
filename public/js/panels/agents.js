// Settings → Agents: which model agents use, which agents are on in new chats, and each one's options.
import { state } from '../state.js';
import { el, icon, field, select, textArea, textInput, toggle, section, slider } from '../ui.js';
import { agents, agentSettings, agentConfig, saveAgentSettings } from '../agents/core.js';
import { TRACKER_SECTIONS, ECHO_STYLES } from '../agents/builtin.js';
import { agentConnectionSelect } from '../agents/ui.js';

const ORDER = ['director', 'plot', 'prose', 'continuity', 'trackers', 'cyoa', 'lorekeeper', 'echo'];

export async function render(body) {
    const s = agentSettings();
    const profiles = state.settings.connection.profiles || [];
    const save = () => { saveAgentSettings(); import('../state.js').then(m => import('../events.js').then(e => e.eventSource.emit('rv_agents_changed'))); };
    body.append(section('How agents run',
        el('p', { class: 'hint' }, 'Agents are small helper AIs that run around your replies. Switch them on per story in the character sheet’s Story tab; the switches below decide what new stories start with.'),
        field('Model for agents', select([['', 'Same as the chat'], ...profiles.map(p => [p.name, `${p.name} (${p.model})`])], s.connection, v => { s.connection = v; save(); }),
            profiles.length ? 'A cheaper, faster model works well for most agents.' : 'Save a connection profile (Settings → Connection → Profiles) to give agents their own model.'),
        toggle('Give agents the full story context', s.richBrief !== false, v => { s.richBrief = v; save(); }, 'The whole card, persona, active lore, memories and tracker state. Better judgement; a few more tokens per agent call.')));

    for (const id of ORDER) {
        const def = agents.get(id);
        if (!def) continue;
        const cfg = agentConfig(id);
        const opts = [];
        const every = (label = 'Run every … messages') => slider(label, Number(cfg.every) || 1, { min: 1, max: 30, step: 1, onChange: v => { cfg.every = v; save(); } });
        switch (id) {
            case 'plot': opts.push(every('Rethink the plan every … messages')); break;
            case 'prose':
                opts.push(field('Banned words and phrases', textArea(cfg.banned, v => { cfg.banned = v; save(); }, { rows: 3 }), 'Comma-separated.'),
                    field('Avoid', textInput(cfg.avoid, v => { cfg.avoid = v; save(); })),
                    field('Prefer', textInput(cfg.prefer, v => { cfg.prefer = v; save(); }, { placeholder: 'e.g. British spelling, short paragraphs' })),
                    toggle('Hold the reply until it’s polished', cfg.hold, v => { cfg.hold = v; save(); }, 'Blurs the raw reply while it streams, so you only read the final version.'));
                break;
            case 'continuity': opts.push(every()); break;
            case 'trackers':
                opts.push(el('div', { class: 'chip-row' }, Object.entries(TRACKER_SECTIONS).map(([k, sec]) => {
                    const chip = el('button', { class: `chip toggle-chip${cfg.sections?.[k] ? ' active' : ''}`, onclick: () => {
                        cfg.sections = { ...(cfg.sections || {}), [k]: !cfg.sections?.[k] };
                        chip.classList.toggle('active', !!cfg.sections[k]);
                        save();
                    } }, icon(sec.icon), sec.label);
                    return chip;
                })),
                toggle('Show the state to the AI every reply', cfg.inject, v => { cfg.inject = v; save(); }, 'Adds a short “current story state” section to the prompt so details stay consistent.'),
                every('Update every … messages'));
                break;
            case 'cyoa': opts.push(slider('Number of choices', Number(cfg.count) || 4, { min: 2, max: 6, step: 1, onChange: v => { cfg.count = v; save(); } })); break;
            case 'lorekeeper':
                opts.push(every('Look for new lore every … messages'),
                    toggle('Add suggestions without asking', cfg.auto, v => { cfg.auto = v; save(); }, 'Off: you approve each entry in the Story tab.'));
                break;
            case 'echo':
                opts.push(field('Audience', select(Object.keys(ECHO_STYLES).map(k => [k, { ao3: 'AO3 / Wattpad readers', social: 'Twitter / Reddit', hype: 'Hype squad', critics: 'Critique partners', doom: 'Harbingers of doom' }[k]]), cfg.style, v => { cfg.style = v; save(); })),
                    slider('Reactions per reply', Number(cfg.count) || 5, { min: 2, max: 8, step: 1, onChange: v => { cfg.count = v; save(); } }));
                break;
            default: break;
        }
        body.append(section('',
            el('div', { class: 'agent-setting-head' }, el('span', { class: 'agent-setting-icon' }, icon(def.icon)), el('div', {}, el('b', {}, def.name), el('p', { class: 'hint' }, def.description))),
            toggle('On in new stories', !!s.defaults[id], v => { s.defaults[id] = v; save(); }),
            profiles.length ? field('Model', agentConnectionSelect(id, save)) : null,
            ...opts));
    }
}
