import { bannerSettingsSection } from '../avatar-banner.js';
import { api } from '../api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChat } from '../state.js';
import { BUILTIN_THEMES, applyTheme, importTheme, exportTheme, currentTheme, isReverieTheme, resolveReverieTheme, toReverieTheme, reverieToSillyTavern, prefersLight } from '../themes.js';
import { printMessages } from '../chat.js';
import { applyBranding } from '../layout.js';
import { dialogueSettings, refreshDialogueColors, openCastEditor } from '../dialogue-colors.js';
import { popMenu } from '../chat.js';
import { el, icon, field, select, textArea, textInput, toggle, slider, section, toast, pickFile, download, confirmDialog, promptDialog, debounce } from '../ui.js';

let rootBody;
const rerender = () => {
    // Park SillyTavern blocks (custom CSS, extension controls) back in #st-dom so they survive the re-render.
    for (const block of rootBody.querySelectorAll('[data-st-park]')) document.getElementById('st-dom').append(block);
    rootBody.replaceChildren();
    render(rootBody);
};

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
        const reverie = isReverieTheme(t);
        const view = reverie ? resolveReverieTheme(t) : t;
        const isActive = active.id && t.id ? active.id === t.id : (a.theme?.id ? a.theme.id === t.id : active.name === t.name && !!t.builtin === !a.theme);
        const card = el('button', {
            class: `theme-card${isActive ? ' active' : ''}`,
            style: { '--tc-bg': view.rv_bg || 'rgb(20,20,20)', '--tc-panel': view.bot_mes_blur_tint_color, '--tc-text': view.main_text_color, '--tc-quote': view.quote_text_color, '--tc-accent': view.rv_accent || view.quote_text_color, '--tc-em': view.italics_text_color },
            onclick: () => {
                a.themeName = t.name;
                a.theme = t.builtin ? null : structuredClone(t);
                if (reverie) {
                    // Reverie themes carry layout preferences.
                    if (t.layout?.messageStyle) a.chatStyle = t.layout.messageStyle;
                    if (t.layout?.avatars) a.avatarStyle = t.layout.avatars;
                    if (t.layout?.layout && t.layout.layout !== (a.layout || 'reverie')) {
                        a.layout = t.layout.layout;
                        toast(`This theme uses the ${a.layout} layout.`, 'info');
                    }
                } else if (t.chat_display) a.chatStyle = t.chat_display;
                save();
                rerender();
            },
        },
        el('div', { class: 'theme-preview' }, el('span', { class: 'tp-line' }), el('span', { class: 'tp-quote' }, '"Hello"'), el('span', { class: 'tp-em' }, '*smiles*')),
        el('span', { class: 'theme-name' }, t.name,
            reverie ? el('span', { class: 'theme-badges' },
                t.variants?.dark ? icon('moon') : null, t.variants?.light ? icon('sun') : null) : null),
        !t.builtin ? el('span', { class: 'theme-del', title: 'Delete', onclick: async e => {
            e.stopPropagation();
            if (!await confirmDialog(`Delete theme “${t.name}”?`, { danger: true, okLabel: 'Delete' })) return;
            await api.del(`themes/${encodeURIComponent(t.id)}`);
            rerender();
        } }, icon('xmark')) : null);
        return card;
    }));

    // Colour editing. For Reverie themes, edits go into the variant currently showing.
    const reverieActive = isReverieTheme(a.theme);
    const editing = reverieActive ? structuredClone(active) : (a.theme ? a.theme : structuredClone(active));
    const ST_TO_TOKEN = { main_text_color: 'text', italics_text_color: 'em', quote_text_color: 'quote', underline_text_color: 'underline', blur_tint_color: 'panel', chat_tint_color: 'chatTint', bot_mes_blur_tint_color: 'botMessage', user_mes_blur_tint_color: 'userMessage', border_color: 'border', shadow_color: 'shadow' };
    const colorsBox = el('div', { class: 'stack' }, COLOR_KEYS.map(([k, label]) => colorControl(editing, k, label, debounce(() => {
        if (reverieActive) {
            const variant = prefersLight() && a.theme.variants?.light ? 'light' : (a.theme.variants?.dark ? 'dark' : 'light');
            a.theme.variants ??= {};
            a.theme.variants[variant] = { ...(a.theme.variants[variant] || {}), [ST_TO_TOKEN[k]]: editing[k] };
        } else a.theme = editing;
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
                            const json = JSON.parse(await file.text());
                            const theme = isReverieTheme(json) ? json : importTheme(json);
                            const saved = await api.post('themes', theme);
                            a.theme = saved;
                            a.themeName = saved.name;
                            if (saved.chat_display) a.chatStyle = saved.chat_display;
                            toast(`Imported theme “${saved.name}”`, 'success');
                        } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
                    }
                    save();
                    rerender();
                } }, icon('file-import'), 'Import theme'),
                el('button', { class: 'btn small', onclick: e => popMenu(e.currentTarget, [
                    ['star', 'Export as Reverie theme (.rvtheme.json)', () => download(`${active.name}.rvtheme.json`, reverieActive ? stripIds(a.theme) : toReverieTheme(active))],
                    ['file-export', 'Export as SillyTavern theme', () => download(`${active.name}.json`, reverieActive ? reverieToSillyTavern(a.theme) : exportTheme({ ...active, custom_css: [active.custom_css, a.customCss].filter(Boolean).join('\n') }))],
                ]) }, icon('download'), 'Export'),
                el('button', { class: 'btn small', onclick: async () => {
                    const name = await promptDialog('Theme name', `${active.name} (custom)`, { title: 'Save as Reverie theme' });
                    if (!name) return;
                    const saved = await api.post('themes', reverieActive ? { ...stripIds(a.theme), name } : toReverieTheme({ ...editing, name }, { name }));
                    a.theme = saved;
                    a.themeName = saved.name;
                    save();
                    rerender();
                } }, icon('floppy-disk'), 'Save as Reverie theme'),
                reverieActive ? el('button', { class: 'btn small', onclick: () => editReverieTheme(a.theme, async updated => {
                    a.theme = updated;
                    if (updated.id) await api.put(`themes/${encodeURIComponent(updated.id)}`, updated);
                    save();
                    rerender();
                }) }, icon('pen-ruler'), 'Edit theme details') : null),
            field('Light / dark', select([['auto', 'Follow my device'], ['dark', 'Always dark'], ['light', 'Always light']], a.colorScheme || 'auto', v => { a.colorScheme = v; save(); rerender(); }), 'Reverie themes can include both a light and a dark version.')),
        section('Layout',
            field('Interface layout', select([['reverie', 'Reverie (sidebar, cards, character sheet)'], ['classic', 'SillyTavern classic (for ST interface themes)']], a.layout || 'reverie', v => {
                a.layout = v;
                save();
                toast(v === 'classic' ? 'Classic layout on. Reload to load interface themes like Moonlit Echoes.' : 'Reverie layout on.', 'info', { timeout: 4000 });
                rerender();
            }), 'Classic mirrors SillyTavern\'s geometry — top bar, centred chat column, side panels — so themes such as Moonlit Echoes fit.'),
            a.layout === 'classic' ? null : field('Message style', select([['cards', 'Cards'], ['bubbles', 'Bubbles'], ['flat', 'Flat'], ['document', 'Document (novel)']], a.chatStyle, v => { a.chatStyle = v; save(); })),
            el('div', { class: 'grid-2' },
                field('Story font', select([['Lora', 'Lora (serif)'], ['Cormorant', 'Cormorant (elegant)'], ['Inter', 'Inter (sans)'], ['System', 'System'], ['Mono', 'Monospace']], a.chatFont, v => { a.chatFont = v; save(); })),
                field('Interface font', select([['Inter', 'Inter'], ['System', 'System'], ['Lora', 'Lora'], ['Mono', 'Monospace']], a.uiFont, v => { a.uiFont = v; save(); }))),
            field('Avatars', select([['round', 'Round'], ['rounded', 'Rounded square'], ['rect', 'Portrait'], ['square', 'Square'], ['hidden', 'Hidden']], a.avatarStyle, v => { a.avatarStyle = v; save(); })),
            slider('Text size', a.fontScale, { min: 0.8, max: 1.4, step: 0.02, onChange: v => { a.fontScale = v; save(); } }),
            slider('Chat width (desktop, % of screen)', a.chatWidth, { min: 30, max: 100, step: 1, onChange: v => { a.chatWidth = v; save(); } }),
            toggle('Show timestamps', a.showTimestamps, v => { a.showTimestamps = v; saveSettingsDebounced(); printMessages(); }),
            toggle('Animated aurora backdrop', a.aurora, v => { a.aurora = v; save(); }),
            toggle('Scene lighting', a.ambient !== false, v => { a.ambient = v; saveSettingsDebounced(); import('../ambient.js').then(m => m.applyAmbient()); rerender(); },
                'Shifts the light to match the story — candlelight, moonlight, storms, snow — from the latest messages. Pin or turn it off per chat from the toolbar.'),
            a.ambient === false ? null : slider('Scene lighting strength', a.ambientIntensity ?? 0.5, { min: 0.1, max: 1, step: 0.05, onChange: v => { a.ambientIntensity = v; saveSettingsDebounced(); import('../ambient.js').then(m => m.applyAmbient()); } }),
            toggle('"Previously on…" recaps', a.recap !== false, v => { a.recap = v; saveSettingsDebounced(); }, 'When you return to a story after 6+ hours, a short recap appears under the last message.'),
            toggle('Show generation details under replies', a.genDetails !== false, v => { a.genDetails = v; saveSettingsDebounced(); printMessages(); }),
            field('Enter key', select([['desktop', 'Sends on desktop, new line on phone'], ['always', 'Always sends'], ['never', 'Never sends (use the button)']], a.enterToSend, v => { a.enterToSend = v; saveSettingsDebounced(); }))),
        dialogueSection(rerender),
        bannerSettingsSection({ section, toggle, slider, field, textInput }),
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

