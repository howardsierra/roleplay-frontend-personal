import { backupSection } from '../backup.js';
import { api } from '../api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChat } from '../state.js';
import { printMessages } from '../chat.js';
import { el, icon, field, select, textArea, textInput, toggle, section, slider, toast, pickFile, confirmDialog } from '../ui.js';

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
            toggle('Trim incomplete sentences', g.trimIncomplete, v => { g.trimIncomplete = v; save(); }),
            toggle('Ask what to change when regenerating', g.askOnRegenerate, v => { g.askOnRegenerate = v; save(); }, 'Otherwise, long-press (or right-click) the → arrow, or use “Regenerate with a note…” in the ⋯ and ✨ menus.')),
        thinkingSection(),
        await voiceSection(),
        alertsSection(),
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

async function voiceSection() {
    const tts = await import('../tts.js');
    if (!tts.ttsSupported()) return section('Read aloud', el('p', { class: 'hint' }, 'This browser has no built-in voices.'));
    const s = tts.ttsSettings();
    const save = () => saveSettingsDebounced();
    const list = await tts.voicesReady();
    const options = [['', 'Device default'], ...list.map(v => [v.voiceURI, `${v.name} (${v.lang})${v.localService ? '' : ' · online'}`])];
    const name = state.character?.card?.data?.name;
    const test = () => {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(name ? `"Hello," said ${name}. "Shall we begin?"` : 'Once upon a time, the story began.');
        const v = list.find(x => x.voiceURI === ((name && s.voices[name]) || s.voice));
        if (v) { u.voice = v; u.lang = v.lang; }
        u.rate = Number(s.rate) || 1;
        u.pitch = Number(s.pitch) || 1;
        speechSynthesis.speak(u);
    };
    return section('Read aloud',
        el('p', { class: 'hint' }, 'Tap the 🔊 button in a message’s actions to hear it. Uses your device’s own voices, so it’s free and private.'),
        toggle('Read new replies aloud', s.auto, v => { s.auto = v; save(); }),
        field('What to read', select([['all', 'Everything'], ['dialogue', 'Only “spoken” dialogue']], s.mode, v => { s.mode = v; save(); })),
        field('Voice', select(options, s.voice, v => { s.voice = v; save(); })),
        name ? field(`Voice for ${name}`, select([['', 'Same as above'], ...options.slice(1)], s.voices[name] || '', v => tts.setCharacterVoice(name, v))) : null,
        slider('Speed', Number(s.rate) || 1, { min: 0.5, max: 2, step: 0.05, onChange: v => { s.rate = v; save(); } }),
        slider('Pitch', Number(s.pitch) || 1, { min: 0.5, max: 2, step: 0.05, onChange: v => { s.pitch = v; save(); } }),
        el('button', { class: 'btn small', onclick: test }, icon('volume-high'), 'Test voice'));
}

function alertsSection() {
    const n = state.settings.notify || (state.settings.notify = { wakeLock: true, title: true, vibrate: true, system: false });
    const save = () => saveSettingsDebounced();
    const canNotify = 'Notification' in window;
    const denied = canNotify && Notification.permission === 'denied';
    let notifyRow = null;
    const out = section('While a reply is written',
        'wakeLock' in navigator ? toggle('Keep the screen on', n.wakeLock !== false, v => { n.wakeLock = v; save(); }, 'Your phone won’t dim or lock in the middle of a reply.') : null,
        toggle('Show “replied” in the tab title', n.title !== false, v => { n.title = v; save(); }, 'When you’ve switched to another tab or app.'),
        'vibrate' in navigator ? toggle('Buzz when a reply arrives', n.vibrate !== false, v => { n.vibrate = v; save(); }, 'When Reverie is in the background (Android).') : null,
        canNotify ? (notifyRow = toggle('Send a notification', !!n.system && !denied, async v => {
            if (v && !await import('../notify.js').then(m => m.enableSystemNotifications())) {
                toast('Notifications are blocked for this site in your browser settings', 'warning');
                notifyRow.querySelector('input').checked = false;
                n.system = false;
                save();
                return;
            }
            n.system = v;
            save();
        }, denied ? 'Blocked in your browser’s site settings.' : 'Only when Reverie isn’t on screen. On iPhone and iPad, add Reverie to your Home Screen first.')) : null);
    return out;
}

function thinkingSection() {
    const r = state.settings.reasoning = { autoParse: true, tags: '', prefix: '', suffix: '', addToPrompts: false, maxAdditions: 1, separator: '\n\n', ...(state.settings.reasoning || {}) };
    const save = () => { saveSettingsDebounced(); printMessages(); };
    return section('Thinking (reasoning models)',
        toggle('Move inline thinking into “Thoughts”', r.autoParse !== false, v => { r.autoParse = v; save(); },
            'Models like DeepSeek R1, QwQ and GLM write <think>…</think> inside the reply. Reverie folds it into the collapsible Thoughts box and never sends it back to the model. Also works when your preset’s prefill opens the tag.'),
        field('Other tag names', textInput(r.tags || '', v => { r.tags = v; save(); }, { placeholder: 'e.g. scratchpad, plan' }), 'Comma-separated. Already recognised: think, thinking, reasoning anywhere; thought, thoughts, reflection only when they open the reply.'),
        el('div', { class: 'grid-2' },
            field('Custom start', textInput(r.prefix || '', v => { r.prefix = v; save(); }, { placeholder: 'e.g. [THINK]' })),
            field('Custom end', textInput(r.suffix || '', v => { r.suffix = v; save(); }, { placeholder: 'e.g. [/THINK]' }))),
        toggle('Thoughts start collapsed', state.settings.render.reasoningCollapsed !== false, v => { state.settings.render.reasoningCollapsed = v; save(); }),
        toggle('Add thinking to prompts', !!r.addToPrompts, v => { r.addToPrompts = v; saveSettingsDebounced(); },
            'Resend the newest replies’ thinking to the model, wrapped in the custom start/end (or <think>…</think>).'),
        el('div', { class: 'grid-2' },
            field('Max additions', (() => { const i = el('input', { class: 'input', type: 'number', min: 0 }); i.value = r.maxAdditions ?? 1; i.addEventListener('input', () => { r.maxAdditions = Math.max(0, Number(i.value) || 0); saveSettingsDebounced(); }); return i; })()),
            field('Separator', textInput(JSON.stringify(r.separator ?? '\n\n').slice(1, -1), v => { try { r.separator = JSON.parse(`"${v.replace(/"/g, '\\"')}"`); } catch { r.separator = v; } saveSettingsDebounced(); }, { placeholder: '\\n\\n' }), 'Between the thinking and the reply. \\n for a newline.')));
}
