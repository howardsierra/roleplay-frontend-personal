// Reverie bootstrap.
import { state, loadSettings, saveSettings } from './state.js';
import { eventSource, event_types } from './events.js';
import { applyTheme } from './themes.js';
import { ensurePreset } from './preset-store.js';
import { loadCharacters, renderLibrary, openCharacter, importCharacter, createCharacter, showChatList, newChat } from './characters.js';
import { bindChatEvents, sendMessage, generate, stopGeneration, autoGrow, showPromptPreview, swipeRight } from './chat.js';
import { initSettings, openSettings } from './panels/settings.js';
import { openImageStudio, openGallery } from './imagegen.js';
import { installCompat, installStDom, frameRpc, executeSlashCommands, registerNativeOverrides } from './st/compat.js';
import { loadExtensions } from './st/extensions-loader.js';
import { loadReverieExtensions } from './rv-ext/loader.js';
import { loadLumiverseExtensions } from './spindle/host.js';
import { initDialogueColors, openCastEditor } from './dialogue-colors.js';
import { renderHome, bindHome } from './home.js';
import { setFrameRpcHandler } from './render.js';
import { initLayout } from './layout.js';
import { el, icon, toast, modal, toggleDrawer, closeAllDrawers, openDrawer, isMobile } from './ui.js';

const $id = id => document.getElementById(id);

function coreActions() {
    const menu = $id('core-actions-menu');
    const items = [
        ['rotate', 'Regenerate', () => (state.chat.at(-1)?.is_user ? generate('normal') : swipeRight())],
        ['forward', 'Continue', () => generate('continue')],
        ['user-pen', 'Write for me (impersonate)', () => generate('impersonate')],
        ['wand-magic-sparkles', 'Illustrate the scene', () => openImageStudio('scene')],
        ['image', 'Image studio', () => openImageStudio('free')],
        ['clapperboard', 'Previously on… (recap)', () => import('./recap.js').then(m => m.showRecap({ force: true }))],
        ['comments', 'Chats', showChatList],
        ['square-plus', 'New chat', newChat],
        ['magnifying-glass-chart', 'Prompt inspector', showPromptPreview],
        ['note-sticky', "Author's note", () => openSettings('advanced')],
        ['palette', 'Cast colors', openCastEditor],
    ];
    menu.replaceChildren(...items.map(([ic, label, fn]) => el('button', { class: 'menu-item list-group-item', onclick: () => { hideMenu(); fn(); } }, icon(ic), el('span', {}, label))));
}

function hideMenu() {
    $id('extensionsMenu').classList.add('hidden');
}

/** --rv-composer-h: the message box's height, so floating extension UI can stay clear of it. */
function trackComposerHeight() {
    const form = document.getElementById('form_sheld');
    if (!form || !window.ResizeObserver) return;
    const set = () => {
        const r = form.getBoundingClientRect();
        document.documentElement.style.setProperty('--rv-composer-h', `${r.height ? Math.ceil(innerHeight - r.top) : 0}px`);
    };
    document.addEventListener('rv:home', set);
    new ResizeObserver(() => { set(); liftLaunchers(); }).observe(form);
    addEventListener('resize', () => { set(); liftLaunchers(); });
    // Extensions add their floating buttons whenever they like; check again when the page changes.
    let pending = 0;
    new MutationObserver(() => { clearTimeout(pending); pending = setTimeout(liftLaunchers, 250); }).observe(document.body, { childList: true });
    set();
}

/**
 * Small floating buttons that extensions pin to the screen corners (Offstage, Phone & PC, …) are
 * lifted above the message box when they would cover it, so the send button stays reachable.
 */
const OWN_LAYERS = '#app, #bg_layer, #toast-container, #modal-root, #st-dom, #movingDivs, #root, .lv-dock, .lv-dock-tabs, .popover-menu, .drawer, script, style, link';
function liftLaunchers() {
    const form = document.getElementById('form_sheld');
    const box = form?.getBoundingClientRect();
    if (!box?.height) return;
    const composerH = Math.ceil(innerHeight - box.top);
    const placed = []; // { left, right, top } of launchers already lifted this pass
    for (const node of document.body.children) {
        if (node.matches(OWN_LAYERS)) continue;
        const cs = getComputedStyle(node);
        if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') continue;
        const r = node.getBoundingClientRect();
        if (!r.width || r.width > 280 || r.height > 180) continue;
        const lifted = node.dataset.rvLifted === '1';
        const covers = r.bottom > box.top + 2 && r.top < box.bottom && r.right > box.left && r.left < box.right;
        if (!covers && !lifted) continue;
        // Stack above the message box, and above any launcher already lifted in the same column.
        let bottom = composerH + 12;
        for (const p of placed) if (r.right > p.left && r.left < p.right) bottom = Math.max(bottom, innerHeight - p.top + 8);
        node.style.setProperty('top', 'auto', 'important');
        node.style.setProperty('bottom', `${bottom}px`, 'important');
        node.dataset.rvLifted = '1';
        placed.push({ left: r.left, right: r.right, top: innerHeight - bottom - r.height });
    }
}

