// Dialogue colors: each speaker's quotes in their own color.
// - Speaker colors: taken from the avatar (smart extraction with quality filtering), a static
//   color, or a per-character override. Exposed as --character-color on every .mes.
// - Cast tags: the model wraps each line of dialogue in <font color="#hex" title="Name">, using
//   the chat's cast list. New named speakers are learned into the cast automatically, and known
//   names are always repainted with their cast color, so colors stay consistent.
// Inspired by Smart Dialogue Colorizer (SillyTavern) and Prism (Lumiverse).
import { state, saveSettingsDebounced, chatMetadata, saveChatDebounced, currentPersona, charName, userName } from './state.js';
import { eventSource, event_types } from './events.js';
import { setExtensionPrompt, extensionPrompts } from './prompt.js';
import { registerMacro } from './macros.js';
import { avatarFor } from './chat.js';
import { el, icon, modal, toast } from './ui.js';

const PROMPT_KEY = 'rv_dialogue_colors';
export const DIALOGUE_DEFAULTS = {
    enabled: false,
    charSource: 'avatar',   // avatar | static | off
    personaSource: 'avatar',
    charStatic: '#e18a24',
    personaStatic: '#8ab4f8',
    saturation: 0,          // 0..10 boost
    brightness: 0,          // 0..10 boost
    colorNames: true,
    castTags: 'auto',       // off | auto (inject instructions) | macro ({{dialogueColors}} in your preset)
    thoughts: false,
    learn: true,
    overrides: {},          // "char:<avatar>" | "persona:<id>" -> #hex
};

export const dialogueSettings = () => {
    if (!state.settings.dialogue) importSmartDialogueColorizer();
    state.settings.dialogue = { ...DIALOGUE_DEFAULTS, ...(state.settings.dialogue || {}) };
    return state.settings.dialogue;
};

/** Carries Smart Dialogue Colorizer's saved settings over the first time (that extension is built in now). */
function importSmartDialogueColorizer() {
    const sdc = state.settings.extension_settings?.['SillyTavern-Smart-Dialogue-Colorizer'];
    if (!sdc || typeof sdc !== 'object') return;
    const source = v => ({ avatar_smart: 'avatar', static_color: 'static', disabled: 'off', char_color_override: 'avatar' })[v] || 'avatar';
    const c = sdc.charColorSettings || {};
    const p = sdc.personaColorSettings || {};
    const overrides = {};
    for (const [avatarName, color] of Object.entries(c.colorOverrides || {})) {
        const stem = String(avatarName).replace(/\.[^.]+$/, '');
        const match = (state.characters || []).find(ch => ch.avatar === avatarName || ch.name === stem);
        overrides[`char:${match?.avatar || avatarName}`] = color;
    }
    for (const [avatarName, color] of Object.entries(p.colorOverrides || {})) {
        const match = (state.settings.personas || []).find(x => x.stAvatar === avatarName || x.id === avatarName);
        if (match) overrides[`persona:${match.id}`] = color;
    }
    state.settings.dialogue = {
        enabled: true,
        charSource: source(c.colorizeSource),
        personaSource: source(p.colorizeSource),
        ...(c.staticColor ? { charStatic: c.staticColor } : {}),
        ...(p.staticColor ? { personaStatic: p.staticColor } : {}),
        colorNames: !!c.colorNameText,
        overrides,
    };
    saveSettingsDebounced();
}

// ---------------------------------------------------------------- color math
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
function hexToRgb(hex) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return null;
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
const rgbToHex = rgb => `#${rgb.map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('')}`;
function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
    if (!s) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const f = t => {
        t = (t + 1) % 1;
        if (t < 1 / 6) return p + (q - p) * 6 * t;
        if (t < 1 / 2) return q;
        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
        return p;
    };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const hueDistance = (a, b) => Math.min(Math.abs(a - b), 1 - Math.abs(a - b));

/** Is the chat drawn on a light background? (Judged from the theme's text color.) */
function lightBackground() {
    const rgb = getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeBodyColor').match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number);
    if (!rgb) return false;
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 < 0.5;
}

