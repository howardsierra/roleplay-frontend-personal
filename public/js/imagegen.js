// Image generation: illustrate messages, inline <pic prompt="…"> tags, a free-form studio and a gallery.
import { api } from './api.js';
import { state, saveChat, chatMetadata, saveSettingsDebounced, currentPersona } from './state.js';
import { eventSource, event_types } from './events.js';
import { substituteParams } from './macros.js';
import { generateRaw, updateMessageBlock, addOneMessage, nowDate } from './chat.js';
import { extractPicPrompts } from './render.js';
import { applyTheme } from './themes.js';
import { el, icon, toast, modal, confirmDialog, field, textArea, select } from './ui.js';

export async function generateImage(prompt, overrides = {}) {
    const cfg = { ...state.settings.image, ...overrides };
    const finalPrompt = `${substituteParams(cfg.prefix || '')}${substituteParams(prompt)}`.trim();
    const data = { prompt: finalPrompt, negative: substituteParams(cfg.negative || '') };
    await eventSource.emit(event_types.SD_PROMPT_PROCESSING, data);
    const res = await api.post('images/generate', {
        provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl,
        prompt: data.prompt, negative: data.negative,
        width: cfg.width, height: cfg.height, steps: cfg.steps, scale: cfg.scale, sampler: cfg.sampler,
        quality: cfg.quality, workflow: cfg.workflow, seed: cfg.seed ?? -1,
    });
    return res.url;
}