function bindUi() {
    trackComposerHeight();
    $id('btn-library').addEventListener('click', () => toggleDrawer('left-nav-panel'));
    $id('btn-settings').addEventListener('click', () => openSettings());
    $id('btn-gallery').addEventListener('click', openGallery);
    $id('chat-title').addEventListener('click', () => (state.character ? showChatList() : openDrawer('left-nav-panel')));
    $id('scrim').addEventListener('click', closeAllDrawers);
    document.querySelectorAll('.drawer-close').forEach(b => b.addEventListener('click', closeAllDrawers));
    document.addEventListener('click', e => {
        const target = e.target.closest('[data-action]');
        if (!target) return;
        const action = target.dataset.action;
        if (target.closest('summary')) e.preventDefault();
        if (action === 'import-character') importCharacter();
        if (action === 'create-character') createCharacter();
        if (action === 'new-story') newStory();
        if (action === 'gallery') { closeAllDrawers(); openGallery(); }
        if (action === 'open-settings' && target.dataset.tab === 'persona' && state.settings.extension_settings?.aevPersonaManager?.hijackDrawer !== false) {
            closeAllDrawers();
            import('./persona-manager/index.js').then(m => m.openManager());
        } else if (action === 'open-settings') openSettings(target.dataset.tab);
    });
    $id('char-search').addEventListener('input', renderLibrary);

    const ta = $id('send_textarea');
    const send = async () => {
        if (state.generating) return;
        const text = ta.value;
        if (text.trim().startsWith('/')) {
            ta.value = '';
            autoGrow();
            await executeSlashCommands(text.trim());
            return;
        }
        ta.value = '';
        autoGrow();
        localStorage.removeItem('rv-draft');
        await sendMessage(text);
    };
    ta.addEventListener('input', () => {
        autoGrow();
        localStorage.setItem('rv-draft', ta.value);
    });
    ta.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        const mode = state.settings.appearance.enterToSend;
        if (mode === 'never' || (mode === 'desktop' && isMobile())) return;
        e.preventDefault();
        send();
    });
    ta.value = localStorage.getItem('rv-draft') || '';
    $id('send_but').addEventListener('click', send);
    $id('mes_stop').addEventListener('click', stopGeneration);
    $id('btn-continue').addEventListener('click', () => generate('continue'));

    const menu = $id('extensionsMenu');
    $id('options_button').addEventListener('click', e => {
        e.stopPropagation();
        menu.classList.toggle('hidden');
    });
    document.addEventListener('click', e => {
        if (!menu.contains(e.target) && e.target !== $id('options_button')) hideMenu();
        else if (e.target.closest('#extensionsMenu .list-group-item, #extensionsMenu .menu-item')) setTimeout(hideMenu, 50);
    });

    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') { hideMenu(); closeAllDrawers(); }
        if (e.target.matches('input, textarea, [contenteditable]')) return;
        if (e.key === 'ArrowRight' && state.character && !document.querySelector('.modal-wrap')) swipeRight();
        if (e.key === 'ArrowLeft' && state.character && !document.querySelector('.modal-wrap')) import('./chat.js').then(m => m.swipeLeft());
    });

    // Keep the composer above the on-screen keyboard on phones.
    if (window.visualViewport) {
        const onResize = () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`);
        window.visualViewport.addEventListener('resize', onResize);
        onResize();
    }
}

async function newStory() {
    closeAllDrawers();
    if (!state.characters.length) return importCharacter();
    let close = () => {};
    const grid = el('div', { class: 'char-grid picker' }, state.characters.map(c => {
        const tile = el('button', { class: 'char-tile', title: c.name },
            el('div', { class: 'char-tile-img', style: { backgroundImage: `url("${c.avatar ? `files/avatars/${encodeURIComponent(c.avatar)}` : 'icons/icon.svg'}")` } }),
            el('div', { class: 'char-tile-info' }, el('div', { class: 'char-tile-name' }, c.name)));
        tile.addEventListener('click', async () => {
            close();
            await openCharacter(c.id);
            await newChat();
        });
        return tile;
    }));
    modal({
        title: 'Begin a new story',
        content: el('div', { class: 'stack' }, el('p', { class: 'hint' }, 'Choose who this story is with.'), grid,
            el('div', { class: 'row gap wrap' },
                el('button', { class: 'btn small', onclick: () => { close(); importCharacter(); } }, icon('file-import'), 'Import a card'),
                el('button', { class: 'btn small', onclick: () => { close(); createCharacter(); } }, icon('plus'), 'Create a character'))),
        wide: true,
        buttons: [],
        onOpen: (_b, c) => { close = c; },
    });
}

async function welcome() {
    const name = el('input', { class: 'input', type: 'text', placeholder: 'Your name', value: '' });
    const content = el('div', { class: 'stack welcome' },
        el('div', { class: 'home-mark' }, '✦'),
        el('p', {}, 'Welcome to Reverie — your private stage for roleplay. Characters, presets, themes and extensions from SillyTavern work here, and Lumiverse presets too.'),
        el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'What should characters call you?'), name));
    const go = await modal({
        title: 'Welcome',
        content,
        dismissable: false,
        buttons: [{ label: 'Set up AI connection', value: true, primary: true, icon: 'plug' }],
        onOpen: () => setTimeout(() => name.focus(), 80),
    });
    const s = state.settings;
    const persona = { id: crypto.randomUUID(), name: name.value.trim() || 'User', description: '', avatar: '' };
    s.personas = [persona, ...s.personas.filter(p => p.name !== 'User' || p.description)];
    s.personaId = persona.id;
    s.onboarded = true;
    await saveSettings();
    if (go) openSettings('connection');
}

async function boot() {
    installCompat();
    setFrameRpcHandler(frameRpc);
    await loadSettings();
    await eventSource.emit(event_types.SETTINGS_LOADED_BEFORE, state.settings);
    state.providers = await (await import('./api.js')).api.get('providers').catch(() => null);
    installStDom();
    applyTheme();
    initSettings();
    coreActions();
    bindUi();
    bindChatEvents();
    await ensurePreset();
    await loadCharacters();
    initLayout();
    initDialogueColors();
    await eventSource.emit(event_types.SETTINGS_LOADED, state.settings);
    await eventSource.emit(event_types.SETTINGS_LOADED_AFTER, state.settings);
    await eventSource.emit(event_types.APP_INITIALIZED);

    // Like SillyTavern: extensions load before the first chat opens, so they see CHAT_CHANGED for it.
    await loadExtensions();
    registerNativeOverrides();
    await loadReverieExtensions();
    await loadLumiverseExtensions().catch(err => console.error('Lumiverse extensions failed to load', err));
    await eventSource.emit(event_types.APP_READY);

    // Start on the home screen; recent stories are one tap away there.
    bindHome();
    import('./ambient.js').then(m => m.bindAmbient());
    import('./recap.js').then(m => m.bindRecap());
    import('./personas.js').then(m => m.bindPersonas());
    import('./avatar-banner.js').then(m => m.bindAvatarBanner());
    import('./persona-switch.js').then(m => m.bindPersonaSwitch());
    setTimeout(() => import('./backup.js').then(m => m.backupReminder()), 8000);
    import('./persona-manager/index.js').then(m => m.initPersonaManager());
    $id('btn-persona').addEventListener('click', () => {
        closeAllDrawers();
        if (state.settings.extension_settings?.aevPersonaManager?.hijackDrawer === false) openSettings('persona');
        else import('./persona-manager/index.js').then(m => m.openManager());
    });
    renderHome();
    document.body.classList.add('ready');

    if (!state.settings.onboarded) await welcome();
    else if (!state.settings.connection.model) {
        setTimeout(() => toast('Choose an AI provider and model in Settings → Connection to start chatting.', 'info', { timeout: 8000 }), 600);
    }
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch(err => {
    console.error(err);
    toast(`Startup failed: ${err.message}`, 'error', { timeout: 0 });
});
