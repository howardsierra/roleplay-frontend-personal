import { api } from '../api.js';
import { state, saveSettingsDebounced, chatMetadata, saveChat } from '../state.js';
import { normalizeWorld, newEntry, loadWorld, saveWorld, toCharacterBook } from '../worldinfo.js';
import { el, icon, field, select, textInput, textArea, toggle, slider, section, toast, modal, confirmDialog, promptDialog, pickFile, download } from '../ui.js';

let rootBody;
const rerender = () => { rootBody.replaceChildren(); render(rootBody); };

export async function render(body) {
    rootBody = body;
    const cfg = state.settings.worlds;
    const worlds = await api.get('worlds');
    const active = new Set(cfg.active);
    const linked = state.character?.card?.data?.extensions?.world;
    const chatBook = state.chatId ? chatMetadata().world_info : null;

    const list = el('div', { class: 'stack' }, worlds.map(w => {
        const sw = el('input', { type: 'checkbox', class: 'switch-input' });
        sw.checked = active.has(w.id);
        sw.addEventListener('change', () => {
            cfg.active = sw.checked ? [...new Set([...cfg.active, w.id])] : cfg.active.filter(x => x !== w.id);
            saveSettingsDebounced();
        });
        return el('div', { class: 'list-row' },
            el('button', { class: 'list-row-main', onclick: () => openWorld(w.id) },
                el('span', { class: 'list-row-title' }, icon('book'), ' ', w.name),
                el('span', { class: 'hint' }, `${w.count} entries`, w.name === linked ? ' · linked to character' : '', w.name === chatBook ? ' · bound to chat' : '')),
            el('label', { class: 'switch small', title: 'Always active (global)' }, sw, el('span', { class: 'switch-track' })));
    }));
    if (!worlds.length) list.append(el('div', { class: 'empty' }, 'No lorebooks yet.'));

    body.append(
        section('Lorebooks',
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', onclick: async () => {
                    const name = await promptDialog('Lorebook name', 'New Lorebook', { title: 'Create lorebook' });
                    if (!name) return;
                    const w = await api.post('worlds', { name, entries: {} });
                    rerender();
                    openWorld(w.id);
                } }, icon('plus'), 'New'),
                el('button', { class: 'btn small', onclick: async () => {
                    const files = await pickFile('.json,application/json', { multiple: true });
                    for (const file of files || []) {
                        try {
                            const world = normalizeWorld(JSON.parse(await file.text()), file.name.replace(/\.json$/i, ''));
                            await api.post('worlds', world);
                            toast(`Imported ${world.name}`, 'success');
                        } catch (err) { toast(`${file.name}: ${err.message}`, 'error'); }
                    }
                    rerender();
                } }, icon('file-import'), 'Import')),
            el('p', { class: 'hint' }, 'Switch on to make a lorebook active in every chat. A character\'s linked lorebook and its embedded book are always used with that character.'),
            list),
        state.chatId ? section('This chat',
            field('Chat lorebook', select([['', '— none —'], ...worlds.map(w => [w.name, w.name])], chatBook || '', async v => {
                chatMetadata().world_info = v || undefined;
                await saveChat();
            }))) : '',
        section('Activation',
            slider('Scan depth (messages)', cfg.scanDepth, { min: 1, max: 30, step: 1, onChange: v => { cfg.scanDepth = v; saveSettingsDebounced(); } }),
            slider('Budget (% of context)', cfg.budgetPercent, { min: 5, max: 100, step: 1, onChange: v => { cfg.budgetPercent = v; saveSettingsDebounced(); } }),
            toggle('Recursive scanning', cfg.recursive, v => { cfg.recursive = v; saveSettingsDebounced(); }, 'Activated entries can trigger other entries.'),
            toggle('Include names when scanning', cfg.includeNames, v => { cfg.includeNames = v; saveSettingsDebounced(); })));
}

const POSITIONS = [[0, 'Before character'], [1, 'After character'], [2, "Top of Author's Note"], [3, "Bottom of Author's Note"], [4, 'In chat @ depth'], [5, 'Before examples'], [6, 'After examples']];
const LOGIC = [[0, 'AND ANY'], [1, 'NOT ALL'], [2, 'NOT ANY'], [3, 'AND ALL']];

