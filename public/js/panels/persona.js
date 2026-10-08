import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { printMessages } from '../chat.js';
import { el, icon, field, textInput, textArea, section, confirmDialog, pickFile, toPngBlob, toast } from '../ui.js';

export async function render(body) {
    const s = state.settings;
    if (!s.personas.length) {
        s.personas.push({ id: crypto.randomUUID(), name: 'You', description: '', avatar: '' });
        s.personaId = s.personas[0].id;
        saveSettingsDebounced();
    }
    const list = el('div', { class: 'persona-list' });
    const editor = el('div', { class: 'stack' });

    const renderList = () => {
        list.replaceChildren(...s.personas.map(p => el('button', {
            class: `persona-chip${p.id === s.personaId ? ' active' : ''}`,
            onclick: () => {
                s.personaId = p.id;
                saveSettingsDebounced();
                eventSource.emit(event_types.PERSONA_CHANGED, p.id);
                renderList();
                renderEditor();
                printMessages();
            },
        }, el('img', { src: p.avatar || 'icons/user.svg', alt: '' }), el('span', {}, p.name || 'Unnamed'))),
        el('button', { class: 'persona-chip add', onclick: () => {
            const p = { id: crypto.randomUUID(), name: 'New persona', description: '', avatar: '' };
            s.personas.push(p);
            s.personaId = p.id;
            saveSettingsDebounced();
            renderList();
            renderEditor();
        } }, icon('plus'), el('span', {}, 'New')));
    };

    const renderEditor = () => {
        const p = s.personas.find(x => x.id === s.personaId) || s.personas[0];
        const img = el('img', { class: 'editor-avatar', src: p.avatar || 'icons/user.svg' });
        editor.replaceChildren(
            el('div', { class: 'editor-top' },
                el('button', { class: 'editor-avatar-btn', title: 'Change avatar', onclick: async () => {
                    const file = await pickFile('image/*');
                    if (!file) return;
                    const res = await api.upload('images?name=persona.png', await toPngBlob(file, 512));
                    p.avatar = res.url;
                    img.src = res.url;
                    saveSettingsDebounced();
                    renderList();
                } }, img, el('span', { class: 'editor-avatar-hint' }, icon('camera'))),
                el('div', { class: 'stack grow' }, field('Name', textInput(p.name, v => { p.name = v; saveSettingsDebounced(); renderListDebounced(); })))),
            field('Description', textArea(p.description, v => { p.description = v; saveSettingsDebounced(); }, { rows: 8, placeholder: 'Who are you in this story? Appearance, personality, background…' }), 'Inserted where the preset has the “Persona Description” marker ({{persona}}).'),
            s.personas.length > 1 ? el('button', { class: 'btn small danger', onclick: async () => {
                if (!await confirmDialog(`Delete persona “${p.name}”?`, { okLabel: 'Delete', danger: true })) return;
                s.personas = s.personas.filter(x => x.id !== p.id);
                s.personaId = s.personas[0].id;
                saveSettingsDebounced();
                renderList();
                renderEditor();
            } }, icon('trash-can'), 'Delete persona') : null);
    };
    let t;
    const renderListDebounced = () => { clearTimeout(t); t = setTimeout(renderList, 400); };

    renderList();
    renderEditor();
    const importBtn = el('button', { class: 'btn small', onclick: async () => {
        const files = await pickFile('.json,application/json,image/*', { multiple: true });
        if (!files?.length) return;
        try {
            const res = await importSillyTavernPersonas([...files]);
            toast(`Imported ${res.added} persona${res.added === 1 ? '' : 's'}${res.avatars ? ` with ${res.avatars} avatar${res.avatars === 1 ? '' : 's'}` : ''}${res.skipped ? ` · ${res.skipped} already here` : ''}`, 'success', { timeout: 5000 });
            renderList();
            renderEditor();
        } catch (err) {
            toast(err.message, 'error', { title: 'Persona import failed' });
        }
    } }, icon('file-import'), 'Import from SillyTavern');
    const pmBox = el('div', { class: 'persona-manager-settings' });
    import('../persona-manager/index.js').then(m => m.mountSettings(pmBox));
    body.append(section('Persona Manager', pmBox), section('Who you are', list), section('', editor),
        section('Import', el('div', { class: 'row gap wrap' }, importBtn),
            el('p', { class: 'hint' }, 'Pick your SillyTavern persona backup (Persona Management → Backup, a personas_….json) or its settings.json. Select your avatar images from SillyTavern\'s “User Avatars” folder at the same time and they\'re matched by file name.')));
}

/**
 * Import personas from a SillyTavern backup ({ personas, persona_descriptions, default_persona })
 * or a settings.json (the same fields under power_user). Images picked alongside are matched to
 * personas by file name (SillyTavern keys personas by their avatar file).
 */
export async function importSillyTavernPersonas(files) {
    const s = state.settings;
    const jsonFile = files.find(f => /\.json$/i.test(f.name) || f.type === 'application/json');
    if (!jsonFile) throw new Error('Pick the persona backup .json file (you can select avatar images with it).');
    let data;
    try { data = JSON.parse(await jsonFile.text()); } catch { throw new Error('That file isn\'t valid JSON.'); }
    const src = data.personas && typeof data.personas === 'object' ? data : data.power_user;
    if (!src?.personas || typeof src.personas !== 'object') throw new Error('No personas found. Use SillyTavern\'s persona Backup file or its settings.json.');
    const descriptions = src.persona_descriptions || {};
    const images = new Map(files.filter(f => f.type.startsWith('image/')).map(f => [f.name.toLowerCase(), f]));

    let added = 0;
    let skipped = 0;
    let avatars = 0;
    let defaultId = null;
    for (const [avatarKey, name] of Object.entries(src.personas)) {
        const d = descriptions[avatarKey] || {};
        const description = String(d.description ?? '');
        const existing = s.personas.find(p => p.stAvatar === avatarKey || (p.name === name && (p.description || '') === description));
        if (existing) {
            skipped++;
            if (avatarKey === src.default_persona) defaultId = existing.id;
            continue;
        }
        const persona = {
            id: crypto.randomUUID(),
            name: String(name || 'Unnamed'),
            title: String(d.title || ''),
            description,
            avatar: '',
            stAvatar: avatarKey,
            // SillyTavern's description placement, kept for reference: position 0 = in prompt, 2 = top of AN, 3 = bottom of AN, 4 = at depth.
            st: { position: d.position ?? 0, depth: d.depth ?? 2, role: d.role ?? 0, lorebook: d.lorebook || '' },
        };
        const img = images.get(String(avatarKey).toLowerCase());
        if (img) {
            try {
                const res = await api.upload('images?name=persona.png', await toPngBlob(img, 512));
                persona.avatar = res.url;
                avatars++;
            } catch { /* keep the default avatar */ }
        }
        s.personas.push(persona);
        added++;
        if (avatarKey === src.default_persona) defaultId = persona.id;
    }
    // Remove the empty placeholder persona Reverie creates on first run.
    if (added) s.personas = s.personas.filter(p => !(p.name === 'You' && !p.description && !p.avatar && !p.stAvatar));
    if (defaultId) s.personaId = defaultId;
    if (!s.personas.some(p => p.id === s.personaId)) s.personaId = s.personas[0]?.id ?? null;
    saveSettingsDebounced();
    eventSource.emit(event_types.PERSONA_CHANGED, s.personaId);
    printMessages();
    return { added, skipped, avatars };
}
