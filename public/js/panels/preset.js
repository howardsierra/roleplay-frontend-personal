import { state, saveSettingsDebounced } from '../state.js';
import { listPresets, selectPreset, savePresetDebounced, savePreset, createPreset, deletePreset } from '../preset-store.js';
import { importPreset, toSillyTavern, toLumiverse, toReverie, defaultPreset, makeBlock, normalizeProfile, MARKER_NAMES, STRUCTURAL_MARKERS } from '../presets.js';
import { checkCondition } from '../conditions.js';
import { activeModelProfile } from '../prompt.js';
import { estimateTokens } from '../prompt.js';
import { el, icon, field, select, textInput, textArea, toggle, slider, section, toast, modal, confirmDialog, promptDialog, pickFile, download } from '../ui.js';
import { popMenu, showPromptPreview } from '../chat.js';

let rootBody = null;
const rerender = () => { if (rootBody) { rootBody.replaceChildren(); render(rootBody); } };

export async function render(body) {
    rootBody = body;
    const presets = await listPresets();
    const p = state.preset;
    const change = fn => v => { fn(v); savePresetDebounced(); };

    const picker = select(presets.map(x => [x.id, `${x.name}${x.source && x.source !== 'reverie' ? `  ·  ${x.source === 'sillytavern' ? 'ST' : 'Lumi'}` : ''}`]), p.id, async id => {
        await savePreset();
        await selectPreset(id);
        rerender();
    }, { class: 'input grow' });

    const moreBtn = el('button', { class: 'icon-btn', title: 'Preset actions' }, icon('ellipsis-vertical'));
    moreBtn.addEventListener('click', () => popMenu(moreBtn, [
        ['file-import', 'Import (Reverie / SillyTavern / Lumiverse)', importFlow],
        ['file-export', 'Export as Reverie preset', () => download(`${p.name}.rvpreset.json`, toReverie(p))],
        ['file-export', 'Export as SillyTavern', () => download(`${p.name}.json`, toSillyTavern(p))],
        ['file-export', 'Export as Lumiverse (Loom)', () => download(`${p.name}.loom.json`, toLumiverse(p))],
        ['plus', 'New preset', async () => { await createPreset(defaultPreset()); rerender(); }],
        ['clone', 'Duplicate', async () => {
            const { id, ...copy } = structuredClone(p);
            copy.name = `${p.name} (copy)`;
            await createPreset(copy);
            rerender();
        }],
        ['pen', 'Rename', async () => {
            const name = await promptDialog('Preset name', p.name, { title: 'Rename preset' });
            if (!name) return;
            p.name = name;
            await savePreset();
            rerender();
        }],
        ['trash-can', 'Delete', async () => {
            if (!await confirmDialog(`Delete preset “${p.name}”?`, { okLabel: 'Delete', danger: true })) return;
            await deletePreset(p.id);
            rerender();
        }, 'danger'],
    ]));

    const navBtn = el('button', { class: 'icon-btn', title: 'Browse presets', onclick: () => presetNavigator(presets, rerender) }, icon('table-cells-large'));
    body.append(el('div', { class: 'row gap sticky-bar' }, picker, navBtn, moreBtn));

    // ----- Prompt variables (Lumiverse) -----
    const varBlocks = p.blocks.filter(b => b.variables?.length);
    if (varBlocks.length) body.append(section('Preset options', ...varBlocks.flatMap(b => b.variables.map(def => variableControl(p, b, def)))));

    // ----- Samplers -----
    const s = p.samplers;
    body.append(section('Sampling',
        slider('Temperature', s.temperature, { min: 0, max: 2, step: 0.01, onChange: change(v => { s.temperature = v; }) }),
        slider('Top P', s.top_p, { min: 0, max: 1, step: 0.01, onChange: change(v => { s.top_p = v; }) }),
        slider('Top K', s.top_k, { min: 0, max: 200, step: 1, onChange: change(v => { s.top_k = v; }), hint: '0 = off. Claude, OpenRouter & custom only.' }),
        slider('Min P', s.min_p, { min: 0, max: 1, step: 0.01, onChange: change(v => { s.min_p = v; }) }),
        slider('Frequency penalty', s.frequency_penalty, { min: -2, max: 2, step: 0.01, onChange: change(v => { s.frequency_penalty = v; }) }),
        slider('Presence penalty', s.presence_penalty, { min: -2, max: 2, step: 0.01, onChange: change(v => { s.presence_penalty = v; }) }),
        slider('Repetition penalty', s.repetition_penalty, { min: 1, max: 2, step: 0.01, onChange: change(v => { s.repetition_penalty = v; }) }),
        el('div', { class: 'grid-2' },
            field('Max response (tokens)', numberInput(s.max_tokens, change(v => { s.max_tokens = v; }))),
            field('Context size (tokens)', numberInput(s.context_size, change(v => { s.context_size = v; })))),
        el('div', { class: 'grid-2' },
            field('Reasoning effort', select([['', 'Model default'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.reasoning_effort, change(v => { s.reasoning_effort = v; }))),
            field('Seed', numberInput(s.seed, change(v => { s.seed = v; }), { min: -1 }))),
        toggle('Stream responses', s.stream, change(v => { s.stream = v; }))));

    // ----- Prompt manager (with Preset Organizer-style sections, search and bulk toggles) -----
    const ui = (state.settings.ui ??= {});
    const list = el('div', { class: `block-list${ui.promptCheckboxes ? ' checkboxes' : ''}` });
    const tokenNote = el('span', { class: 'hint' });
    const chips = el('div', { class: 'section-chips' });
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search prompts…' });
    const collapsedKey = `rv-collapsed-${p.id}`;
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem(collapsedKey) || '[]')); } catch { /* ignore */ }
    const saveCollapsed = () => { try { localStorage.setItem(collapsedKey, JSON.stringify([...collapsed])); } catch { /* ignore */ } };
    const dividerRx = (() => { try { return new RegExp(ui.dividerPattern || '^\\s*(={2,}|-{3,}|#{1,3}\\s|━|\\[[^\\]]+\\]\\s*$)'); } catch { return /^\s*(={2,}|-{3,}|#{1,3}\s|━)/; } })();
    const isHeader = b => b.marker === 'category' || (!b.marker && dividerRx.test(b.name || '') && !String(b.content || '').trim());
    const sections = () => {
        const out = [];
        let cur = null;
        p.blocks.forEach((b, i) => {
            if (isHeader(b)) { cur = { header: b, index: i, members: [] }; out.push(cur); }
            else if (cur) cur.members.push(b);
        });
        return out;
    };
    const renderBlocks = () => {
        const q = search.value.trim().toLowerCase();
        const secs = sections();
        const bySection = new Map();
        for (const sec of secs) for (const m of sec.members) bySection.set(m, sec);
        let category = null;
        list.replaceChildren(...p.blocks.map((b, i) => {
            if (b.marker === 'category') category = b;
            const row = blockRow(p, b, i, category, renderBlocks);
            const sec = secs.find(x => x.header === b);
            if (sec) {
                row.classList.add('section-header');
                const on = sec.members.filter(m => m.enabled).length;
                const total = sec.members.length;
                const caret = el('button', { class: 'section-caret', title: 'Collapse / expand', onclick: () => {
                    if (collapsed.has(b.id)) collapsed.delete(b.id); else collapsed.add(b.id);
                    saveCollapsed();
                    renderBlocks();
                } }, icon(collapsed.has(b.id) && !q ? 'chevron-right' : 'chevron-down'));
                const badge = el('span', { class: `section-badge${on === total && total ? ' all' : on === 0 ? ' none' : ''}` }, `${on}/${total}`);
                const bulk = el('button', { class: 'mini-btn', title: on === total ? 'Disable section' : 'Enable section', onclick: () => {
                    const target = on !== total;
                    for (const m of sec.members) m.enabled = target;
                    savePresetDebounced();
                    renderBlocks();
                } }, icon(on === total ? 'toggle-on' : 'toggle-off'));
                row.querySelector('.drag-handle').after(caret);
                row.querySelector('.block-badges').prepend(badge);
                row.append(bulk);
            }
            const owner = bySection.get(b);
            if (q) {
                const hit = String(b.name || '').toLowerCase().includes(q) || String(b.content || '').toLowerCase().includes(q);
                const sectionHit = sec && sec.members.some(m => String(m.name || '').toLowerCase().includes(q) || String(m.content || '').toLowerCase().includes(q));
                if (!hit && !sectionHit) row.classList.add('hidden');
                if (hit) {
                    const nameEl = row.querySelector('.block-name');
                    const text = nameEl.textContent;
                    const at = text.toLowerCase().indexOf(q);
                    if (at >= 0) nameEl.replaceChildren(text.slice(0, at), el('mark', {}, text.slice(at, at + q.length)), text.slice(at + q.length));
                }
            } else if (owner && collapsed.has(owner.header.id)) {
                row.classList.add('hidden');
            }
            return row;
        }));
        chips.replaceChildren(...secs.map((sec, n) => el('button', {
            class: 'section-chip', style: { '--chip-hue': String((n * 47) % 360) },
            onclick: () => {
                collapsed.delete(sec.header.id);
                saveCollapsed();
                renderBlocks();
                list.querySelector(`.block-row[data-index="${sec.index}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
        }, (sec.header.name || 'Section').replace(/^[\s=\-#━\[]+|[\s=\-#━\]]+$/g, '') || 'Section', el('span', {}, `${sec.members.filter(m => m.enabled).length}/${sec.members.length}`))));
        chips.classList.toggle('hidden', !secs.length);
        const total = p.blocks.filter(b => b.enabled && !STRUCTURAL_MARKERS.has(b.marker)).reduce((n, b) => n + estimateTokens(b.content), 0);
        tokenNote.textContent = `≈ ${total.toLocaleString()} tokens of preset text enabled`;
    };
    search.addEventListener('input', renderBlocks);
    renderBlocks();
    enableDrag(list, p, renderBlocks);

    body.append(section('Prompt manager',
        el('div', { class: 'row gap wrap' },
            el('button', { class: 'btn small', onclick: async () => {
                const b = makeBlock({ name: 'New prompt', content: '' });
                p.blocks.splice(Math.max(0, p.blocks.findIndex(x => x.marker === 'chat_history')), 0, b);
                renderBlocks();
                savePresetDebounced();
                editBlock(p, b, renderBlocks);
            } }, icon('plus'), 'Add prompt'),
            el('button', { class: 'btn small', onclick: async () => {
                const name = await promptDialog('Section name', '===== New section =====', { title: 'Add section divider' });
                if (!name) return;
                p.blocks.splice(Math.max(0, p.blocks.findIndex(x => x.marker === 'chat_history')), 0, makeBlock({ name, content: '', enabled: true }));
                renderBlocks();
                savePresetDebounced();
            } }, icon('grip-lines'), 'Add section'),
            el('button', { class: 'btn small', onclick: async () => {
                const missing = Object.keys(MARKER_NAMES).filter(m => m !== 'category' && !p.blocks.some(b => b.marker === m));
                if (!missing.length) return toast('All markers are already present', 'info');
                const choice = await new Promise(resolve => popMenu(document.activeElement, missing.map(m => ['location-dot', MARKER_NAMES[m], () => resolve(m)])));
                p.blocks.push(makeBlock({ name: MARKER_NAMES[choice], marker: choice }));
                renderBlocks();
                savePresetDebounced();
            } }, icon('location-dot'), 'Add marker'),
            el('button', { class: 'btn small', onclick: showPromptPreview }, icon('eye'), 'Preview prompt')),
        el('div', { class: 'row gap pm-toolbar' },
            search,
            el('button', { class: 'icon-btn small', title: 'Collapse all sections', onclick: () => { for (const sec of sections()) collapsed.add(sec.header.id); saveCollapsed(); renderBlocks(); } }, icon('compress')),
            el('button', { class: 'icon-btn small', title: 'Expand all sections', onclick: () => { collapsed.clear(); saveCollapsed(); renderBlocks(); } }, icon('expand')),
            el('button', { class: `icon-btn small${ui.promptCheckboxes ? ' active' : ''}`, title: 'Checkbox style', onclick: e => {
                ui.promptCheckboxes = !ui.promptCheckboxes;
                saveSettingsDebounced();
                list.classList.toggle('checkboxes', ui.promptCheckboxes);
                e.currentTarget.classList.toggle('active', ui.promptCheckboxes);
            } }, icon('square-check'))),
        chips,
        tokenNote,
        list,
        el('p', { class: 'hint' }, 'Tip: a prompt with no text whose name looks like a divider (===== Style =====, --- NSFW ---, ## Jailbreaks) becomes a collapsible section.')));

    // ----- Model profiles (Reverie presets) -----
    const profBox = el('div', { class: 'stack' });
    const renderProfiles = () => {
        const active = activeModelProfile(p);
        profBox.replaceChildren(
            ...p.modelProfiles.map((prof, i) => {
                const sw = el('input', { type: 'checkbox', class: 'switch-input' });
                sw.checked = prof.enabled !== false;
                sw.addEventListener('change', () => { prof.enabled = sw.checked; savePresetDebounced(); renderProfiles(); });
                const summary = [...Object.entries(prof.samplers).map(([k, v]) => `${k}=${v}`), prof.assistantPrefill !== undefined ? 'prefill' : ''].filter(Boolean).join(' · ') || 'no overrides';
                return el('div', { class: `list-row${prof === active ? ' active-profile' : ''}` },
                    el('button', { class: 'list-row-main', onclick: () => editProfile(p, i, renderProfiles) },
                        el('span', { class: 'list-row-title' }, prof.name, prof === active ? el('span', { class: 'badge marker' }, 'active now') : null),
                        el('span', { class: 'hint mono ellipsis' }, `model ~ ${prof.match || '?'} — ${summary}`)),
                    el('label', { class: 'switch small' }, sw, el('span', { class: 'switch-track' })));
            }),
            el('button', { class: 'btn small', onclick: () => {
                p.modelProfiles.push(normalizeProfile({ name: 'Claude', match: 'claude', samplers: { temperature: 1 } }));
                savePresetDebounced();
                editProfile(p, p.modelProfiles.length - 1, renderProfiles);
            } }, icon('plus'), 'Add model profile'));
    };
    renderProfiles();
    body.append(section('Model profiles',
        el('p', { class: 'hint' }, 'Overrides that apply automatically when the active model matches — e.g. a different temperature and prefill for Claude than for Gemini. The first matching profile wins.'),
        profBox));

    // ----- About -----
    const meta = p.meta;
    body.append(section('About this preset',
        el('div', { class: 'grid-2' },
            field('Author', textInput(meta.author, change(v => { meta.author = v; }))),
            field('Version', textInput(meta.version, change(v => { meta.version = v; }), { placeholder: '1.0' }))),
        field('Description', textArea(meta.description, change(v => { meta.description = v; }), { rows: 3 })),
        field('Homepage', textInput(meta.homepage, change(v => { meta.homepage = v; }), { placeholder: 'https://…' }))));

    // ----- Behaviour -----
    const b = p.behavior;
    const c = p.completion;
    body.append(section('Behaviour',
        field('Assistant prefill', textArea(c.assistantPrefill, change(v => { c.assistantPrefill = v; }), { rows: 2 }), 'Starts every reply with this text (great for Claude).'),
        field('Impersonation prefill', textArea(c.assistantImpersonation, change(v => { c.assistantImpersonation = v; }), { rows: 2 })),
        field('New chat separator', textArea(b.newChatPrompt, change(v => { b.newChatPrompt = v; }), { rows: 2 })),
        field('Example chat separator', textArea(b.newExampleChatPrompt, change(v => { b.newExampleChatPrompt = v; }), { rows: 2 })),
        field('Continue nudge', textArea(b.continueNudge, change(v => { b.continueNudge = v; }), { rows: 2 })),
        field('Impersonation prompt', textArea(b.impersonationPrompt, change(v => { b.impersonationPrompt = v; }), { rows: 3 })),
        field('Send if empty', textArea(b.sendIfEmpty, change(v => { b.sendIfEmpty = v; }), { rows: 2 }), 'Sent as your message when you press send with an empty box.'),
        field('Character names', select([[0, 'Don\'t add'], [1, 'As message “name” field'], [2, 'Prefix message content']], c.namesBehavior, change(v => { c.namesBehavior = Number(v); }))),
        toggle('Continue using prefill', c.continuePrefill, change(v => { c.continuePrefill = v; }), 'Continues by prefilling the last message instead of a nudge.'),
        toggle('Squash consecutive system messages', c.squashSystemMessages, change(v => { c.squashSystemMessages = v; })),
        field('World Info format', textInput(p.formats.wiFormat, change(v => { p.formats.wiFormat = v; })), '{0} is replaced by the activated lore.'),
        field('Scenario format', textInput(p.formats.scenarioFormat, change(v => { p.formats.scenarioFormat = v; }))),
        field('Personality format', textInput(p.formats.personalityFormat, change(v => { p.formats.personalityFormat = v; }))),
        field('Stop strings (one per line)', textArea((p.stopStrings || []).join('\n'), change(v => { p.stopStrings = v.split('\n').filter(x => x.length); }), { rows: 2 })),
        toggle('Custom request body', p.customBody.enabled, change(v => { p.customBody.enabled = v; })),
        field('Custom body JSON', textArea(p.customBody.rawJson, change(v => { p.customBody.rawJson = v; }), { rows: 3, class: 'input mono' }), 'Merged into the API request, e.g. {"provider": {"sort": "throughput"}}')));
}

function numberInput(value, onChange, attrs = {}) {
    const input = el('input', { class: 'input', type: 'number', ...attrs });
    input.value = value ?? '';
    input.addEventListener('change', () => onChange(input.value === '' ? null : Number(input.value)));
    return input;
}

function variableControl(p, block, def) {
    p.promptVariables[block.id] ??= {};
    const store = p.promptVariables[block.id];
    const value = store[def.name] ?? def.defaultValue;
    const set = v => { store[def.name] = v; savePresetDebounced(); };
    const label = def.label || def.name;
    switch (def.type) {
        case 'switch': return toggle(label, Number(value) === 1, v => set(v ? 1 : 0), def.description);
        case 'slider': return slider(label, Number(value), { min: def.min, max: def.max, step: def.step || 1, onChange: set, hint: def.description });
        case 'number': return field(label, numberInput(value, set, { min: def.min, max: def.max, step: def.step }), def.description);
        case 'select': return field(label, select((def.options || []).map(o => [o.id, o.label]), value, set), def.description);
        case 'multiselect': {
            const chosen = new Set(Array.isArray(value) ? value : []);
            return el('div', { class: 'field' }, el('span', { class: 'field-label' }, label),
                el('div', { class: 'chip-row' }, (def.options || []).map(o => {
                    const chip = el('button', { class: `chip toggle-chip${chosen.has(o.id) ? ' active' : ''}`, onclick: () => {
                        if (chosen.has(o.id)) chosen.delete(o.id); else chosen.add(o.id);
                        chip.classList.toggle('active', chosen.has(o.id));
                        set([...chosen]);
                    } }, o.label);
                    return chip;
                })), def.description ? el('small', { class: 'hint' }, def.description) : null);
        }
        case 'textarea': return field(label, textArea(value, set, { rows: def.rows || 3 }), def.description);
        default: return field(label, textInput(value, set), def.description);
    }
}

function blockRow(p, b, index, category, refresh) {
    const isCategory = b.marker === 'category';
    const structural = STRUCTURAL_MARKERS.has(b.marker);
    const sw = el('input', { type: 'checkbox', class: 'switch-input' });
    sw.checked = !!b.enabled;
    sw.addEventListener('change', () => {
        b.enabled = sw.checked;
        // Lumiverse radio categories: only one block in the category may be on.
        if (b.enabled && category?.categoryMode === 'radio' && !isCategory) {
            const start = p.blocks.indexOf(category);
            for (let i = start + 1; i < p.blocks.length && p.blocks[i].marker !== 'category'; i++) {
                if (p.blocks[i] !== b) p.blocks[i].enabled = false;
            }
            refresh();
        }
        savePresetDebounced();
    });
    const badges = [];
    if (b.marker && !isCategory) badges.push(el('span', { class: `badge marker${structural ? ' structural' : ''}` }, structural ? icon('location-dot') : icon('thumbtack'), structural ? 'marker' : 'pinned'));
    if (b.position === 'in_history') badges.push(el('span', { class: 'badge depth' }, `@${b.depth}`));
    if (b.role && b.role !== 'system' && !isCategory) badges.push(el('span', { class: `badge role-${b.role}` }, b.role.replace('_', ' ')));
    if (b.injectionTrigger?.length) badges.push(el('span', { class: 'badge' }, icon('bolt'), b.injectionTrigger.join(',')));
    if (b.when?.trim()) badges.push(el('span', { class: `badge cond${checkCondition(b.when) ? ' bad' : ''}`, title: b.when }, icon('code-branch'), 'if'));
    const tokens = structural ? '' : `${estimateTokens(b.content)}t`;
    const row = el('div', { class: `block-row${isCategory ? ' category' : ''}${b.enabled ? '' : ' off'}`, 'data-index': index, style: b.color ? { '--block-color': b.color } : null },
        el('span', { class: 'drag-handle', title: 'Drag to reorder' }, icon('grip-vertical')),
        el('button', { class: 'block-main', onclick: () => editBlock(p, b, refresh) },
            el('span', { class: 'block-name' }, b.name || MARKER_NAMES[b.marker] || 'Untitled'),
            el('span', { class: 'block-badges' }, badges, tokens ? el('span', { class: 'dim' }, tokens) : null)),
        isCategory && !b.content ? el('span') : el('span', { class: 'switch small' }, sw, el('span', { class: 'switch-track' })));
    return row;
}

function enableDrag(list, p, refresh) {
    let dragging = null;
    let placeholderIndex = -1;
    list.addEventListener('pointerdown', e => {
        const handle = e.target.closest('.drag-handle');
        if (!handle) return;
        e.preventDefault();
        dragging = handle.closest('.block-row');
        dragging.classList.add('dragging');
        handle.setPointerCapture(e.pointerId);
        placeholderIndex = Number(dragging.dataset.index);
        const move = ev => {
            const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.block-row');
            if (!over || over === dragging || !list.contains(over)) return;
            const rect = over.getBoundingClientRect();
            const after = ev.clientY > rect.top + rect.height / 2;
            over[after ? 'after' : 'before'](dragging);
        };
        const up = () => {
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', up);
            handle.removeEventListener('pointercancel', up);
            dragging.classList.remove('dragging');
            const order = [...list.querySelectorAll('.block-row')].map(r => p.blocks[Number(r.dataset.index)]);
            p.blocks.splice(0, p.blocks.length, ...order);
            dragging = null;
            refresh();
            savePresetDebounced();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
    });
}

async function editBlock(p, block, refresh) {
    const draft = structuredClone(block);
    const structural = STRUCTURAL_MARKERS.has(draft.marker);
    const triggers = ['normal', 'continue', 'impersonate', 'swipe', 'regenerate', 'quiet'];
    const content = el('div', { class: 'stack' },
        field('Name', textInput(draft.name, v => { draft.name = v; })),
        el('div', { class: 'grid-2' },
            field('Role', select([['system', 'System'], ['user', 'User'], ['assistant', 'Assistant'], ['user_append', 'Append to last user msg'], ['assistant_append', 'Append to last AI msg']], draft.role, v => { draft.role = v; })),
            field('Position', select([['pre_history', 'Relative (by order)'], ['in_history', 'In chat @ depth']], draft.position === 'post_history' ? 'pre_history' : draft.position, v => { draft.position = v; }))),
        field('Depth', (() => { const i = el('input', { class: 'input', type: 'number', min: 0 }); i.value = draft.depth; i.addEventListener('input', () => { draft.depth = Number(i.value) || 0; }); return i; })(), 'Only for “In chat @ depth”. 0 = after the last message.'),
        structural
            ? el('p', { class: 'hint' }, icon('circle-info'), ` This is the “${MARKER_NAMES[draft.marker]}” marker — its text comes from the character / persona / lorebook. You can still move it, toggle it, or change its role.`)
            : field('Content', textArea(draft.content, v => { draft.content = v; }, { rows: 14, class: 'input mono' }), 'Supports {{char}}, {{user}}, {{random::a::b}}, {{getvar::x}}, {{var::name}} and other SillyTavern / Lumiverse macros.'),
        (() => {
            const status = el('small', { class: 'hint' });
            const input = textInput(draft.when || '', v => {
                draft.when = v;
                const err = v.trim() ? checkCondition(v) : '';
                status.textContent = err ? `⚠ ${err}` : v.trim() ? '✓ Valid condition' : 'Leave empty to always include.';
                status.classList.toggle('warn', !!err);
            }, { class: 'input mono', placeholder: "chat.length > 20 and char.tags has 'fantasy'" });
            status.textContent = draft.when ? (checkCondition(draft.when) ? `⚠ ${checkCondition(draft.when)}` : '✓ Valid condition') : 'Leave empty to always include.';
            return el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Only include when (Reverie condition)'), input, status,
                el('details', { class: 'cond-help' }, el('summary', {}, 'What can I test?'),
                    el('div', { class: 'hint' }, 'type (normal, continue, impersonate, swipe, quiet) · chat.length · chat.last · char.name · char.tags · user.name · model · provider · profile · var.NAME (chat or preset variable) · global.NAME',
                        el('br'), "Operators: == != > < >= <= · ~ (contains, or /regex/) · has · and / or / not · ( )",
                        el('br'), "Examples: model ~ 'claude' · type != 'impersonate' · var.tone == 'dark' · not var.nsfw")));
        })(),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Only for generation types (none = all)'),
            el('div', { class: 'chip-row' }, triggers.map(t => {
                const chip = el('button', { class: `chip toggle-chip${draft.injectionTrigger.includes(t) ? ' active' : ''}`, onclick: () => {
                    draft.injectionTrigger = draft.injectionTrigger.includes(t) ? draft.injectionTrigger.filter(x => x !== t) : [...draft.injectionTrigger, t];
                    chip.classList.toggle('active');
                } }, t);
                return chip;
            }))));
    const result = await modal({
        title: draft.name || 'Prompt',
        content,
        wide: true,
        buttons: [
            { label: 'Delete', value: 'delete', danger: true, icon: 'trash-can' },
            { label: 'Cancel', value: null },
            { label: 'Save', value: 'save', primary: true, icon: 'check' },
        ],
    });
    if (result === 'delete') {
        if (draft.marker === 'chat_history' && !await confirmDialog('Removing Chat History means your conversation is placed at the end of the prompt. Continue?')) return;
        p.blocks.splice(p.blocks.indexOf(block), 1);
    } else if (result === 'save') {
        Object.assign(block, draft);
    } else return;
    refresh();
    savePresetDebounced();
}

async function editProfile(p, index, refresh) {
    const prof = structuredClone(p.modelProfiles[index]);
    const keys = [['temperature', 'Temperature'], ['top_p', 'Top P'], ['top_k', 'Top K'], ['min_p', 'Min P'], ['frequency_penalty', 'Frequency penalty'], ['presence_penalty', 'Presence penalty'], ['max_tokens', 'Max response'], ['context_size', 'Context size']];
    const numberField = (key, label) => {
        const input = el('input', { class: 'input', type: 'number', step: 'any', placeholder: 'preset value' });
        input.value = prof.samplers[key] ?? '';
        input.addEventListener('input', () => {
            if (input.value === '') delete prof.samplers[key];
            else prof.samplers[key] = Number(input.value);
        });
        return field(label, input);
    };
    let usePrefill = prof.assistantPrefill !== undefined;
    const prefill = textArea(prof.assistantPrefill ?? '', v => { prof.assistantPrefill = v; }, { rows: 2 });
    const result = await modal({
        title: 'Model profile',
        content: el('div', { class: 'stack' },
            el('div', { class: 'grid-2' },
                field('Name', textInput(prof.name, v => { prof.name = v; })),
                field('Model matches', textInput(prof.match, v => { prof.match = v; }, { class: 'input mono', placeholder: 'claude  or  /gemini-2\\.5/' }))),
            el('p', { class: 'hint' }, 'Leave a value empty to keep the preset\'s.'),
            el('div', { class: 'grid-2' }, keys.map(([k, l]) => numberField(k, l))),
            field('Reasoning effort', select([['', 'Preset value'], ['minimal', 'Minimal'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], prof.samplers.reasoning_effort || '', v => {
                if (v) prof.samplers.reasoning_effort = v; else delete prof.samplers.reasoning_effort;
            })),
            toggle('Override assistant prefill', usePrefill, v => { usePrefill = v; prefill.disabled = !v; }),
            prefill),
        buttons: [{ label: 'Delete', value: 'delete', danger: true }, { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }],
    });
    if (result === 'delete') p.modelProfiles.splice(index, 1);
    else if (result === 'save') {
        if (!usePrefill) delete prof.assistantPrefill;
        else prof.assistantPrefill ??= '';
        p.modelProfiles[index] = prof;
    } else return;
    savePresetDebounced();
    refresh();
}

async function presetNavigator(presets, refresh) {
    const ui = (state.settings.ui ??= {});
    const favs = new Set(ui.favPresets || []);
    const grid = el('div', { class: 'preset-grid' });
    const q = el('input', { class: 'input', type: 'search', placeholder: 'Search presets…' });
    let close = () => {};
    const render = () => {
        const term = q.value.trim().toLowerCase();
        const items = presets.filter(x => !term || x.name.toLowerCase().includes(term))
            .sort((a, b) => (favs.has(b.id) - favs.has(a.id)) || a.name.localeCompare(b.name));
        grid.replaceChildren(...items.map(x => el('div', { class: `preset-tile${x.id === state.preset.id ? ' current' : ''}` },
            el('button', { class: 'preset-tile-main', onclick: async () => {
                await savePreset();
                await selectPreset(x.id);
                close();
                refresh();
            } }, el('span', { class: 'preset-mono' }, x.name.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase() || '✦'),
                el('span', { class: 'preset-tile-name' }, x.name),
                el('span', { class: 'hint' }, x.source === 'sillytavern' ? 'SillyTavern' : x.source === 'lumiverse' ? 'Lumiverse' : 'Reverie')),
            el('button', { class: `preset-fav${favs.has(x.id) ? ' on' : ''}`, title: 'Favourite', onclick: () => {
                if (favs.has(x.id)) favs.delete(x.id); else favs.add(x.id);
                ui.favPresets = [...favs];
                saveSettingsDebounced();
                render();
            } }, icon('star')))));
    };
    q.addEventListener('input', render);
    render();
    modal({ title: 'Presets', content: el('div', { class: 'stack' }, q, grid), wide: true, buttons: [], onOpen: (_b, c) => { close = c; setTimeout(() => q.focus(), 60); } });
}

async function importFlow() {
    const files = await pickFile('.json,application/json', { multiple: true });
    if (!files?.length) return;
    for (const file of files) {
        try {
            const json = JSON.parse(await file.text());
            const preset = importPreset(json, file.name.replace(/\.(loom\.)?json$/i, ''));
            if (!json.name) preset.name = file.name.replace(/\.(loom\.)?json$/i, '');
            await createPreset(preset);
            toast(`Imported “${preset.name}” (${preset.blocks.length} prompts${preset.regex.length ? `, ${preset.regex.length} regex` : ''})`, 'success');
        } catch (err) {
            toast(`${file.name}: ${err.message}`, 'error');
        }
    }
    rerender();
}