/** Make a color readable on the current background and apply the user's boosts. */
export function tuneColor(hex, { boost = true } = {}) {
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    let [h, s, l] = rgbToHsl(rgb);
    const cfg = dialogueSettings();
    if (boost) {
        s = clamp(s + cfg.saturation * 0.04);
        l = clamp(l + cfg.brightness * 0.03);
    }
    if (lightBackground()) l = Math.min(l, 0.42);
    else l = clamp(l, 0.6, 0.85);
    if (s < 0.25 && boost) s = Math.max(s, 0.35);
    return rgbToHex(hslToRgb([h, s, l]));
}

/**
 * Pick a vibrant, readable color from an image: tries vibrant pixels first, then muted ones,
 * then the average, rejecting near-black, near-white and grey buckets.
 */
async function extractColor(url) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const size = 48;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, size, size);
    const { data } = g.getImageData(0, 0, size, size);
    const buckets = new Map();
    let avg = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        const rgb = [data[i], data[i + 1], data[i + 2]];
        avg = avg.map((v, k) => v + rgb[k]);
        n++;
        const [h, s, l] = rgbToHsl(rgb);
        if (l < 0.12 || l > 0.92) continue;
        const key = `${Math.round(h * 24) % 24}:${s > 0.45 ? 'v' : s > 0.18 ? 'm' : 'g'}`;
        const b = buckets.get(key) || { count: 0, sum: [0, 0, 0], s: 0, l: 0 };
        b.count++;
        b.sum = b.sum.map((v, k) => v + rgb[k]);
        b.s += s;
        b.l += l;
        buckets.set(key, b);
    }
    const pick = kind => {
        let best = null;
        for (const [key, b] of buckets) {
            if (!key.endsWith(kind) || b.count < n * 0.01) continue;
            const s = b.s / b.count;
            const l = b.l / b.count;
            const score = b.count * (0.4 + s) * (1 - Math.abs(l - 0.55));
            if (!best || score > best.score) best = { score, rgb: b.sum.map(v => v / b.count) };
        }
        return best?.rgb;
    };
    const rgb = pick('v') || pick('m') || (n ? avg.map(v => v / n) : null);
    return rgb ? rgbToHex(rgb) : null;
}

const avatarCache = new Map(); // url -> Promise<hex|null>
function avatarColor(url) {
    if (!url) return Promise.resolve(null);
    if (!avatarCache.has(url)) avatarCache.set(url, extractColor(url).catch(() => null));
    return avatarCache.get(url);
}

// ---------------------------------------------------------------- speakers
const charKey = () => `char:${state.character?.avatar || state.character?.id || ''}`;
const personaKey = () => `persona:${currentPersona().id || ''}`;

/** Resolve a message's speaker color (async the first time an avatar is analyzed). */
async function speakerColor(mes) {
    const cfg = dialogueSettings();
    const isUser = !!mes.is_user;
    const key = isUser ? personaKey() : charKey();
    if (cfg.overrides[key] && !mes.force_avatar) return tuneColor(cfg.overrides[key], { boost: false });
    const source = isUser ? cfg.personaSource : cfg.charSource;
    if (source === 'off') return null;
    if (source === 'static') return tuneColor(isUser ? cfg.personaStatic : cfg.charStatic, { boost: false });
    const hex = await avatarColor(avatarFor(mes));
    if (hex) return tuneColor(hex);
    return tuneColor(isUser ? cfg.personaStatic : cfg.charStatic, { boost: false });
}

/** The chat's cast: [{ name, color, learned? }]. The main character and persona come first. */
export function castList() {
    const list = chatMetadata().rv_cast;
    return Array.isArray(list) ? list : [];
}
function saveCast(list) {
    chatMetadata().rv_cast = list;
    saveChatDebounced();
}

let mainColors = { char: null, persona: null };
async function refreshMainColors() {
    mainColors = {
        char: state.character ? await speakerColor({ is_user: false, name: charName() }) : null,
        persona: await speakerColor({ is_user: true, name: userName() }),
    };
    // Keep the persona visibly different from the character.
    const c = hexToRgb(mainColors.char);
    const p = hexToRgb(mainColors.persona);
    if (c && p) {
        const hc = rgbToHsl(c);
        const hp = rgbToHsl(p);
        if (hueDistance(hc[0], hp[0]) < 0.06) mainColors.persona = rgbToHex(hslToRgb([(hp[0] + 0.33) % 1, Math.max(hp[1], 0.45), hp[2]]));
    }
}

