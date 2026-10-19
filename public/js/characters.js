// Character library, editor, and chat management.
import { bannerControls, KEY as BANNER_KEY } from './avatar-banner.js';
import { api } from './api.js';
import { state, saveSettingsDebounced, saveChat, userName, charName } from './state.js';
import { eventSource, event_types } from './events.js';
import { substituteParams } from './macros.js';
import { printMessages, clearChat, nowDate } from './chat.js';
import { applyTheme } from './themes.js';
import { el, icon, toast, modal, confirmDialog, promptDialog, pickFile, closeAllDrawers, toPngBlob, download, escapeHtml, field, textArea, textInput, select } from './ui.js';
import { normalizeWorld } from './worldinfo.js';

const avatarUrl = c => (c?.avatar ? `files/avatars/${encodeURIComponent(c.avatar)}` : 'icons/icon.svg');

export async function loadCharacters() {
    state.characters = await api.get('characters');
    renderLibrary();
}

// ---------------- library ----------------
export function cardTile(c, { compact = false, onPick } = {}) {
    const tile = el('button', { class: `char-tile${compact ? ' compact' : ''}${state.character?.id === c.id ? ' active' : ''}`, 'data-id': c.id, title: c.name },
        el('div', { class: 'char-tile-img', style: { backgroundImage: `url("${avatarUrl(c)}")` } }),
        el('div', { class: 'char-tile-info' },
            el('div', { class: 'char-tile-name' }, c.fav ? icon('star', 'fav-star') : null, c.name),
            compact ? el('div', { class: 'char-tile-notes' }, c.notes || (c.tags || []).slice(0, 4).join(' · ')) : el('div', { class: 'char-tile-tags' }, (c.tags || []).slice(0, 3).map(t => el('span', { class: 'tag' }, t)))));
    let held = 0;
    let skipClick = false;
    let touch = false;
    tile.addEventListener('click', e => {
        if (skipClick) { skipClick = false; e.preventDefault(); return; }
        onPick ? onPick(c) : showCharacterProfile(c.id);
    });
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        // On touch the hold timer below opens the menu (Android also sends contextmenu: don't open it twice).
        if (touch || tile.closest('.selecting')) return;
        characterMenu(tile, c);
    });
    // Touch: hold for the same menu.
    tile.addEventListener('pointerdown', e => {
        touch = e.pointerType === 'touch';
        skipClick = false; // Android sends no click after a long press: don't swallow the next real tap
        if (!touch || tile.closest('.selecting')) return;
        held = setTimeout(() => { skipClick = true; navigator.vibrate?.(15); characterMenu(tile, c); }, 550);
    });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) tile.addEventListener(ev, () => clearTimeout(held));
    return tile;
}

export function renderLibrary() {
    const q = (document.getElementById('char-search')?.value || '').trim().toLowerCase();
    const list = state.characters.filter(c => !q || c.name.toLowerCase().includes(q) || (c.tags || []).some(t => t.toLowerCase().includes(q)) || (c.creator || '').toLowerCase().includes(q));
    const sorted = [...list].sort((a, b) => (b.fav - a.fav) || ((b.lastChat || b.updated) - (a.lastChat || a.updated)));
    const side = document.getElementById('rm_print_characters_block');
    side.replaceChildren(...sorted.map(c => cardTile(c, { compact: true })));
    if (!sorted.length) side.append(el('div', { class: 'empty' }, state.characters.length ? 'No matches.' : 'No characters yet — import a card to start.'));
    const hq = (document.getElementById('home-search')?.value || '').trim().toLowerCase();
    const homeList = [...state.characters].filter(c => !hq || c.name.toLowerCase().includes(hq) || (c.tags || []).some(t => t.toLowerCase().includes(hq)))
        .sort((a, b) => (b.fav - a.fav) || ((b.lastChat || b.updated) - (a.lastChat || a.updated)));
    const grid = document.getElementById('home-grid');
    grid.replaceChildren(...homeList.map(c => cardTile(c)));
    if (hq && !homeList.length) grid.append(el('div', { class: 'empty wide' }, 'No characters match.'));
    else if (!homeList.length) grid.append(el('div', { class: 'empty wide' }, el('i', { class: 'fa-solid fa-masks-theater' }), el('p', {}, 'Your stage is empty. Import a SillyTavern / Chub character card (PNG or JSON) or create one.')));
}