function dialogueSection(rerender) {
    const d = dialogueSettings();
    const save = () => { saveSettingsDebounced(); refreshDialogueColors(); };
    const sources = [['avatar', 'From the avatar (smart)'], ['static', 'One fixed color'], ['off', 'Theme quote color']];
    const colorPick = (value, onChange) => {
        const input = el('input', { type: 'color', class: 'cast-color' });
        input.value = value;
        input.addEventListener('change', () => onChange(input.value));
        return input;
    };
    return section('Dialogue colors',
        toggle('Color dialogue by speaker', d.enabled, v => { d.enabled = v; save(); rerender(); }, 'Each speaker\'s "quotes" get their own color, like Smart Dialogue Colorizer and Prism.'),
        d.enabled ? el('div', { class: 'stack' },
            el('div', { class: 'grid-2' },
                field('Character color', select(sources, d.charSource, v => { d.charSource = v; save(); rerender(); })),
                field('Your color', select(sources, d.personaSource, v => { d.personaSource = v; save(); rerender(); }))),
            d.charSource === 'static' || d.personaSource === 'static' ? el('div', { class: 'row gap' },
                d.charSource === 'static' ? field('Character', colorPick(d.charStatic, v => { d.charStatic = v; save(); })) : null,
                d.personaSource === 'static' ? field('You', colorPick(d.personaStatic, v => { d.personaStatic = v; save(); })) : null) : null,
            slider('Saturation boost', d.saturation, { min: 0, max: 10, step: 1, onChange: v => { d.saturation = v; save(); } }),
            slider('Brightness boost', d.brightness, { min: 0, max: 10, step: 1, onChange: v => { d.brightness = v; save(); } }),
            toggle('Color speaker names too', d.colorNames, v => { d.colorNames = v; save(); }),
            field('Multiple speakers in one reply', select([
                ['auto', 'Ask the AI to tag each speaker (automatic)'],
                ['macro', 'Ask the AI via {{dialogueColors}} in my preset'],
                ['off', 'Off: one color per message'],
            ], d.castTags, v => { d.castTags = v; save(); rerender(); }), 'The AI wraps each line in <font color="…" title="Name">. Known speakers are always repainted with their cast color, so they stay consistent.'),
            d.castTags !== 'off' ? toggle('Color inner thoughts too', d.thoughts, v => { d.thoughts = v; save(); }) : null,
            d.castTags !== 'off' ? toggle('Learn new speakers automatically', d.learn, v => { d.learn = v; save(); }) : null,
            el('button', { class: 'btn small', onclick: openCastEditor }, icon('palette'), 'Edit this chat\'s cast colors'),
            el('p', { class: 'hint' }, 'Custom CSS can use var(--character-color) on any message.')) : null);
}