/** Everyone with a fixed color in this chat. */
export function fullCast() {
    const out = [];
    if (state.character && mainColors.char) out.push({ name: charName(), color: mainColors.char, main: true });
    if (mainColors.persona) out.push({ name: userName(), color: mainColors.persona, main: true, persona: true });
    for (const c of castList()) if (!out.some(o => o.name.toLowerCase() === c.name.toLowerCase())) out.push(c);
    return out;
}

// ---------------------------------------------------------------- prompt
export function castInstruction() {
    const cfg = dialogueSettings();
    if (!cfg.enabled) return '';
    const rows = fullCast().map(c => `- ${c.name}: ${c.color}`).join('\n');
    return [
        '[Dialogue colors]',
        'Wrap every line of spoken dialogue, including its quotation marks, in a font tag with the speaker\'s color and name, like:',
        `<font color="#e8a33d" title="Name">"Spoken words."</font>`,
        cfg.thoughts ? 'Wrap a character\'s inner thoughts the same way, around the italics: <font color="#hex" title="Name">*thought*</font>.' : '',
        'Use exactly these colors for known speakers:',
        rows || '(none yet)',
        'For any other named speaker, choose a new distinct, readable color and keep using it. Narration stays untagged.',
    ].filter(Boolean).join('\n');
}

function syncPrompt() {
    const cfg = dialogueSettings();
    if (cfg.enabled && cfg.castTags === 'auto' && state.character) setExtensionPrompt(PROMPT_KEY, castInstruction(), 1, 1, false, 0);
    else delete extensionPrompts[PROMPT_KEY];
}

// ---------------------------------------------------------------- painting
function applyBodyClasses() {
    const cfg = dialogueSettings();
    document.body.classList.toggle('rv-dc', !!cfg.enabled);
    document.body.classList.toggle('rv-dc-names', !!cfg.enabled && !!cfg.colorNames);
}

/** Called for every rendered message (see chat.js renderMessageInto). */
export function paintMessage(node, mes) {
    const cfg = dialogueSettings();
    if (!cfg.enabled) {
        node.style.removeProperty('--character-color');
        return;
    }
    // Repaint tagged dialogue for known speakers with their cast color.
    const cast = fullCast();
    for (const f of node.querySelectorAll('.mes_text font[color]')) {
        const who = f.getAttribute('title');
        const known = who && cast.find(c => c.name.toLowerCase() === who.trim().toLowerCase());
        if (known) f.setAttribute('color', known.color);
        f.classList.add('rv-speaker');
        if (who) f.dataset.speaker = who;
    }
    speakerColor(mes).then(color => {
        if (color) node.style.setProperty('--character-color', color);
        else node.style.removeProperty('--character-color');
    });
}

function repaintAll() {
    applyBodyClasses();
    for (const node of document.querySelectorAll('#chat > .mes')) {
        const mes = state.chat[Number(node.getAttribute('mesid'))];
        if (mes) paintMessage(node, mes);
    }
}

