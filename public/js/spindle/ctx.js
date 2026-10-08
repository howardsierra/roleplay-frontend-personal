// The `ctx` object a Lumiverse extension frontend receives in setup(ctx), built on Reverie's UI.
// Everything an extension creates through ctx is tracked and removed when it's turned off.
import DOMPurify from '../../vendor/purify.js';
import { state, connectionRequest } from '../state.js';
import { api } from '../api.js';
import { messageId } from '../message-ids.js';
import { renderHooks, printMessages } from '../chat.js';
import { displayFilters } from '../render.js';
import { points, pointsChanged } from '../rv-ext/points.js';
import { confirmDialog, el } from '../ui.js';
import { activeChatId } from './dto.js';
import { sheetState, openSheetTab } from '../layout.js';
import { onLumiverse } from './events.js';

const sanitize = html => DOMPurify.sanitize(String(html ?? ''), { ADD_TAGS: ['style'], ADD_ATTR: ['target'], FORBID_TAGS: ['script'] });

// ---------------------------------------------------------------- shared registries
const injections = new Set(); // { ext, wrapper, messageId, inText, position }
renderHooks.add((node, mes) => {
    const id = messageId(mes);
    for (const inj of injections) {
        if (inj.messageId !== id || inj.wrapper.isConnected) continue;
        const target = inj.inText ? node.querySelector('.mes_text') : node.querySelector('.mes_block') || node;
        target?.insertAdjacentElement(inj.position, inj.wrapper);
    }
});

const tagInterceptors = new Set(); // { ext, tagName, attrs, remove, handler }
const seenTags = new Map(); // messageId -> Set<key>
const pendingTags = new Map(); // messageId -> matches found during the last format

function parseAttrs(src) {
    const out = {};
    for (const m of String(src || '').matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    return out;
}
const matchesAttrs = (want, got) => Object.entries(want || {}).every(([k, v]) => (got[k] ?? '') === String(v));

displayFilters.add((text, { streaming, message, isUser }) => {
    if (!tagInterceptors.size || !message) return text;
    const id = messageId(message);
    const found = [];
    let out = text;
    const names = [...new Set([...tagInterceptors].map(t => t.tagName))];
    for (const name of names) {
        const rx = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}\\s*>`, 'gi');
        out = out.replace(rx, (full, attrSrc, inner) => {
            const attrs = parseAttrs(attrSrc);
            const hits = [...tagInterceptors].filter(t => t.tagName === name && matchesAttrs(t.attrs, attrs));
            if (!hits.length) return full;
            found.push({ hits, payload: { tagName: name, attrs, content: inner, fullMatch: full, isUser: !!isUser, isStreaming: !!streaming } });
            return hits.some(h => h.remove) ? '' : full;
        });
        // While streaming, hide an unfinished tag so raw markup doesn't flash.
        if (streaming && [...tagInterceptors].some(t => t.tagName === name && t.remove)) {
            out = out.replace(new RegExp(`<${name}\\b[^>]*>(?![\\s\\S]*</${name}\\s*>)[\\s\\S]*$`, 'i'), '<span class="rv-tag-pending">…</span>');
        }
    }
    if (found.length) pendingTags.set(id, found);
    return out;
});

renderHooks.add((_node, mes) => {
    const id = messageId(mes);
    const found = pendingTags.get(id);
    if (!found) return;
    pendingTags.delete(id);
    const seen = seenTags.get(id) || new Set();
    seenTags.set(id, seen);
    for (const { hits, payload } of found) {
        const key = `${payload.isStreaming}|${payload.fullMatch}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const h of hits) {
            try { h.handler({ extensionId: h.ext, ...payload, messageId: id, chatId: activeChatId() }); } catch (err) { console.error(`[${h.ext}] tag interceptor`, err); }
        }
    }
});

// ---------------------------------------------------------------- UI primitives
let zTop = 1400;

