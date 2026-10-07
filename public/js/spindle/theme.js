// Lumiverse theme variables for extensions, derived from the active Reverie theme.
// Lumiverse extensions style themselves with --lumiverse-* / --lcs-* custom properties; Reverie
// computes a matching set from its own colours (an independent implementation of the same
// variable names) and keeps it on <html>, so extension UI follows Reverie themes.
import { state } from '../state.js';
import { prefersLight } from '../themes.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hsla = (h, s, l, a = 1) => `hsla(${Math.round(h)}, ${Math.round(clamp(s, 0, 100))}%, ${Math.round(clamp(l, 0, 100))}%, ${a})`;

function parseRgb(color) {
    const c = String(color || '').trim();
    let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})/i);
    if (m) {
        const h = m[1].length === 3 ? [...m[1]].map(x => x + x).join('') : m[1];
        return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    }
    m = c.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: l * 100 };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: h * 60, s: s * 100, l: l * 100 };
}

const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Judge the theme by its text colour: light text means a dark theme. */
function isLightTheme() {
    const text = parseRgb(cssVar('--SmartThemeBodyColor'));
    if (!text) return prefersLight();
    return (0.299 * text[0] + 0.587 * text[1] + 0.114 * text[2]) / 255 < 0.5;
}

/** Snapshot of the active theme in Lumiverse's ThemeInfo shape. */
export function currentThemeInfo() {
    const accentRgb = parseRgb(cssVar('--rv-accent')) || [167, 139, 250];
    const a = state.settings.appearance || {};
    return {
        id: a.themeName || 'reverie',
        name: a.themeName || 'Reverie',
        mode: isLightTheme() ? 'light' : 'dark',
        accent: toHsl(accentRgb),
        enableGlass: true,
        radiusScale: 1,
        fontScale: Number(a.fontScale) || 1,
        uiScale: 1,
        characterAware: false,
    };
}