/** Learn new named speakers from a finished reply. */
function learnFrom(id) {
    const cfg = dialogueSettings();
    if (!cfg.enabled || !cfg.learn || cfg.castTags === 'off') return;
    const mes = state.chat[id];
    if (!mes || mes.is_user) return;
    const known = fullCast();
    const found = [];
    for (const m of String(mes.mes || '').matchAll(/<font\b[^>]*>/gi)) {
        const tag = m[0];
        const color = tag.match(/color\s*=\s*["']?(#[0-9a-f]{3,6})/i)?.[1];
        const name = tag.match(/title\s*=\s*["']([^"']{1,40})["']/i)?.[1]?.trim();
        if (!color || !name) continue;
        if (known.some(c => c.name.toLowerCase() === name.toLowerCase()) || found.some(c => c.name.toLowerCase() === name.toLowerCase())) continue;
        found.push({ name, color: tuneColor(color, { boost: false }), learned: true });
    }
    if (!found.length) return;
    saveCast([...castList(), ...found]);
    syncPrompt();
    repaintAll();
    toast(`Added ${found.map(f => f.name).join(', ')} to this chat's cast colors`, 'info', { timeout: 3500 });
}

// ---------------------------------------------------------------- cast editor
export function openCastEditor() {
    const cfg = dialogueSettings();
    const body = el('div', { class: 'stack cast-editor' });
    const render = () => {
        const rows = [];
        const colorInput = (value, onChange) => {
            const input = el('input', { type: 'color', class: 'cast-color' });
            input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : '#cccccc';
            input.addEventListener('change', () => onChange(input.value));
            return input;
        };
        if (state.character) {
            rows.push(el('div', { class: 'cast-row' }, colorInput(mainColors.char, v => { cfg.overrides[charKey()] = v; saveSettingsDebounced(); refresh(); }),
                el('span', { class: 'cast-name', style: `color:${mainColors.char || 'inherit'}` }, charName()), el('span', { class: 'hint' }, cfg.overrides[charKey()] ? 'custom' : 'from avatar'),
                cfg.overrides[charKey()] ? el('button', { class: 'icon-btn', title: 'Back to automatic', onclick: () => { delete cfg.overrides[charKey()]; saveSettingsDebounced(); refresh(); } }, icon('rotate-left')) : null));
        }
        rows.push(el('div', { class: 'cast-row' }, colorInput(mainColors.persona, v => { cfg.overrides[personaKey()] = v; saveSettingsDebounced(); refresh(); }),
            el('span', { class: 'cast-name', style: `color:${mainColors.persona || 'inherit'}` }, userName()), el('span', { class: 'hint' }, 'you'),
            cfg.overrides[personaKey()] ? el('button', { class: 'icon-btn', title: 'Back to automatic', onclick: () => { delete cfg.overrides[personaKey()]; saveSettingsDebounced(); refresh(); } }, icon('rotate-left')) : null));
        castList().forEach((c, i) => {
            const name = el('input', { class: 'input cast-name-input', value: c.name });
            name.addEventListener('change', () => { const list = [...castList()]; list[i] = { ...c, name: name.value.trim() || c.name, learned: false }; saveCast(list); refresh(); });
            rows.push(el('div', { class: 'cast-row' },
                colorInput(c.color, v => { const list = [...castList()]; list[i] = { ...c, color: v, learned: false }; saveCast(list); refresh(); }),
                name, c.learned ? el('span', { class: 'hint' }, 'learned') : null,
                el('button', { class: 'icon-btn danger', title: 'Remove', onclick: () => { saveCast(castList().filter((_, k) => k !== i)); refresh(); } }, icon('xmark'))));
        });
        body.replaceChildren(
            el('p', { class: 'hint' }, 'Each speaker\'s dialogue uses their color. Side characters are added here automatically when the AI names them, or add them yourself.'),
            ...rows,
            el('button', { class: 'btn small', onclick: () => {
                const used = fullCast().map(c => rgbToHsl(hexToRgb(c.color) || [200, 200, 200])[0]);
                let h = Math.random();
                for (let k = 0; k < 24 && used.some(u => hueDistance(u, h) < 0.08); k++) h = (h + 0.137) % 1;
                saveCast([...castList(), { name: 'New speaker', color: tuneColor(rgbToHex(hslToRgb([h, 0.6, 0.6]))) }]);
                refresh();
            } }, icon('plus'), 'Add speaker'),
        );
    };
    const refresh = async () => { await refreshMainColors(); syncPrompt(); repaintAll(); render(); };
    render();
    return modal({ title: 'Cast colors', content: body, buttons: [{ label: 'Done', value: true, primary: true }] });
}

// ---------------------------------------------------------------- setup
export async function refreshDialogueColors() {
    avatarCache.clear();
    await refreshMainColors();
    syncPrompt();
    repaintAll();
}

export function initDialogueColors() {
    dialogueSettings();
    applyBodyClasses();
    registerMacro('dialogueColors', () => (dialogueSettings().castTags === 'macro' ? castInstruction() : ''));
    registerMacro('dialogueCast', () => fullCast().map(c => `${c.name}: ${c.color}`).join('\n'));
    eventSource.on(event_types.CHAT_CHANGED, async () => { await refreshMainColors(); syncPrompt(); repaintAll(); });
    eventSource.on(event_types.PERSONA_CHANGED, async () => { await refreshMainColors(); syncPrompt(); repaintAll(); });
    eventSource.on(event_types.CHARACTER_EDITED, () => refreshDialogueColors());
    eventSource.on(event_types.GENERATION_STARTED, () => syncPrompt());
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, id => learnFrom(Number(id)));
    eventSource.on(event_types.SETTINGS_UPDATED, () => { applyBodyClasses(); syncPrompt(); });
}
