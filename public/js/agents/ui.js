// Agents in the interface: the Story tab, choices and continuity cards under replies, the Echo feed,
// the Push story button and the status chip.
import { state } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { el, icon, toast, toggle } from '../ui.js';
import { points, pointsChanged } from '../rv-ext/points.js';
import { agents, isOn, setOn, agentsOff, chatAgents, agentStore, agentConfig, runNow } from './core.js';
import {
    pushStory, formatPlot, applyContinuity, trackerState, trackerLocks, editTrackers, TRACKER_SECTIONS,
    acceptLore, dismissLore,
} from './builtin.js';

const ORDER = ['director', 'plot', 'prose', 'continuity', 'trackers', 'cyoa', 'lorekeeper', 'echo'];
const ordered = () => ORDER.map(id => agents.get(id)).filter(Boolean);

// ---------------------------------------------------------------- Story tab
let storyBox = null;
function renderStory(container) {
    storyBox = container;
    if (!state.chatId) { container.replaceChildren(el('div', { class: 'empty' }, 'Open a chat to use agents.')); return; }
    const a = chatAgents();
    const anyOn = ordered().some(x => isOn(x.id));
    container.replaceChildren(el('div', { class: 'story-tab' },
        el('div', { class: 'story-head' },
            toggle('Agents in this story', !a.off, v => { a.off = !v; import('../state.js').then(m => m.saveChatDebounced()); refresh(); }),
            el('div', { class: 'agent-chips' }, ordered().map(def => el('button', {
                class: `agent-chip${isOn(def.id) ? ' on' : ''}`, title: def.description, disabled: agentsOff(),
                onclick: () => { setOn(def.id, !isOn(def.id)); refresh(); },
            }, icon(def.icon), def.name))),
            el('button', { class: 'btn small ghost', onclick: () => import('../panels/settings.js').then(m => m.openSettings('agents')) }, icon('sliders'), 'Agent settings')),
        isOn('director') ? directorCard() : null,
        isOn('trackers') || trackerState().state ? trackersCard() : null,
        isOn('plot') ? plotCard() : null,
        (agentStore('lorekeeper').pending || []).length ? loreCard() : null,
        !anyOn ? el('p', { class: 'hint' }, 'Switch agents on above. Each one is a small helper AI that runs around your replies — they use your chat model, or a cheaper one picked in Agent settings.') : null));
}
const refresh = () => { if (storyBox?.isConnected) renderStory(storyBox); syncComposer(); };

function card(title, ic, ...children) {
    return el('section', { class: 'story-card' }, el('h4', {}, icon(ic), title), ...children);
}

function directorCard() {
    const last = agentStore('director').last;
    const go = mode => async () => {
        try { await pushStory(mode); refresh(); } catch (err) { toast(err.message, 'warning', { title: 'Director' }); }
    };
    return card('Narrative Director', 'compass',
        el('div', { class: 'row gap wrap' },
            el('button', { class: 'btn small primary', onclick: go('natural') }, icon('forward'), 'Push the story'),
            el('button', { class: 'btn small', onclick: go('random') }, icon('dice'), 'Random event')),
        last ? el('p', { class: 'hint' }, el('b', {}, 'Last push: '), last.text) : el('p', { class: 'hint' }, 'Type a message first if you want to act too — it\'s sent along with the push.'));
}