/** A full --lumiverse-* / --lcs-* variable set for an accent and mode. */
export function generateVariables(cfg = {}) {
    const info = { ...currentThemeInfo(), ...cfg };
    const { h, s } = info.accent;
    const dark = info.mode !== 'light';
    const r = Number(info.radiusScale) || 1;
    const glass = info.enableGlass !== false;
    const pl = dark ? clamp(info.accent.l, 58, 74) : clamp(info.accent.l - 18, 28, 46);
    const ink = (a) => (dark ? `rgba(255, 255, 255, ${a})` : hsla(h, s * 0.2, 12, a));
    const shade = (a) => `rgba(0, 0, 0, ${dark ? a : a * 0.4})`;
    const bg = (l, a = 1) => hsla(h, s * (dark ? 0.28 : 0.14), dark ? l : 100 - l * 0.4, a);
    const v = {
        '--lumiverse-primary': hsla(h, s, pl, 0.92),
        '--lumiverse-primary-hover': hsla(h, s, pl + 6, 0.96),
        '--lumiverse-primary-active': hsla(h, s, pl - 4, 1),
        '--lumiverse-primary-light': hsla(h, s, pl, 0.1),
        '--lumiverse-primary-muted': hsla(h, s, pl, 0.6),
        '--lumiverse-primary-text': hsla(h, s + 6, pl + (dark ? 10 : -6), 0.96),
        '--lumiverse-primary-010': hsla(h, s, pl, 0.1),
        '--lumiverse-primary-015': hsla(h, s, pl, 0.15),
        '--lumiverse-primary-020': hsla(h, s, pl, 0.2),
        '--lumiverse-primary-050': hsla(h, s, pl, 0.5),
        '--lumiverse-primary-contrast': pl > 55 ? hsla(h, 25, 12) : hsla(h, 20, 96),
        '--lumiverse-accent': hsla((h + 30) % 360, s, pl, 0.95),
        '--lumiverse-secondary': 'rgba(128, 128, 128, 0.15)',
        '--lumiverse-secondary-hover': 'rgba(128, 128, 128, 0.25)',
        '--lumiverse-secondary-border': 'rgba(128, 128, 128, 0.25)',
        '--lumiverse-danger': '#ef5350',
        '--lumiverse-danger-hover': '#e53935',
        '--lumiverse-danger-015': 'rgba(239, 83, 80, 0.15)',
        '--lumiverse-danger-020': 'rgba(239, 83, 80, 0.2)',
        '--lumiverse-danger-050': 'rgba(239, 83, 80, 0.5)',
        '--lumiverse-error': '#ef5350',
        '--lumiverse-success': '#34c46e',
        '--lumiverse-success-015': 'rgba(52, 196, 110, 0.15)',
        '--lumiverse-success-020': 'rgba(52, 196, 110, 0.2)',
        '--lumiverse-success-050': 'rgba(52, 196, 110, 0.5)',
        '--lumiverse-warning': '#f2a93b',
        '--lumiverse-warning-015': 'rgba(242, 169, 59, 0.15)',
        '--lumiverse-warning-020': 'rgba(242, 169, 59, 0.2)',
        '--lumiverse-warning-050': 'rgba(242, 169, 59, 0.5)',
        '--lumiverse-info': hsla(210, 80, dark ? 66 : 42),
        '--lumiverse-link': hsla(h, s + 10, pl + 12, 0.95),
        '--lumiverse-bg': bg(12, glass && dark ? 0.95 : 1),
        '--lumiverse-background': bg(12),
        '--lumiverse-surface': bg(15),
        '--lumiverse-bg-elevated': bg(16, glass && dark ? 0.92 : 1),
        '--lumiverse-bg-hover': bg(20),
        '--lumiverse-bg-dark': shade(0.15),
        '--lumiverse-bg-darker': shade(0.25),
        '--lumiverse-bg-deep': bg(6),
        '--lumiverse-bg-040': bg(12, 0.4),
        '--lumiverse-bg-050': bg(12, 0.5),
        '--lumiverse-bg-070': bg(12, 0.7),
        '--lumiverse-bg-elevated-040': bg(16, 0.4),
        '--lumiverse-bg-deep-080': bg(9, 0.8),
        '--lumiverse-scene-text-scrim': bg(4, 0.5),
        '--lumiverse-border': hsla(h, s, pl, dark ? 0.14 : 0.18),
        '--lumiverse-border-hover': hsla(h, s, pl, dark ? 0.28 : 0.32),
        '--lumiverse-border-light': `rgba(128, 128, 128, ${dark ? 0.12 : 0.16})`,
        '--lumiverse-border-neutral': `rgba(128, 128, 128, ${dark ? 0.16 : 0.2})`,
        '--lumiverse-border-neutral-hover': `rgba(128, 128, 128, ${dark ? 0.26 : 0.3})`,
        '--lumiverse-text': ink(0.92),
        '--lumiverse-text-secondary': ink(0.75),
        '--lumiverse-text-muted': ink(0.65),
        '--lumiverse-text-dim': ink(0.42),
        '--lumiverse-text-hint': ink(0.3),
        '--lumiverse-icon': ink(0.92),
        '--lumiverse-icon-muted': ink(0.6),
        '--lumiverse-icon-dim': ink(0.42),
        '--lumiverse-fill-subtle': shade(0.1),
        '--lumiverse-fill': shade(0.15),
        '--lumiverse-fill-hover': shade(0.2),
        '--lumiverse-fill-medium': shade(0.25),
        '--lumiverse-fill-strong': shade(0.3),
        '--lumiverse-fill-heavy': shade(0.5),
        '--lumiverse-fill-deepest': shade(0.7),
        '--lumiverse-radius-sm': `${Math.round(5 * r)}px`,
        '--lumiverse-radius': `${Math.round(8 * r)}px`,
        '--lumiverse-radius-md': `${Math.round(10 * r)}px`,
        '--lumiverse-radius-lg': `${Math.round(12 * r)}px`,
        '--lumiverse-radius-xl': `${Math.round(16 * r)}px`,
        '--lumiverse-shadow': `0 4px 6px -1px ${shade(0.3)}`,
        '--lumiverse-shadow-sm': `0 2px 8px ${shade(0.2)}`,
        '--lumiverse-shadow-md': `0 8px 24px ${shade(0.4)}`,
        '--lumiverse-shadow-lg': `0 24px 80px ${shade(0.5)}`,
        '--lumiverse-shadow-xl': `0 20px 60px ${shade(0.5)}`,
        '--lumiverse-highlight-inset': `inset 0 1px 0 rgba(255, 255, 255, ${dark ? 0.1 : 0.05})`,
        '--lumiverse-highlight-inset-md': `inset 0 1px 0 rgba(255, 255, 255, ${dark ? 0.18 : 0.1})`,
        '--lumiverse-highlight-inset-lg': `inset 0 1px 0 rgba(255, 255, 255, ${dark ? 0.24 : 0.12})`,
        '--lumiverse-modal-backdrop': `rgba(0, 0, 0, ${dark ? 0.6 : 0.3})`,
        '--lumiverse-gradient-modal': `linear-gradient(135deg, ${bg(16, 0.98)}, ${bg(9, 0.98)})`,
        '--lumiverse-swatch-border': `rgba(255, 255, 255, ${dark ? 0.15 : 0.3})`,
        '--lumiverse-card-bg': `linear-gradient(165deg, ${bg(13)} 0%, ${bg(9)} 100%)`,
        '--lumiverse-card-image-bg': `linear-gradient(135deg, ${bg(9)} 0%, ${bg(13)} 100%)`,
        '--lumiverse-transition': '200ms ease',
        '--lumiverse-transition-fast': '150ms ease',
        '--lumiverse-font-family': 'var(--rv-ui-font, system-ui, sans-serif)',
        '--lumiverse-font-mono': 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        '--lumiverse-font-scale': String(info.fontScale || 1),
        '--lumiverse-ui-scale': String(info.uiScale || 1),
        '--lumiverse-prose-italic': 'var(--SmartThemeEmColor, var(--lumiverse-text-muted))',
        '--lumiverse-prose-bold': 'inherit',
        '--lumiverse-prose-dialogue': 'var(--SmartThemeQuoteColor, var(--lumiverse-primary-text))',
        '--lumiverse-prose-blockquote': 'var(--lumiverse-text-muted)',
        '--lumiverse-prose-link': hsla(h, s + 10, pl + 14, 0.92),
        '--lcs-glass-bg': glass ? bg(7, dark ? 0.6 : 0.65) : bg(10),
        '--lcs-glass-bg-hover': glass ? bg(10, dark ? 0.7 : 0.75) : bg(14),
        '--lcs-glass-border': dark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(0, 0, 0, 0.08)',
        '--lcs-glass-border-hover': dark ? 'rgba(255, 255, 255, 0.11)' : 'rgba(0, 0, 0, 0.12)',
        '--lcs-glass-blur': glass ? '8px' : '0px',
        '--lcs-glass-soft-blur': glass ? '6px' : '0px',
        '--lcs-glass-strong-blur': glass ? '12px' : '0px',
        '--lcs-radius': `${Math.round(14 * r)}px`,
        '--lcs-radius-sm': `${Math.round(8 * r)}px`,
        '--lcs-radius-xs': `${Math.round(5 * r)}px`,
        '--lcs-transition': '220ms cubic-bezier(0.4, 0, 0.2, 1)',
        '--lcs-transition-fast': '120ms cubic-bezier(0.4, 0, 0.2, 1)',
    };
    // Prefer Reverie's real surfaces and text when they're the theme being described.
    if (!cfg.accent) {
        const text = cssVar('--SmartThemeBodyColor');
        const panel = cssVar('--SmartThemeBlurTintColor');
        if (text) v['--lumiverse-text'] = text;
        if (panel) { v['--lumiverse-bg-elevated'] = panel; v['--lumiverse-surface'] = panel; }
    }
    return v;
}

