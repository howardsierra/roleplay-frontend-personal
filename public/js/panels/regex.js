import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { newScript, parseRegex, runScript, REGEX_PLACEMENT } from '../regex.js';
import { savePresetDebounced } from '../preset-store.js';
import { printMessages } from '../chat.js';
import { el, icon, field, select, textInput, textArea, toggle, section, toast, modal, pickFile, download, confirmDialog } from '../ui.js';

let rootBody;
const rerender = () => { rootBody.replaceChildren(); render(rootBody); };

export async function render(body) {
    rootBody = body;
    const scopes = [
        { key: 'global', label: 'Global scripts', list: state.settings.regex, save: () => saveSettingsDebounced() },
        { key: 'preset', label: `Preset scripts · ${state.preset?.name || ''}`, list: state.preset.regex, save: () => savePresetDebounced() },
    ];
    if (state.character) {
        const ext = state.character.card.data.extensions ??= {};
        ext.regex_scripts ??= [];
        scopes.push({
            key: 'character', label: `Character scripts · ${state.character.card.data.name}`, list: ext.regex_scripts,
            save: () => api.put(`characters/${encodeURIComponent(state.character.id)}`, { card: state.character.card }),
        });
    }
    body.append(section('', toggle('Allow character-scoped scripts', state.settings.allowCharacterRegex, v => { state.settings.allowCharacterRegex = v; saveSettingsDebounced(); printMessages(); }, 'Cards often ship regex that turns tags into styled HTML panels.')));
    for (const scope of scopes) {
        const rows = scope.list.map((s, i) => {
            const sw = el('input', { type: 'checkbox', class: 'switch-input' });
            sw.checked = !s.disabled;
            sw.addEventListener('change', async () => { s.disabled = !sw.checked; await scope.save(); printMessages(); });
            return el('div', { class: `list-row${s.disabled ? ' off' : ''}` },
                el('button', { class: 'list-row-main', onclick: () => editScript(scope, i) },
                    el('span', { class: 'list-row-title' }, s.scriptName || 'Untitled'),
                    el('span', { class: 'hint mono ellipsis' }, s.findRegex)),
                el('label', { class: 'switch small' }, sw, el('span', { class: 'switch-track' })));
        });
        body.append(section(scope.label,
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', onclick: async () => { scope.list.push(newScript()); await scope.save(); editScript(scope, scope.list.length - 1); } }, icon('plus'), 'New'),
                el('button', { class: 'btn small', onclick: async () => {
                    const files = await pickFile('.json,application/json', { multiple: true });
                    for (const file of files || []) {
                        try {
                            const json = JSON.parse(await file.text());
                            const arr = Array.isArray(json) ? json : (Array.isArray(json.regex_scripts) ? json.regex_scripts : [json]);
                            for (const s of arr) scope.list.push(newScript({ ...s, id: s.id || crypto.randomUUID() }));
                            toast(`Imported ${arr.length} script(s)`, 'success');
                        } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
                    }
                    await scope.save();
                    rerender();
                } }, icon('file-import'), 'Import'),
                scope.list.length ? el('button', { class: 'btn small', onclick: () => download(`regex-${scope.key}.json`, scope.list) }, icon('download'), 'Export') : null),
            rows.length ? el('div', { class: 'stack' }, rows) : el('div', { class: 'empty' }, 'No scripts.')));
    }
}

async function editScript(scope, index) {
    const s = structuredClone(scope.list[index]);
    const places = [[REGEX_PLACEMENT.USER_INPUT, 'User input'], [REGEX_PLACEMENT.AI_OUTPUT, 'AI output'], [REGEX_PLACEMENT.SLASH_COMMAND, 'Slash commands'], [REGEX_PLACEMENT.WORLD_INFO, 'World Info'], [REGEX_PLACEMENT.REASONING, 'Reasoning']];
    const testIn = el('textarea', { class: 'input mono', rows: 3, placeholder: 'Test input…' });
    const testOut = el('pre', { class: 'regex-test-out' });
    const runTest = () => {
        const rx = parseRegex(s.findRegex);
        testOut.textContent = rx ? runScript(s, testIn.value) : '⚠ Invalid regular expression';
    };
    testIn.addEventListener('input', runTest);
    const content = el('div', { class: 'stack' },
        field('Name', textInput(s.scriptName, v => { s.scriptName = v; })),
        field('Find regex', textInput(s.findRegex, v => { s.findRegex = v; runTest(); }, { class: 'input mono', placeholder: '/<status>([\\s\\S]*?)<\\/status>/gi' })),
        field('Replace with', textArea(s.replaceString, v => { s.replaceString = v; runTest(); }, { rows: 6, class: 'input mono' }), 'Use $1, $2… or {{match}}. HTML, CSS and <script> are rendered live.'),
        field('Trim out (one per line)', textArea((s.trimStrings || []).join('\n'), v => { s.trimStrings = v.split('\n').filter(Boolean); }, { rows: 2 })),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Affects'),
            el('div', { class: 'chip-row' }, places.map(([v, label]) => {
                const chip = el('button', { class: `chip toggle-chip${(s.placement || []).map(Number).includes(v) ? ' active' : ''}`, onclick: () => {
                    const set = new Set((s.placement || []).map(Number));
                    if (set.has(v)) set.delete(v); else set.add(v);
                    s.placement = [...set];
                    chip.classList.toggle('active');
                } }, label);
                return chip;
            }))),
        field('Apply to', select([['both', 'Saved message text'], ['display', 'Display only (markdown)'], ['prompt', 'Outgoing prompt only']], s.markdownOnly ? 'display' : s.promptOnly ? 'prompt' : 'both', v => {
            s.markdownOnly = v === 'display';
            s.promptOnly = v === 'prompt';
        })),
        el('div', { class: 'grid-3' },
            field('Min depth', (() => { const i = el('input', { class: 'input', type: 'number', min: -1 }); i.value = s.minDepth ?? ''; i.addEventListener('input', () => { s.minDepth = i.value === '' ? null : Number(i.value); }); return i; })()),
            field('Max depth', (() => { const i = el('input', { class: 'input', type: 'number', min: -1 }); i.value = s.maxDepth ?? ''; i.addEventListener('input', () => { s.maxDepth = i.value === '' ? null : Number(i.value); }); return i; })()),
            field('Macros in regex', select([[0, "Don't substitute"], [1, 'Raw'], [2, 'Escaped']], s.substituteRegex ?? 0, v => { s.substituteRegex = Number(v); }))),
        toggle('Run on edit', s.runOnEdit !== false, v => { s.runOnEdit = v; }),
        field('Test', testIn), testOut);
    const result = await modal({ title: 'Regex script', content, wide: true, buttons: [{ label: 'Delete', value: 'delete', danger: true }, { label: 'Cancel', value: null }, { label: 'Save', value: 'save', primary: true }] });
    if (result === 'delete') {
        if (!await confirmDialog('Delete this script?', { danger: true, okLabel: 'Delete' })) return;
        scope.list.splice(index, 1);
    } else if (result === 'save') {
        scope.list[index] = s;
    } else return;
    await scope.save();
    printMessages();
    rerender();
}
