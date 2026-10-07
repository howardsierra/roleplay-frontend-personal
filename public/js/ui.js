// Small UI kit: element builder, toasts, modals, drawers, file picking.

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'html') node.innerHTML = v;
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

export const icon = (name, extra = '') => el('i', { class: `fa-solid fa-${name} ${extra}`.trim() });

export function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- toasts ----------------
export function toast(message, type = 'info', { title = '', timeout = 3800 } = {}) {
    const root = document.getElementById('toast-container');
    const icons = { info: 'circle-info', success: 'circle-check', warning: 'triangle-exclamation', error: 'circle-xmark' };
    const node = el('div', { class: `toast toast-${type}`, role: 'status' },
        icon(icons[type] || 'circle-info'),
        el('div', { class: 'toast-body' }, title ? el('strong', {}, title) : null, el('div', { html: escapeHtml(message).replace(/\n/g, '<br>') })));
    node.addEventListener('click', () => dismiss());
    root.append(node);
    requestAnimationFrame(() => node.classList.add('show'));
    const dismiss = () => {
        node.classList.remove('show');
        setTimeout(() => node.remove(), 300);
    };
    if (timeout) setTimeout(dismiss, type === 'error' ? Math.max(timeout, 7000) : timeout);
    return node;
}

// toastr-compatible global used by SillyTavern extensions.
export const toastr = {
    info: (msg, title, o) => toast(msg, 'info', { title, ...o }),
    success: (msg, title, o) => toast(msg, 'success', { title, ...o }),
    warning: (msg, title, o) => toast(msg, 'warning', { title, ...o }),
    error: (msg, title, o) => toast(msg, 'error', { title, ...o }),
    clear: () => document.getElementById('toast-container').replaceChildren(),
    remove: node => node?.remove?.(),
    options: {},
};

// ---------------- modals ----------------
let modalDepth = 0;

/**
 * Opens a modal. `content` is a Node or HTML string.
 * buttons: [{ label, value, primary, danger }] — resolves with the clicked value (or null on dismiss).
 */
