import { backupSection } from '../backup.js';
import { api } from '../api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChat } from '../state.js';
import { printMessages } from '../chat.js';
import { el, icon, field, select, textArea, textInput, toggle, section, toast, pickFile, confirmDialog } from '../ui.js';

export async function render(body) {
    const g = state.settings.generation;
    const r = state.settings.render;
    const save = () => saveSettingsDebounced();
    const info = await api.get('info').catch(() => ({}));

    if (state.chatId) {
        const meta = chatMetadata();
        body.append(section("Author's note (this chat)",
            textArea(meta.note_prompt || '', v => { meta.note_prompt = v; saveChat(); }, { rows: 3, placeholder: 'e.g. [Style: slow-burn, keep descriptions vivid. It is raining.]' }),
            el('div', { class: 'grid-2' },
                field('Depth', (() => { const i = el('input', { class: 'input', type: 'number', min: 0 }); i.value = meta.note_depth ?? 4; i.addEventListener('input', () => { meta.note_depth = Number(i.value); saveChat(); }); return i; })()),
                field('Role', select([[0, 'System'], [1, 'User'], [2, 'Assistant']], meta.note_role ?? 0, v => { meta.note_role = Number(v); saveChat(); }))),
            field('Scenario override (this chat)', textArea(meta.scenario || '', v => { meta.scenario = v; saveChat(); }, { rows: 2 }))));
    }

    body.append(
        section('Generation',
            toggle('Prefer character main prompt', g.preferCharPrompt, v => { g.preferCharPrompt = v; save(); }, 'Use the card\'s system prompt instead of the preset\'s Main Prompt when it has one.'),
            toggle('Prefer character post-history instructions', g.preferCharInstructions, v => { g.preferCharInstructions = v; save(); }),
            toggle('Trim incomplete sentences', g.trimIncomplete, v => { g.trimIncomplete = v; save(); })),
        section('Rich content',
            toggle('Render HTML / CSS / JS from replies', r.html, v => { r.html = v; save(); printMessages(); }, '```html blocks and full HTML documents become live, sandboxed mini-apps.'),
            toggle('Run loose <script> tags', r.iframeScripts, v => { r.iframeScripts = v; save(); printMessages(); }, 'Messages with <script> (e.g. from regex status panels) render inside a sandbox.'),
            toggle('Colour "quoted" dialogue', r.quotes, v => { r.quotes = v; save(); printMessages(); }),
            field('Python code blocks', select([['button', 'Show a Run button'], ['auto', 'Run automatically'], ['off', 'Just show code']], r.python, v => { r.python = v; save(); printMessages(); }), 'Runs in your browser with Pyodide (≈10 MB download the first time).'),
            field('Pyodide URL', textInput(r.pyodideUrl, v => { r.pyodideUrl = v; save(); }))),
        await backupSection(section),
        section('Account',
            el('p', { class: 'hint' }, `Reverie ${info.version || ''} · ${info.auth ? 'password protected' : 'no password set (APP_PASSWORD)'}`),
            info.auth ? el('button', { class: 'btn small', onclick: async () => { await api.post('logout'); location.href = 'login.html'; } }, icon('right-from-bracket'), 'Log out') : null,
            el('button', { class: 'btn small', onclick: () => { localStorage.clear(); toast('Local UI cache cleared', 'success'); } }, icon('broom'), 'Clear local UI cache')));

}
