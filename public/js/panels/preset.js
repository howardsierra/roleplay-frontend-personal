import { state } from '../state.js';
import { listPresets, selectPreset, savePresetDebounced, savePreset, createPreset, deletePreset } from '../preset-store.js';
import { importPreset, toSillyTavern, toLumiverse, defaultPreset, makeBlock, MARKER_NAMES, STRUCTURAL_MARKERS } from '../presets.js';
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
        ['file-import', 'Import (SillyTavern / Lumiverse)', importFlow],
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

    body.append(el('div', { class: 'row gap sticky-bar' }, picker, moreBtn));

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

    // ----- Prompt manager -----
    const list = el('div', { class: 'block-list' });
    const tokenNote = el('span', { class: 'hint' });
    const renderBlocks = () => {
        let category = null;
        list.replaceChildren(...p.blocks.map((b, i) => {
            if (b.marker === 'category') category = b;
            const row = blockRow(p, b, i, category, renderBlocks);
            return row;
        }));
        const total = p.blocks.filter(b => b.enabled && !STRUCTURAL_MARKERS.has(b.marker)).reduce((n, b) => n + estimateTokens(b.content), 0);
        tokenNote.textContent = `≈ ${total.toLocaleString()} tokens of preset text enabled`;
    };
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
                const missing = Object.keys(MARKER_NAMES).filter(m => m !== 'category' && !p.blocks.some(b => b.marker === m));
                if (!missing.length) return toast('All markers are already present', 'info');
                const choice = await new Promise(resolve => popMenu(document.activeElement, missing.map(m => ['location-dot', MARKER_NAMES[m], () => resolve(m)])));
                p.blocks.push(makeBlock({ name: MARKER_NAMES[choice], marker: choice }));
                renderBlocks();
                savePresetDebounced();
            } }, icon('location-dot'), 'Add marker'),
            el('button', { class: 'btn small', onclick: showPromptPreview }, icon('eye'), 'Preview prompt')),
        tokenNote,
        list));

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
