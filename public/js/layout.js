// Story sidebar, chat toolbar (preset switcher, search, rename, status) and the character sheet panel.
import { api } from './api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChat } from './state.js';
import { eventSource, event_types } from './events.js';
import { substituteParams } from './macros.js';
import { listPresets, selectPreset, savePreset } from './preset-store.js';
import { lastLore } from './prompt.js';
import { generateRaw } from './chat.js';
import { applyTheme } from './themes.js';
import { points, onPointsChanged } from './rv-ext/points.js';
import { el, icon, toast, modal, confirmDialog, promptDialog, field, textInput, textArea, select, openDrawer, closeDrawer, debounce } from './ui.js';

const $id = id => document.getElementById(id);
const avatarUrl = file => (file ? `files/avatars/${encodeURIComponent(file)}` : 'icons/icon.svg');
const wide = query => window.matchMedia(query).matches && !document.body.classList.contains('layout-classic');
const SHEET_DOCK = '(min-width: 1400px)';

function timeAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    if (s < 604800) return `${Math.round(s / 86400)}d ago`;
    return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ===================================================================
// Sidebar
// ===================================================================
export async function renderRecent() {
    const box = $id('recent-stories');
    let list = [];
    try { list = await api.get('chats?limit=15'); } catch { /* offline */ }
    box.replaceChildren(...list.map(item => {
        const active = state.character?.id === item.charId && state.chatId === item.chatId;
        const title = item.chatId.replace(new RegExp(`^${item.charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-\\s*`), '') || item.chatId;
        return el('div', { class: `story-card${active ? ' active' : ''}` },
            el('button', { class: 'story-main', title: `${item.charName} · ${item.chatId}`, onclick: async () => {
                const { openCharacter } = await import('./characters.js');
                await openCharacter(item.charId, { chatId: item.chatId });
            } },
            el('img', { src: avatarUrl(item.avatar), alt: '', loading: 'lazy' }),
            el('span', { class: 'story-text' },
                el('span', { class: 'story-title' }, item.charName),
                el('span', { class: 'story-sub' }, `${title} · ${timeAgo(item.updated)}`),
                el('span', { class: 'story-preview' }, item.preview || '—'))),
            el('button', { class: 'story-del', title: 'Delete this chat', onclick: async () => {
                if (!await confirmDialog(`Delete “${item.chatId}”?`, { okLabel: 'Delete', danger: true })) return;
                await api.del(`chats/${encodeURIComponent(item.charId)}/${encodeURIComponent(item.chatId)}`);
                if (active) {
                    const { openCharacter } = await import('./characters.js');
                    state.chatId = null;
                    await openCharacter(item.charId);
                }
                renderRecent();
            } }, icon('trash-can')));
    }));
    if (!list.length) box.append(el('div', { class: 'empty small' }, 'Your stories will appear here.'));
}

export function applyBranding() {
    const a = state.settings.appearance;
    $id('brand-title').textContent = a.brandTitle || 'Reverie';
    $id('brand-tagline').textContent = a.brandTagline ?? 'where stories begin';
    const art = $id('sidebar-art');
    art.classList.toggle('hidden', !a.sidebarArt);
    if (a.sidebarArt) {
        art.querySelector('img').src = a.sidebarArt;
        art.querySelector('figcaption').textContent = a.sidebarArtCaption || '';
    }
}

// ===================================================================
// Toolbar
// ===================================================================
export async function refreshPresetPicker() {
    const sel = $id('quick-preset');
    const list = await listPresets().catch(() => []);
    sel.replaceChildren(...list.map(p => el('option', { value: p.id, selected: p.id === state.preset?.id }, p.name)));
}

