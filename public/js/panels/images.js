import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { keyField } from './connection.js';
import { openImageStudio, openGallery } from '../imagegen.js';
import { el, icon, field, select, textInput, textArea, toggle, slider, section } from '../ui.js';

const MODEL_HINTS = {
    pollinations: 'flux, turbo, kontext… (blank = default)',
    openai: 'gpt-image-1, dall-e-3',
    openrouter: 'google/gemini-2.5-flash-image, openai/gpt-5-image…',
    google: 'gemini-2.5-flash-image, imagen-4.0-generate-001',
    novelai: 'nai-diffusion-4-5-full, nai-diffusion-4-5-curated, nai-diffusion-3',
    xai: 'grok-2-image',
    nanogpt: 'any image model id from NanoGPT',
    a1111: 'checkpoint name (blank = current)',
    comfyui: 'used for %model% in your workflow',
    custom: 'model id for your endpoint',
};
const SIZES = [['832x1216', 'Portrait 832×1216'], ['1024x1024', 'Square 1024×1024'], ['1216x832', 'Landscape 1216×832'], ['768x1344', 'Tall 768×1344'], ['1344x768', 'Wide 1344×768'], ['512x768', 'Small portrait 512×768']];

export async function render(body) {
    const cfg = state.settings.image;
    const save = () => saveSettingsDebounced();
    state.providers ??= await api.get('providers');
    const provs = state.providers.image;
    const secrets = await api.get('secrets');

    const providerBits = el('div', { class: 'stack' });
    const renderBits = () => {
        const def = provs[cfg.provider];
        const keyName = cfg.provider === 'custom' ? 'custom_image' : cfg.provider;
        providerBits.replaceChildren(
            def?.needsKey !== false ? keyField(keyName, secrets, cfg.provider === 'a1111' ? 'Login (user:password)' : 'API key') : null,
            ['a1111', 'comfyui', 'custom', 'openai', 'nanogpt'].includes(cfg.provider)
                ? field('API URL', textInput(cfg.baseUrl, v => { cfg.baseUrl = v.trim(); save(); }, { placeholder: def?.base || 'https://…' }), cfg.provider === 'a1111' || cfg.provider === 'comfyui' ? 'Must be reachable from the Reverie server (use a tunnel if Reverie runs on Railway).' : '')
                : null,
            field('Model', textInput(cfg.model, v => { cfg.model = v.trim(); save(); }, { placeholder: MODEL_HINTS[cfg.provider] || '' })),
            cfg.provider === 'comfyui'
                ? field('Workflow (API format JSON)', textArea(cfg.workflow, v => { cfg.workflow = v; save(); }, { rows: 6, class: 'input mono' }), 'Use placeholders "%prompt%", "%negative_prompt%", "%seed%", "%width%", "%height%", "%steps%", "%scale%".')
                : null,
            cfg.provider === 'openai' ? field('Quality', select([['', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['hd', 'HD (DALL·E 3)']], cfg.quality || '', v => { cfg.quality = v; save(); })) : null);
    };
    renderBits();

    body.append(
        section('Image generation',
            field('Provider', select(Object.entries(provs).map(([k, v]) => [k, v.label]), cfg.provider, v => { cfg.provider = v; cfg.model = ''; cfg.baseUrl = ''; save(); renderBits(); })),
            providerBits,
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn primary', onclick: () => openImageStudio() }, icon('wand-magic-sparkles'), 'Open studio'),
                el('button', { class: 'btn', onclick: openGallery }, icon('images'), 'Gallery'))),
        section('Output',
            field('Size', select(SIZES, `${cfg.width}x${cfg.height}`, v => { const [w, h] = v.split('x').map(Number); cfg.width = w; cfg.height = h; save(); })),
            slider('Steps', cfg.steps, { min: 1, max: 60, step: 1, onChange: v => { cfg.steps = v; save(); }, hint: 'NovelAI / WebUI / ComfyUI' }),
            slider('Guidance (CFG)', cfg.scale, { min: 1, max: 20, step: 0.5, onChange: v => { cfg.scale = v; save(); } }),
            field('Sampler', textInput(cfg.sampler, v => { cfg.sampler = v; save(); }, { placeholder: 'k_euler_ancestral / Euler a' }))),
        section('Prompting',
            field('Always prepend', textArea(cfg.prefix, v => { cfg.prefix = v; save(); }, { rows: 2 }), 'Style tags added before every prompt.'),
            field('Negative prompt', textArea(cfg.negative, v => { cfg.negative = v; save(); }, { rows: 2 })),
            field('Scene → prompt instruction', textArea(cfg.promptFromChatInstruction, v => { cfg.promptFromChatInstruction = v; save(); }, { rows: 3 }), 'How the chat model writes image prompts when illustrating a message.')),
        section('Inline images in replies',
            toggle('Render inline image tags', cfg.inlineTags, v => { cfg.inlineTags = v; save(); }, 'The model can write <pic prompt="…"> or [img: …] and it becomes an image.'),
            toggle('Generate them automatically', cfg.autoGenerateInline, v => { cfg.autoGenerateInline = v; save(); }),
            el('p', { class: 'hint' }, 'Tip: add a prompt to your preset such as “When a moment is visually striking, include <pic prompt=\"detailed comma-separated image description\"> on its own line.”')));
}
