// Themes: SillyTavern theme JSON compatible (same keys + SmartTheme CSS variables),
// with a few Reverie extras (accent gradient, aurora backdrop).
import { state } from './state.js';

const base = {
    blur_strength: 14,
    shadow_width: 2,
    font_scale: 1,
    chat_width: 52,
    avatar_style: 0,
    chat_display: 'cards',
    custom_css: '',
};

export const BUILTIN_THEMES = [
    {
        ...base,
        name: 'Nocturne',
        main_text_color: 'rgba(234, 229, 243, 1)',
        italics_text_color: 'rgba(176, 164, 209, 1)',
        underline_text_color: 'rgba(170, 220, 255, 1)',
        quote_text_color: 'rgba(244, 199, 128, 1)',
        blur_tint_color: 'rgba(21, 17, 33, 0.78)',
        chat_tint_color: 'rgba(13, 11, 20, 0.35)',
        user_mes_blur_tint_color: 'rgba(84, 56, 140, 0.28)',
        bot_mes_blur_tint_color: 'rgba(30, 25, 47, 0.62)',
        shadow_color: 'rgba(0, 0, 0, 0.35)',
        border_color: 'rgba(255, 255, 255, 0.08)',
        rv_bg: '#0c0a13',
        rv_accent: '#a78bfa',
        rv_accent2: '#f472b6',
        rv_aurora: ['#4c1d95', '#831843', '#1e3a8a'],
    },
    {
        ...base,
        name: 'Rose Haven',
        main_text_color: 'rgba(246, 228, 232, 1)',
        italics_text_color: 'rgba(226, 170, 190, 1)',
        underline_text_color: 'rgba(255, 196, 214, 1)',
        quote_text_color: 'rgba(255, 255, 255, 1)',
        blur_tint_color: 'rgba(58, 18, 34, 0.86)',
        chat_tint_color: 'rgba(40, 10, 22, 0.4)',
        user_mes_blur_tint_color: 'rgba(120, 40, 70, 0.34)',
        bot_mes_blur_tint_color: 'rgba(66, 20, 38, 0.7)',
        shadow_color: 'rgba(0, 0, 0, 0.3)',
        shadow_width: 1,
        border_color: 'rgba(244, 167, 196, 0.22)',
        rv_bg: '#2a0b18',
        rv_accent: '#e88aac',
        rv_accent2: '#b0386a',
        rv_aurora: ['#7a1f45', '#4a0f2a', '#8f2d55'],
        chat_display: 'document',
        custom_css: `
:root { --rv-ui-font: 'Lora', Georgia, serif; --rv-blossom: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cg fill='%23f6a9c4' fill-opacity='.92'%3E%3Cpath id='p' d='M50 50C40 38 38 22 46 12c3 5 5 6 8 0 8 10 6 26-4 38z'/%3E%3Cuse href='%23p' transform='rotate(72 50 50)'/%3E%3Cuse href='%23p' transform='rotate(144 50 50)'/%3E%3Cuse href='%23p' transform='rotate(216 50 50)'/%3E%3Cuse href='%23p' transform='rotate(288 50 50)'/%3E%3C/g%3E%3Ccircle cx='50' cy='50' r='7' fill='%23ffe3ec'/%3E%3Cg fill='%23c2185b'%3E%3Ccircle cx='50' cy='40' r='1.8'/%3E%3Ccircle cx='59' cy='47' r='1.8'/%3E%3Ccircle cx='56' cy='58' r='1.8'/%3E%3Ccircle cx='44' cy='58' r='1.8'/%3E%3Ccircle cx='41' cy='47' r='1.8'/%3E%3C/g%3E%3C/svg%3E"); }
.brand-title { font-style: italic; }
.sidebar::after, .sheet-panel::after, #send_form::before {
  content: ''; position: absolute; pointer-events: none; background-repeat: no-repeat; z-index: 0;
  background-image: var(--rv-blossom), var(--rv-blossom), var(--rv-blossom), var(--rv-blossom);
}
.sidebar::after { left: -14px; bottom: -10px; width: 170px; height: 150px; opacity: .85;
  background-size: 64px, 40px, 30px, 22px; background-position: 6px 70px, 60px 102px, 4px 30px, 92px 70px; }
.sheet-panel::after { right: -10px; bottom: -12px; width: 150px; height: 120px; opacity: .8;
  background-size: 56px, 34px, 24px, 18px; background-position: 88px 60px, 52px 86px, 112px 22px, 30px 98px; }
#send_form { position: relative; }
#send_form::before { left: -18px; top: -16px; width: 70px; height: 52px; opacity: .9;
  background-size: 34px, 22px, 0, 0; background-position: 0 6px, 30px 0; }
.sidebar-art img { filter: drop-shadow(0 10px 24px rgba(244, 114, 182, .35)); }
#bg_layer::after { content: ''; position: absolute; inset: 0; opacity: .05; background-image: var(--rv-blossom); background-size: 120px; }
`,
    },
    {
        ...base,
        name: 'Moonlit Parchment',
        main_text_color: 'rgba(43, 37, 33, 1)',
        italics_text_color: 'rgba(118, 98, 80, 1)',
        underline_text_color: 'rgba(30, 90, 140, 1)',
        quote_text_color: 'rgba(158, 52, 40, 1)',
        blur_tint_color: 'rgba(250, 246, 238, 0.82)',
        chat_tint_color: 'rgba(244, 239, 230, 0.2)',
        user_mes_blur_tint_color: 'rgba(231, 220, 200, 0.6)',
        bot_mes_blur_tint_color: 'rgba(255, 252, 246, 0.78)',
        shadow_color: 'rgba(80, 60, 30, 0.12)',
        shadow_width: 0,
        border_color: 'rgba(80, 60, 30, 0.14)',
        rv_bg: '#efe8dc',
        rv_accent: '#9a5b2e',
        rv_accent2: '#c2410c',
        rv_aurora: ['#f5d0a9', '#e9d5ff', '#fde68a'],
        rv_light: true,
    },
    {
        ...base,
        name: 'Sakura Night',
        main_text_color: 'rgba(250, 232, 240, 1)',
        italics_text_color: 'rgba(240, 168, 200, 1)',
        underline_text_color: 'rgba(255, 200, 230, 1)',
        quote_text_color: 'rgba(255, 214, 165, 1)',
        blur_tint_color: 'rgba(36, 16, 30, 0.78)',
        chat_tint_color: 'rgba(20, 8, 16, 0.3)',
        user_mes_blur_tint_color: 'rgba(150, 40, 90, 0.26)',
        bot_mes_blur_tint_color: 'rgba(50, 20, 40, 0.6)',
        shadow_color: 'rgba(0, 0, 0, 0.35)',
        border_color: 'rgba(255, 182, 214, 0.12)',
        rv_bg: '#150812',
        rv_accent: '#f9a8d4',
        rv_accent2: '#fb7185',
        rv_aurora: ['#9d174d', '#7e22ce', '#be123c'],
    },
    {
        ...base,
        name: 'Abyss',
        main_text_color: 'rgba(222, 232, 236, 1)',
        italics_text_color: 'rgba(130, 160, 170, 1)',
        underline_text_color: 'rgba(94, 234, 212, 1)',
        quote_text_color: 'rgba(125, 211, 252, 1)',
        blur_tint_color: 'rgba(0, 0, 0, 0.88)',
        chat_tint_color: 'rgba(0, 0, 0, 0.5)',
        user_mes_blur_tint_color: 'rgba(20, 70, 70, 0.3)',
        bot_mes_blur_tint_color: 'rgba(12, 16, 18, 0.8)',
        shadow_color: 'rgba(0, 0, 0, 0)',
        shadow_width: 0,
        border_color: 'rgba(94, 234, 212, 0.1)',
        rv_bg: '#000000',
        rv_accent: '#2dd4bf',
        rv_accent2: '#38bdf8',
        rv_aurora: ['#042f2e', '#082f49', '#000000'],
    },
    {
        ...base,
        name: 'Ember',
        main_text_color: 'rgba(245, 232, 220, 1)',
        italics_text_color: 'rgba(214, 160, 120, 1)',
        underline_text_color: 'rgba(253, 186, 116, 1)',
        quote_text_color: 'rgba(252, 211, 77, 1)',
        blur_tint_color: 'rgba(30, 16, 10, 0.8)',
        chat_tint_color: 'rgba(16, 8, 4, 0.35)',
        user_mes_blur_tint_color: 'rgba(140, 60, 20, 0.25)',
        bot_mes_blur_tint_color: 'rgba(40, 22, 14, 0.62)',
        shadow_color: 'rgba(0, 0, 0, 0.4)',
        border_color: 'rgba(251, 146, 60, 0.12)',
        rv_bg: '#120804',
        rv_accent: '#fb923c',
        rv_accent2: '#ef4444',
        rv_aurora: ['#7c2d12', '#991b1b', '#78350f'],
    },
    {
        ...base,
        name: 'Verdant',
        main_text_color: 'rgba(228, 238, 226, 1)',
        italics_text_color: 'rgba(150, 180, 150, 1)',
        underline_text_color: 'rgba(190, 242, 100, 1)',
        quote_text_color: 'rgba(253, 230, 138, 1)',
        blur_tint_color: 'rgba(14, 24, 16, 0.8)',
        chat_tint_color: 'rgba(6, 12, 8, 0.35)',
        user_mes_blur_tint_color: 'rgba(40, 100, 60, 0.25)',
        bot_mes_blur_tint_color: 'rgba(20, 34, 24, 0.62)',
        shadow_color: 'rgba(0, 0, 0, 0.35)',
        border_color: 'rgba(134, 239, 172, 0.1)',
        rv_bg: '#070d08',
        rv_accent: '#86efac',
        rv_accent2: '#facc15',
        rv_aurora: ['#14532d', '#365314', '#134e4a'],
    },
];