// ---------------------------------------------------------------- applying
const STYLE_ID = 'lumiverse-vars';
const overrides = new Map(); // extension id -> { variables }

function render() {
    let style = document.getElementById(STYLE_ID);
    if (!style) {
        style = Object.assign(document.createElement('style'), { id: STYLE_ID });
        document.head.append(style);
    }
    const base = generateVariables();
    const layered = Object.assign({}, base, ...[...overrides.values()].map(o => o.variables || {}));
    style.textContent = `:root {\n${Object.entries(layered).map(([k, val]) => `  ${k}: ${val};`).join('\n')}\n}`;
}

export function refreshLumiverseVars() { render(); }

export function applyThemeOverride(ext, payload = {}) {
    const mode = isLightTheme() ? 'light' : 'dark';
    const vars = { ...(payload.variables || {}), ...(payload.variablesByMode?.[mode] || {}) };
    const clean = Object.fromEntries(Object.entries(vars).filter(([k, v]) => /^--[\w-]+$/.test(k) && !/[;{}]/.test(String(v))).slice(0, 200));
    overrides.set(ext, { variables: { ...(overrides.get(ext)?.variables || {}), ...clean } });
    render();
    return { applied: Object.keys(clean).length };
}

export function clearThemeOverride(ext) {
    overrides.delete(ext);
    render();
    return true;
}
