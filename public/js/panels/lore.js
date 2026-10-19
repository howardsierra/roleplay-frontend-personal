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
            slider('Scan depth (messages)', cfg.scanDepth, { min: 0, max: 30, step: 1, onChange: v => { cfg.scanDepth = v; saveSettingsDebounced(); }, hint: '0 = only always-on entries.' }),
            slider('Budget (% of context)', cfg.budgetPercent, { min: 1, max: 100, step: 1, onChange: v => { cfg.budgetPercent = v; saveSettingsDebounced(); } }),
            slider('Budget cap (tokens, 0 = none)', cfg.budgetCap || 0, { min: 0, max: 16000, step: 100, onChange: v => { cfg.budgetCap = v; saveSettingsDebounced(); } }),
            field('Priority between books', select([[1, 'Character lore first'], [2, 'Global lore first'], [0, 'Evenly (by order)']], cfg.characterStrategy ?? 1, v => { cfg.characterStrategy = Number(v); saveSettingsDebounced(); }), 'Chat lore always comes first, then the persona\'s. Decides what goes in when the budget runs out.'),
            slider('Max recursion steps (0 = unlimited)', cfg.maxRecursionSteps || 0, { min: 0, max: 10, step: 1, onChange: v => { cfg.maxRecursionSteps = v; saveSettingsDebounced(); } }),
            slider('Minimum activations', cfg.minActivations || 0, { min: 0, max: 20, step: 1, onChange: v => { cfg.minActivations = v; saveSettingsDebounced(); }, hint: 'Keep scanning further back until this many entries are active.' }),
            slider('…but scan back at most (0 = whole chat)', cfg.minActivationsDepthMax || 0, { min: 0, max: 100, step: 1, onChange: v => { cfg.minActivationsDepthMax = v; saveSettingsDebounced(); } }),
            toggle("Scan the Author's Note", !!cfg.scanAuthorsNote, v => { cfg.scanAuthorsNote = v; saveSettingsDebounced(); }, 'Keywords in the note can trigger entries.'),
            toggle('Recursive scanning', cfg.recursive, v => { cfg.recursive = v; saveSettingsDebounced(); }, 'Activated entries can trigger other entries.'),
            toggle('Include names when scanning', cfg.includeNames, v => { cfg.includeNames = v; saveSettingsDebounced(); }),
            toggle('Case-sensitive keys', !!cfg.caseSensitive, v => { cfg.caseSensitive = v; saveSettingsDebounced(); }, 'Default for entries that don\'t set their own.'),
            toggle('Match whole words', !!cfg.matchWholeWords, v => { cfg.matchWholeWords = v; saveSettingsDebounced(); }, '“cat” won\'t trigger on “category”. Default for entries that don\'t set their own.'),
            toggle('Group scoring', !!cfg.useGroupScoring, v => { cfg.useGroupScoring = v; saveSettingsDebounced(); }, 'In an inclusion group, the entry matching the most keywords wins.')));
}

const POSITIONS = [[0, 'Before character'], [1, 'After character'], [2, "Top of Author's Note"], [3, "Bottom of Author's Note"], [4, 'In chat @ depth'], [5, 'Before examples'], [6, 'After examples'], [7, 'Outlet ({{outlet::name}})']];
const TRISTATE = [['', 'Use global'], ['true', 'Yes'], ['false', 'No']];
const tri = v => (v === null || v === undefined ? '' : String(!!v));
const fromTri = v => (v === '' ? null : v === 'true');
const splitList = v => v.split(',').map(s => s.trim()).filter(Boolean);
function numInput(value, onChange, attrs = {}) {
    const i = el('input', { class: 'input', type: 'number', ...attrs });
    i.value = value ?? '';
    i.addEventListener('input', () => onChange(i.value === '' ? null : Number(i.value)));
    return i;
}
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
                await api.put(`characters/${encodeURIComponent(state.character.id)}`, { data: { character_book: state.character.card.data.character_book }, extensions: { world: world.name } });
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
            toggle('No recursion', e.preventRecursion, v => { e.preventRecursion = v; }),
            toggle('Locked', !!e.locked, v => { e.locked = v; }, 'The Lorebook Keeper agent won\'t change it.')),
        advanced(e),
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