const ST_DISPLAY = { 0: 'flat', 1: 'bubbles', 2: 'document' };
const AVATAR = { 0: 'round', 1: 'rect', 2: 'square', 3: 'rounded' };

/** Normalize an imported SillyTavern (or Reverie) theme JSON. */
export function importTheme(json) {
    if (!json || typeof json !== 'object' || !json.name) throw new Error('Not a theme file (missing "name")');
    const theme = { ...base, ...json };
    if (typeof theme.chat_display === 'number') theme.chat_display = ST_DISPLAY[theme.chat_display] || 'flat';
    return theme;
}

export function exportTheme(theme) {
    const out = { ...theme };
    const back = { flat: 0, bubbles: 1, document: 2, cards: 0 };
    out.chat_display = back[theme.chat_display] ?? 0;
    return out;
}

export function currentTheme() {
    const a = state.settings.appearance;
    return a.theme || BUILTIN_THEMES.find(t => t.name === a.themeName) || BUILTIN_THEMES[0];
}

function rgba(color) {
    const m = String(color || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    return m[1].split(',').map(s => parseFloat(s));
}

function luminance(color) {
    const c = rgba(color);
    if (!c) return 0.1;
    return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
}

export function applyTheme() {
    const t = currentTheme();
    const a = state.settings.appearance;
    const light = t.rv_light ?? luminance(t.blur_tint_color) > 0.6;
    const accent = t.rv_accent || t.quote_text_color || '#a78bfa';
    const accent2 = t.rv_accent2 || accent;
    const aurora = t.rv_aurora || [accent, accent2, accent];
    const body = rgba(t.main_text_color) || [230, 230, 230];
    const fonts = {
        Lora: "'Lora', Georgia, serif",
        Inter: "'Inter', system-ui, sans-serif",
        Cormorant: "'Cormorant Garamond', Georgia, serif",
        System: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        Mono: "'JetBrains Mono', monospace",
    };
    const vars = {
        '--SmartThemeBodyColor': t.main_text_color,
        '--SmartThemeEmColor': t.italics_text_color,
        '--SmartThemeUnderlineColor': t.underline_text_color,
        '--SmartThemeQuoteColor': t.quote_text_color,
        '--SmartThemeBlurTintColor': t.blur_tint_color,
        '--SmartThemeChatTintColor': t.chat_tint_color,
        '--SmartThemeUserMesBlurTintColor': t.user_mes_blur_tint_color,
        '--SmartThemeBotMesBlurTintColor': t.bot_mes_blur_tint_color,
        '--SmartThemeShadowColor': t.shadow_color,
        '--SmartThemeBorderColor': t.border_color,
        '--SmartThemeCheckboxBgColorR': body[0],
        '--SmartThemeCheckboxBgColorG': body[1],
        '--SmartThemeCheckboxBgColorB': body[2],
        '--blurStrength': t.blur_strength ?? 14,
        '--SmartThemeBlurStrength': `${t.blur_strength ?? 14}px`,
        '--shadowWidth': t.shadow_width ?? 2,
        '--fontScale': a.fontScale ?? t.font_scale ?? 1,
        '--mainFontSize': `calc(${a.fontScale ?? t.font_scale ?? 1} * 15px)`,
        '--sheldWidth': `${a.chatWidth || t.chat_width || 52}vw`,
        '--rv-bg': t.rv_bg || 'rgb(12,10,19)',
        '--rv-accent': accent,
        '--rv-accent-2': accent2,
        '--rv-aurora-1': aurora[0],
        '--rv-aurora-2': aurora[1],
        '--rv-aurora-3': aurora[2],
        '--rv-text-dim': `rgba(${body[0]}, ${body[1]}, ${body[2]}, 0.62)`,
        '--rv-text-faint': `rgba(${body[0]}, ${body[1]}, ${body[2]}, 0.38)`,
        '--rv-surface': light ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.045)',
        '--rv-surface-2': light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)',
        '--rv-hover': light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.07)',
        '--rv-chat-font': fonts[a.chatFont] || fonts.Lora,
        '--rv-ui-font': fonts[a.uiFont] || fonts.Inter,
        '--rv-bg-dim': a.bgDim ?? 0.35,
        '--rv-bg-blur': `${a.bgBlur ?? 0}px`,
    };
    document.getElementById('rv-theme-vars').textContent = `:root { ${Object.entries(vars).map(([k, v]) => `${k}: ${v};`).join(' ')} }`;
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.rv_bg || '#0c0a13');

    const cls = document.body.classList;
    for (const c of [...cls]) if (c.startsWith('chat-style-') || c.startsWith('avatar-style-')) cls.remove(c);
    const classic = a.layout === 'classic';
    cls.toggle('layout-classic', classic);
    // In the classic layout, message styling is left to SillyTavern-style themes.
    if (!classic) cls.add(`chat-style-${a.chatStyle || t.chat_display || 'cards'}`);
    cls.add(`avatar-style-${typeof t.avatar_style === 'number' && !a.avatarStyle ? AVATAR[t.avatar_style] : (a.avatarStyle || 'round')}`);
    cls.toggle('aurora-off', !a.aurora);
    cls.toggle('no-shadows', !t.shadow_width);

    const chatBg = state.chatMeta?.chat_metadata?.custom_background;
    const bg = chatBg || a.background;
    const bgEl = document.getElementById('bg_image');
    bgEl.style.backgroundImage = bg ? `url("${bg.replace(/"/g, '%22')}")` : '';
    document.body.classList.toggle('has-bg', !!bg);

    document.getElementById('custom-style').textContent = [t.custom_css || '', a.customCss || ''].join('\n');
}