// ---------------- open / chats ----------------
function greetingMessage() {
    const d = state.character.card.data;
    const greetings = [d.first_mes, ...(d.alternate_greetings || [])].filter(g => g !== undefined && g !== null && String(g).trim());
    if (!greetings.length) return null;
    const swipes = greetings.map(g => substituteParams(g));
    return {
        name: d.name,
        is_user: false,
        is_system: false,
        send_date: nowDate(),
        mes: swipes[0],
        swipes,
        swipe_id: 0,
        swipe_info: swipes.map(() => ({ send_date: nowDate(), extra: { rv_greeting: true } })),
        extra: { rv_greeting: true },
    };
}

/**
 * The greeting has {{user}} filled in when the chat starts. If you switch persona before replying (or a
 * persona lock switches it as the chat opens), write it again with the new name, unless you edited it.
 */
export function refreshGreeting() {
    const first = state.chat[0];
    if (!state.character || !first || first.is_user || !first.extra?.rv_greeting) return false;
    if (state.chat.some(m => m.is_user) || first.extra?.rv_history?.length) return false;
    const fresh = greetingMessage();
    if (!fresh || fresh.swipes.length !== (first.swipes?.length || 1)) return false;
    first.swipes = fresh.swipes;
    first.mes = fresh.swipes[first.swipe_id ?? 0];
    return true;
}

/**
 * Leaving a chat while a reply is still being written: stop it first, so what arrived is saved to the chat
 * it belongs to (not the one you're switching to).
 */
async function settleGeneration() {
    if (!state.generating) return;
    const { stopGeneration } = await import('./chat.js');
    stopGeneration();
    for (let i = 0; i < 80 && state.generating; i++) await new Promise(r => setTimeout(r, 50));
    toast('Stopped the reply that was being written', 'info', { timeout: 2200 });
}

export async function openCharacter(id, { chatId, fresh = false } = {}) {
    await settleGeneration();
    await saveChat();
    const character = await api.get(`characters/${encodeURIComponent(id)}`);
    // Forget the old chat before switching character, so nothing can save it into the new character's folder.
    state.chatId = null;
    state.chat = [];
    state.chatMeta = {};
    state.character = character;
    document.body.classList.remove('no-character');
    closeAllDrawers();
    updateHeader();
    const chats = await api.get(`chats/${encodeURIComponent(id)}`);
    const target = chatId || localStorage.getItem(`rv-last-chat-${id}`) || chats[0]?.id;
    if (!fresh && target && chats.some(c => c.id === target)) await openChat(target);
    else await newChat();
    state.settings.lastCharacterId = id;
    saveSettingsDebounced();
    renderLibrary();
    applyTheme();
    // A card that brings its own regex scripts asks before they run (like SillyTavern).
    const { askRegexPermission, characterScripts } = await import('./regex.js');
    if (await askRegexPermission('character', { id, name: character.card.data.name, scripts: characterScripts(character) }) && state.character?.id === id) printMessages();
}

export function updateHeader() {
    const c = state.character;
    document.getElementById('chat-title-avatar').src = avatarUrl(c);
    document.getElementById('chat-title-name').textContent = c ? c.card.data.name : 'Reverie';
    document.getElementById('chat-title-sub').textContent = c ? (state.chatId || '') : (state.characters.length ? 'Your stories' : 'Pick a character to begin');
    document.title = c ? `${c.card.data.name} · Reverie` : 'Reverie';
}

export async function openChat(chatId) {
    await settleGeneration();
    await saveChat();
    const chat = await api.get(`chats/${encodeURIComponent(state.character.id)}/${encodeURIComponent(chatId)}`);
    state.chatId = chat.id;
    state.chatMeta = chat.meta || {};
    state.chatMeta.chat_metadata ??= {};
    state.chat = chat.messages || [];
    // Lines the server couldn't read are dropped on the next save; say so.
    if (chat.skipped) toast(`${chat.skipped} damaged line${chat.skipped === 1 ? '' : 's'} in this chat couldn't be read and will be left out when it's saved`, 'warning', { timeout: 8000 });
    printMessages();
    updateHeader();
    rememberChat();
    await eventSource.emit(event_types.CHAT_CHANGED, state.chatId);
    await eventSource.emit(event_types.CHAT_LOADED, { detail: { id: state.chatId, character: state.character.id } });
}

async function rememberChat() {
    const id = state.character.id;
    state.character.lastChatId = state.chatId;
    await api.put(`characters/${encodeURIComponent(id)}`, { lastChat: Date.now() }).catch(() => {});
    const c = state.characters.find(x => x.id === id);
    if (c) c.lastChat = Date.now();
    localStorage.setItem(`rv-last-chat-${id}`, state.chatId);
}

