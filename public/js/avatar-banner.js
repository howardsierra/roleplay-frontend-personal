// Avatar Banner, built in: a cropped strip of the character's (or persona's) art across the top of
// their messages, the name in a display font with an accent glow, per-character accent and quote
// colours, and an optional banner on the character panel.
// Ported from Kaede's SillyTavern-AvatarBanner (MIT). It keeps that extension's data: settings in
// extension_settings['SillyTavern-AvatarBanner'] and banners in the card at
// data.extensions['SillyTavern-AvatarBanner'], so cards with banners from SillyTavern show them here.
import { state, saveSettingsDebounced } from './state.js';
import { api } from './api.js';
import { eventSource, event_types } from './events.js';
import { el, icon, toast, modal, pickFile, confirmDialog } from './ui.js';

export const KEY = 'SillyTavern-AvatarBanner';
const STYLE_ID = 'avatar-banner-dynamic';
const DEFAULTS = {
    enabled: true,
    bannerHeight: 15, // vh
    enableUserBanners: false,
    userBanners: {},
    extraStylingEnabled: false,
    enablePanelBanner: false,
    fontFamily: '',
    accentColor: '#e79fa8',
    fontSize: 2.4, // rem
    namePaddingTB: 0, // em
    namePaddingLR: 0, // em
    gradientCoverage: 80, // px of the accent glow at the bottom of a message
};

export function bannerSettings() {
    const all = (state.settings.extension_settings ??= {});
    const s = (all[KEY] ??= {});
    for (const [k, v] of Object.entries(DEFAULTS)) if (!(k in s)) s[k] = structuredClone(v);
    // Their old pixel units (see the extension's migrateSettings).
    if (s.bannerHeight > 40) s.bannerHeight = +(s.bannerHeight / 10).toFixed(2);
    if (s.fontSize > 10) s.fontSize = +(s.fontSize / 15).toFixed(2);
    if (s.namePaddingTB >= 1) s.namePaddingTB = +(s.namePaddingTB / 36).toFixed(3);
    if (s.namePaddingLR >= 1) s.namePaddingLR = +(s.namePaddingLR / 36).toFixed(3);
    return s;
}

// ---------------------------------------------------------------- data
export const characterBanner = character => character?.card?.data?.extensions?.[KEY] || {};

async function saveCharacterBanner(charId, patch) {
    const c = state.character?.id === charId ? state.character : await api.get(`characters/${encodeURIComponent(charId)}`);
    const ext = (c.card.data.extensions ??= {});
    ext[KEY] = { ...(ext[KEY] || {}), ...patch };
    await api.put(`characters/${encodeURIComponent(charId)}`, { card: c.card });
    regenerate();
    return ext[KEY];
}

export function personaBanner(p) {
    if (!p) return {};
    const map = bannerSettings().userBanners || {};
    const entry = map[p.id] ?? (p.stAvatar ? map[p.stAvatar] : undefined);
    return typeof entry === 'string' ? { banner: entry } : entry || {};
}

function savePersonaBanner(personaId, patch) {
    const p = (state.settings.personas || []).find(x => x.id === personaId);
    const s = bannerSettings();
    s.userBanners[personaId] = { ...personaBanner(p), ...patch };
    saveSettingsDebounced();
    regenerate();
    return s.userBanners[personaId];
}

const isImageData = str => typeof str === 'string' && /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(str);
const cssUrl = str => str.replace(/"/g, '\\"').replace(/[\n\r]/g, '');

// ---------------------------------------------------------------- colours & fonts
function hexToRgb(color) {
    const fallback = { r: 231, g: 159, b: 168 };
    if (!color || typeof color !== 'string') return fallback;
    color = color.trim();
    if (color.startsWith('rgb')) {
        const parts = color.match(/\d+/g);
        return parts?.length >= 3 ? { r: +parts[0], g: +parts[1], b: +parts[2] } : fallback;
    }
    const hex = color.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i, (_m, r, g, b) => r + r + g + g + b + b);
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : fallback;
}
const themeQuoteColor = () => getComputedStyle(document.documentElement).getPropertyValue('--SmartThemeQuoteColor').trim() || '#e79fa8';

