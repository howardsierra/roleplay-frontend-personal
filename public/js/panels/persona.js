import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { printMessages } from '../chat.js';
import { el, icon, field, textInput, textArea, section, confirmDialog, pickFile, toPngBlob } from '../ui.js';

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
    body.append(section('Who you are', list), section('', editor));
}