let hits = [];
let hitIndex = -1;
function runSearch(step = 0) {
    const q = $id('chat-search').value.trim().toLowerCase();
    document.querySelectorAll('.mes.search-hit, .mes.search-current').forEach(n => n.classList.remove('search-hit', 'search-current'));
    const count = $id('chat-search-count');
    if (!q) {
        hits = [];
        count.textContent = '';
        return;
    }
    if (step === 0) {
        hits = state.chat.map((m, i) => (String(m.mes).toLowerCase().includes(q) ? i : -1)).filter(i => i >= 0);
        hitIndex = hits.length - 1;
    } else if (hits.length) {
        hitIndex = (hitIndex + step + hits.length) % hits.length;
    }
    for (const i of hits) document.querySelector(`.mes[mesid="${i}"]`)?.classList.add('search-hit');
    count.textContent = hits.length ? `${hitIndex + 1}/${hits.length}` : '0';
    const node = document.querySelector(`.mes[mesid="${hits[hitIndex]}"]`);
    if (node) {
        node.classList.add('search-current');
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
}

function setStatus(kind, label) {
    const s = $id('gen-status');
    s.className = `gen-status ${kind}`;
    s.querySelector('.label').textContent = label;
}

function bindToolbar() {
    $id('quick-preset').addEventListener('change', async e => {
        await savePreset();
        await selectPreset(e.target.value);
        toast(`Preset: ${state.preset.name}`, 'success', { timeout: 1400 });
    });
    const search = $id('chat-search');
    search.addEventListener('input', debounce(() => runSearch(0), 150));
    search.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); runSearch(e.shiftKey ? 1 : -1); }
        if (e.key === 'Escape') { search.value = ''; runSearch(0); search.blur(); }
    });
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
            e.preventDefault();
            search.focus();
            search.select();
        }
    });
    $id('btn-rename-chat').addEventListener('click', async () => {
        if (!state.chatId) return;
        const name = await promptDialog('Chat name', state.chatId, { title: 'Rename story' });
        if (!name || name === state.chatId) return;
        await saveChat();
        const res = await api.post(`chats/${encodeURIComponent(state.character.id)}/${encodeURIComponent(state.chatId)}/rename`, { name });
        state.chatId = res.id;
        localStorage.setItem(`rv-last-chat-${state.character.id}`, res.id);
        (await import('./characters.js')).updateHeader();
        renderRecent();
        eventSource.emit(event_types.CHAT_RENAMED, res.id);
    });

    eventSource.on(event_types.GENERATION_STARTED, type => setStatus('busy', type === 'quiet' ? 'Working…' : 'Thinking…'));
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, () => {
        if (!$id('gen-status').classList.contains('writing')) setStatus('busy writing', 'Writing…');
    });
    eventSource.on(event_types.GENERATION_ENDED, () => setStatus('', 'Idle'));
    eventSource.on(event_types.GENERATION_STOPPED, () => setStatus('', 'Stopped'));
    eventSource.on(event_types.PRESET_CHANGED, refreshPresetPicker);
    eventSource.on(event_types.CHAT_CHANGED, () => { $id('chat-search').value = ''; runSearch(0); });
}

// ===================================================================
// Character sheet
// ===================================================================
const DETAIL_ICONS = [
    [/age|born|birth/i, 'hourglass-half'], [/height|tall/i, 'arrows-up-down'], [/build|body|weight|physique/i, 'dumbbell'],
    [/occupation|job|role|title|profession|class/i, 'briefcase'], [/residence|home|lives|location|from|origin/i, 'location-dot'],
    [/dislike|hate/i, 'heart-crack'], [/like|love|enjoy/i, 'heart'], [/species|race/i, 'paw'], [/gender|pronoun|sex/i, 'venus-mars'],
    [/eye/i, 'eye'], [/hair/i, 'scissors'], [/affiliation|faction|allegiance|guild/i, 'shield-halved'], [/power|magic|abilit|skill/i, 'wand-sparkles'],
    [/relation|partner|family/i, 'people-arrows'], [/fear/i, 'ghost'], [/goal|want|desire/i, 'bullseye'], [/voice|speech/i, 'comment'],
];
const detailIcon = label => DETAIL_ICONS.find(([rx]) => rx.test(label))?.[1] || 'circle-info';

let sheetTab = 'character';

function sheetData() {
    const d = state.character?.card?.data;
    return d?.extensions?.reverie_sheet || null;
}

async function saveSheet(sheet) {
    const c = state.character;
    c.card.data.extensions = { ...(c.card.data.extensions || {}), reverie_sheet: sheet };
    await api.put(`characters/${encodeURIComponent(c.id)}`, { card: c.card });
    renderSheet();
}