export async function newChat({ messages } = {}) {
    if (!state.character) return;
    await settleGeneration();
    await saveChat();
    const greeting = greetingMessage();
    const chat = await api.post(`chats/${encodeURIComponent(state.character.id)}`, {
        characterName: charName(),
        userName: userName(),
        messages: messages ?? (greeting ? [greeting] : []),
    });
    state.chatId = chat.id;
    state.chatMeta = chat.meta;
    state.chat = chat.messages;
    printMessages();
    updateHeader();
    rememberChat();
    await eventSource.emit(event_types.CHAT_CREATED);
    await eventSource.emit(event_types.CHAT_CHANGED, state.chatId);
    if (greeting && !messages) await eventSource.emit(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, 0);
}

/** Leave the current chat and return to the home screen. */
export async function closeChat() {
    await settleGeneration();
    await saveChat();
    state.character = null;
    state.chatId = null;
    state.chat = [];
    state.chatMeta = {};
    clearChat();
    document.body.classList.add('no-character');
    updateHeader();
    renderLibrary();
    applyTheme();
    await eventSource.emit(event_types.CHAT_CHANGED, null);
    (await import('./home.js')).renderHome();
}

export async function branchChat(id) {
    const messages = structuredClone(state.chat.slice(0, id + 1));
    await newChat({ messages });
    toast('Branched into a new chat', 'success');
}

/**
 * Deletes a chat. Pending saves finish first (so a late save can't bring it back); if it was the
 * open chat, you land in the most recent remaining one, or a fresh one if none are left.
 */
export async function deleteChat(charId, chatId) {
    const isOpen = state.character?.id === charId && state.chatId === chatId;
    if (isOpen) await saveChat();
    await api.del(`chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`);
    if (localStorage.getItem(`rv-last-chat-${charId}`) === chatId) localStorage.removeItem(`rv-last-chat-${charId}`);
    await eventSource.emit(event_types.CHAT_DELETED, chatId);
    // Deleting the open chat goes back Home (rather than opening another chat with the same character).
    if (isOpen) {
        state.chatId = null;
        state.chat = [];
        await closeChat();
    }
}

export async function showChatList() {
    if (!state.character) return;
    const charId = state.character.id;
    const listEl = el('div', { class: 'chat-list' });
    const render = async () => {
        const chats = await api.get(`chats/${encodeURIComponent(charId)}`);
        listEl.replaceChildren(...chats.map(c => {
            const row = el('div', { class: `chat-row${c.id === state.chatId ? ' active' : ''}` },
                el('button', { class: 'chat-row-main', onclick: async () => { await openChat(c.id); close(); } },
                    el('div', { class: 'chat-row-title' }, c.id),
                    el('div', { class: 'chat-row-preview' }, c.preview || '—'),
                    el('div', { class: 'chat-row-meta' }, `${c.count} messages · ${new Date(c.updated).toLocaleString()}`)),
                el('div', { class: 'chat-row-actions' },
                    el('button', { class: 'icon-btn', title: 'Rename', onclick: async () => {
                        const name = await promptDialog('New name', c.id, { title: 'Rename chat' });
                        if (!name || name === c.id) return;
                        const res = await api.post(`chats/${encodeURIComponent(charId)}/${encodeURIComponent(c.id)}/rename`, { name });
                        if (c.id === state.chatId) { state.chatId = res.id; updateHeader(); rememberChat(); }
                        render();
                    } }, icon('pen')),
                    el('button', { class: 'icon-btn', title: 'Export…', onclick: e => { const b = e.currentTarget; import('./export.js').then(m => m.exportMenu(b, charId, c.id)); } }, icon('download')),
                    el('button', { class: 'icon-btn danger', title: 'Delete', onclick: async () => {
                        if (!await confirmDialog(`Delete chat "${c.id}"?`, { okLabel: 'Delete', danger: true })) return;
                        const wasOpen = c.id === state.chatId && state.character?.id === charId;
                        await deleteChat(charId, c.id);
                        if (wasOpen) close(); // back Home
                        else render();
                    } }, icon('trash-can'))));
            return row;
        }));
        if (!chats.length) listEl.append(el('div', { class: 'empty' }, 'No chats yet.'));
    };
    let close = () => {};
    const head = el('div', { class: 'row gap wrap' },
        el('button', { class: 'btn primary', onclick: async () => { await newChat(); close(); } }, icon('plus'), 'New chat'),
        el('button', { class: 'btn', onclick: async () => {
            const file = await pickFile('.jsonl,.json,application/jsonl,application/json');
            if (!file) return;
            const q = new URLSearchParams({ character_name: state.character?.card?.data?.name || '', user_name: userName(), filename: file.name });
            let res;
            try {
                res = await api.upload(`chats/${encodeURIComponent(charId)}/import?${q}`, await file.text());
            } catch (err) {
                toast(`${file.name}: ${err.message}`, 'error');
                return;
            }
            const many = (res.ids?.length || 1) > 1 ? `${res.ids.length} chats imported` : 'Chat imported';
            if (res.warning) toast(`${many}, but ${res.warning}.`, 'warning', { timeout: 6000 });
            else toast(many, 'success');
            await openChat(res.id);
            close();
        } }, icon('file-import'), 'Import .jsonl'),
        el('button', { class: 'btn', onclick: () => { close(); editCharacter(charId); } }, icon('user-pen'), 'Edit character'));
    modal({
        title: `Chats with ${state.character.card.data.name}`,
        content: el('div', { class: 'stack' }, head, listEl),
        buttons: [],
        onOpen: (_b, c) => { close = c; render(); },
    });
}

