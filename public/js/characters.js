// Character library, editor, and chat management.
import { bannerControls, KEY as BANNER_KEY } from './avatar-banner.js';
import { api } from './api.js';
import { state, saveSettingsDebounced, saveChat, userName, charName } from './state.js';
import { eventSource, event_types } from './events.js';
import { substituteParams } from './macros.js';
import { printMessages, clearChat, nowDate } from './chat.js';
import { applyTheme } from './themes.js';
import { el, icon, toast, modal, confirmDialog, promptDialog, pickFile, closeAllDrawers, toPngBlob, download, escapeHtml, field, textArea, textInput } from './ui.js';
import { normalizeWorld } from './worldinfo.js';

const avatarUrl = c => (c?.avatar ? `files/avatars/${encodeURIComponent(c.avatar)}` : 'icons/icon.svg');

export async function loadCharacters() {
    state.characters = await api.get('characters');
    renderLibrary();
}

// ---------------- library ----------------
function cardTile(c, { compact = false } = {}) {
    const tile = el('button', { class: `char-tile${compact ? ' compact' : ''}${state.character?.id === c.id ? ' active' : ''}`, 'data-id': c.id, title: c.name },
        el('div', { class: 'char-tile-img', style: { backgroundImage: `url("${avatarUrl(c)}")` } }),
        el('div', { class: 'char-tile-info' },
            el('div', { class: 'char-tile-name' }, c.fav ? icon('star', 'fav-star') : null, c.name),
            compact ? el('div', { class: 'char-tile-notes' }, c.notes || (c.tags || []).slice(0, 4).join(' · ')) : el('div', { class: 'char-tile-tags' }, (c.tags || []).slice(0, 3).map(t => el('span', { class: 'tag' }, t)))));
    tile.addEventListener('click', () => showCharacterProfile(c.id));
    tile.addEventListener('contextmenu', e => {
        e.preventDefault();
        editCharacter(c.id);
    });
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
        swipe_info: swipes.map(() => ({ send_date: nowDate(), extra: {} })),
        extra: {},
    };
}

export async function openCharacter(id, { chatId, fresh = false } = {}) {
    if (state.generating) return toast('Wait for the current reply to finish', 'warning');
    await saveChat();
    const character = await api.get(`characters/${encodeURIComponent(id)}`);
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
}

export function updateHeader() {
    const c = state.character;
    document.getElementById('chat-title-avatar').src = avatarUrl(c);
    document.getElementById('chat-title-name').textContent = c ? c.card.data.name : 'Reverie';
    document.getElementById('chat-title-sub').textContent = c ? (state.chatId || '') : 'Pick a character to begin';
    document.title = c ? `${c.card.data.name} · Reverie` : 'Reverie';
}