async function fillSheetWithAI() {
    const d = state.character?.card?.data;
    if (!d) return;
    if (!state.settings.connection.model) return toast('Set up a connection first', 'warning');
    const t = toast('Reading the character card…', 'info', { timeout: 0 });
    try {
        const source = substituteParams([d.description, d.personality && `Personality: ${d.personality}`, d.scenario && `Scenario: ${d.scenario}`].filter(Boolean).join('\n\n')).slice(0, 12000);
        const text = await generateRaw(`Character: ${d.name}\n\n${source}`, null, false, false,
            'Extract a compact character sheet from the card below. Reply with ONLY a JSON object, no prose: {"title": "short epithet or role, e.g. First King of Serialis", "traits": ["6-8 short personality adjectives"], "details": [{"label": "Age", "value": "..."}, ...]}. Include details that the card actually states, choosing from: Age, Species, Gender, Height, Build, Hair, Eyes, Occupation, Residence, Affiliation, Abilities, Likes, Dislikes, Goals. Keep each value under 8 words. Omit anything unknown.');
        const json = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || 'null');
        if (!json) throw new Error('The model did not return a sheet. Try again or edit it by hand.');
        await saveSheet({
            title: String(json.title || ''),
            traits: (json.traits || []).map(String).slice(0, 12),
            details: (json.details || []).filter(x => x?.label && x?.value).map(x => ({ label: String(x.label), value: String(x.value) })),
        });
        toast('Character sheet filled in', 'success');
    } catch (err) {
        toast(err.message, 'error');
    } finally {
        t.remove();
    }
}

async function editSheet() {
    const cur = sheetData() || { title: '', traits: [], details: [] };
    let title = cur.title;
    let traits = cur.traits.join(', ');
    let details = cur.details.map(x => `${x.label}: ${x.value}`).join('\n');
    const ok = await modal({
        title: 'Character sheet',
        content: el('div', { class: 'stack' },
            field('Title / epithet', textInput(title, v => { title = v; }, { placeholder: 'First King of Serialis' })),
            field('Traits (comma separated)', textInput(traits, v => { traits = v; }, { placeholder: 'charismatic, witty, impulsive' })),
            field('Key details (one per line, “Label: value”)', textArea(details, v => { details = v; }, { rows: 9, placeholder: 'Age: 380\nHeight: 6\'9"\nOccupation: King' }))),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true, icon: 'check' }],
    });
    if (!ok) return;
    await saveSheet({
        title: title.trim(),
        traits: traits.split(',').map(s => s.trim()).filter(Boolean),
        details: details.split('\n').map(line => {
            const i = line.indexOf(':');
            return i > 0 ? { label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null;
        }).filter(Boolean),
    });
}

function characterTab() {
    const c = state.character;
    if (!c) return el('div', { class: 'empty' }, icon('id-card'), el('p', {}, 'Open a story to see its character.'));
    const d = c.card.data;
    const sheet = sheetData();
    const traits = sheet?.traits?.length ? sheet.traits : (d.tags || []);
    const hero = el('div', { class: 'sheet-hero', style: { backgroundImage: `url("${avatarUrl(c.avatar)}")` } },
        el('div', { class: 'sheet-hero-text' },
            el('h2', {}, d.name),
            sheet?.title ? el('div', { class: 'sheet-epithet' }, sheet.title) : null));
    const about = d.description ? el('details', { class: 'sheet-about' }, el('summary', {}, 'About'), el('div', { class: 'sheet-about-text' }, substituteParams(d.description).slice(0, 4000))) : null;
    return el('div', { class: 'sheet-character' },
        hero,
        traits.length ? el('div', { class: 'trait-chips' }, traits.map(t => el('span', { class: 'trait' }, t))) : null,
        sheet?.details?.length
            ? el('div', { class: 'sheet-section' }, el('h3', {}, 'Key Details'),
                el('dl', { class: 'detail-list' }, sheet.details.map(x => el('div', { class: 'detail-row' },
                    el('dt', {}, icon(detailIcon(x.label)), x.label), el('dd', {}, x.value)))))
            : el('div', { class: 'sheet-empty' },
                el('p', {}, 'No character sheet yet. Let the AI read the card and fill in the key details, or write them yourself.')),
        el('div', { class: 'row gap wrap sheet-actions' },
            el('button', { class: 'btn small primary', onclick: fillSheetWithAI }, icon('wand-magic-sparkles'), sheet ? 'Refill with AI' : 'Fill with AI'),
            el('button', { class: 'btn small', onclick: editSheet }, icon('pen'), 'Edit sheet'),
            el('button', { class: 'btn small', onclick: () => import('./characters.js').then(m => m.editCharacter(c.id)) }, icon('user-pen'), 'Card')),
        about);
}