function parseFont(input) {
    const raw = String(input || '').trim();
    if (!raw) return { importUrl: '', family: '' };
    const url = raw.match(/https:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s)]+/)?.[0];
    if (url) return { importUrl: url, family: decodeURIComponent((url.match(/family=([^&:]+)/)?.[1] || '').replace(/\+/g, ' ')) };
    return { importUrl: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(raw).replace(/%20/g, '+')}&display=swap`, family: raw };
}

// ---------------------------------------------------------------- templates
// STANDARD and MOONLIT are the extension's own templates (for the SillyTavern classic layout);
// REVERIE puts the banner on Reverie's message cards.
const TEMPLATES = {
    REVERIE: `
/* @BANNER_START */
#chat {{selector}} .mes_block::before {
    content: ""; position: absolute; top: 0; left: 0; width: 100%; height: {{bannerHeight}};
    background: url("{{bannerUrl}}") top center no-repeat; background-size: cover;
    -webkit-mask-image: linear-gradient(to bottom, black 60%, rgba(0, 0, 0, 0) 100%); mask-image: linear-gradient(to bottom, black 60%, rgba(0, 0, 0, 0) 100%);
    border-top-left-radius: inherit; border-top-right-radius: inherit; pointer-events: none; z-index: 0;
}
#chat {{selector}} .mes_block { padding-top: calc({{bannerHeight}} * 0.8) !important; }
body.chat-style-flat #chat {{selector}} { padding-top: calc({{bannerHeight}} * 0.8) !important; }
body.chat-style-flat #chat {{selector}} .mes_block::before { top: -12px; }
/* @BANNER_END */
#chat {{selector}} .mes_block {
    --avatar-banner-accent: rgb({{accentR}}, {{accentG}}, {{accentB}});
    position: relative; overflow: visible;
    /* @EXTRA_START */
    background: linear-gradient(to top, rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.5) 0px, {{blurTintColor}} {{gradientCoverage}}) !important;
    border: rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.7) solid 2px !important;
    box-shadow: 3px 3px 10px rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.25) !important;
    /* @EXTRA_END */
}
#chat {{selector}} .mes_block > * { position: relative; z-index: 1; }
#chat {{selector}} .mesAvatarWrapper { display: none !important; }
#chat {{selector}} .name_text {
    display: inline-flex !important; align-items: baseline; font-size: {{fontSize}} !important; line-height: 1.15;
    padding: {{namePaddingTB}} {{namePaddingLR}} !important; padding-right: 0.5em !important; margin-right: -0.5em !important;
    white-space: normal !important; overflow: visible !important;
    /* @EXTRA_START */
    font-family: {{fontFamily}} !important;
    background: linear-gradient(to bottom, color-mix(in srgb, white 80%, var(--avatar-banner-accent)), var(--avatar-banner-accent));
    filter: drop-shadow(0 0 5px var(--avatar-banner-accent));
    -webkit-background-clip: text !important; background-clip: text !important; -webkit-text-fill-color: transparent !important; color: transparent; text-shadow: none;
    /* @EXTRA_END */
}
#chat {{selector}} .ch_name { align-items: flex-end; }
#chat {{selector}} .mes_button {
    /* @EXTRA_START */
    border-radius: 50%; color: rgba(255, 255, 255, 0.9);
    background: linear-gradient(to bottom, rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.8), rgba(255, 255, 255, 0.35));
    box-shadow: 0 0 5px rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.8);
    /* @EXTRA_END */
}
#chat {{selector}} { --SmartThemeQuoteColor: var(--character-color, {{quoteColor}}) !important; }
`,
    STANDARD: `