/** Ask the chat model to turn text into an image prompt. */
async function writePrompt(sourceText, instruction) {
    const d = state.character?.card?.data || {};
    const sys = `You write prompts for an image generator. ${instruction}`;
    const context = [
        d.name ? `Character: ${d.name}\nAppearance/description: ${substituteParams(d.description || '').slice(0, 2500)}` : '',
        currentPersona().description ? `User persona ({{user}}): ${substituteParams(currentPersona().description).slice(0, 800)}` : '',
        `Text to illustrate:\n${sourceText}`,
    ].filter(Boolean).join('\n\n');
    const text = await generateRaw(context, null, false, false, sys);
    return String(text || '').replace(/^["'`\s]+|["'`\s]+$/g, '').replace(/^prompt:\s*/i, '').trim();
}

export async function illustrateMessage(id) {
    const mes = state.chat[id];
    if (!mes) return;
    const t = toast('Writing an image prompt…', 'info', { timeout: 0 });
    try {
        const prompt = await writePrompt(mes.mes.slice(-4000), state.settings.image.promptFromChatInstruction);
        t.querySelector('.toast-body div').textContent = 'Painting…';
        const url = await generateImage(prompt);
        mes.extra ??= {};
        mes.extra.media = [...(mes.extra.media || []), { url, title: prompt, type: 'image' }];
        updateMessageBlock(id);
        await saveChat();
        await eventSource.emit(event_types.MESSAGE_UPDATED, id);
    } catch (err) {
        toast(err.message, 'error', { title: 'Image generation failed' });
    } finally {
        t.remove();
    }
}

const inflight = new Set();
export async function generateInlinePic(id, prompt, force = false) {
    const mes = state.chat[id];
    if (!mes || !prompt) return;
    const key = `${id}|${prompt}`;
    if (inflight.has(key)) return;
    mes.extra ??= {};
    mes.extra.inline_images ??= {};
    if (mes.extra.inline_images[prompt] && !force) return;
    inflight.add(key);
    mes.extra.inline_pending = [...(mes.extra.inline_pending || []), prompt];
    updateMessageBlock(id);
    try {
        const url = await generateImage(prompt);
        mes.extra.inline_images[prompt] = url;
    } catch (err) {
        toast(err.message, 'error', { title: 'Inline image failed' });
    } finally {
        inflight.delete(key);
        mes.extra.inline_pending = (mes.extra.inline_pending || []).filter(p => p !== prompt);
        if (!mes.extra.inline_pending.length) delete mes.extra.inline_pending;
        updateMessageBlock(id);
        await saveChat();
    }
}

export async function autoInlinePics(id) {
    const mes = state.chat[id];
    if (!mes) return;
    for (const prompt of extractPicPrompts(mes.mes)) {
        if (!mes.extra?.inline_images?.[prompt]) await generateInlinePic(id, prompt);
    }
}

// ---------------- studio ----------------
export async function openImageStudio(initialMode = 'free') {
    const modes = [
        ['free', 'Free prompt'],
        ['scene', 'Current scene (from the chat)'],
        ['char', 'Portrait of {{char}}'],
        ['user', 'Portrait of me (persona)'],
        ['last', 'The last message'],
    ];
    let mode = initialMode;
    let prompt = '';
    const promptBox = textArea('', v => { prompt = v; }, { rows: 4, placeholder: 'A moonlit library with floating candles, cinematic lighting…' });
    const preview = el('div', { class: 'studio-preview' }, el('div', { class: 'empty' }, icon('image'), el('p', {}, 'Your image will appear here.')));
    let lastUrl = null;
    const actions = el('div', { class: 'row gap wrap hidden' },
        el('button', { class: 'btn small', onclick: async () => {
            if (!state.character) return toast('Open a chat first', 'warning');
            const mes = { name: state.character.card.data.name, is_user: false, is_system: false, send_date: nowDate(), mes: '', extra: { media: [{ url: lastUrl, title: prompt, type: 'image' }] }, swipes: [''], swipe_id: 0, swipe_info: [{}] };
            state.chat.push(mes);
            addOneMessage(mes);
            await saveChat();
            toast('Added to chat', 'success');
        } }, icon('comment-medical'), 'Send to chat'),
        el('button', { class: 'btn small', onclick: async () => {
            if (!state.chatId) return toast('Open a chat first', 'warning');
            chatMetadata().custom_background = lastUrl;
            await saveChat();
            applyTheme();
            toast('Set as this chat\'s background', 'success');
        } }, icon('panorama'), 'Chat background'),
        el('button', { class: 'btn small', onclick: () => {
            state.settings.appearance.background = lastUrl;
            saveSettingsDebounced();
            applyTheme();
        } }, icon('desktop'), 'Global background'));

    const go = async () => {
        preview.replaceChildren(el('div', { class: 'studio-loading' }, el('div', { class: 'rv-pic-shimmer' }), el('p', {}, 'Painting…')));
        actions.classList.add('hidden');
        try {
            let p = prompt.trim();
            if (mode !== 'free' || !p) {
                const d = state.character?.card?.data || {};
                const sources = {
                    scene: state.chat.slice(-4).map(m => `${m.name}: ${m.mes}`).join('\n\n').slice(-5000),
                    char: `Portrait of ${d.name}. ${d.description || ''}`.slice(0, 3000),
                    user: `Portrait of ${currentPersona().name}. ${currentPersona().description || ''}`,
                    last: state.chat.at(-1)?.mes || '',
                    free: p,
                };
                if (mode !== 'free') {
                    p = await writePrompt(sources[mode], state.settings.image.promptFromChatInstruction);
                    if (prompt.trim()) p = `${p}, ${prompt.trim()}`;
                    promptBox.value = prompt = p;
                }
            }
            if (!p) throw new Error('Write a prompt first');
            lastUrl = await generateImage(p);
            preview.replaceChildren(el('img', { src: lastUrl, class: 'studio-img', alt: p }));
            actions.classList.remove('hidden');
        } catch (err) {
            preview.replaceChildren(el('div', { class: 'empty error' }, icon('triangle-exclamation'), el('p', {}, err.message)));
        }
    };

    const content = el('div', { class: 'studio' },
        el('div', { class: 'stack' },
            field('What to paint', select(modes, mode, v => { mode = v; })),
            field('Prompt', promptBox, 'For the non-free modes, the chat model writes the prompt; anything you type here is appended.'),
            el('div', { class: 'row gap' }, el('button', { class: 'btn primary', onclick: go }, icon('wand-magic-sparkles'), 'Generate'))),
        el('div', { class: 'stack' }, preview, actions));
    modal({ title: 'Image studio', content, wide: true, buttons: [] });
}

export async function openGallery() {
    const grid = el('div', { class: 'gallery-grid' });
    const render = async () => {
        const images = await api.get('images');
        grid.replaceChildren(...images.map(img => el('figure', { class: 'gallery-item' },
            el('img', { src: img.url, loading: 'lazy', onclick: () => import('./chat.js').then(m => m.zoomImage(img.url)) }),
            el('figcaption', {},
                el('button', { class: 'mini-btn', title: 'Set as background', onclick: () => { state.settings.appearance.background = img.url; saveSettingsDebounced(); applyTheme(); toast('Background set', 'success'); } }, icon('panorama')),
                el('a', { class: 'mini-btn', title: 'Download', href: img.url, download: img.name }, icon('download')),
                el('button', { class: 'mini-btn danger', title: 'Delete', onclick: async () => {
                    if (!await confirmDialog('Delete this image?', { okLabel: 'Delete', danger: true })) return;
                    await api.del(`images/${encodeURIComponent(img.name)}`);
                    render();
                } }, icon('trash-can'))))));
        if (!images.length) grid.append(el('div', { class: 'empty' }, icon('images'), el('p', {}, 'No images yet. Generate some from the ✦ menu or by tapping the palette on any message.')));
    };
    render();
    modal({
        title: 'Gallery',
        content: el('div', { class: 'stack' }, el('div', { class: 'row gap' }, el('button', { class: 'btn primary', onclick: () => openImageStudio() }, icon('wand-magic-sparkles'), 'New image')), grid),
        wide: true,
        buttons: [],
    });
}