function loreTab() {
    const lore = lastLore();
    return el('div', { class: 'stack' },
        el('p', { class: 'hint' }, 'Lorebook entries that were active in the last reply.'),
        lore.length
            ? el('div', { class: 'stack' }, lore.map(e => el('details', { class: 'lore-hit' },
                el('summary', {}, icon(e.constant ? 'thumbtack' : 'key'), ' ', e.comment || (e.key || []).join(', ') || 'Entry', el('span', { class: 'dim' }, ` · ${e.book}`)),
                el('div', { class: 'lore-hit-text' }, e.content))))
            : el('div', { class: 'empty small' }, 'Nothing triggered yet.'),
        el('button', { class: 'btn small', onclick: () => import('./panels/settings.js').then(m => m.openSettings('lore')) }, icon('book-atlas'), 'Manage lorebooks'));
}

async function sceneTab() {
    if (!state.chatId) return el('div', { class: 'empty' }, 'Open a story first.');
    const meta = chatMetadata();
    const save = debounce(() => saveChat(), 500);
    const backgrounds = await api.get('backgrounds').catch(() => []);
    const bgPick = el('div', { class: 'bg-grid small' },
        el('button', { class: `bg-tile none${!meta.custom_background ? ' active' : ''}`, onclick: () => setBg('') }, icon('ban'), el('span', {}, 'Default')),
        backgrounds.map(b => el('button', { class: `bg-tile${meta.custom_background === b.url ? ' active' : ''}`, style: { backgroundImage: `url("${b.url}")` }, onclick: () => setBg(b.url) })));
    async function setBg(url) {
        meta.custom_background = url || undefined;
        await saveChat();
        applyTheme();
        renderSheet();
    }
    return el('div', { class: 'stack' },
        field("Author's note", textArea(meta.note_prompt || '', v => { meta.note_prompt = v; save(); }, { rows: 4, placeholder: '[It is raining. Keep the tension slow-burn.]' }), 'Whispered to the AI near the end of the chat, every turn.'),
        el('div', { class: 'grid-2' },
            field('Depth', (() => { const i = el('input', { class: 'input', type: 'number', min: 0 }); i.value = meta.note_depth ?? 4; i.addEventListener('input', () => { meta.note_depth = Number(i.value); save(); }); return i; })()),
            field('As', select([[0, 'System'], [1, 'User'], [2, 'Assistant']], meta.note_role ?? 0, v => { meta.note_role = Number(v); save(); }))),
        field('Scenario for this story', textArea(meta.scenario || '', v => { meta.scenario = v; save(); }, { rows: 3, placeholder: state.character?.card?.data?.scenario || 'Override the card scenario for this chat only' })),
        el('div', { class: 'field' }, el('span', { class: 'field-label' }, 'Backdrop'), bgPick),
        el('p', { class: 'hint' }, `${state.chat.length} messages in this story.`));
}

