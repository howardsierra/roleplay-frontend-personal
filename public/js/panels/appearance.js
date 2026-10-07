import { api } from '../api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChat } from '../state.js';
import { BUILTIN_THEMES, applyTheme, importTheme, exportTheme, currentTheme } from '../themes.js';
import { printMessages } from '../chat.js';
import { applyBranding } from '../layout.js';
import { el, icon, field, select, textArea, textInput, toggle, slider, section, toast, pickFile, download, confirmDialog, promptDialog, debounce } from '../ui.js';

let rootBody;
const rerender = () => { rootBody.replaceChildren(); render(rootBody); };

const COLOR_KEYS = [
    ['main_text_color', 'Main text'],
    ['italics_text_color', 'Italics / actions'],
    ['quote_text_color', 'Quotes / dialogue'],
    ['underline_text_color', 'Underline'],
    ['blur_tint_color', 'Panels'],
    ['chat_tint_color', 'Chat backdrop'],
    ['bot_mes_blur_tint_color', 'Character messages'],
    ['user_mes_blur_tint_color', 'Your messages'],
    ['border_color', 'Borders'],
    ['shadow_color', 'Text shadow'],
];

function toHexAlpha(rgba) {
    const m = String(rgba).match(/rgba?\(([^)]+)\)/);
    if (!m) return { hex: String(rgba).startsWith('#') ? String(rgba).slice(0, 7) : '#ffffff', a: 1 };
    const [r, g, b, a = 1] = m[1].split(',').map(s => parseFloat(s));
    return { hex: `#${[r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('')}`, a };
}

