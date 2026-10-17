// Two quick pickers in the top bar:
// - Characters (👥): every character as a gallery, with search, tag filters and sorting.
// - Stories (the "Reverie" title on Home): recent chats across all characters, to jump straight back in.
// The sidebar itself has its own ☰ button.
import { api } from './api.js';
import { state } from './state.js';
import { el, icon, modal, debounce } from './ui.js';

const avatarUrl = file => (file ? `files/avatars/${encodeURIComponent(file)}` : 'icons/icon.svg');

function timeAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
}

const SORTS = [
    ['recent', 'Recently played'],
    ['name', 'Name (A–Z)'],
    ['new', 'Newest added'],
];

export async function openCharacterBrowser() {
    const chars = await import('./characters.js');
    const prefs = (() => { try { return JSON.parse(localStorage.getItem('rv-browser') || '{}'); } catch { return {}; } })();
    let sort = prefs.sort || 'recent';
    let tag = '';
    let favOnly = false;
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search by name, tag or creator…', autocomplete: 'off' });
    const grid = el('div', { class: 'char-grid browser-grid' });
    const tagRow = el('div', { class: 'chip-row browser-tags' });
    const count = el('span', { class: 'hint browser-count' });
    let close = () => {};
    // Select mode: tap tiles to pick several, then delete them together.
    let selecting = false;
    const picked = new Set();
    const selectBar = el('div', { class: 'browser-select-bar hidden' });
    const paintSelectBar = () => {
        selectBar.classList.toggle('hidden', !selecting);
        grid.classList.toggle('selecting', selecting);
        selectBtn.classList.toggle('active', selecting);
        selectBar.replaceChildren(
            el('span', { class: 'grow' }, picked.size ? `${picked.size} selected` : 'Tap characters to select them'),
            el('button', { class: 'btn small', onclick: () => { grid.querySelectorAll('.char-tile').forEach(t => picked.add(t.dataset.id)); paint(); } }, 'Select all shown'),
            el('button', { class: 'btn small', onclick: () => { selecting = false; picked.clear(); paint(); } }, 'Cancel'),
            el('button', { class: 'btn small danger', disabled: !picked.size, onclick: async () => {
                if (await chars.deleteCharacters([...picked])) { picked.clear(); selecting = false; paint(); }
            } }, icon('trash-can'), picked.size ? `Delete ${picked.size}` : 'Delete'));
    };
    const selectBtn = el('button', { class: 'btn', title: 'Select characters to delete', onclick: () => { selecting = !selecting; picked.clear(); paint(); } }, icon('square-check'), el('span', {}, 'Select'));

    const allTags = () => {
        const counts = new Map();
        for (const c of state.characters) for (const t of c.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24).map(([t]) => t);
    };
    const paintTags = () => tagRow.replaceChildren(
        el('button', { class: `chip toggle-chip${favOnly ? ' active' : ''}`, onclick: () => { favOnly = !favOnly; paint(); } }, icon('star'), 'Favourites'),
        ...allTags().map(t => el('button', { class: `chip toggle-chip${tag === t ? ' active' : ''}`, onclick: () => { tag = tag === t ? '' : t; paint(); } }, t)));

    const paint = () => {
        const q = search.value.trim().toLowerCase();
        let list = state.characters.filter(c => (!q || c.name.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q)) || (c.creator || '').toLowerCase().includes(q))
            && (!tag || (c.tags || []).includes(tag)) && (!favOnly || c.fav));
        list = [...list].sort(sort === 'name' ? (a, b) => a.name.localeCompare(b.name)
            : sort === 'new' ? (a, b) => (b.created || b.updated || 0) - (a.created || a.updated || 0)
                : (a, b) => (b.fav - a.fav) || ((b.lastChat || b.updated) - (a.lastChat || a.updated)));
        grid.replaceChildren(...list.map(c => {
            const tile = chars.cardTile(c, { onPick: one => {
                if (!selecting) { close(); chars.showCharacterProfile(one.id); return; }
                picked.has(one.id) ? picked.delete(one.id) : picked.add(one.id);
                tile.classList.toggle('picked', picked.has(one.id));
                paintSelectBar();
            } });
            tile.classList.toggle('picked', picked.has(c.id));
            return tile;
        }));
        paintSelectBar();
        if (!list.length) grid.append(el('div', { class: 'empty wide' }, state.characters.length ? 'No characters match.' : 'No characters yet. Import a card or create one.'));
        count.textContent = `${list.length} of ${state.characters.length}`;
        paintTags();
    };
    search.addEventListener('input', debounce(paint, 120));

    const sortSel = el('select', { class: 'input browser-sort', onchange: e => { sort = e.target.value; try { localStorage.setItem('rv-browser', JSON.stringify({ sort })); } catch { /* fine */ } paint(); } },
        ...SORTS.map(([v, l]) => el('option', { value: v, selected: v === sort }, l)));

    modal({
        title: 'Characters',
        wide: true,
        className: 'browser-modal',
        content: el('div', { class: 'stack' },
            el('div', { class: 'browser-bar' },
                el('label', { class: 'gsearch-box browser-search' }, icon('magnifying-glass'), search),
                sortSel,
                selectBtn,
                el('button', { class: 'btn', onclick: () => { close(); chars.importCharacter(); } }, icon('file-import'), el('span', {}, 'Import')),
                el('button', { class: 'btn primary', onclick: () => { close(); chars.createCharacter(); } }, icon('plus'), el('span', {}, 'Create')),
                state.characters.some(c => c.assistant) ? null
                    : el('button', { class: 'btn', title: 'Add Reverie’s built-in Assistant back', onclick: async () => {
                        const { api } = await import('./api.js');
                        await api.post('characters/assistant', {});
                        await chars.loadCharacters();
                        close();
                        openCharacterBrowser();
                    } }, icon('wand-magic-sparkles'), el('span', {}, 'Add the Assistant'))),
            el('div', { class: 'browser-meta' }, tagRow, count),
            selectBar,
            grid),
        buttons: [],
        onOpen: (_b, c) => { close = c; paint(); if (!matchMedia('(hover: none)').matches) setTimeout(() => search.focus(), 50); },
    });
}

