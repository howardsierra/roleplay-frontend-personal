// Settings drawer with tabs. Each tab module exports `render(body)`.
import { el, openDrawer } from '../ui.js';

const TABS = [
    { id: 'connection', label: 'Connection', icon: 'plug', load: () => import('./connection.js') },
    { id: 'preset', label: 'Preset', icon: 'sliders', load: () => import('./preset.js') },
    { id: 'persona', label: 'Persona', icon: 'user-astronaut', load: () => import('./persona.js') },
    { id: 'lore', label: 'Lorebooks', icon: 'book-atlas', load: () => import('./lore.js') },
    { id: 'regex', label: 'Regex', icon: 'code', load: () => import('./regex.js') },
    { id: 'images', label: 'Images', icon: 'palette', load: () => import('./images.js') },
    { id: 'appearance', label: 'Look', icon: 'brush', load: () => import('./appearance.js') },
    { id: 'extensions', label: 'Extensions', icon: 'puzzle-piece', load: () => import('./extensions.js') },
    { id: 'advanced', label: 'More', icon: 'gear', load: () => import('./advanced.js') },
];

let current = null;

export function initSettings() {
    const nav = document.getElementById('settings-tabs');
    nav.replaceChildren(...TABS.map(t => el('button', { class: 'tab', 'data-tab': t.id, title: t.label, onclick: () => showTab(t.id) },
        el('i', { class: `fa-solid fa-${t.icon}` }), el('span', {}, t.label))));
}

export async function showTab(id) {
    const tab = TABS.find(t => t.id === id) || TABS[0];
    const body = document.getElementById('settings-body');
    // Park the extension settings host back in the drawer before re-rendering.
    const host = document.getElementById('extensions_settings_host');
    if (host.parentElement !== document.getElementById('right-nav-panel')) {
        host.classList.add('hidden');
        document.getElementById('right-nav-panel').append(host);
    }
    // SillyTavern blocks that extensions decorate are parked in #st-dom when their tab isn't shown.
    for (const block of document.querySelectorAll('[data-st-park]')) {
        if (block.parentElement?.id !== 'st-dom') document.getElementById('st-dom').append(block);
    }
    current = tab.id;
    document.querySelectorAll('#settings-tabs .tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab.id));
    document.getElementById('settings-title').textContent = tab.label;
    body.replaceChildren(el('div', { class: 'loading-row' }, el('span', { class: 'rv-dots' }, el('span'), el('span'), el('span'))));
    const mod = await tab.load();
    if (current !== tab.id) return;
    body.replaceChildren();
    body.scrollTop = 0;
    await mod.render(body);
    localStorage.setItem('rv-settings-tab', tab.id);
}

export function openSettings(tabId) {
    openDrawer('right-nav-panel');
    showTab(tabId || current || localStorage.getItem('rv-settings-tab') || 'connection');
}

export function rerender() {
    if (current) showTab(current);
}