function colorControl(theme, key, label, onChange) {
    const { hex, a } = toHexAlpha(theme[key]);
    const color = el('input', { type: 'color', value: hex, class: 'color-input' });
    const alpha = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: a, class: 'range alpha' });
    const update = () => {
        const n = parseInt(color.value.slice(1), 16);
        theme[key] = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha.value})`;
        onChange();
    };
    color.addEventListener('input', update);
    alpha.addEventListener('input', update);
    return el('div', { class: 'color-row' }, color, el('span', { class: 'grow' }, label), alpha);
}

export async function render(body) {
    rootBody = body;
    const a = state.settings.appearance;
    const save = () => { saveSettingsDebounced(); applyTheme(); };
    const savedThemes = await api.get('themes');
    const allThemes = [...BUILTIN_THEMES.map(t => ({ ...t, builtin: true })), ...savedThemes];
    const active = currentTheme();

    const swatches = el('div', { class: 'theme-grid' }, allThemes.map(t => {
        const card = el('button', {
            class: `theme-card${(active.id && t.id ? active.id === t.id : active.name === t.name && !!t.builtin === !active.id) ? ' active' : ''}`,
            style: { '--tc-bg': t.rv_bg || 'rgb(20,20,20)', '--tc-panel': t.bot_mes_blur_tint_color, '--tc-text': t.main_text_color, '--tc-quote': t.quote_text_color, '--tc-accent': t.rv_accent || t.quote_text_color, '--tc-em': t.italics_text_color },
            onclick: () => {
                a.themeName = t.name;
                a.theme = t.builtin ? null : structuredClone(t);
                if (t.chat_display) a.chatStyle = t.chat_display;
                save();
                rerender();
            },
        },
        el('div', { class: 'theme-preview' }, el('span', { class: 'tp-line' }), el('span', { class: 'tp-quote' }, '"Hello"'), el('span', { class: 'tp-em' }, '*smiles*')),
        el('span', { class: 'theme-name' }, t.name),
        !t.builtin ? el('span', { class: 'theme-del', title: 'Delete', onclick: async e => {
            e.stopPropagation();
            if (!await confirmDialog(`Delete theme “${t.name}”?`, { danger: true, okLabel: 'Delete' })) return;
            await api.del(`themes/${encodeURIComponent(t.id)}`);
            rerender();
        } }, icon('xmark')) : null);
        return card;
    }));

    // Editable copy of the current theme.
    const editing = a.theme ? a.theme : structuredClone(active);
    const colorsBox = el('div', { class: 'stack' }, COLOR_KEYS.map(([k, label]) => colorControl(editing, k, label, debounce(() => {
        a.theme = editing;
        save();
    }, 60))));

    body.append(
        section('Themes',
            swatches,
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', onclick: async () => {
                    const files = await pickFile('.json,application/json', { multiple: true });
                    for (const file of files || []) {
                        try {
                            const theme = importTheme(JSON.parse(await file.text()));
                            const saved = await api.post('themes', theme);
                            a.theme = saved;
                            a.themeName = saved.name;
                            if (saved.chat_display) a.chatStyle = saved.chat_display;
                            toast(`Imported theme “${saved.name}”`, 'success');
                        } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
                    }
                    save();
                    rerender();
                } }, icon('file-import'), 'Import SillyTavern theme'),
                el('button', { class: 'btn small', onclick: () => download(`${active.name}.json`, exportTheme({ ...active, custom_css: [active.custom_css, a.customCss].filter(Boolean).join('\n') })) }, icon('download'), 'Export'),
                el('button', { class: 'btn small', onclick: async () => {
                    const name = await promptDialog('Theme name', `${active.name} (custom)`, { title: 'Save theme' });
                    if (!name) return;
                    const saved = await api.post('themes', { ...editing, name, chat_display: a.chatStyle });
                    a.theme = saved;
                    a.themeName = saved.name;
                    save();
                    rerender();
                } }, icon('floppy-disk'), 'Save as new theme'))),
        section('Layout',
            field('Message style', select([['cards', 'Cards'], ['bubbles', 'Bubbles'], ['flat', 'Flat'], ['document', 'Document (novel)']], a.chatStyle, v => { a.chatStyle = v; save(); })),
            el('div', { class: 'grid-2' },
                field('Story font', select([['Lora', 'Lora (serif)'], ['Cormorant', 'Cormorant (elegant)'], ['Inter', 'Inter (sans)'], ['System', 'System'], ['Mono', 'Monospace']], a.chatFont, v => { a.chatFont = v; save(); })),
                field('Interface font', select([['Inter', 'Inter'], ['System', 'System'], ['Lora', 'Lora'], ['Mono', 'Monospace']], a.uiFont, v => { a.uiFont = v; save(); }))),
            field('Avatars', select([['round', 'Round'], ['rounded', 'Rounded square'], ['rect', 'Portrait'], ['square', 'Square'], ['hidden', 'Hidden']], a.avatarStyle, v => { a.avatarStyle = v; save(); })),
            slider('Text size', a.fontScale, { min: 0.8, max: 1.4, step: 0.02, onChange: v => { a.fontScale = v; save(); } }),
            slider('Chat width (desktop, % of screen)', a.chatWidth, { min: 30, max: 100, step: 1, onChange: v => { a.chatWidth = v; save(); } }),
            toggle('Show timestamps', a.showTimestamps, v => { a.showTimestamps = v; saveSettingsDebounced(); printMessages(); }),
            toggle('Animated aurora backdrop', a.aurora, v => { a.aurora = v; save(); }),
            field('Enter key', select([['desktop', 'Sends on desktop, new line on phone'], ['always', 'Always sends'], ['never', 'Never sends (use the button)']], a.enterToSend, v => { a.enterToSend = v; saveSettingsDebounced(); }))),
        section('Colours', colorsBox,
            slider('Panel blur', editing.blur_strength ?? 14, { min: 0, max: 40, step: 1, onChange: v => { editing.blur_strength = v; a.theme = editing; save(); } })),
        await backgroundSection(a, save),
        section('Sidebar',
            field('Title', textInput(a.brandTitle || '', v => { a.brandTitle = v; saveSettingsDebounced(); applyBranding(); }, { placeholder: 'Reverie' })),
            field('Tagline', textInput(a.brandTagline ?? '', v => { a.brandTagline = v; saveSettingsDebounced(); applyBranding(); }, { placeholder: 'where stories begin' })),
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', onclick: async () => {
                    const file = await pickFile('image/*');
                    if (!file) return;
                    const res = await api.upload(`images?name=${encodeURIComponent(file.name)}`, file);
                    a.sidebarArt = res.url;
                    saveSettingsDebounced();
                    applyBranding();
                    rerender();
                } }, icon('image'), a.sidebarArt ? 'Change sidebar art' : 'Add sidebar art (a mascot, a sigil…)'),
                a.sidebarArt ? el('button', { class: 'btn small danger', onclick: () => { a.sidebarArt = ''; saveSettingsDebounced(); applyBranding(); rerender(); } }, icon('xmark'), 'Remove art') : null),
            a.sidebarArt ? field('Art caption', textInput(a.sidebarArtCaption || '', v => { a.sidebarArtCaption = v; saveSettingsDebounced(); applyBranding(); }, { placeholder: "Haven's Pet" })) : null),
        stThemeAddons(),
        section('Custom CSS', customCssBlock(),
            el('p', { class: 'hint' }, 'Applied after the theme\'s own custom_css. SillyTavern snippets and selectors (.mes, .mes_text, #chat, #send_form…) work here.')));
}

function stThemeAddons() {
    // Extensions like Custom Theme Style Inputs add controls to ST's #FontBlurChatWidthBlock.
    const block = document.getElementById('FontBlurChatWidthBlock');
    return block?.children.length ? section('From extensions', block) : '';
}

function customCssBlock() {
    // The real #CustomCSS-block lives in #st-dom so extensions (CSS Snippets, Custom Theme Style Inputs) can find it.
    const block = document.getElementById('CustomCSS-block');
    const css = document.getElementById('customCSS');
    css.value = state.settings.appearance.customCss || '';
    return block;
}

async function backgroundSection(a, save) {
    const backgrounds = await api.get('backgrounds');
    const grid = el('div', { class: 'bg-grid' },
        el('button', { class: `bg-tile none${!a.background ? ' active' : ''}`, onclick: () => { a.background = ''; save(); rerender(); } }, icon('ban'), el('span', {}, 'None')),
        backgrounds.map(b => el('button', { class: `bg-tile${a.background === b.url ? ' active' : ''}`, style: { backgroundImage: `url("${b.url}")` }, onclick: () => { a.background = b.url; save(); rerender(); } },
            el('span', { class: 'bg-del', title: 'Delete', onclick: async e => {
                e.stopPropagation();
                if (!await confirmDialog('Delete this background?', { danger: true, okLabel: 'Delete' })) return;
                await api.del(`backgrounds/${encodeURIComponent(b.name)}`);
                if (a.background === b.url) a.background = '';
                save();
                rerender();
            } }, icon('xmark')))));
    return section('Background',
        grid,
        el('div', { class: 'row gap wrap' },
            el('button', { class: 'btn small', onclick: async () => {
                const file = await pickFile('image/*');
                if (!file) return;
                const res = await api.upload(`backgrounds?name=${encodeURIComponent(file.name)}`, file);
                a.background = res.url;
                save();
                rerender();
            } }, icon('upload'), 'Upload'),
            state.chatId ? el('button', { class: 'btn small', onclick: async () => {
                chatMetadata().custom_background = a.background || undefined;
                await saveChat();
                toast(a.background ? 'Current background locked to this chat' : 'Chat background cleared', 'success');
                applyTheme();
            } }, icon('thumbtack'), 'Use for this chat only') : null),
        slider('Dim', a.bgDim, { min: 0, max: 0.9, step: 0.01, onChange: v => { a.bgDim = v; save(); } }),
        slider('Blur', a.bgBlur, { min: 0, max: 30, step: 1, onChange: v => { a.bgBlur = v; save(); } }));
}