function plotCard() {
    const store = agentStore('plot');
    const arc = store.arc;
    const box = el('div', { class: `plot-box${store.revealed ? '' : ' spoiler'}` });
    const field = (label, k, rows = 2) => {
        const ta = el('textarea', { class: 'input', rows });
        ta.value = k === 'beats' ? (arc?.beats || []).join('\n') : arc?.[k] || '';
        ta.addEventListener('change', () => {
            store.arc ??= {};
            store.arc[k] = k === 'beats' ? ta.value.split('\n').map(s => s.trim()).filter(Boolean) : ta.value;
            store.locked = true;
            import('../state.js').then(m => m.saveChatDebounced());
        });
        return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), ta);
    };
    box.append(arc ? el('div', { class: 'stack' }, field('Arc', 'arc'), field('Your arc', 'protagonist'), field('Next beats (one per line)', 'beats', 3), field('Hidden twist', 'twist')) : el('p', { class: 'hint' }, `The plan is written after ${agentConfig('plot').every || 8} messages.`));
    return card('Secret Plot', 'masks-theater',
        el('div', { class: 'row gap wrap' },
            el('button', { class: 'btn small', onclick: () => { store.revealed = !store.revealed; refresh(); } }, icon(store.revealed ? 'eye-slash' : 'eye'), store.revealed ? 'Hide' : 'Peek'),
            el('button', { class: 'btn small', onclick: async () => { store.locked = false; await runNow('plot'); refresh(); } }, icon('rotate'), arc ? 'Rethink it' : 'Plan it now'),
            store.locked ? el('span', { class: 'hint' }, icon('lock'), ' Your edits are kept until you rethink it') : null),
        box);
}