async function openWorld(id) {
    const world = structuredClone(await loadWorld(id));
    const entriesBox = el('div', { class: 'stack' });
    let filter = '';
    const renderEntries = () => {
        const entries = Object.entries(world.entries).filter(([, e]) => !filter || `${e.comment} ${e.key.join(' ')} ${e.content}`.toLowerCase().includes(filter));
        entriesBox.replaceChildren(...entries.sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0)).map(([k, e]) => entryCard(world, k, e, renderEntries)));
        if (!entries.length) entriesBox.append(el('div', { class: 'empty' }, 'No entries.'));
    };
    renderEntries();
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Filter entries…' });
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); renderEntries(); });
    const content = el('div', { class: 'stack' },
        field('Name', textInput(world.name, v => { world.name = v; })),
        el('div', { class: 'row gap wrap' },
            el('button', { class: 'btn small primary', onclick: () => {
                const uid = Math.max(-1, ...Object.keys(world.entries).map(Number)) + 1;
                world.entries[uid] = newEntry(uid, { comment: 'New entry' });
                renderEntries();
            } }, icon('plus'), 'Add entry'),
            el('button', { class: 'btn small', onclick: () => download(`${world.name}.json`, { entries: world.entries }) }, icon('download'), 'Export'),
            state.character ? el('button', { class: 'btn small', onclick: async () => {
                state.character.card.data.extensions = { ...(state.character.card.data.extensions || {}), world: world.name };
                state.character.card.data.character_book = toCharacterBook(world);
                await api.put(`characters/${encodeURIComponent(state.character.id)}`, { card: state.character.card });
                toast(`Linked to ${state.character.card.data.name}`, 'success');
            } }, icon('link'), 'Link to current character') : null,
            el('button', { class: 'btn small danger', onclick: async () => {
                if (!await confirmDialog(`Delete lorebook “${world.name}”?`, { okLabel: 'Delete', danger: true })) return;
                await api.del(`worlds/${encodeURIComponent(id)}`);
                state.worldsCache.delete(id);
                state.settings.worlds.active = state.settings.worlds.active.filter(x => x !== id);
                saveSettingsDebounced();
                document.querySelector('.modal-wrap.open:last-child .modal-head .icon-btn')?.click();
                rerender();
            } }, icon('trash-can'), 'Delete')),
        search,
        entriesBox);
    const ok = await modal({ title: world.name, content, wide: true, buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true, icon: 'check' }] });
    if (!ok) return;
    await saveWorld(world);
    toast('Lorebook saved', 'success', { timeout: 1500 });
    rerender();
}

function entryCard(world, key, e, refresh) {
    const keys = textInput(e.key.join(', '), v => { e.key = v.split(',').map(s => s.trim()).filter(Boolean); }, { placeholder: 'dragon, /drak(e|on)s?/i' });
    const sec = textInput(e.keysecondary.join(', '), v => { e.keysecondary = v.split(',').map(s => s.trim()).filter(Boolean); });
    const body = el('div', { class: 'stack entry-body' },
        el('div', { class: 'grid-2' }, field('Keywords', keys, 'Comma separated. /regex/ allowed.'), field('Secondary keywords', sec)),
        field('Content', textArea(e.content, v => { e.content = v; }, { rows: 6 })),
        el('div', { class: 'grid-3' },
            field('Position', select(POSITIONS, e.position, v => { e.position = Number(v); })),
            field('Order', (() => { const i = el('input', { class: 'input', type: 'number' }); i.value = e.order; i.addEventListener('input', () => { e.order = Number(i.value); }); return i; })()),
            field('Depth', (() => { const i = el('input', { class: 'input', type: 'number', min: 0 }); i.value = e.depth; i.addEventListener('input', () => { e.depth = Number(i.value); }); return i; })())),
        el('div', { class: 'grid-3' },
            field('Secondary logic', select(LOGIC, e.selectiveLogic, v => { e.selectiveLogic = Number(v); })),
            field('Probability %', (() => { const i = el('input', { class: 'input', type: 'number', min: 0, max: 100 }); i.value = e.probability; i.addEventListener('input', () => { e.probability = Number(i.value); }); return i; })()),
            field('Role (@depth)', select([[0, 'System'], [1, 'User'], [2, 'Assistant']], e.role, v => { e.role = Number(v); }))),
        el('div', { class: 'row gap wrap' },
            toggle('Always on', e.constant, v => { e.constant = v; }),
            toggle('Case sensitive', !!e.caseSensitive, v => { e.caseSensitive = v; }),
            toggle('Whole words', !!e.matchWholeWords, v => { e.matchWholeWords = v; }),
            toggle('No recursion', e.preventRecursion, v => { e.preventRecursion = v; })),
        el('button', { class: 'btn small danger', onclick: () => { delete world.entries[key]; refresh(); } }, icon('trash-can'), 'Delete entry'));
    const det = el('details', { class: `entry-card${e.disable ? ' off' : ''}` },
        el('summary', {},
            el('span', { class: 'entry-title' }, e.constant ? icon('circle', 'const-dot') : icon('key'), ' ', e.comment || e.key.join(', ') || 'Untitled'),
            (() => {
                const sw = el('input', { type: 'checkbox', class: 'switch-input' });
                sw.checked = !e.disable;
                sw.addEventListener('click', ev => ev.stopPropagation());
                sw.addEventListener('change', () => { e.disable = !sw.checked; det.classList.toggle('off', e.disable); });
                return el('label', { class: 'switch small', onclick: ev => ev.stopPropagation() }, sw, el('span', { class: 'switch-track' }));
            })()),
        field('Title / memo', textInput(e.comment, v => { e.comment = v; })),
        body);
    return det;
}