/* @BANNER_START */
#chat {{selector}}::before {
    content: ""; position: absolute; top: 0; left: 0; width: 100%; height: {{bannerHeight}};
    background: url("{{bannerUrl}}") top center no-repeat; background-size: cover;
    -webkit-mask-image: linear-gradient(to bottom, black 60%, rgba(0, 0, 0, 0) 100%); mask-image: linear-gradient(to bottom, black 60%, rgba(0, 0, 0, 0) 100%);
    z-index: 2; pointer-events: none;
}
body.bubblechat #chat {{selector}}::before { border-radius: 10px; }
/* @BANNER_END */
#chat {{selector}} {
    --avatar-banner-accent: rgb({{accentR}}, {{accentG}}, {{accentB}});
    position: relative;
    /* @PADDING_START */
    padding: calc({{bannerHeight}} * 0.8) 1.5vw 1vh !important;
    /* @PADDING_END */
    /* @EXTRA_START */
    background: linear-gradient(to top, rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.5) 0px, {{blurTintColor}} {{gradientCoverage}});
    border: rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.7) solid 2px !important;
    box-shadow: 3px 3px 10px rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.25) !important;
    /* @EXTRA_END */
    overflow: visible !important;
}
{{selector}} .mes_block, {{selector}} .mes_text, {{selector}} .ch_name, {{selector}} .avatar { position: relative; z-index: 3; }
{{selector}} .ch_name, {{selector}} .mes_block { overflow: visible !important; }
#chat {{selector}} .avatar, #chat {{selector}} .mesAvatarWrapper { display: none !important; }
#chat {{selector}} .name_text {
    display: inline-flex !important; align-items: baseline; font-size: {{fontSize}} !important; text-align: left;
    padding: {{namePaddingTB}} {{namePaddingLR}} !important; padding-right: 0.5em !important; margin-right: -0.5em !important;
    overflow: visible !important; white-space: normal !important;
    /* @EXTRA_START */
    font-family: {{fontFamily}} !important;
    background: linear-gradient(to bottom, color-mix(in srgb, white 80%, var(--avatar-banner-accent)), var(--avatar-banner-accent));
    filter: drop-shadow(0 0 5px var(--avatar-banner-accent));
    -webkit-background-clip: text !important; background-clip: text !important; -webkit-text-fill-color: transparent !important; color: transparent; text-shadow: none;
    /* @EXTRA_END */
}
{{selector}} .mes_button, {{selector}} .extraMesButtons > div {
    border-radius: 50%; transition: all 0.3s ease-in-out;
    /* @EXTRA_START */
    background: linear-gradient(to bottom, rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.8), rgba(255, 255, 255, 0.5));
    color: rgba(255, 255, 255, 0.9); box-shadow: 0 0 5px rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.8);
    /* @EXTRA_END */
}
{{selector}} { --SmartThemeQuoteColor: var(--character-color, {{quoteColor}}) !important; }
`,
    MOONLIT: `
/* @BANNER_START */
{{selector}} .mes_block::before {
    content: ""; position: absolute; top: 0; left: 0; width: 100%; height: {{bannerHeight}};
    background: url("{{bannerUrl}}") top center no-repeat; background-size: cover;
    -webkit-mask-image: linear-gradient(to bottom, black 60%, rgba(0, 0, 0, 0) 100%); mask-image: linear-gradient(to bottom, black 60%, rgba(0, 0, 0, 0) 100%);
    z-index: 1; pointer-events: none; border-top-left-radius: inherit; border-top-right-radius: inherit; overflow: hidden;
}
/* @BANNER_END */
{{selector}} .mes_block {
    --avatar-banner-accent: rgb({{accentR}}, {{accentG}}, {{accentB}});
    position: relative;
    /* @PADDING_START */
    padding: calc({{bannerHeight}} * 0.8) 1.5vw 1vh !important;
    /* @PADDING_END */
    /* @EXTRA_START */
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.3) 0%, rgba(0, 0, 0, 0) 90%, rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.5) 100%), var(--SmartThemeBlurTintColor);
    border: rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.7) solid 2px !important;
    box-shadow: 3px 3px 10px rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.25) !important;
    /* @EXTRA_END */
    overflow: visible !important;
}
{{selector}} .mes_block, {{selector}} .mes_text, {{selector}} .ch_name { position: relative; z-index: 2; overflow: visible !important; }
#chat {{selector}} .avatar, #chat {{selector}} .mesAvatarWrapper { display: none !important; }
#chat {{selector}} .name_text {
    display: inline-flex !important; align-items: baseline; font-size: {{fontSize}} !important; text-align: left;
    padding: {{namePaddingTB}} {{namePaddingLR}}; padding-right: 0.5em !important; margin-right: -0.5em !important;
    overflow: visible !important; white-space: normal !important;
    /* @EXTRA_START */
    font-family: {{fontFamily}};
    background: linear-gradient(to bottom, color-mix(in srgb, white 80%, var(--avatar-banner-accent)), var(--avatar-banner-accent));
    filter: drop-shadow(0 0 5px var(--avatar-banner-accent));
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; text-shadow: none;
    /* @EXTRA_END */
}
{{selector}} .mes_button, {{selector}} .extraMesButtons > div {
    border-radius: 50%; transition: all 0.3s ease-in-out;
    /* @EXTRA_START */
    background: linear-gradient(to bottom, rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.8), rgba(255, 255, 255, 0.5));
    color: rgba(255, 255, 255, 0.9); box-shadow: 0 0 5px rgba({{accentR}}, {{accentG}}, {{accentB}}, 0.8);
    /* @EXTRA_END */
}
{{selector}} { --SmartThemeQuoteColor: var(--character-color, {{quoteColor}}) !important; }
`,
    // Reverie's character sheet already opens on the character's art; the banner takes its place.
    PANEL: `