const stripIds = t => {
    const { id, created, updated, ...rest } = structuredClone(t);
    return rest;
};

/** Edit the parts of a Reverie theme that aren't colours: fonts, shape, assets, CSS, light variant. */
async function editReverieTheme(theme, onSave) {
    const t = structuredClone(theme);
    t.fonts ??= {};
    t.assets ??= {};
    const assetList = el('div', { class: 'stack' });
    const renderAssets = () => {
        assetList.replaceChildren(...Object.entries(t.assets).map(([name, uri]) => el('div', { class: 'list-row' },
            el('img', { src: uri, class: 'asset-thumb', alt: '' }),
            el('span', { class: 'list-row-main mono' }, `var(--rv-asset-${name})`),
            el('button', { class: 'icon-btn small danger', onclick: () => { delete t.assets[name]; renderAssets(); } }, icon('xmark')))),
        el('button', { class: 'btn small', onclick: async () => {
            const file = await pickFile('image/*');
            if (!file) return;
            if (file.size > 600 * 1024) return toast('Keep embedded assets under 600 KB so the theme stays shareable', 'warning');
            const name = (await promptDialog('Asset name (letters, numbers, dashes)', file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '-').toLowerCase()) || '').replace(/[^\w-]/g, '');
            if (!name) return;
            t.assets[name] = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
            renderAssets();
        } }, icon('image'), 'Embed an image (ornament, texture, background…)'));
    };
    renderAssets();
    const hasLight = !!t.variants?.light;
    const ok = await modal({
        title: `Theme details · ${t.name}`,
        wide: true,
        content: el('div', { class: 'stack' },
            el('div', { class: 'grid-2' },
                field('Name', textInput(t.name, v => { t.name = v; })),
                field('Author', textInput(t.author || '', v => { t.author = v; }))),
            field('Description', textArea(t.description || '', v => { t.description = v; }, { rows: 2 })),
            el('div', { class: 'grid-3' },
                field('Interface font', textInput(t.fonts.ui || '', v => { t.fonts.ui = v; }, { placeholder: 'e.g. Nunito' })),
                field('Story font', textInput(t.fonts.chat || '', v => { t.fonts.chat = v; }, { placeholder: 'e.g. EB Garamond' })),
                field('Heading font', textInput(t.fonts.heading || '', v => { t.fonts.heading = v; }, { placeholder: 'e.g. Playfair Display' }))),
            el('p', { class: 'hint' }, 'Any Google Fonts family name works; it loads automatically.'),
            el('div', { class: 'grid-2' },
                field('Corner radius (px)', (() => { const i = el('input', { class: 'input', type: 'number', min: 0, max: 40 }); i.value = t.radius ?? 18; i.addEventListener('input', () => { t.radius = Number(i.value); }); return i; })()),
                field('Blur', (() => { const i = el('input', { class: 'input', type: 'number', min: 0, max: 40 }); i.value = t.blur ?? 14; i.addEventListener('input', () => { t.blur = Number(i.value); }); return i; })())),
            toggle('Has a light version', hasLight, v => {
                t.variants ??= {};
                if (v && !t.variants.light) t.variants.light = { background: '#f4efe6', text: 'rgba(43, 37, 33, 1)', em: 'rgba(118, 98, 80, 1)', quote: 'rgba(158, 52, 40, 1)', panel: 'rgba(250, 246, 238, 0.85)', botMessage: 'rgba(255, 252, 246, 0.8)', userMessage: 'rgba(231, 220, 200, 0.6)', border: 'rgba(80, 60, 30, 0.14)', accent: t.variants.dark?.accent };
                if (!v) delete t.variants.light;
            }, 'Edit its colours by switching Light / dark to "Always light".'),
            el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Embedded assets'), assetList),
            field('Theme CSS', textArea(t.css || '', v => { t.css = v; }, { rows: 8, class: 'input mono', placeholder: '.sidebar::after { content: ""; background: var(--rv-asset-flowers) no-repeat; }' }))),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }],
    });
    if (ok) onSave(t);
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