export async function openChat(chatId) {
    const chat = await api.get(`chats/${encodeURIComponent(state.character.id)}/${encodeURIComponent(chatId)}`);
    state.chatId = chat.id;
    state.chatMeta = chat.meta || {};
    state.chatMeta.chat_metadata ??= {};
    state.chat = chat.messages || [];
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
                    el('a', { class: 'icon-btn', title: 'Export (.jsonl)', href: `api/chats/${encodeURIComponent(charId)}/${encodeURIComponent(c.id)}/export` }, icon('download')),
                    el('button', { class: 'icon-btn danger', title: 'Delete', onclick: async () => {
                        if (!await confirmDialog(`Delete chat "${c.id}"?`, { okLabel: 'Delete', danger: true })) return;
                        await api.del(`chats/${encodeURIComponent(charId)}/${encodeURIComponent(c.id)}`);
                        if (c.id === state.chatId) { state.chatId = null; state.chat = []; clearChat(); }
                        await eventSource.emit(event_types.CHAT_DELETED, c.id);
                        render();
                    } }, icon('trash-can'))));
            return row;
        }));
        if (!chats.length) listEl.append(el('div', { class: 'empty' }, 'No chats yet.'));
    };
    let close = () => {};
    const head = el('div', { class: 'row gap wrap' },
        el('button', { class: 'btn primary', onclick: async () => { await newChat(); close(); } }, icon('plus'), 'New chat'),
        el('button', { class: 'btn', onclick: async () => {
            const file = await pickFile('.jsonl,application/jsonl,application/json');
            if (!file) return;
            const res = await api.upload(`chats/${encodeURIComponent(charId)}/import`, await file.text());
            toast('Chat imported', 'success');
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
    const files = await pickFile('.png,.json,image/png,application/json', { multiple: true });
    if (!files?.length) return;
    let last = null;
    for (const file of files) {
        try {
            last = await api.upload('characters/import', file);
            toast(`Imported ${last.card.data.name}`, 'success');
        } catch (err) {
            toast(`${file.name}: ${err.message}`, 'error');
        }
    }
    await loadCharacters();
    if (last) {
        await maybeImportEmbeddedBook(last);
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
                el('button', { class: 'btn', onclick: () => { close(); editCharacter(id); } }, icon('pen'), 'Edit')),
            chats.length ? el('div', { class: 'char-profile-chats' },
                el('div', { class: 'section-label' }, `Chats (${chats.length})`),
                chats.slice(0, 6).map(c => el('button', { class: 'char-profile-chat', onclick: () => go({ chatId: c.id }) },
                    el('span', { class: 'char-profile-chat-title' }, c.id.replace(`${d.name} - `, '')),
                    el('span', { class: 'hint' }, `${c.count} messages · ${timeAgo(c.updated)}`),
                    c.preview ? el('span', { class: 'char-profile-chat-preview' }, plain(c.preview).slice(0, 120)) : null))) : null));
    modal({ title: '', content, buttons: [], wide: true, className: 'char-profile-wrap', onOpen: (_body, done) => { close = () => done(null); } });
}

async function maybeImportEmbeddedBook(character) {
    const book = character.card.data.character_book;
    if (!book?.entries?.length) return;
    // Keep the embedded book; also make it editable as a standalone lorebook linked to the character.
    const world = normalizeWorld(book, book.name || `${character.card.data.name}'s Lore`);
    const saved = await api.post('worlds', world);
    character.card.data.extensions = { ...(character.card.data.extensions || {}), world: saved.name };
    await api.put(`characters/${encodeURIComponent(character.id)}`, { card: character.card });
    toast(`Linked lorebook “${saved.name}” (${Object.keys(saved.entries).length} entries)`, 'info');
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
            field('Character note (creator notes)', textArea(d.creator_notes, v => { d.creator_notes = v; }, { rows: 4 }))),
        Prompts: el('div', { class: 'stack' },
            field('Main prompt override', textArea(d.system_prompt, v => { d.system_prompt = v; }, { rows: 6 }), 'Replaces the preset main prompt when “Prefer character prompt” is on. Use {{original}} to include the preset version.'),
            field('Post-history instructions', textArea(d.post_history_instructions, v => { d.post_history_instructions = v; }, { rows: 6 }), 'Replaces the preset post-history instructions. {{original}} works here too.'),
            field('Linked lorebook (name)', textInput(d.extensions?.world || '', v => { d.extensions = { ...(d.extensions || {}), world: v }; })),
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
        el('a', { class: 'btn small', href: `api/characters/${encodeURIComponent(id)}/export.png` }, icon('image'), 'Export PNG'),
        el('a', { class: 'btn small', href: `api/characters/${encodeURIComponent(id)}/export.json` }, icon('file-code'), 'Export JSON'),
        el('button', { class: 'btn small', onclick: async () => {
            const copy = await api.post(`characters/${encodeURIComponent(id)}/duplicate`);
            toast(`Duplicated as ${copy.card.data.name}`, 'success');
            loadCharacters();
        } }, icon('clone'), 'Duplicate'),
        el('button', { class: 'btn small danger', onclick: async () => {
            if (!await confirmDialog(`Delete ${d.name} and all of their chats? This cannot be undone.`, { okLabel: 'Delete forever', danger: true })) return;
            await api.del(`characters/${encodeURIComponent(id)}`);
            await eventSource.emit(event_types.CHARACTER_DELETED, { id });
            if (state.character?.id === id) {
                state.character = null;
                state.chat = [];
                state.chatId = null;
                clearChat();
                document.body.classList.add('no-character');
                updateHeader();
            }
            document.querySelector('.modal-wrap.open .modal-head .icon-btn')?.click();
            loadCharacters();
        } }, icon('trash-can'), 'Delete'));

    const result = await modal({
        title: isNew ? 'Create character' : `Edit ${d.name}`,
        content: el('div', { class: 'stack' }, tabBar, body, extras),
        wide: true,
        buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true, icon: 'check' }],
    });
    if (!result) return;
    character.card.data = d;
    const saved = await api.put(`characters/${encodeURIComponent(id)}`, { card: character.card });
    if (state.character?.id === id) {
        state.character = { ...state.character, ...saved };
        updateHeader();
    }
    await eventSource.emit(event_types.CHARACTER_EDITED, { detail: { id } });
    toast('Saved', 'success', { timeout: 1500 });
    await loadCharacters();
    if (isNew) openCharacter(id);
}

export function exportChatFile() {
    if (!state.character || !state.chatId) return;
    download(`${state.chatId}.jsonl`, [state.chatMeta, ...state.chat].map(x => JSON.stringify(x)).join('\n'), 'application/jsonl');
}

export { escapeHtml };