body.has-panel-banner #sheet-body .sheet-hero { background-image: url("{{bannerUrl}}") !important; background-position: center top !important; height: auto !important; aspect-ratio: 5 / 2; }
`,
};

function processTemplate(name, values, { includeBanner, extraStyling }) {
    let css = TEMPLATES[name];
    if (!includeBanner) css = css.replace(/\/\* @BANNER_START \*\/[\s\S]*?\/\* @BANNER_END \*\//g, '').replace(/\/\* @PADDING_START \*\/[\s\S]*?\/\* @PADDING_END \*\//g, '');
    if (!extraStyling) css = css.replace(/\/\* @EXTRA_START \*\/[\s\S]*?\/\* @EXTRA_END \*\//g, '');
    return css.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? String(values[k]) : m));
}

const MOONLIT_STYLES = ['echostyle', 'whisperstyle', 'hushstyle', 'ripplestyle', 'tidestyle'];
function templateName() {
    const body = document.body.classList;
    if (!body.contains('layout-classic')) return body.contains('chat-style-document') ? null : 'REVERIE';
    const moonlit = MOONLIT_STYLES.some(c => body.contains(c)) || !!document.getElementById('MoonlitEchosTheme-style');
    // Like the extension: banners for SillyTavern's flat and bubble styles (and Moonlit's own look).
    if (body.contains('documentstyle')) return null;
    if (moonlit) return MOONLIT_STYLES.some(c => body.contains(c)) ? null : 'MOONLIT';
    return 'STANDARD';
}

function baseValues(s, rgb, quoteColor, isUser) {
    const family = parseFont(s.fontFamily).family;
    return {
        bannerHeight: `${s.bannerHeight}vh`,
        fontSize: `${s.fontSize}rem`,
        fontFamily: family ? `"${family}", cursive` : '"Caveat", cursive',
        namePaddingTB: `${s.namePaddingTB}em`,
        namePaddingLR: `${s.namePaddingLR}em`,
        gradientCoverage: `${s.gradientCoverage ?? 80}px`,
        accentR: rgb.r, accentG: rgb.g, accentB: rgb.b,
        quoteColor,
        blurTintColor: isUser ? 'var(--SmartThemeUserMesBlurTintColor)' : 'var(--SmartThemeBotMesBlurTintColor)',
    };
}

let timer = 0;
export function regenerate() {
    clearTimeout(timer);
    timer = setTimeout(generate, 60);
}

function generate() {
    const s = bannerSettings();
    const styleEl = document.getElementById(STYLE_ID) || document.head.appendChild(Object.assign(document.createElement('style'), { id: STYLE_ID }));
    document.body.classList.remove('has-panel-banner');
    const tpl = templateName();
    if (!s.enabled || !tpl || !state.character) { styleEl.textContent = ''; return; }
    let css = '/* Avatar Banner */\n';
    if (s.extraStylingEnabled) css += `@import url('${parseFont(s.fontFamily || 'Caveat').importUrl}');\n`;

    const charData = characterBanner(state.character);
    const charHasBanner = isImageData(charData.banner);
    const name = state.character.card?.data?.name || '';
    if (charHasBanner && name) {
        const values = {
            ...baseValues(s, hexToRgb(charData.accentColor || s.accentColor), charData.quoteColor || themeQuoteColor(), false),
            selector: `.mes[ch_name="${CSS.escape(name)}"]:not([is_user="true"])`,
            bannerUrl: cssUrl(charData.banner),
        };
        css += processTemplate(tpl, values, { includeBanner: true, extraStyling: s.extraStylingEnabled });
    }

    const persona = (state.settings.personas || []).find(p => p.id === state.settings.personaId);
    const userData = personaBanner(persona);
    const userHasBanner = isImageData(userData.banner);
    // As in the extension: with persona banners on, a persona with a banner gets one; with them off,
    // your messages still get the styling (no banner) whenever the character has a banner.
    const userStyled = (s.enableUserBanners && userHasBanner) || (!s.enableUserBanners && charHasBanner);
    if (userStyled) {
        const values = {
            ...baseValues(s, hexToRgb(userData.accentColor || s.accentColor), userData.quoteColor || themeQuoteColor(), true),
            selector: '.mes[is_user="true"]',
            bannerUrl: s.enableUserBanners && userHasBanner ? cssUrl(userData.banner) : '',
        };
        css += processTemplate(tpl, values, { includeBanner: s.enableUserBanners && userHasBanner, extraStyling: s.extraStylingEnabled });
    }

    if (s.enablePanelBanner && charHasBanner) {
        css += processTemplate('PANEL', { bannerUrl: cssUrl(charData.banner) }, { includeBanner: true, extraStyling: true });
        document.body.classList.add('has-panel-banner');
    }
    styleEl.textContent = css;
}

// ---------------------------------------------------------------- cropper
const readAsDataUrl = blob => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
});

/** An uploaded image, at most 2000px wide, as a JPEG data URL (it's stored in the card / settings). */
async function shrink(file, max = 2000) {
    const bitmap = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * k);
    canvas.height = Math.round(bitmap.height * k);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
}

/** Lets you pick a 4:1 strip of an image (drag to move, wheel / pinch / slider to zoom). Resolves to a data URL. */
export function cropBanner(src, { title = 'Choose the banner', aspect = 4 } = {}) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const frame = el('div', { class: 'ab-crop-frame', style: { aspectRatio: String(aspect) } });
            const pic = el('img', { class: 'ab-crop-img', src, alt: '', draggable: 'false' });
            frame.append(pic);
            const zoom = el('input', { type: 'range', min: '1', max: '4', step: '0.01', value: '1', class: 'ab-crop-zoom', 'aria-label': 'Zoom' });
            let scale = 1, x = 0, y = 0; // image offset in frame pixels, at the current scale
            const dims = () => {
                const fw = frame.clientWidth, fh = frame.clientHeight;
                const base = Math.max(fw / img.naturalWidth, fh / img.naturalHeight); // cover
                return { fw, fh, w: img.naturalWidth * base * scale, h: img.naturalHeight * base * scale };
            };
            const clamp = () => {
                const { fw, fh, w, h } = dims();
                x = Math.min(0, Math.max(fw - w, x));
                y = Math.min(0, Math.max(fh - h, y));
            };
            const paint = () => {
                clamp();
                const { w, h } = dims();
                Object.assign(pic.style, { width: `${w}px`, height: `${h}px`, transform: `translate(${x}px, ${y}px)` });
            };
            const zoomTo = (next, cx, cy) => {
                const { fw, fh } = dims();
                cx ??= fw / 2; cy ??= fh / 2;
                const ratio = next / scale;
                x = cx - (cx - x) * ratio;
                y = cy - (cy - y) * ratio;
                scale = next;
                zoom.value = String(next);
                paint();
            };
            zoom.addEventListener('input', () => zoomTo(Number(zoom.value)));
            frame.addEventListener('wheel', e => {
                e.preventDefault();
                const r = frame.getBoundingClientRect();
                zoomTo(Math.min(4, Math.max(1, scale * (e.deltaY < 0 ? 1.08 : 1 / 1.08))), e.clientX - r.left, e.clientY - r.top);
            }, { passive: false });
            const pointers = new Map();
            let pinch = null;
            frame.addEventListener('pointerdown', e => { frame.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
            frame.addEventListener('pointermove', e => {
                const prev = pointers.get(e.pointerId);
                if (!prev) return;
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (pointers.size === 2) {
                    const [a, b] = [...pointers.values()];
                    const d = Math.hypot(a.x - b.x, a.y - b.y);
                    if (pinch) {
                        const r = frame.getBoundingClientRect();
                        zoomTo(Math.min(4, Math.max(1, scale * d / pinch)), (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
                    }
                    pinch = d;
                    return;
                }
                x += e.clientX - prev.x;
                y += e.clientY - prev.y;
                paint();
            });
            const up = e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
            frame.addEventListener('pointerup', up);
            frame.addEventListener('pointercancel', up);
            const content = el('div', { class: 'ab-crop' }, frame,
                el('div', { class: 'ab-crop-row' }, icon('magnifying-glass-minus'), zoom, icon('magnifying-glass-plus')),
                el('p', { class: 'hint' }, 'Drag to move, scroll or pinch to zoom.'));
            modal({
                title, content, wide: true, className: 'ab-crop-modal',
                buttons: [{ label: 'Cancel', value: null }, { label: 'Save banner', primary: true, icon: 'check', value: () => {
                    const { fw, w } = dims();
                    const k = img.naturalWidth / w; // natural px per frame px
                    const out = document.createElement('canvas');
                    const outW = Math.min(1600, Math.round(fw * k));
                    out.width = outW;
                    out.height = Math.round(outW / aspect);
                    out.getContext('2d').drawImage(img, -x * k, -y * k, fw * k, fw * k / aspect, 0, 0, out.width, out.height);
                    return out.toDataURL('image/jpeg', 0.9);
                } }],
                onOpen: () => requestAnimationFrame(paint),
            }).then(resolve);
        };
        img.onerror = () => { toast('Couldn\'t load that image', 'error'); resolve(null); };
        img.src = src;
    });
}

// ---------------------------------------------------------------- controls
/**
 * Banner controls for a character or persona: crop from the avatar, upload another image,
 * recrop / remove, accent and quote colours.
 * target: { kind: 'character', id, onChange? } | { kind: 'persona', id }
 */
export function bannerControls(target) {
    const box = el('div', { class: 'ab-controls' });
    const load = async () => {
        if (target.kind === 'persona') return personaBanner((state.settings.personas || []).find(p => p.id === target.id));
        const c = state.character?.id === target.id ? state.character : await api.get(`characters/${encodeURIComponent(target.id)}`);
        return characterBanner(c);
    };
    const save = async patch => {
        const data = target.kind === 'persona' ? savePersonaBanner(target.id, patch) : await saveCharacterBanner(target.id, patch);
        target.onChange?.(data);
        render();
    };
    const avatarSource = async () => {
        let url;
        if (target.kind === 'persona') url = (state.settings.personas || []).find(p => p.id === target.id)?.avatar;
        else {
            const c = state.character?.id === target.id ? state.character : await api.get(`characters/${encodeURIComponent(target.id)}`);
            url = c.avatar ? `files/avatars/${encodeURIComponent(c.avatar)}` : '';
        }
        if (!url) throw new Error('There\'s no avatar image to crop. Upload an image instead.');
        return readAsDataUrl(await (await fetch(url)).blob());
    };
    const crop = async (src, source) => {
        const banner = await cropBanner(src);
        if (!banner) return;
        await save(source === undefined ? { banner } : { banner, source });
        toast('Banner saved', 'success', { timeout: 1800 });
    };

    const render = async () => {
        const data = await load();
        const s = bannerSettings();
        const color = (label, key, fallback) => {
            const input = el('input', { type: 'color', value: toHex(data[key] || fallback) });
            input.addEventListener('change', () => save({ [key]: input.value }));
            return el('label', { class: 'ab-color', title: `${label}${data[key] ? '' : ' (default)'}` }, input, el('span', {}, label),
                data[key] ? el('button', { class: 'icon-btn small', title: 'Back to the default', onclick: e => { e.preventDefault(); save({ [key]: null }); } }, icon('rotate-left')) : null);
        };
        box.replaceChildren(...[
            isImageData(data.banner) ? el('div', { class: 'ab-preview', style: { backgroundImage: `url("${cssUrl(data.banner)}")` } }) : el('div', { class: 'ab-preview empty' }, icon('panorama'), el('span', {}, 'No banner yet')),
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', title: 'Crop a banner from the avatar', onclick: async () => {
                    try { await crop(await avatarSource()); } catch (err) { toast(err.message, 'warning'); }
                } }, icon('panorama'), 'From avatar'),
                el('button', { class: 'btn small', title: 'Use another image', onclick: async () => {
                    const file = await pickFile('image/*');
                    if (!file) return;
                    const src = await shrink(file);
                    await crop(src, src);
                } }, icon('upload'), data.source ? 'New image' : 'Upload image'),
                isImageData(data.banner) ? el('button', { class: 'btn small', title: 'Recrop the banner', onclick: async () => {
                    try { await crop(data.source || await avatarSource()); } catch (err) { toast(err.message, 'warning'); }
                } }, icon('crop-simple'), 'Recrop') : null,
                isImageData(data.banner) ? el('button', { class: 'btn small danger', onclick: async () => {
                    if (await confirmDialog('Remove this banner?', { okLabel: 'Remove', danger: true })) save({ banner: '' });
                } }, icon('trash-can'), 'Remove') : null,
                data.source ? el('button', { class: 'btn small', title: 'Forget the uploaded image', onclick: async () => {
                    if (await confirmDialog('Delete the uploaded image (and its banner)?', { okLabel: 'Delete', danger: true })) save({ banner: '', source: '' });
                } }, icon('image'), 'Delete image') : null),
            el('div', { class: 'row gap wrap' }, color('Accent', 'accentColor', s.accentColor), color('Quotes', 'quoteColor', themeQuoteColor())),
            target.kind === 'persona' && !s.enableUserBanners ? el('p', { class: 'hint' }, 'Persona banners are off — turn them on in Look → Avatar banners.') : null,
            !s.enabled ? el('p', { class: 'hint' }, 'Avatar banners are off — turn them on in Look → Avatar banners.') : null,
        ].filter(Boolean));
    };
    render();
    return box;
}

function toHex(color) {
    const { r, g, b } = hexToRgb(color);
    return `#${[r, g, b].map(n => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Look → Avatar banners. */