export function modal({ title = '', content = '', buttons = [{ label: 'Close', value: true, primary: true }], wide = false, onOpen, className = '', dismissable = true } = {}) {
    return new Promise(resolve => {
        const root = document.getElementById('modal-root');
        const body = el('div', { class: 'modal-body' });
        if (content instanceof Node) body.append(content);
        else body.innerHTML = content;
        const footer = el('div', { class: 'modal-footer' });
        const wrap = el('div', { class: `modal-wrap ${className}`, style: { zIndex: 1000 + modalDepth * 10 } });
        const box = el('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
            title ? el('div', { class: 'modal-head' }, el('h3', {}, title), el('button', { class: 'icon-btn', title: 'Close', onclick: () => close(null) }, icon('xmark'))) : null,
            body, buttons.length ? footer : null);
        wrap.append(box);
        let done = false;
        const close = value => {
            if (done) return;
            done = true;
            modalDepth--;
            wrap.classList.remove('open');
            document.removeEventListener('keydown', onKey);
            setTimeout(() => wrap.remove(), 220);
            resolve(typeof value === 'function' ? value() : value);
        };
        for (const b of buttons) {
            footer.append(el('button', {
                class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`,
                onclick: () => close(typeof b.value === 'function' ? b.value(body) : b.value),
            }, b.icon ? icon(b.icon) : null, b.label));
        }
        const onKey = e => {
            if (e.key === 'Escape' && dismissable) close(null);
        };
        wrap.addEventListener('mousedown', e => {
            if (e.target === wrap && dismissable) close(null);
        });
        document.addEventListener('keydown', onKey);
        root.append(wrap);
        modalDepth++;
        requestAnimationFrame(() => wrap.classList.add('open'));
        onOpen?.(body, close);
    });
}

export async function confirmDialog(message, { title = 'Are you sure?', okLabel = 'Confirm', danger = false } = {}) {
    return !!(await modal({
        title,
        content: el('p', {}, message),
        buttons: [{ label: 'Cancel', value: false }, { label: okLabel, value: true, primary: !danger, danger }],
    }));
}

export async function promptDialog(message, defaultValue = '', { title = '', multiline = false, placeholder = '' } = {}) {
    const input = multiline
        ? el('textarea', { class: 'input', rows: 8, placeholder })
        : el('input', { class: 'input', type: 'text', placeholder });
    input.value = defaultValue;
    const result = await modal({
        title,
        content: el('div', { class: 'stack' }, message ? el('p', {}, message) : null, input),
        buttons: [{ label: 'Cancel', value: null }, { label: 'OK', value: () => input.value, primary: true }],
        onOpen: (_body, close) => {
            setTimeout(() => input.focus(), 50);
            if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); close(input.value); } });
        },
    });
    return result;
}

// ---------------- file picking ----------------
export function pickFile(accept = '*', { multiple = false } = {}) {
    return new Promise(resolve => {
        const input = document.getElementById('file-picker');
        input.value = '';
        input.accept = accept;
        input.multiple = multiple;
        input.onchange = () => resolve(multiple ? [...input.files] : input.files[0] || null);
        input.click();
    });
}

export function download(filename, data, type = 'application/json') {
    const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Convert any image file to a PNG blob (so exported cards always carry the avatar). */
export async function toPngBlob(file, maxSize = 1024) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxSize / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

// ---------------- drawers ----------------
const drawers = new Set();
export function openDrawer(id) {
    const node = document.getElementById(id);
    for (const other of drawers) if (other !== node) closeDrawer(other.id);
    node.classList.add('open');
    node.setAttribute('aria-hidden', 'false');
    drawers.add(node);
    document.getElementById('scrim').classList.add('show');
}

export function closeDrawer(id) {
    const node = document.getElementById(id);
    node.classList.remove('open');
    node.setAttribute('aria-hidden', 'true');
    drawers.delete(node);
    if (!drawers.size) document.getElementById('scrim').classList.remove('show');
}

export function toggleDrawer(id) {
    const node = document.getElementById(id);
    if (node.classList.contains('open')) closeDrawer(id);
    else openDrawer(id);
}

export function closeAllDrawers() {
    for (const node of [...drawers]) closeDrawer(node.id);
}

export const isMobile = () => window.matchMedia('(max-width: 820px)').matches || /Android|iPhone|iPad/i.test(navigator.userAgent);

export function debounce(fn, ms = 300) {
    let t;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

// ---------------- form helpers ----------------
export function field(label, input, hint) {
    return el('label', { class: 'field' }, el('span', { class: 'field-label' }, label), input, hint ? el('small', { class: 'hint' }, hint) : null);
}

export function textInput(value, onInput, attrs = {}) {
    const input = el('input', { class: 'input', type: 'text', ...attrs });
    input.value = value ?? '';
    input.addEventListener('input', () => onInput(input.value));
    return input;
}

export function textArea(value, onInput, attrs = {}) {
    const input = el('textarea', { class: 'input', rows: 4, ...attrs });
    input.value = value ?? '';
    input.addEventListener('input', () => onInput(input.value));
    return input;
}

export function select(options, value, onChange, attrs = {}) {
    const node = el('select', { class: 'input', ...attrs });
    for (const opt of options) {
        const [v, label] = Array.isArray(opt) ? opt : [opt.value ?? opt, opt.label ?? opt];
        const o = el('option', { value: v }, label);
        if (String(v) === String(value)) o.selected = true;
        node.append(o);
    }
    node.addEventListener('change', () => onChange(node.value));
    return node;
}

export function toggle(label, checked, onChange, hint) {
    const input = el('input', { type: 'checkbox', class: 'switch-input' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'toggle-row' },
        el('span', { class: 'toggle-text' }, el('span', {}, label), hint ? el('small', { class: 'hint' }, hint) : null),
        el('span', { class: 'switch' }, input, el('span', { class: 'switch-track' })));
}

/** Slider + number input pair. */
export function slider(label, value, { min = 0, max = 1, step = 0.01, onChange, hint } = {}) {
    const range = el('input', { type: 'range', min, max, step, class: 'range' });
    const number = el('input', { type: 'number', min, max, step, class: 'input num' });
    range.value = number.value = value ?? 0;
    const sync = v => {
        range.value = number.value = v;
        range.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
        onChange?.(Number(v));
    };
    range.addEventListener('input', () => sync(range.value));
    number.addEventListener('change', () => sync(number.value));
    range.style.setProperty('--fill', `${((value - min) / (max - min)) * 100}%`);
    return el('div', { class: 'slider-field' },
        el('div', { class: 'slider-head' }, el('span', { class: 'field-label' }, label), number),
        range, hint ? el('small', { class: 'hint' }, hint) : null);
}

export function section(title, ...children) {
    return el('section', { class: 'panel-section' }, title ? el('h4', { class: 'section-title' }, title) : null, ...children);
}

export function readFileText(file) {
    return file.text();
}