function makeModal({ title = '', width = 420, maxHeight = 520, persistent = false } = {}, track) {
    const dismissers = new Set();
    const body = el('div', { class: 'modal-body lv-modal-body' });
    const titleEl = el('h3', {}, title);
    const wrap = el('div', { class: 'modal-wrap lv-modal-wrap', style: { zIndex: ++zTop } });
    const box = el('div', { class: 'modal lv-modal', role: 'dialog', 'aria-modal': 'true', style: { width: `min(${width}px, calc(100vw - 24px))`, maxHeight: `min(${maxHeight}px, calc(100dvh - 24px))` } },
        el('div', { class: 'modal-head' }, titleEl, el('button', { class: 'icon-btn', title: 'Close', onclick: () => dismiss() }, el('i', { class: 'fa-solid fa-xmark' }))),
        body);
    wrap.append(box);
    let done = false;
    function dismiss() {
        if (done) return;
        done = true;
        wrap.classList.remove('open');
        setTimeout(() => wrap.remove(), 180);
        for (const fn of dismissers) { try { fn(); } catch (err) { console.error(err); } }
    }
    wrap.addEventListener('mousedown', e => { if (e.target === wrap && !persistent) dismiss(); });
    document.getElementById('modal-root').append(wrap);
    requestAnimationFrame(() => wrap.classList.add('open'));
    track(dismiss);
    return {
        root: body,
        modalId: `lvm-${zTop}`,
        dismiss,
        setTitle: t => { titleEl.textContent = t; },
        onDismiss: fn => { dismissers.add(fn); return () => dismissers.delete(fn); },
    };
}