export function bannerSettingsSection({ section, toggle, slider, field, textInput }) {
    const s = bannerSettings();
    const changed = () => { saveSettingsDebounced(); regenerate(); };
    const accent = el('input', { type: 'color', value: toHex(s.accentColor) });
    accent.addEventListener('change', () => { s.accentColor = accent.value; changed(); });
    return section('Avatar banners',
        toggle('Avatar banners', s.enabled, v => { s.enabled = v; changed(); }, 'A strip of the character\'s art across the top of their messages. Set it up per character in the character editor (Banner tab) and per persona in the Persona Manager.'),
        toggle('Persona banners', s.enableUserBanners, v => { s.enableUserBanners = v; changed(); }),
        toggle('Extra styling', s.extraStylingEnabled, v => { s.extraStylingEnabled = v; changed(); }, 'The name in a display font with an accent glow, an accent border and a gradient at the bottom of the message.'),
        toggle('Banner on the character panel', s.enablePanelBanner, v => { s.enablePanelBanner = v; changed(); }),
        el('label', { class: 'ab-color' }, accent, el('span', {}, 'Default accent colour')),
        field('Name font (Google Fonts)', textInput(s.fontFamily, v => { s.fontFamily = v; changed(); }, { placeholder: 'Caveat' }), 'A Google Fonts family name, as written on fonts.google.com, or its @import code.'),
        slider('Banner height (% of screen)', s.bannerHeight, { min: 5, max: 40, step: 0.5, onChange: v => { s.bannerHeight = v; changed(); } }),
        slider('Name size (rem)', s.fontSize, { min: 1, max: 5, step: 0.05, onChange: v => { s.fontSize = v; changed(); } }),
        slider('Name padding, top/bottom (em)', s.namePaddingTB, { min: 0, max: 1.6, step: 0.02, onChange: v => { s.namePaddingTB = v; changed(); } }),
        slider('Name padding, left/right (em)', s.namePaddingLR, { min: 0, max: 1.6, step: 0.02, onChange: v => { s.namePaddingLR = v; changed(); } }));
}

export function bindAvatarBanner() {
    for (const ev of [event_types.CHAT_CHANGED, event_types.PERSONA_CHANGED, event_types.PERSONA_UPDATED, event_types.CHARACTER_EDITED, event_types.SETTINGS_UPDATED]) eventSource.on(ev, regenerate);
    window.addEventListener('rv:theme-applied', regenerate);
    regenerate();
}
