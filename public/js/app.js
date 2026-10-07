// Reverie bootstrap.
import { state, loadSettings, saveSettings } from './state.js';
import { eventSource, event_types } from './events.js';
import { applyTheme } from './themes.js';
import { ensurePreset } from './preset-store.js';
import { loadCharacters, renderLibrary, openCharacter, importCharacter, createCharacter, showChatList, newChat } from './characters.js';
import { bindChatEvents, sendMessage, generate, stopGeneration, autoGrow, showPromptPreview, swipeRight } from './chat.js';
import { initSettings, openSettings } from './panels/settings.js';
import { openImageStudio, openGallery } from './imagegen.js';
import { installCompat, frameRpc, executeSlashCommands } from './st/compat.js';
import { loadExtensions } from './st/extensions-loader.js';
import { setFrameRpcHandler } from './render.js';
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
        ['comments', 'Chats', showChatList],
        ['square-plus', 'New chat', newChat],
        ['scroll', 'Prompt preview', showPromptPreview],
        ['note-sticky', "Author's note", () => openSettings('advanced')],
    ];
    menu.replaceChildren(...items.map(([ic, label, fn]) => el('button', { class: 'menu-item list-group-item', onclick: () => { hideMenu(); fn(); } }, icon(ic), el('span', {}, label))));
}

function hideMenu() {
    $id('extensionsMenu').classList.add('hidden');
}

function bindUi() {
    $id('btn-library').addEventListener('click', () => toggleDrawer('left-nav-panel'));
    $id('btn-settings').addEventListener('click', () => openSettings());
    $id('btn-gallery').addEventListener('click', openGallery);
    $id('chat-title').addEventListener('click', () => (state.character ? showChatList() : openDrawer('left-nav-panel')));
    $id('scrim').addEventListener('click', closeAllDrawers);
    document.querySelectorAll('.drawer-close').forEach(b => b.addEventListener('click', closeAllDrawers));
    document.addEventListener('click', e => {
        const action = e.target.closest('[data-action]')?.dataset.action;
        if (action === 'import-character') importCharacter();
        if (action === 'create-character') createCharacter();
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
    applyTheme();
    initSettings();
    coreActions();
    bindUi();
    bindChatEvents();
    await ensurePreset();
    await loadCharacters();
    await eventSource.emit(event_types.SETTINGS_LOADED, state.settings);
    await eventSource.emit(event_types.SETTINGS_LOADED_AFTER, state.settings);
    await eventSource.emit(event_types.APP_INITIALIZED);

    const last = state.settings.lastCharacterId;
    if (last && state.characters.some(c => c.id === last)) await openCharacter(last);

    document.body.classList.add('ready');
    await loadExtensions();
    await eventSource.emit(event_types.APP_READY);

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