// SillyTavern's finer controls: timing, groups, filters and extra text to match against.
function advanced(e) {
    e.characterFilter ??= { isExclude: false, names: [], tags: [] };
    const cf = e.characterFilter;
    return el('details', { class: 'entry-advanced' },
        el('summary', {}, 'More options'),
        el('div', { class: 'stack' },
            el('div', { class: 'grid-3' },
                field('Sticky (messages)', numInput(e.sticky || 0, v => { e.sticky = v || 0; }, { min: 0 }), 'Stays on this long after it triggers.'),
                field('Cooldown (messages)', numInput(e.cooldown || 0, v => { e.cooldown = v || 0; }, { min: 0 }), "Can't trigger again for this long."),
                field('Delay (messages)', numInput(e.delay || 0, v => { e.delay = v || 0; }, { min: 0 }), 'Only once the chat is this long.')),
            el('div', { class: 'grid-3' },
                field('Inclusion group', textInput(e.group || '', v => { e.group = v; }, { placeholder: 'weather' }), 'Only one entry per group goes in.'),
                field('Group weight', numInput(e.groupWeight ?? 100, v => { e.groupWeight = v ?? 100; }, { min: 0 })),
                field('Scan depth', numInput(e.scanDepth, v => { e.scanDepth = v || null; }, { min: 0, placeholder: 'global' }))),
            el('div', { class: 'grid-3' },
                field('Case sensitive', select(TRISTATE, tri(e.caseSensitive), v => { e.caseSensitive = fromTri(v); })),
                field('Whole words', select(TRISTATE, tri(e.matchWholeWords), v => { e.matchWholeWords = fromTri(v); })),
                field('Group scoring', select(TRISTATE, tri(e.useGroupScoring), v => { e.useGroupScoring = fromTri(v); }))),
            field('Outlet name', textInput(e.outletName || '', v => { e.outletName = v; }), 'With position “Outlet”, the text appears wherever a preset block says {{outlet::name}}.'),
            el('div', { class: 'grid-2' },
                field('Only for characters', textInput((cf.names || []).join(', '), v => { cf.names = splitList(v); }, { placeholder: 'names, comma separated' })),
                field('Only for tags', textInput((cf.tags || []).join(', '), v => { cf.tags = splitList(v); }))),
            el('div', { class: 'row gap wrap' },
                toggle('Exclude those instead', !!cf.isExclude, v => { cf.isExclude = v; }),
                toggle('Prioritize in group', !!e.groupOverride, v => { e.groupOverride = v; }),
                toggle('Ignore budget', !!e.ignoreBudget, v => { e.ignoreBudget = v; }),
                toggle('Not triggered by other entries', !!e.excludeRecursion, v => { e.excludeRecursion = v; })),
            el('div', { class: 'grid-2' },
                field('Only triggered by other entries', numInput(e.delayUntilRecursion === true ? 1 : Number(e.delayUntilRecursion) || 0, v => { e.delayUntilRecursion = v > 0 ? v : false; }, { min: 0 }), '0 = off. Higher levels wait for later passes.'),
                field('Only for', select([['', 'Every kind of reply'], ['normal', 'Normal replies'], ['continue', 'Continue'], ['impersonate', 'Impersonate'], ['swipe', 'Swipe'], ['regenerate', 'Regenerate'], ['quiet', 'Background (quiet)']], (e.triggers || [])[0] || '', v => { e.triggers = v ? [v] : []; }), (e.triggers || []).length > 1 ? `Imported with: ${e.triggers.join(', ')}` : 'Start the content with @@activate or @@dont_activate to force it on or off.')),
            el('span', { class: 'field-label' }, 'Also match keywords in'),
            el('div', { class: 'row gap wrap' },
                toggle('Persona description', !!e.matchPersonaDescription, v => { e.matchPersonaDescription = v; }),
                toggle('Character description', !!e.matchCharacterDescription, v => { e.matchCharacterDescription = v; }),
                toggle('Personality', !!e.matchCharacterPersonality, v => { e.matchCharacterPersonality = v; }),
                toggle("Character's Note", !!e.matchCharacterDepthPrompt, v => { e.matchCharacterDepthPrompt = v; }),
                toggle('Scenario', !!e.matchScenario, v => { e.matchScenario = v; }),
                toggle('Creator notes', !!e.matchCreatorNotes, v => { e.matchCreatorNotes = v; }))));
}