export async function openStorySwitcher() {
    const list = el('div', { class: 'story-switch-list' }, el('div', { class: 'loading-row' }, el('span', { class: 'rv-dots' }, el('span'), el('span'), el('span'))));
    let close = () => {};
    modal({
        title: 'Your stories',
        className: 'story-switch-modal',
        content: el('div', { class: 'stack' },
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn primary', onclick: () => { close(); document.querySelector('[data-action="new-story"]')?.click(); } }, icon('feather-pointed'), 'New story'),
                el('button', { class: 'btn', onclick: () => { close(); import('./search.js').then(m => m.openGlobalSearch()); } }, icon('magnifying-glass'), 'Search all stories'),
                el('button', { class: 'btn', onclick: () => { close(); openCharacterBrowser(); } }, icon('users'), 'Characters')),
            list),
        buttons: [],
        onOpen: (_b, c) => { close = c; },
    });
    let recent = [];
    try { recent = await api.get('chats?limit=40'); } catch { /* offline */ }
    list.replaceChildren(...recent.map(item => el('button', { class: 'story-switch-row', onclick: async () => {
        close();
        const { openCharacter } = await import('./characters.js');
        openCharacter(item.charId, { chatId: item.chatId });
    } },
    el('img', { src: avatarUrl(item.avatar), alt: '', loading: 'lazy' }),
    el('div', { class: 'story-switch-text' },
        el('div', { class: 'story-switch-head' }, el('b', {}, item.charName || 'Unknown'), el('span', {}, timeAgo(item.updated))),
        el('div', { class: 'story-switch-chat' }, item.chatId),
        el('div', { class: 'story-switch-preview' }, item.preview || '…')))));
    if (!recent.length) list.append(el('div', { class: 'empty' }, 'No stories yet. Pick a character to begin.'));
}