// ---------------- import / create / edit ----------------
export async function importCharacter() {
    const files = await pickFile('.png,.json,.charx,image/png,application/json,application/zip', { multiple: true });
    if (!files?.length) return;
    let last = null;
    const imported = [];
    for (const file of files) {
        try {
            last = await api.upload('characters/import', file);
            if (last.avatarIsPng === false) await convertAvatarToPng(last).catch(() => {});
            imported.push(last);
            toast(`Imported ${last.card.data.name}`, 'success');
        } catch (err) {
            toast(`${file.name}: ${err.message}`, 'error');
        }
    }
    // Every imported card's embedded lorebook (and any extra books a CharX carries) becomes a linked lorebook.
    for (const character of imported) await maybeImportEmbeddedBook(character).catch(err => toast(`${character.card.data.name}: ${err.message}`, 'error'));
    await loadCharacters();
    if (last) {
        // Stay where you are; just point out the new card.
        const tile = document.querySelector(`#home-grid .char-tile[data-id="${CSS.escape(last.id)}"], #rm_print_characters_block .char-tile[data-id="${CSS.escape(last.id)}"]`);
        tile?.classList.add('just-added');
        tile?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        setTimeout(() => tile?.classList.remove('just-added'), 2600);
    }
}

const timeAgo = ms => {
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
};
const plain = text => String(text ?? '').replace(/<[^>]+>/g, ' ').replace(/[*_~`#]+/g, '').replace(/\s+/g, ' ').trim();

/** A character's profile: portrait, details and their chats, with Continue / New chat / Edit. */
/**
 * Deletes characters (and all their chats) after one confirmation. Returns true if anything was deleted.
 * Used by the editor, the profile, tile menus and the Characters browser's select mode.
 */
export async function deleteCharacters(ids) {
    ids = [...new Set(ids)].filter(Boolean);
    if (!ids.length) return false;
    const names = ids.map(id => state.characters.find(c => c.id === id)?.name || 'this character');
    const what = ids.length === 1 ? names[0] : `${ids.length} characters (${names.slice(0, 4).join(', ')}${ids.length > 4 ? '…' : ''})`;
    if (!await confirmDialog(`Delete ${what} and all of their chats? This can't be undone. (Backups in Settings → More keep a copy.)`, { okLabel: ids.length === 1 ? 'Delete forever' : `Delete ${ids.length} forever`, danger: true })) return false;
    let failed = 0;
    for (const id of ids) {
        try {
            await api.del(`characters/${encodeURIComponent(id)}`);
            localStorage.removeItem(`rv-last-chat-${id}`);
            await eventSource.emit(event_types.CHARACTER_DELETED, { id });
            if (state.character?.id === id) {
                state.chatId = null; // nothing left to save: the chats went with the character
                await closeChat();
            }
        } catch { failed++; }
    }
    await loadCharacters();
    (await import('./home.js')).renderHome();
    if (failed) toast(`${failed} couldn't be deleted`, 'error');
    else toast(ids.length === 1 ? `Deleted ${names[0]}` : `Deleted ${ids.length} characters`, 'success');
    return ids.length > failed;
}

/** Long-press / right-click menu for a character tile. */
export function characterMenu(anchor, c) {
    import('./chat.js').then(({ popMenu }) => popMenu(anchor, [
        ['book-open', 'Open', () => openCharacter(c.id)],
        ['pen', 'Edit', () => editCharacter(c.id)],
        ['star', c.fav ? 'Remove from favourites' : 'Add to favourites', async () => { await api.put(`characters/${encodeURIComponent(c.id)}`, { fav: !c.fav }); loadCharacters(); }],
        ['clone', 'Duplicate', async () => { const copy = await api.post(`characters/${encodeURIComponent(c.id)}/duplicate`); toast(`Duplicated as ${copy.card.data.name}`, 'success'); loadCharacters(); }],
        ['image', 'Export PNG', () => exportCharacterCard(c.id, 'png')],
        ['trash-can', 'Delete…', () => deleteCharacters([c.id]), 'danger'],
    ]));
}

export async function showCharacterProfile(id) {
    const [character, chats] = await Promise.all([
        api.get(`characters/${encodeURIComponent(id)}`),
        api.get(`chats/${encodeURIComponent(id)}`).catch(() => []),
    ]);
    const d = character.card.data;
    const banner = d.extensions?.[BANNER_KEY] || {};
    let close = () => {};
    const go = async opts => { close(); await openCharacter(id, opts); };
    // No chat is open yet, so fill {{char}} / {{user}} here rather than from the (empty) current chat.
    const about = plain(substituteParams(String(d.creator_notes || d.description || '').replace(/\{\{char\}\}|<BOT>|<CHAR>/gi, d.name).replace(/\{\{user\}\}|<USER>/gi, userName()))).slice(0, 600);
    const content = el('div', { class: 'char-profile' },
        el('button', { class: 'icon-btn char-profile-close', title: 'Close', onclick: () => close() }, icon('xmark')),
        el('div', { class: 'char-profile-art', style: { backgroundImage: `url("${avatarUrl(character)}")` } }),
        el('div', { class: 'char-profile-body' },
            banner.banner ? el('div', { class: 'char-profile-banner', style: { backgroundImage: `url("api/characters/${encodeURIComponent(id)}/banner?v=${character.updated || 0}")` } }) : null,
            el('h2', { class: `char-profile-name${banner.banner ? ' has-banner' : ''}`, style: /^#[0-9a-f]{3,8}$/i.test(banner.accentColor || '') ? `--ab-accent: ${banner.accentColor}` : null }, d.name),
            d.creator ? el('div', { class: 'hint' }, `by ${d.creator}`) : null,
            d.tags?.length ? el('div', { class: 'char-profile-tags' }, d.tags.slice(0, 12).map(t => el('span', { class: 'tag' }, t))) : null,
            about ? el('p', { class: 'char-profile-about' }, about) : null,
            el('div', { class: 'char-profile-actions' },
                chats.length ? el('button', { class: 'btn primary', onclick: () => go({ chatId: chats[0].id }) }, icon('book-open'), 'Continue') : null,
                el('button', { class: `btn${chats.length ? '' : ' primary'}`, onclick: () => go({ fresh: true }) }, icon('feather'), 'New chat'),
                el('button', { class: 'btn', onclick: () => { close(); editCharacter(id); } }, icon('pen'), 'Edit'),
                el('button', { class: 'btn icon-only', title: 'More (duplicate, export, delete…)', onclick: e => {
                    const anchor = e.currentTarget;
                    const summary = state.characters.find(x => x.id === id) || { id, name: d.name };
                    import('./chat.js').then(({ popMenu }) => popMenu(anchor, [
                        ['clone', 'Duplicate', async () => { close(); const copy = await api.post(`characters/${encodeURIComponent(id)}/duplicate`); toast(`Duplicated as ${copy.card.data.name}`, 'success'); loadCharacters(); }],
                        ['image', 'Export PNG', () => exportCharacterCard(id, 'png')],
                        ['file-code', 'Export JSON', () => { location.href = `api/characters/${encodeURIComponent(id)}/export.json`; }],
                        ['trash-can', `Delete ${summary.name}…`, async () => { if (await deleteCharacters([id])) close(); }, 'danger'],
                    ]));
                } }, icon('ellipsis'))),
            chats.length ? el('div', { class: 'char-profile-chats' },
                el('div', { class: 'section-label' }, `Chats (${chats.length})`),
                chats.slice(0, 6).map(c => el('button', { class: 'char-profile-chat', onclick: () => go({ chatId: c.id }) },
                    el('span', { class: 'char-profile-chat-title' }, c.id.replace(`${d.name} - `, '')),
                    el('span', { class: 'hint' }, `${c.count} messages · ${timeAgo(c.updated)}`),
                    c.preview ? el('span', { class: 'char-profile-chat-preview' }, plain(c.preview).slice(0, 120)) : null))) : null));
    modal({ title: '', content, buttons: [], wide: true, className: 'char-profile-wrap', onOpen: (_body, done) => { close = () => done(null); } });
}

/** Re-encodes a non-PNG avatar (JPEG / WebP from a CharX or Marinara import) as PNG, so PNG export keeps it. */
async function convertAvatarToPng(character) {
    const blob = await fetch(avatarUrl(character)).then(r => (r.ok ? r.blob() : Promise.reject(new Error('Avatar not found'))));
    const png = await toPngBlob(blob, 2048);
    const updated = await api.upload(`characters/${encodeURIComponent(character.id)}/avatar`, png);
    character.avatar = updated.avatar;
    return updated;
}

/**
 * Downloads a character as a PNG or JSON card. Older characters may still have a JPEG/WebP avatar, which the
 * server can't re-encode: it's converted to PNG here first so the card carries the real picture.
 */
export async function exportCharacterCard(id, fmt = 'png') {
    if (fmt === 'png') {
        const c = state.characters.find(x => x.id === id) || await api.get(`characters/${encodeURIComponent(id)}`).catch(() => null);
        if (c?.avatar && !/\.png$/i.test(c.avatar)) {
            try {
                await convertAvatarToPng(c);
                await loadCharacters();
            } catch { /* export with the placeholder image */ }
        }
    }
    location.href = `api/characters/${encodeURIComponent(id)}/export.${fmt}`;
}

/** Same name and same number of entries: treat an existing lorebook as this one instead of duplicating it. */
async function saveOrReuseBook(world) {
    const count = Object.keys(world.entries || {}).length;
    const list = await api.get('worlds').catch(() => []);
    const same = list.find(w => w.name === world.name && w.count === count);
    if (same) return { saved: same, reused: true };
    // Another book already has this name: pick a free one so the link points at the right book.
    const names = new Set(list.map(w => w.name));
    let name = world.name;
    for (let i = 2; names.has(name); i++) name = `${world.name} (${i})`;
    return { saved: await api.post('worlds', { ...world, name }), reused: false };
}

async function maybeImportEmbeddedBook(character) {
    const extra = (character.books || []).filter(b => b && typeof b === 'object');
    const book = character.card.data.character_book;
    const link = { world: character.card.data.extensions?.world || '', extra_worlds: [...(character.card.data.extensions?.extra_worlds || [])] };
    const notes = [];
    if (book?.entries?.length) {
        // Keep the embedded book; also make it editable as a standalone lorebook linked to the character.
        const world = normalizeWorld(book, book.name || `${character.card.data.name}'s Lore`);
        const { saved, reused } = await saveOrReuseBook(world);
        link.world = saved.name;
        notes.push(`${reused ? 'Linked existing' : 'Linked'} lorebook “${saved.name}” (${saved.count ?? Object.keys(saved.entries || {}).length} entries)`);
    }
    for (const raw of extra) {
        const world = normalizeWorld(raw.type ? raw : { type: 'lumiverse_world_book', ...raw }, raw.name || `${character.card.data.name}'s Lore`);
        if (!Object.keys(world.entries).length) continue;
        const { saved } = await saveOrReuseBook(world);
        if (!link.world) link.world = saved.name;
        else if (link.world !== saved.name && !link.extra_worlds.includes(saved.name)) link.extra_worlds.push(saved.name);
        notes.push(`lorebook “${saved.name}”`);
    }
    if (!notes.length) return;
    const ext = { world: link.world, ...(link.extra_worlds.length ? { extra_worlds: link.extra_worlds } : {}) };
    character.card.data.extensions = { ...(character.card.data.extensions || {}), ...ext };
    await api.put(`characters/${encodeURIComponent(character.id)}`, { extensions: ext });
    toast(notes.join(' · '), 'info');
}

export async function createCharacter() {
    const created = await api.post('characters', { card: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'New Character', first_mes: '*{{char}} looks up as you approach.* "Oh — hello there."' } } });
    await loadCharacters();
    await editCharacter(created.id, { isNew: true });
}

export async function editCharacter(id, { isNew = false } = {}) {
    const character = await api.get(`characters/${encodeURIComponent(id)}`);
    const d = structuredClone(character.card.data);
    d.alternate_greetings ??= [];
    d.tags ??= [];
    d.extensions ??= {};
    const depthPrompt = d.extensions.depth_prompt = { prompt: '', depth: 4, role: 'system', ...(d.extensions.depth_prompt || {}) };
    const avatarImg = el('img', { class: 'editor-avatar', src: avatarUrl(character) });
    const greetingsBox = el('div', { class: 'stack' });
    const renderGreetings = () => {
        greetingsBox.replaceChildren(...d.alternate_greetings.map((g, i) => el('div', { class: 'greeting-row' },
            textArea(g, v => { d.alternate_greetings[i] = v; }, { rows: 3 }),
            el('button', { class: 'icon-btn danger', title: 'Remove', onclick: () => { d.alternate_greetings.splice(i, 1); renderGreetings(); } }, icon('xmark')))),
        el('button', { class: 'btn small', onclick: () => { d.alternate_greetings.push(''); renderGreetings(); } }, icon('plus'), 'Add alternate greeting'));
    };
    renderGreetings();
    const tagsInput = textInput(d.tags.join(', '), v => { d.tags = v.split(',').map(s => s.trim()).filter(Boolean); }, { placeholder: 'fantasy, slow-burn, adventure' });

    const tabs = {
        Basics: el('div', { class: 'stack' },
            el('div', { class: 'editor-top' },
                el('button', { class: 'editor-avatar-btn', title: 'Change avatar', onclick: async () => {
                    const file = await pickFile('image/*');
                    if (!file) return;
                    const png = await toPngBlob(file);
                    const updated = await api.upload(`characters/${encodeURIComponent(id)}/avatar`, png);
                    character.avatar = updated.avatar;
                    avatarImg.src = avatarUrl(updated);
                } }, avatarImg, el('span', { class: 'editor-avatar-hint' }, icon('camera'))),
                el('div', { class: 'stack grow' },
                    field('Name', textInput(d.name, v => { d.name = v; })),
                    field('Tags', tagsInput),
                    field('Creator', textInput(d.creator, v => { d.creator = v; })))),
            field('Description', textArea(d.description, v => { d.description = v; }, { rows: 10 }), 'Who they are — appearance, background, behaviour. Macros like {{char}} and {{user}} work everywhere.'),
            field('First message', textArea(d.first_mes, v => { d.first_mes = v; }, { rows: 6 })),
            el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Alternate greetings'), greetingsBox)),
        Details: el('div', { class: 'stack' },
            field('Personality summary', textArea(d.personality, v => { d.personality = v; }, { rows: 3 })),
            field('Scenario', textArea(d.scenario, v => { d.scenario = v; }, { rows: 4 })),
            field('Example dialogue', textArea(d.mes_example, v => { d.mes_example = v; }, { rows: 8, placeholder: '<START>\n{{user}}: Hi!\n{{char}}: *waves* Hello!' }), 'Separate examples with <START>.'),
            field('Creator notes', textArea(d.creator_notes, v => { d.creator_notes = v; }, { rows: 4 }), 'For you, not the AI: shown on the profile, never sent with the prompt.')),
        Prompts: el('div', { class: 'stack' },
            field('Main prompt override', textArea(d.system_prompt, v => { d.system_prompt = v; }, { rows: 6 }), 'Replaces the preset main prompt when “Prefer character prompt” is on. Use {{original}} to include the preset version.'),
            field('Post-history instructions', textArea(d.post_history_instructions, v => { d.post_history_instructions = v; }, { rows: 6 }), 'Replaces the preset post-history instructions. {{original}} works here too.'),
            field("Character's Note", textArea(depthPrompt.prompt, v => { depthPrompt.prompt = v; }, { rows: 4 }), 'A reminder slipped into the chat a few messages from the end every turn, so it never drifts out of view (SillyTavern’s Character’s Note).'),
            el('div', { class: 'grid-2' },
                field('Note depth', (() => {
                    const i = el('input', { class: 'input', type: 'number', min: 0 });
                    i.value = depthPrompt.depth;
                    i.addEventListener('input', () => { depthPrompt.depth = Math.max(0, Number(i.value) || 0); });
                    return i;
                })(), '0 = after the last message.'),
                field('Note role', select([['system', 'System'], ['user', 'User'], ['assistant', 'Assistant']], depthPrompt.role, v => { depthPrompt.role = v; }))),
            field('Linked lorebook (name)', textInput(d.extensions?.world || '', v => { d.extensions = { ...(d.extensions || {}), world: v }; })),
            field('Extra lorebooks', textInput((d.extensions?.extra_worlds || []).join(', '), v => { d.extensions = { ...(d.extensions || {}), extra_worlds: v.split(',').map(s => s.trim()).filter(Boolean) }; }, { placeholder: 'names, comma separated' }), 'Also active whenever this character is.'),
            field('Character version', textInput(d.character_version, v => { d.character_version = v; }))),
        Banner: el('div', { class: 'stack' },
            el('p', { class: 'hint' }, 'A strip of art across the top of this character\'s messages (Avatar Banner). Changes save right away.'),
            bannerControls({ kind: 'character', id, onChange: data => { d.extensions = { ...(d.extensions || {}), [BANNER_KEY]: data }; } })),
    };
    const tabBar = el('div', { class: 'tabs inline' });
    const body = el('div', { class: 'editor-body' });
    const show = name => {
        tabBar.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
        body.replaceChildren(tabs[name]);
    };
    for (const name of Object.keys(tabs)) tabBar.append(el('button', { class: 'tab', 'data-tab': name, onclick: () => show(name) }, name));
    show('Basics');

    const extras = el('div', { class: 'row gap wrap editor-extras' },
        el('button', { class: `btn small${character.fav ? ' active' : ''}`, onclick: async e => {
            character.fav = !character.fav;
            e.currentTarget.classList.toggle('active', character.fav);
            await api.put(`characters/${encodeURIComponent(id)}`, { fav: character.fav });
            loadCharacters();
        } }, icon('star'), 'Favourite'),
        el('button', { class: 'btn small', onclick: () => exportCharacterCard(id, 'png') }, icon('image'), 'Export PNG'),
        el('button', { class: 'btn small', onclick: () => exportCharacterCard(id, 'json') }, icon('file-code'), 'Export JSON'),
        el('button', { class: 'btn small', onclick: async () => {
            const copy = await api.post(`characters/${encodeURIComponent(id)}/duplicate`);
            toast(`Duplicated as ${copy.card.data.name}`, 'success');
            loadCharacters();
        } }, icon('clone'), 'Duplicate'),
        el('button', { class: 'btn small danger', onclick: async () => {
            deleted = true; // don't autosave a character that's about to go
            if (!await deleteCharacters([id])) { deleted = false; return; }
            closeEditor();
        } }, icon('trash-can'), 'Delete character'));

    // Saves as you go (like SillyTavern): a moment after each change, and once more when the editor closes,
    // however it's closed (Done, ✕, Esc or a tap outside), so nothing typed is lost.
    const status = el('span', { class: 'hint editor-save-status' }, 'Changes save automatically');
    let dirty = false;
    let timer = 0;
    let saving = Promise.resolve();
    let deleted = false;
    let closeEditor = () => {};
    const save = () => {
        clearTimeout(timer);
        if (!dirty || deleted) return saving;
        dirty = false;
        status.textContent = 'Saving…';
        saving = saving.then(async () => {
            // Only the fields this editor owns: banners and extensions save their own parts of the card.
            const { extensions, ...fields } = structuredClone(d);
            const ext = { world: extensions?.world || '' };
            if (extensions?.depth_prompt) ext.depth_prompt = extensions.depth_prompt;
            if (extensions?.extra_worlds) ext.extra_worlds = extensions.extra_worlds;
            const saved = await api.put(`characters/${encodeURIComponent(id)}`, { data: fields, extensions: ext });
            character.card = saved.card;
            if (state.character?.id === id) {
                state.character = { ...state.character, ...saved };
                updateHeader();
            }
            status.textContent = 'Saved';
            await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id } });
        }).catch(err => {
            dirty = true;
            status.textContent = 'Not saved';
            toast(`Couldn't save ${d.name}: ${err.message}`, 'error');
        });
        return saving;
    };
    const changed = () => { dirty = true; status.textContent = 'Editing…'; clearTimeout(timer); timer = setTimeout(save, 900); };
    const content = el('div', { class: 'stack' }, tabBar, body, extras, status);
    // Field handlers update the draft first; this hears the same events as they bubble up.
    content.addEventListener('input', changed);
    content.addEventListener('change', changed);
    content.addEventListener('click', e => { if (e.target.closest('.greeting-row .icon-btn, .stack > .btn.small')) changed(); });

    await modal({
        title: isNew ? 'Create character' : `Edit ${d.name}`,
        content,
        wide: true,
        buttons: [{ label: 'Done', value: true, primary: true, icon: 'check' }],
        onOpen: (_b, close) => { closeEditor = () => close(null); },
    });
    const hadChanges = dirty;
    await save();
    if (hadChanges && !deleted && status.textContent === 'Saved') toast('Saved', 'success', { timeout: 1500 });
    await loadCharacters();
    if (isNew && !deleted) openCharacter(id);
}

export function exportChatFile() {
    if (!state.character || !state.chatId) return;
    download(`${state.chatId}.jsonl`, [state.chatMeta, ...state.chat].map(x => JSON.stringify(x)).join('\n'), 'application/jsonl');
}

export { escapeHtml };
