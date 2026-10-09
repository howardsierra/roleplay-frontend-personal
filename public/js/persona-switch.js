// Persona quick switch: your persona's avatar beside the composer; tap it to switch persona
// without opening the Persona Manager. (Reverie's take on SillyTavern's Quick Persona.)
import { state } from './state.js';
import { eventSource, event_types } from './events.js';
import { el, icon } from './ui.js';
import { allPersonas, activePersona, setActivePersona, isPersonaLocked, defaultPersonaId } from './personas.js';

let button = null;
const avatarOf = p => p?.avatar || 'icons/user.svg';

function paint() {
    if (!button) return;
    const p = activePersona();
    button.replaceChildren(el('img', { src: avatarOf(p), alt: '' }));
    button.title = p ? `You are ${p.name}${p.title ? ` — ${p.title}` : ''}. Tap to switch.` : 'Choose a persona';
}

function close() {
    document.querySelector('.persona-switch-pop')?.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
}
const onOutside = e => { if (!e.target.closest('.persona-switch-pop, #persona-switch')) close(); };
const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

function open() {
    if (document.querySelector('.persona-switch-pop')) return close();
    const current = activePersona();
    const recent = state.settings.extension_settings?.aevPersonaManager?.lastUsed || {};
    const list = [...allPersonas()].sort((a, b) => (b.id === current?.id) - (a.id === current?.id) || (recent[b.id] || 0) - (recent[a.id] || 0) || a.name.localeCompare(b.name));
    const search = el('input', { class: 'input persona-switch-search', type: 'search', placeholder: 'Find a persona…' });
    const items = el('div', { class: 'persona-switch-list', role: 'listbox' });
    const render = () => {
        const q = search.value.trim().toLowerCase();
        items.replaceChildren(...list.filter(p => !q || `${p.name} ${p.title || ''}`.toLowerCase().includes(q)).map(p => el('button', {
            class: `persona-switch-item${p.id === current?.id ? ' active' : ''}`, role: 'option', 'aria-selected': String(p.id === current?.id),
            onclick: async () => { close(); await setActivePersona(p.id, { quiet: false }); },
        },
        el('img', { src: avatarOf(p), alt: '', loading: 'lazy' }),
        el('span', { class: 'persona-switch-text' }, el('b', {}, p.name || 'Unnamed'), p.title ? el('small', {}, p.title) : null),
        p.id === defaultPersonaId() ? icon('crown', 'persona-switch-badge') : null,
        p.id === current?.id ? icon('circle-check', 'persona-switch-badge') : null)));
    };
    search.addEventListener('input', render);
    render();
    const locked = ['chat', 'character'].filter(t => isPersonaLocked(t));
    const pop = el('div', { class: 'persona-switch-pop' },
        list.length > 6 ? search : null,
        items,
        locked.length ? el('div', { class: 'persona-switch-note' }, icon('lock'), ` ${current?.name} is locked to this ${locked.join(' and ')}. Switching won't change the lock.`) : null,
        el('button', { class: 'persona-switch-manage', onclick: () => { close(); import('./persona-manager/index.js').then(m => m.openManager()); } }, icon('user-gear'), 'Manage personas…'));
    document.body.append(pop);
    const r = button.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left))}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
    requestAnimationFrame(() => pop.classList.add('open'));
    if (list.length > 6 && !matchMedia('(pointer: coarse)').matches) search.focus();
    setTimeout(() => {
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    });
}

export function bindPersonaSwitch() {
    const host = document.getElementById('leftSendForm');
    if (!host || document.getElementById('persona-switch')) return;
    button = el('button', { id: 'persona-switch', class: 'icon-btn persona-switch', type: 'button', 'aria-haspopup': 'listbox', onclick: open });
    host.prepend(button);
    paint();
    for (const ev of [event_types.PERSONA_CHANGED, event_types.PERSONA_UPDATED, event_types.PERSONA_CREATED, event_types.PERSONA_DELETED, event_types.SETTINGS_UPDATED]) eventSource.on(ev, paint);
}