function trackersCard() {
    const cfg = agentConfig('trackers');
    const t = trackerState().state || {};
    const locks = trackerLocks();
    const lockBtn = path => el('button', {
        class: `icon-btn small lock${locks[path] ? ' on' : ''}`, title: locks[path] ? 'Locked — the AI won\'t change this' : 'Lock so the AI won\'t change it',
        onclick: () => { if (locks[path]) delete locks[path]; else locks[path] = true; import('../state.js').then(m => m.saveChatDebounced()); refresh(); },
    }, icon(locks[path] ? 'lock' : 'lock-open'));
    const edit = (value, onChange, placeholder = '') => {
        const input = el('input', { class: 'input tracker-input', value: value ?? '', placeholder });
        input.addEventListener('change', () => onChange(input.value));
        return input;
    };
    const sections = [];
    const on = s => cfg.sections?.[s];
    if (on('world')) {
        const w = t.world || {};
        sections.push(el('div', { class: 'tracker-section' }, el('h5', {}, icon(TRACKER_SECTIONS.world.icon), 'World'),
            el('div', { class: 'tracker-grid' }, ['date', 'time', 'weather', 'location'].map(k => el('label', { class: 'tracker-field' },
                el('span', {}, k), el('div', { class: 'row' }, edit(w[k], v => editTrackers(x => { (x.world ??= {})[k] = v; })), lockBtn(`world.${k}`))))),
            el('label', { class: 'tracker-field wide' }, el('span', {}, 'present'), edit((w.present || []).join(', '), v => editTrackers(x => { (x.world ??= {}).present = v.split(',').map(s => s.trim()).filter(Boolean); })))));
    }
    const list = (s, idKey, fields, add) => {
        const rows = t[s] || [];
        return el('div', { class: 'tracker-section' }, el('h5', {}, icon(TRACKER_SECTIONS[s].icon), TRACKER_SECTIONS[s].label),
            rows.length ? rows.map((r, i) => el('div', { class: 'tracker-row' },
                el('div', { class: 'tracker-row-head' }, el('b', {}, r[idKey] || '—'), r.score != null && s === 'relationships' ? el('span', { class: `score ${r.score >= 0 ? 'pos' : 'neg'}` }, String(r.score)) : null,
                    el('span', { class: 'grow' }), lockBtn(`${s}.${String(r[idKey] || '').toLowerCase()}`),
                    el('button', { class: 'icon-btn small', title: 'Remove', onclick: () => editTrackers(x => { x[s].splice(i, 1); }) }, icon('xmark'))),
                el('div', { class: 'tracker-row-fields' }, fields.map(f => el('label', { class: 'tracker-field' }, el('span', {}, f),
                    edit(r[f], v => editTrackers(x => { x[s][i][f] = f === 'qty' || f === 'score' ? Number(v) || 0 : v; }))))))) : el('p', { class: 'hint' }, 'Nothing yet.'),
            el('button', { class: 'btn small ghost', onclick: () => editTrackers(x => { (x[s] ??= []).push(add()); }) }, icon('plus'), 'Add'));
    };
    if (on('characters')) sections.push(list('characters', 'name', ['mood', 'outfit', 'condition', 'doing', 'thoughts'], () => ({ name: 'New character' })));
    if (on('quests')) sections.push(list('quests', 'title', ['status', 'notes'], () => ({ title: 'New quest', status: 'active' })));
    if (on('inventory')) sections.push(list('inventory', 'item', ['qty', 'notes'], () => ({ item: 'New item', qty: 1 })));
    if (on('relationships')) sections.push(list('relationships', 'name', ['feeling', 'score'], () => ({ name: 'Someone', feeling: 'neutral', score: 0 })));
    return card('Story state', 'chart-simple',
        el('div', { class: 'row gap wrap' },
            el('button', { class: 'btn small', onclick: async () => { await runNow('trackers'); refresh(); } }, icon('rotate'), 'Update now'),
            el('span', { class: 'hint' }, t.at ? `Updated ${new Date(t.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'Fills in after the next reply.')),
        ...sections);
}

function loreCard() {
    const pending = agentStore('lorekeeper').pending || [];
    return card(`Lorebook suggestions (${pending.length})`, 'book-bookmark', pending.map(e => {
        const content = el('textarea', { class: 'input', rows: 3 });
        content.value = e.content;
        const keys = el('input', { class: 'input', value: e.keys.join(', ') });
        return el('div', { class: 'lore-suggestion' },
            el('div', { class: 'row gap' }, el('b', {}, e.title), e.update ? el('span', { class: 'hint' }, `updates “${e.update}”`) : el('span', { class: 'hint' }, 'new')),
            el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'Keywords'), keys), content,
            el('div', { class: 'row gap' },
                el('button', { class: 'btn small primary', onclick: async () => {
                    await acceptLore({ ...e, content: content.value, keys: keys.value.split(',').map(s => s.trim()).filter(Boolean) });
                    refresh();
                } }, icon('check'), 'Add to lorebook'),
                el('button', { class: 'btn small', onclick: () => { dismissLore(e.id); refresh(); } }, icon('xmark'), 'Dismiss')));
    }));
}

// ---------------------------------------------------------------- under each reply
async function decorate(node, mes, id, { streaming }) {
    node.querySelector(':scope .rv-agent-extras')?.remove();
    if (streaming || mes.is_user || !state.chatId) return;
    const parts = [];
    const cont = mes.extra?.rv_continuity;
    if (cont?.issues?.length) {
        const picks = cont.issues.map(() => true);
        parts.push(el('details', { class: 'continuity-card' },
            el('summary', {}, icon('list-check'), ` Continuity: ${cont.issues.length} possible slip${cont.issues.length === 1 ? '' : 's'}`),
            el('div', { class: 'continuity-list' }, cont.issues.map((iss, i) => el('label', { class: 'continuity-item' },
                el('input', { type: 'checkbox', checked: true, onchange: e => { picks[i] = e.target.checked; } }),
                el('span', {}, el('b', {}, iss.problem), el('span', { class: 'cont-diff' }, el('del', {}, iss.quote), ' → ', el('ins', {}, iss.fix || '(remove)')))))),
            el('div', { class: 'row gap' },
                el('button', { class: 'btn small primary', onclick: () => applyContinuity(mes, cont.issues.filter((_, i) => picks[i])) }, icon('check'), 'Apply selected'),
                el('button', { class: 'btn small', onclick: () => applyContinuity(mes, []) }, 'Dismiss'))));
    }
    const isLast = id === state.chat.findLastIndex(m => !m.is_system);
    const choices = isLast && mes.extra?.rv_choices;
    if (choices?.length) {
        const send = async text => {
            if (state.generating) return;
            const { sendMessage } = await import('../chat.js');
            await sendMessage(text);
        };
        const fill = text => {
            const box = document.getElementById('send_textarea');
            box.value = text;
            box.focus();
            import('../chat.js').then(m => m.autoGrow());
        };
        parts.push(el('div', { class: 'cyoa' },
            choices.map(c => el('div', { class: 'cyoa-choice' },
                el('button', { class: 'cyoa-main', onclick: () => send(c) }, c),
                el('button', { class: 'icon-btn small', title: 'Edit before sending', onclick: () => fill(c) }, icon('pen')))),
            el('button', { class: 'cyoa-reroll', title: 'New choices', onclick: () => runNow('cyoa') }, icon('rotate'), 'Other choices')));
    }
    if (!parts.length) return;
    const box = el('div', { class: 'rv-agent-extras' }, ...parts);
    node.querySelector('.mes_text')?.after(box);
}

// ---------------------------------------------------------------- Echo feed
let echoTimer = 0;
function showEcho(reactions) {
    if (!reactions?.length || !isOn('echo')) return;
    let box = document.getElementById('rv-echo');
    if (!box) {
        box = el('div', { id: 'rv-echo', class: 'rv-echo' },
            el('div', { class: 'rv-echo-head' }, icon('comments'), el('b', {}, 'Echo'), el('span', { class: 'rv-echo-live' }, 'live'),
                el('button', { class: 'icon-btn small', title: 'Hide', onclick: () => { clearInterval(echoTimer); box.remove(); } }, icon('xmark'))),
            el('div', { class: 'rv-echo-list' }));
        document.body.append(box);
    }
    const list = box.querySelector('.rv-echo-list');
    const queue = [...reactions];
    clearInterval(echoTimer);
    const next = () => {
        const r = queue.shift();
        if (!r) { clearInterval(echoTimer); return; }
        list.prepend(el('div', { class: 'rv-echo-item' }, el('b', {}, `@${r.name}`), el('span', {}, r.text)));
        while (list.children.length > 14) list.lastChild.remove();
    };
    next();
    echoTimer = setInterval(next, 6000);
}

// ---------------------------------------------------------------- composer + status
function syncComposer() {
    const host = document.getElementById('leftSendForm');
    if (!host) return;
    let btn = document.getElementById('btn-push-story');
    const show = isOn('director');
    if (show && !btn) {
        btn = el('button', { id: 'btn-push-story', class: 'icon-btn', title: 'Push the story (Narrative Director)', onclick: async () => {
            const { popMenu } = await import('../chat.js');
            popMenu(btn, [
                ['forward', 'Push the story', async () => { try { await pushStory('natural'); } catch (err) { toast(err.message, 'warning', { title: 'Director' }); } }],
                ['dice', 'Random event', async () => { try { await pushStory('random'); } catch (err) { toast(err.message, 'warning', { title: 'Director' }); } }],
            ]);
        } }, icon('compass'));
        host.append(btn);
    } else if (!show && btn) btn.remove();
}

export function bindAgentUi() {
    points.sheetTabs.add({ id: 'story', builtin: true, title: 'Story', shortName: 'Story', icon: 'book-open-reader', render: renderStory });
    pointsChanged('sheetTabs');
    import('../chat.js').then(m => m.renderHooks.add(decorate));
    for (const ev of ['rv_story_changed', 'rv_agents_changed', event_types.CHAT_CHANGED, event_types.MESSAGE_SWIPED, event_types.MESSAGE_DELETED]) eventSource.on(ev, refresh);
    eventSource.on('rv_echo', showEcho);
    document.getElementById('agent-status')?.addEventListener('click', () => import('../layout.js').then(m => m.openSheetTab('story')));
    eventSource.on(event_types.CHAT_CHANGED, () => { clearInterval(echoTimer); document.getElementById('rv-echo')?.remove(); });
    syncComposer();
}