function contextMenu({ position = { x: 0, y: 0 }, items = [] } = {}) {
    return new Promise(resolve => {
        const menu = el('div', { class: 'popover-menu lv-context-menu', role: 'menu', style: { position: 'fixed', zIndex: ++zTop } });
        const close = key => { menu.remove(); document.removeEventListener('pointerdown', outside, true); resolve({ selectedKey: key ?? null }); };
        const outside = e => { if (!menu.contains(e.target)) close(null); };
        for (const item of items) {
            if (item.type === 'divider') { menu.append(el('div', { class: 'menu-divider' })); continue; }
            menu.append(el('button', { class: `menu-item${item.danger ? ' danger' : ''}${item.active ? ' active' : ''}`, disabled: !!item.disabled, onclick: () => close(item.key) }, el('span', {}, item.label)));
        }
        document.body.append(menu);
        const r = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(8, Math.min(position.x, innerWidth - r.width - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(position.y, innerHeight - r.height - 8))}px`;
        setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    });
}

/**
 * Where a widget goes when the extension doesn't say: bottom-right, above the message box,
 * stacked upward so widgets never cover the composer, the send button or each other.
 */
function defaultFloatPosition(w, h) {
    const composer = document.getElementById('form_sheld')?.getBoundingClientRect();
    let y = (composer && composer.height ? composer.top : innerHeight - 96) - h - 12;
    const x = innerWidth - w - 12;
    const taken = [...document.querySelectorAll('.lv-float-box')].filter(b => b.style.display !== 'none').map(b => b.getBoundingClientRect());
    for (let i = 0; i < 12; i++) {
        const hit = taken.find(r => x < r.right && x + w > r.left && y < r.bottom && y + h > r.top);
        if (!hit) break;
        y = hit.top - h - 8;
    }
    return { x, y: Math.max(8, y) };
}

/** Every live float widget, so they can be moved out of the message box's way when it changes. */
const floats = new Set(); // { box, get: () => pos, size: () => size, move(x, y) }
function keepFloatsClear() {
    const composer = document.getElementById('form_sheld')?.getBoundingClientRect();
    if (!composer?.height) return;
    for (const f of floats) {
        if (f.box.classList.contains('fullscreen') || f.box.style.display === 'none') continue;
        const pos = f.get();
        const { h } = f.size();
        if (pos.y + h > composer.top - 4 && pos.y < composer.bottom) f.move(pos.x, Math.max(8, composer.top - h - 12));
    }
}
let floatWatch = false;
function watchComposer() {
    if (floatWatch) return;
    floatWatch = true;
    const form = document.getElementById('form_sheld');
    if (form && window.ResizeObserver) new ResizeObserver(() => keepFloatsClear()).observe(form);
    addEventListener('resize', () => setTimeout(keepFloatsClear, 50));
    document.addEventListener('rv:home', () => setTimeout(keepFloatsClear, 50));
}

function floatWidget(opts = {}, track) {
    watchComposer();
    const w = opts.width || 48;
    const h = opts.height || 48;
    const root = el('div', { class: `lv-float${opts.chromeless ? ' chromeless' : ''}`, title: opts.tooltip || '' });
    const box = el('div', { class: 'lv-float-box', 'data-lv-ext': opts.__ext || '', style: { zIndex: ++zTop } }, root);
    const dragEnd = new Set();
    let pos = opts.initialPosition || defaultFloatPosition(w, h);
    // A saved or requested spot that would sit on the message box is moved just above it.
    const composer = document.getElementById('form_sheld')?.getBoundingClientRect();
    if (composer?.height && !opts.fullscreen && pos.y + h > composer.top && pos.y < composer.bottom) pos = { x: pos.x, y: Math.max(8, composer.top - h - 12) };
    let size = { w, h };
    const place = () => {
        if (box.classList.contains('fullscreen')) return;
        pos = { x: Math.max(0, Math.min(pos.x, innerWidth - size.w)), y: Math.max(0, Math.min(pos.y, innerHeight - size.h)) };
        Object.assign(box.style, { left: `${pos.x}px`, top: `${pos.y}px`, width: `${size.w}px`, height: `${size.h}px` });
    };
    place();
    let drag = null;
    box.addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.target.closest('input, textarea, select, button, a, [data-no-drag]') || box.classList.contains('fullscreen')) return;
        drag = { sx: e.clientX, sy: e.clientY, x: pos.x, y: pos.y, moved: false };
    });
    const move = e => {
        if (!drag) return;
        const dx = e.clientX - drag.sx;
        const dy = e.clientY - drag.sy;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true;
        pos = { x: drag.x + dx, y: drag.y + dy };
        place();
    };
    const up = () => {
        if (!drag) return;
        const moved = drag.moved;
        drag = null;
        if (!moved) return;
        if (opts.snapToEdge) { pos.x = pos.x + size.w / 2 < innerWidth / 2 ? 8 : innerWidth - size.w - 8; place(); }
        for (const fn of dragEnd) fn({ ...pos });
        box.addEventListener('click', e => e.stopPropagation(), { capture: true, once: true });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('resize', place);
    if (opts.fullscreen) box.classList.add('fullscreen');
    document.body.append(box);
    const entry = { box, get: () => ({ ...pos }), size: () => ({ ...size }), move: (x, y) => { pos = { x, y }; place(); } };
    floats.add(entry);
    const destroy = () => { floats.delete(entry); box.remove(); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('resize', place); };
    track(destroy);
    return {
        root,
        widgetId: `lvw-${zTop}`,
        moveTo: (x, y) => { pos = { x, y }; place(); },
        getPosition: () => ({ ...pos }),
        setSize: (nw, nh) => { size = { w: nw, h: nh }; place(); },
        setVisible: v => { box.style.display = v ? '' : 'none'; },
        isVisible: () => box.style.display !== 'none',
        setFullscreen: v => { box.classList.toggle('fullscreen', !!v); if (!v) place(); },
        isFullscreen: () => box.classList.contains('fullscreen'),
        onDragEnd: fn => { dragEnd.add(fn); return () => dragEnd.delete(fn); },
        setTouchScrollMode: () => {},
        destroy,
    };
}

function dockPanel(opts = {}, track) {
    const edge = opts.edge === 'left' ? 'left' : 'right';
    const vis = new Set();
    const root = el('div', { class: 'lv-dock-body' });
    const panel = el('aside', { class: `lv-dock ${edge}${opts.chromeless ? ' chromeless' : ''}`, style: { width: `${opts.size || 360}px`, zIndex: 900 } },
        el('div', { class: 'lv-dock-head' }, el('strong', {}, opts.title || ''), el('button', { class: 'icon-btn small', title: 'Hide', onclick: () => set(false) }, el('i', { class: 'fa-solid fa-xmark' }))),
        root);
    const tab = el('button', { class: `lv-dock-tab ${edge}`, title: opts.title || '', onclick: () => set(true) }, opts.title || '⋯');
    let open = !opts.startCollapsed;
    function set(v) {
        open = v;
        panel.classList.toggle('open', open);
        tab.classList.toggle('hidden', open);
        for (const fn of vis) fn(open);
    }
    let tabs = document.getElementById(`lv-dock-tabs-${edge}`);
    if (!tabs) { tabs = el('div', { id: `lv-dock-tabs-${edge}`, class: `lv-dock-tabs ${edge}` }); document.body.append(tabs); }
    document.body.append(panel);
    tabs.append(tab);
    set(open);
    const destroy = () => { panel.remove(); tab.remove(); };
    track(destroy);
    return {
        root,
        expand: () => set(true),
        collapse: () => set(false),
        isExpanded: () => open,
        setSize: n => { panel.style.width = `${n}px`; },
        setTitle: t => { panel.querySelector('.lv-dock-head strong').textContent = t; tab.textContent = t; },
        onVisibilityChange: fn => { vis.add(fn); return () => vis.delete(fn); },
        destroy,
    };
}

// ---------------------------------------------------------------- components
function fieldHandle(node, read, write) {
    return { element: node, componentId: `lvc-${Math.random().toString(36).slice(2, 8)}`, getValue: read, update: patch => { if (patch && 'value' in patch) write(patch.value); }, destroy: () => node.remove(), open() {}, close() {} };
}

function mountSelect(target, o = {}) {
    const s = el('select', { class: `input lv-select ${o.className || ''}`, 'aria-label': o.ariaLabel || '' });
    const fill = opts => {
        s.replaceChildren(...(o.placeholder ? [el('option', { value: '', disabled: true }, o.placeholder)] : []), ...(opts || []).map(x => el('option', { value: x.value }, x.sublabel ? `${x.label} — ${x.sublabel}` : x.label)));
    };
    fill(o.options);
    s.value = o.value ?? '';
    s.addEventListener('change', () => o.onChange?.(s.value));
    target.append(s);
    const h = fieldHandle(s, () => s.value, v => { s.value = v ?? ''; });
    h.update = patch => { if (patch?.options) fill(patch.options); if (patch && 'value' in patch) s.value = patch.value ?? ''; };
    return h;
}

function mountInput(target, o = {}, type = 'text') {
    const node = type === 'textarea' ? el('textarea', { class: 'input', rows: o.rows || 4, 'aria-label': o.ariaLabel || '', placeholder: o.placeholder || '' }) : el('input', { class: 'input', type, 'aria-label': o.ariaLabel || '', placeholder: o.placeholder || '', min: o.min, max: o.max, step: o.step ?? (o.integer ? 1 : undefined) });
    node.value = o.value ?? '';
    node.addEventListener(type === 'number' ? 'change' : 'input', () => {
        if (type === 'number') { const n = node.value === '' ? null : Number(node.value); o.onChange?.(o.integer && n !== null ? Math.round(n) : n); } else o.onChange?.(node.value);
    });
    target.append(node);
    return fieldHandle(node, () => (type === 'number' ? Number(node.value) : node.value), v => { node.value = v ?? ''; });
}

function mountSwitch(target, o = {}) {
    const input = el('input', { type: 'checkbox', class: 'switch-input', 'aria-label': o.ariaLabel || '' });
    input.checked = !!o.checked;
    input.addEventListener('change', () => o.onChange?.(input.checked));
    const node = el('label', { class: 'switch small' }, input, el('span', { class: 'switch-track' }));
    target.append(node);
    const h = fieldHandle(node, () => input.checked, v => { input.checked = !!v; });
    h.update = patch => { if (patch && 'checked' in patch) input.checked = !!patch.checked; };
    return h;
}

function mountRange(target, o = {}) {
    const dec = o.format?.decimals ?? 0;
    const out = el('span', { class: 'lv-range-value' });
    const input = el('input', { type: 'range', class: 'range', min: o.min ?? 0, max: o.max ?? 1, step: o.step ?? 0.01, disabled: !!o.disabled });
    input.value = o.value ?? 0;
    const show = () => { out.textContent = Number(input.value).toFixed(dec); };
    show();
    input.addEventListener('input', () => { show(); o.onChange?.(Number(input.value)); });
    input.addEventListener('change', () => o.onCommit?.(Number(input.value)));
    const node = el('div', { class: 'lv-range' }, o.label ? el('span', { class: 'field-label' }, o.label) : null, input, out);
    target.append(node);
    return fieldHandle(node, () => Number(input.value), v => { input.value = v; show(); });
}

function mountModelCombobox(target, o = {}) {
    const listId = `lvm-${Math.random().toString(36).slice(2, 8)}`;
    const input = el('input', { class: 'input', list: listId, placeholder: o.placeholder || 'Model', value: o.value || '' });
    const list = el('datalist', { id: listId });
    input.value = o.value || '';
    input.addEventListener('change', () => o.onChange?.(input.value));
    target.append(input, list);
    const load = async () => {
        if (o.connection?.kind === 'image') return;
        const c = state.settings.connection;
        const models = await api.post('models', connectionRequest(c)).catch(() => []);
        list.replaceChildren(...(models || []).slice(0, 500).map(m => el('option', { value: m.id || m })));
    };
    load();
    const h = fieldHandle(input, () => input.value, v => { input.value = v || ''; });
    h.refresh = load;
    h.destroy = () => { input.remove(); list.remove(); };
    return h;
}

// ---------------------------------------------------------------- ctx
const mountRoots = new Map(); // `${ext}:${point}` -> element
export const settingsMounts = () => [...mountRoots.entries()].filter(([k]) => k.endsWith(':settings_extensions'));

/**
 * @param {{ id: string, manifest: object, granted: string[] }} ext
 * @param {{ send(payload): void, onMessage(fn): () => void }} channel
 */
export function createCtx(ext, channel) {
    const disposers = [];
    const track = fn => { disposers.push(fn); return fn; };
    const injected = new Set();
    const styles = new Set();
    const created = new Set();
    const id = ext.id;

    const ctx = {
        manifest: structuredClone(ext.manifest),
        extensionId: id,
        host: { name: 'reverie', version: '1.2.0', capabilities: {} },
        deferReady() {},
        ready() {},

        sendToBackend: payload => channel.send(payload),
        onBackendMessage: fn => track(channel.onMessage(fn)),

        getActiveChat: () => ({ chatId: activeChatId(), characterId: state.character?.id || null }),

        permissions: {
            getGranted: async () => [...ext.granted],
            request: async perms => {
                const missing = (perms || []).filter(p => !ext.granted.includes(p));
                if (missing.length) throw new Error(`Reverie can't grant: ${missing.join(', ')}`);
                return [...ext.granted];
            },
            has: p => ext.granted.includes(p),
        },

        events: {
            on: (name, fn) => track(onLumiverse(name, fn)),
            emit(name, payload) {
                if (name === 'open-settings') import('../panels/settings.js').then(m => m.openSettings(payload?.view === 'extensions' ? 'extensions' : undefined));
                window.dispatchEvent(new CustomEvent(`spindle:${name}`, { detail: payload }));
            },
        },

        messages: {
            getLatestMessageId: () => (state.chat.length ? messageId(state.chat.at(-1)) : null),
            registerTagInterceptor(opts = {}, handler) {
                const entry = { ext: id, tagName: String(opts.tagName || '').trim().toLowerCase(), attrs: opts.attrs || null, remove: opts.removeFromMessage !== false, handler };
                if (!entry.tagName) throw new Error('tagName is required');
                tagInterceptors.add(entry);
                seenTags.clear();
                if (state.chat.length) queueMicrotask(printMessages);
                return track(() => { tagInterceptors.delete(entry); });
            },
        },

        dom: {
            addStyle(css) {
                const style = el('style', { 'data-lv-ext': id });
                style.textContent = String(css ?? '');
                document.head.append(style);
                styles.add(style);
                return () => { style.remove(); styles.delete(style); };
            },
            createElement(tag, attrs = {}) {
                const node = document.createElement(tag);
                for (const [k, v] of Object.entries(attrs || {})) if (v != null) node.setAttribute(k, String(v));
                node.dataset.lvExt = id;
                created.add(node);
                return node;
            },
            inject(target, html, position = 'beforeend') {
                const host = typeof target === 'string' ? document.querySelector(target) : target;
                if (!host) return null;
                const wrapper = el('div', { 'data-spindle-ext': id, class: 'lv-injected' });
                wrapper.innerHTML = sanitize(html);
                host.insertAdjacentElement(position, wrapper);
                injected.add(wrapper);
                const mesNode = host.closest?.('[data-message-id]');
                if (mesNode) injections.add({ ext: id, wrapper, messageId: mesNode.getAttribute('data-message-id'), inText: !!host.closest('.mes_text'), position });
                return wrapper;
            },
            uninject(wrapper) {
                wrapper?.remove?.();
                injected.delete(wrapper);
                for (const inj of injections) if (inj.wrapper === wrapper) injections.delete(inj);
            },
            findMessageElement: mid => document.querySelector(`#chat [data-message-id="${CSS.escape(String(mid))}"]`),
            listMessageElements: () => [...document.querySelectorAll('#chat [data-message-id]')].map(element => ({ messageId: element.getAttribute('data-message-id'), element })),
            cleanup() {
                for (const w of injected) w.remove();
                injected.clear();
                for (const inj of [...injections]) if (inj.ext === id) injections.delete(inj);
                for (const s of styles) s.remove();
                styles.clear();
                for (const n of created) n.remove();
                created.clear();
            },
        },

        ui: {
            registerDrawerTab(opts = {}) {
                const root = el('div', { class: 'lv-drawer-root', 'data-spindle-drawer-tab': `${id}:${opts.id}` });
                const tabId = `lv:${id}:${opts.id}`;
                const activate = new Set();
                const def = {
                    id: tabId, title: opts.title || opts.id, shortName: opts.shortName, ext: id,
                    iconSvg: opts.iconSvg ? sanitize(opts.iconSvg) : null, iconUrl: opts.iconUrl || null,
                    render(container) {
                        container.classList.add('lv-drawer-container');
                        container.append(root);
                        for (const fn of activate) { try { fn(); } catch (err) { console.error(err); } }
                    },
                };
                const remove = points.sheetTabs.add(def);
                pointsChanged('sheetTabs');
                const destroy = () => { remove(); pointsChanged('sheetTabs'); root.remove(); };
                track(destroy);
                return {
                    root, tabId,
                    setTitle: t => { def.title = t; pointsChanged('sheetTabs'); },
                    setShortName: t => { def.shortName = t; pointsChanged('sheetTabs'); },
                    setBadge: () => {},
                    activate: () => openSheetTab(tabId),
                    onActivate: fn => { activate.add(fn); return () => activate.delete(fn); },
                    destroy,
                };
            },
            registerInputBarAction(opts = {}) {
                const handlers = new Set();
                const def = { id: `lv:${id}:${opts.id}`, label: opts.label || opts.id, iconSvg: opts.iconSvg ? sanitize(opts.iconSvg) : null, iconUrl: opts.iconUrl || null, onClick: () => handlers.forEach(fn => fn()) };
                let remove = opts.enabled === false ? () => {} : points.menuItems.add(def);
                pointsChanged('menuItems');
                const destroy = () => { remove(); pointsChanged('menuItems'); };
                track(destroy);
                return {
                    actionId: def.id,
                    setLabel: l => { def.label = l; pointsChanged('menuItems'); },
                    setSubtitle: () => {},
                    setEnabled: on => { remove(); remove = on ? points.menuItems.add(def) : () => {}; pointsChanged('menuItems'); },
                    onClick: fn => { handlers.add(fn); return () => handlers.delete(fn); },
                    destroy,
                };
            },
            showModal: opts => makeModal(opts, track),
            showConfirm: async (opts = {}) => ({ confirmed: !!(await confirmDialog(opts.message || '', { title: opts.title || ext.manifest.name, okLabel: opts.confirmLabel, danger: opts.variant === 'danger' })) }),
            showContextMenu: opts => contextMenu(opts),
            createFloatWidget: opts => floatWidget({ ...opts, __ext: id }, track),
            requestDockPanel: opts => dockPanel(opts, track),
            mount(point) {
                const key = `${id}:${point}`;
                if (!mountRoots.has(key)) {
                    const node = el('div', { class: 'lv-mount', 'data-spindle-mount-point': point, 'data-lv-ext': id });
                    mountRoots.set(key, node);
                    track(() => { node.remove(); mountRoots.delete(key); });
                    if (point === 'sidebar') ctx.ui.registerDrawerTab({ id: 'sidebar', title: ext.manifest.name }).root.append(node);
                }
                return mountRoots.get(key);
            },
            mountApp(opts = {}) {
                const root = el('div', { class: `lv-app ${opts.className || ''}`, 'data-lv-ext': id });
                document.body.append(root);
                const destroy = () => root.remove();
                track(destroy);
                return { root, mountId: `lva-${Math.random().toString(36).slice(2, 8)}`, setVisible: v => { root.style.display = v ? '' : 'none'; }, destroy };
            },
            geometry: { toLayoutPx: px => px, fromLayoutPx: px => px },
            events: {
                getDrawerState: () => sheetState(),
                onDrawerChange(fn) {
                    const h = e => fn({ open: e.detail.open, tabId: e.detail.tabId });
                    window.addEventListener('rv:sheet', h);
                    return track(() => window.removeEventListener('rv:sheet', h));
                },
                getKeyboardState: () => keyboardState(),
                onKeyboardChange(fn) {
                    const h = () => fn(keyboardState());
                    window.visualViewport?.addEventListener('resize', h);
                    return track(() => window.visualViewport?.removeEventListener('resize', h));
                },
                getSettingsState: () => ({ open: !!document.getElementById('right-nav-panel')?.classList.contains('open') }),
                onSettingsChange: () => () => {},
            },
            requestTabLocation() {},
        },

        uploads: {
            pickFile(opts = {}) {
                return new Promise((resolve, reject) => {
                    const input = el('input', { type: 'file', accept: (opts.accept || []).join(','), multiple: !!opts.multiple, style: { display: 'none' } });
                    input.onchange = async () => {
                        const files = [...input.files];
                        input.remove();
                        try {
                            const out = [];
                            for (const f of files) {
                                if (opts.maxSizeBytes && f.size > opts.maxSizeBytes) throw new Error(`${f.name} is too large`);
                                out.push({ name: f.name, mimeType: f.type || 'application/octet-stream', sizeBytes: f.size, bytes: new Uint8Array(await f.arrayBuffer()) });
                            }
                            resolve(out);
                        } catch (err) { reject(err); }
                    };
                    input.oncancel = () => { input.remove(); resolve([]); };
                    document.body.append(input);
                    input.click();
                });
            },
        },

        components: {
            mountSelect,
            mountSwitch,
            mountNumericInput: (t, o) => mountInput(t, o, 'number'),
            mountTextInput: (t, o) => mountInput(t, o, 'text'),
            mountTextArea: (t, o) => mountInput(t, o, 'textarea'),
            mountRangeSlider: mountRange,
            mountModelCombobox,
        },

        theme: {
            catalog: { listComponents: async () => [], listVariables: async () => [] },
            assets: { list: async () => [], getActiveBundleId: async () => null },
            packs: {},
            openEditor: async () => { (await import('../panels/settings.js')).openSettings('appearance'); return true; },
        },
    };

    return {
        ctx,
        dispose() {
            for (const fn of disposers.splice(0).reverse()) { try { fn(); } catch (err) { console.error(err); } }
            ctx.dom.cleanup();
            for (const t of [...tagInterceptors]) if (t.ext === id) tagInterceptors.delete(t);
        },
    };
}

function keyboardState() {
    const vv = window.visualViewport;
    const inset = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
    return { visible: inset > 120, insetBottom: inset, viewportWidth: vv?.width || innerWidth, viewportHeight: vv?.height || innerHeight };
}