export async function renderSheet() {
    const body = $id('sheet-body');
    if (!body) return;
    const extTab = points.sheetTabs.list().find(t => t.id === sheetTab);
    if (!extTab && !['character', 'lore', 'scene'].includes(sheetTab)) sheetTab = 'character';
    document.querySelectorAll('#sheet-tabs .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === sheetTab));
    if (extTab) {
        const container = el('div', { class: 'rv-ext-panel' });
        body.replaceChildren(container);
        try {
            await extTab.render(container, { character: state.character?.card?.data?.name ?? null, chatId: state.chatId });
        } catch (err) {
            container.replaceChildren(el('div', { class: 'empty error' }, `${extTab.title}: ${err.message}`));
        }
        return;
    }
    const content = sheetTab === 'lore' ? loreTab() : sheetTab === 'scene' ? await sceneTab() : characterTab();
    body.replaceChildren(content);
}

/** Open the character sheet on a given tab (used by Lumiverse drawer tabs). */
export function openSheetTab(id) {
    sheetTab = id;
    sheetVisible(true);
    renderSheet();
}
export const sheetState = () => ({ open: document.body.classList.contains('sheet-docked') || !!$id('sheet-panel')?.classList.contains('open'), tabId: sheetTab });

function sheetVisible(on) {
    queueMicrotask(() => window.dispatchEvent(new CustomEvent('rv:sheet', { detail: { open: on, tabId: sheetTab } })));
    const docked = wide(SHEET_DOCK);
    if (docked) {
        state.settings.ui ??= {};
        state.settings.ui.sheetOpen = on;
        saveSettingsDebounced();
        document.body.classList.toggle('sheet-docked', on);
        if (on) renderSheet();
    } else if (on) {
        openDrawer('sheet-panel');
        renderSheet();
    } else closeDrawer('sheet-panel');
}

/** Built-in tabs plus tabs contributed by Reverie extensions. */
function renderSheetTabs() {
    const nav = $id('sheet-tabs');
    nav.querySelectorAll('.tab.ext-tab').forEach(n => n.remove());
    const anchor = nav.querySelector('.grow');
    for (const t of points.sheetTabs.list()) {
        const ic = t.iconSvg ? el('span', { class: 'rvext-svg', html: t.iconSvg }) : t.iconUrl ? el('img', { class: 'rvext-svg', src: t.iconUrl, alt: '' }) : t.icon ? icon(t.icon) : null;
        anchor.before(el('button', { class: 'tab ext-tab', 'data-tab': t.id, title: t.title }, ic, el('span', {}, t.shortName || t.title)));
    }
}

/** Composer buttons and wand-menu items contributed by Reverie extensions. */
function renderExtensionUi() {
    const left = $id('leftSendForm');
    left.querySelectorAll('.rvext-btn').forEach(n => n.remove());
    for (const b of points.composerButtons.list()) {
        left.append(el('button', { class: 'icon-btn rvext-btn', title: b.title || '', onclick: () => b.onClick?.() }, icon(b.icon || 'puzzle-piece')));
    }
    const menu = $id('extensions-actions-menu');
    menu.querySelectorAll('.rvext-item').forEach(n => n.remove());
    for (const m of points.menuItems.list()) {
        const ic = m.iconSvg ? el('span', { class: 'rvext-svg', html: m.iconSvg }) : m.iconUrl ? el('img', { class: 'rvext-svg', src: m.iconUrl, alt: '' }) : icon(m.icon || 'puzzle-piece');
        menu.append(el('button', { class: 'menu-item list-group-item rvext-item', onclick: () => m.onClick?.() }, ic, el('span', {}, m.label)));
    }
}

function bindSheet() {
    onPointsChanged(kind => {
        if (kind === 'sheetTabs') { renderSheetTabs(); renderSheet(); }
        if (kind === 'composerButtons' || kind === 'menuItems') renderExtensionUi();
    });
    $id('btn-sheet').addEventListener('click', () => {
        // The sheet shows the open character; on Home there is none (and the panel is hidden there).
        if (!state.character) return;
        const open = wide(SHEET_DOCK) ? !document.body.classList.contains('sheet-docked') : !$id('sheet-panel').classList.contains('open');
        sheetVisible(open);
    });
    $id('sheet-panel').querySelector('.sheet-close').addEventListener('click', () => sheetVisible(false));
    $id('sheet-tabs').addEventListener('click', e => {
        const tab = e.target.closest('.tab');
        if (!tab) return;
        sheetTab = tab.dataset.tab;
        renderSheet();
        window.dispatchEvent(new CustomEvent('rv:sheet', { detail: { open: true, tabId: sheetTab } }));
    });
    const refresh = () => { if (document.body.classList.contains('sheet-docked') || $id('sheet-panel').classList.contains('open')) renderSheet(); };
    eventSource.on(event_types.CHAT_CHANGED, refresh);
    // Leaving for Home closes the sheet, so it can't leave the blurred backdrop behind.
    eventSource.on(event_types.CHAT_CHANGED, id => { if (!id && $id('sheet-panel').classList.contains('open')) closeDrawer('sheet-panel'); });
    eventSource.on(event_types.CHARACTER_EDITED, refresh);
    eventSource.on(event_types.GENERATION_ENDED, () => { if (sheetTab === 'lore') refresh(); });
    window.matchMedia(SHEET_DOCK).addEventListener('change', () => {
        document.body.classList.toggle('sheet-docked', wide(SHEET_DOCK) && !!state.settings.ui?.sheetOpen);
    });
}

export function initLayout() {
    bindToolbar();
    bindSheet();
    applyBranding();
    refreshPresetPicker();
    renderRecent();
    const docked = wide(SHEET_DOCK) && state.settings.ui?.sheetOpen !== false;
    document.body.classList.toggle('sheet-docked', docked);
    if (docked) renderSheet();
    for (const ev of [event_types.CHAT_CHANGED, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_SENT, event_types.CHAT_DELETED, event_types.CHAT_CREATED]) {
        eventSource.on(ev, debounce(renderRecent, 400));
    }
    eventSource.on(event_types.SETTINGS_UPDATED, applyBranding);
}
