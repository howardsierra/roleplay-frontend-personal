// Chat view + generation flows (send, swipe/regenerate, continue, impersonate, quiet).
import { state, saveSettingsDebounced, saveChat, saveChatDebounced, charName, userName, currentPersona, chatMetadata, connectionRequest } from './state.js';
import { streamCompletion, completion } from './api.js';
import { eventSource, event_types } from './events.js';
import { buildPrompt, samplerParams } from './prompt.js';
import { substituteParams } from './macros.js';
import { applyRegex, REGEX_PLACEMENT } from './regex.js';
import { splitReasoning, endsInsideThinking, stripReasoning, modelStartsInside, learnStartsInside } from './reasoning.js';
import { createStreamPainter } from './stream-view.js';
import { formatMessage, hydrate } from './render.js';
import { el, icon, toast, confirmDialog, modal, escapeHtml, isMobile } from './ui.js';
import { points, plainMessage, onPointsChanged } from './rv-ext/points.js';
import { paintMessage } from './dialogue-colors.js';
import { messageId } from './message-ids.js';
import { recordEdit, hasHistory, showHistory } from './history.js';
import { renderGenDetails, toggleGenDetails, showInspector, recordCapture, newRequestId, generationStats, connectionLabel, captureKey } from './inspector.js';

const chatEl = () => document.getElementById('chat');
const textarea = () => document.getElementById('send_textarea');

export function nowDate() {
    return new Date().toISOString();
}

// ====================================================================
// Rendering
// ====================================================================

export function avatarFor(mes) {
    if (mes.force_avatar) return mes.force_avatar;
    if (mes.is_user) return currentPersona().avatar || 'icons/user.svg';
    return state.character?.avatar ? `files/avatars/${encodeURIComponent(state.character.avatar)}` : 'icons/icon.svg';
}

function formatTime(date) {
    if (!date) return '';
    const d = new Date(date);
    if (Number.isNaN(d.getTime())) return String(date);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function messageTemplate(mes, id) {
    const node = el('div', {
        class: `mes${mes.is_user ? ' user_mes' : ' char_mes'}${mes.is_system ? ' hidden_mes' : ''}`,
        mesid: id, ch_name: mes.name, is_user: String(!!mes.is_user), is_system: String(!!mes.is_system),
    });
    // Same structure and class names as SillyTavern's #message_template, so ST themes and
    // extensions (e.g. ones adding buttons to .extraMesButtons) find what they expect.
    node.innerHTML = `
        <div class="mesAvatarWrapper">
            <div class="avatar"><img alt="" loading="lazy"></div>
            <div class="mesIDDisplay"></div><div class="mes_timer"></div><div class="tokenCounterDisplay"></div>
        </div>
        <div class="swipe_left fa-solid fa-chevron-left" title="Previous swipe" role="button" tabindex="0"></div>
        <div class="mes_block">
            <div class="ch_name flex-container justifySpaceBetween">
                <div class="flex-container flex1 alignitemscenter">
                    <div class="flex-container alignItemsBaseline">
                        <span class="name_text"></span>
                        <i class="mes_ghost fa-solid fa-ghost" title="Hidden from the AI"></i>
                        <small class="timestamp"></small>
                        <button class="rv-edited hidden" data-act="history" title="See edit history"><i class="fa-solid fa-clock-rotate-left"></i> edited</button>
                    </div>
                </div>
                <div class="mes_buttons">
                    <div class="mes_button extraMesButtonsHint fa-solid fa-ellipsis" data-act="more" title="More"></div>
                    <div class="extraMesButtons">
                        <div class="mes_button sd_message_gen fa-solid fa-paintbrush" data-act="image" title="Illustrate this message"></div>
                        <div class="mes_button mes_copy fa-solid fa-copy" data-act="copy" title="Copy"></div>
                    </div>
                    <div class="mes_button mes_edit fa-solid fa-pencil" data-act="edit" title="Edit"></div>
                </div>
            </div>
            <details class="mes_reasoning_details hidden">
                <summary class="mes_reasoning_summary flex-container"><i class="fa-solid fa-brain"></i> <span class="mes_reasoning_header_title reasoning-label">Thoughts</span></summary>
                <div class="mes_reasoning"></div>
            </details>
            <div class="mes_text"></div>
            <div class="mes_media_wrapper mes_media"></div>
            <div class="mes_file_wrapper"></div>
            <div class="mes_bias"></div>
        </div>
        <div class="flex-container swipeRightBlock flexFlowColumn flexNoGap">
            <div class="swipe_right fa-solid fa-chevron-right" title="Next swipe / new reply" role="button" tabindex="0"></div>
            <div class="swipes-counter"></div>
        </div>`;
    return node;
}

/** Called after a message is (re)rendered: hook(node, mes, index, { streaming }). */
export const renderHooks = new Set();

export function renderMessageInto(node, mes, id, { streaming = false } = {}) {
    node.setAttribute('mesid', id);
    node.setAttribute('data-message-id', messageId(mes));
    node.setAttribute('data-message-index', id);
    // Lumiverse's message anatomy, for extensions that look for it.
    node.dataset.part = streaming ? 'streaming' : mes.is_user ? 'user' : 'character';
    node.dataset.swipeId = mes.swipe_id ?? 0;
    node.querySelector('.mes_block')?.classList.add('rv-bubble');
    const prose = node.querySelector('.mes_text');
    if (prose && !prose.dataset.component) { prose.dataset.component = 'MessageContent'; prose.classList.add('rv-prose'); }
    node.setAttribute('ch_name', mes.name ?? '');
    node.setAttribute('is_system', String(!!mes.is_system));
    node.classList.toggle('hidden_mes', !!mes.is_system);
    node.querySelector('.avatar img').src = avatarFor(mes);
    node.querySelector('.name_text').textContent = mes.name ?? '';
    node.querySelector('.timestamp').textContent = state.settings.appearance.showTimestamps ? formatTime(mes.send_date) : '';
    node.querySelector('.rv-edited')?.classList.toggle('hidden', streaming || !hasHistory(mes));

    const depth = state.chat.length - 1 - id;
    const textEl = node.querySelector('.mes_text');
    // Messages saved with inline <think> blocks (older chats, imports, extension edits): show the story only.
    const inline = !streaming && !mes.is_user ? splitReasoning(mes.mes) : { reasoning: '', text: mes.mes };
    const result = formatMessage(inline.text, { isUser: mes.is_user, depth, streaming, message: mes, id });
    textEl.innerHTML = result.html;
    hydrate(textEl, result, { streaming, message: mes, onPic: (prompt, force) => import('./imagegen.js').then(m => m.generateInlinePic(id, prompt, force)) });
    if (streaming && !mes.mes) textEl.innerHTML = '<span class="rv-dots"><span></span><span></span><span></span></span>';

    const reasoning = [mes.extra?.reasoning, inline.reasoning].filter(Boolean).join('\n\n');
    const det = node.querySelector('.mes_reasoning_details');
    det.classList.toggle('hidden', !reasoning);
    if (reasoning) {
        const r = formatMessage(reasoning, { isReasoning: true, streaming: true });
        const rEl = det.querySelector('.mes_reasoning');
        rEl.innerHTML = r.html;
        const secs = mes.extra?.reasoning_duration ? ` for ${Math.round(mes.extra.reasoning_duration / 1000)}s` : '';
        det.querySelector('.reasoning-label').textContent = streaming && !mes.mes ? 'Thinking…' : `Thought${secs}`;
        const collapsed = state.settings.render.reasoningCollapsed !== false;
        if (streaming && !mes.mes) { det.open = true; det.dataset.autoOpened = '1'; } // watch it think
        else if (!streaming && det.dataset.autoOpened) { det.open = !collapsed; delete det.dataset.autoOpened; }
        else if (!det.dataset.init) det.open = !collapsed;
        det.dataset.init = '1';
    }

    const media = node.querySelector('.mes_media');
    media.replaceChildren();
    const images = mes.extra?.media?.length ? mes.extra.media : (mes.extra?.image ? [{ url: mes.extra.image, title: mes.extra.title }] : []);
    for (const m of images) {
        const url = m.url || m;
        media.append(el('figure', { class: 'mes_img_container' },
            el('img', { class: 'mes_img rv-zoomable', src: url, alt: m.title || '', loading: 'lazy' }),
            m.title ? el('figcaption', {}, m.title) : null));
    }

    // Message actions contributed by Reverie extensions.
    const extra = node.querySelector('.extraMesButtons');
    extra.querySelectorAll('.rvext-action').forEach(n => n.remove());
    for (const action of points.messageActions.list()) {
        try {
            if (action.when && !action.when(plainMessage(mes, id), id)) continue;
        } catch { continue; }
        extra.append(el('div', { class: `mes_button rvext-action fa-solid fa-${action.icon || 'puzzle-piece'}`, title: action.title || '', 'data-rvext-action': action.id }));
    }

    paintMessage(node, mes);
    renderGenDetails(node, mes, id, { streaming });
    for (const hook of renderHooks) {
        try { hook(node, mes, id, { streaming }); } catch (err) { console.error('Render hook failed', err); }
    }

    paintSwipeControls(node, mes, id);
}

/** Swipe arrows, counter and the last-message mark (cheap: doesn't touch the message body). */
function paintSwipeControls(node, mes, id) {
    const swipes = mes.swipes?.length || 1;
    const isLast = id === state.chat.length - 1;
    const canSwipe = isLast && !mes.is_user && !mes.is_system && (swipes > 1 || id > 0 || state.chat.length > 0);
    node.classList.toggle('swipes-visible', canSwipe || swipes > 1);
    node.querySelector('.swipes-counter').textContent = swipes > 1 ? `${(mes.swipe_id ?? 0) + 1} / ${swipes}` : '';
    node.querySelector('.swipe_right').classList.toggle('hidden', !canSwipe);
    node.querySelector('.swipe_left').classList.toggle('hidden', !(canSwipe && (mes.swipe_id ?? 0) > 0) && !(swipes > 1 && isLast));
    node.classList.toggle('last_mes', isLast);
}

export function addOneMessage(mes, { scroll = true, forceId } = {}) {
    const id = forceId ?? state.chat.indexOf(mes);
    const node = messageTemplate(mes, id);
    renderMessageInto(node, mes, id);
    chatEl().append(node);
    chatEl().querySelectorAll('.last_mes').forEach(n => { if (n !== node) n.classList.remove('last_mes'); });
    if (scroll) scrollToBottom();
    return node;
}

export function messageNode(id) {
    return chatEl().querySelector(`.mes[mesid="${id}"]`);
}

export function updateMessageBlock(id, mes = state.chat[id], opts) {
    const node = messageNode(id);
    if (!node) return;
    renderMessageInto(node, mes, Number(id), opts);
}

export function printMessages() {
    const root = chatEl();
    root.replaceChildren();
    const frag = document.createDocumentFragment();
    state.chat.forEach((mes, id) => {
        const node = messageTemplate(mes, id);
        renderMessageInto(node, mes, id);
        frag.append(node);
    });
    root.append(frag);
    refreshSwipeControls();
    window.dispatchEvent(new Event('rv:messages-printed'));
    scrollToBottom(true);
}

export function clearChat() {
    chatEl().replaceChildren();
}

export function refreshSwipeControls() {
    // Only the controls and the per-message extras (render hooks) change here. Re-rendering the whole
    // message would reload its HTML widgets and re-run their scripts on every send.
    const last = state.chat.length - 1;
    chatEl().querySelectorAll('.mes').forEach(node => {
        const id = Number(node.getAttribute('mesid'));
        const mes = state.chat[id];
        if (id < last - 1 || !mes) return;
        paintSwipeControls(node, mes, id);
        for (const hook of renderHooks) {
            try { hook(node, mes, id, { streaming: false }); } catch (err) { console.error('Render hook failed', err); }
        }
    });
}

let stickToBottom = true;
export function scrollToBottom(force = false) {
    const root = chatEl();
    if (force || stickToBottom) root.scrollTop = root.scrollHeight;
}

// ====================================================================
// Message actions
// ====================================================================

export function syncSwipe(mes) {
    if (!Array.isArray(mes.swipes) || !mes.swipes.length) return;
    mes.swipes[mes.swipe_id ?? 0] = mes.mes;
    mes.swipe_info ??= [];
    mes.swipe_info[mes.swipe_id ?? 0] = { ...(mes.swipe_info[mes.swipe_id ?? 0] || {}), send_date: mes.send_date, extra: structuredClone(mes.extra || {}) };
}

export async function swipeTo(id, swipeId) {
    const mes = state.chat[id];
    if (!mes?.swipes?.length) return;
    syncSwipe(mes);
    mes.swipe_id = Math.max(0, Math.min(mes.swipes.length - 1, swipeId));
    mes.mes = mes.swipes[mes.swipe_id];
    const info = mes.swipe_info?.[mes.swipe_id];
    if (info?.extra) mes.extra = structuredClone(info.extra);
    if (info?.send_date) mes.send_date = info.send_date;
    const node = messageNode(id);
    node?.classList.add('swiping');
    updateMessageBlock(id);
    setTimeout(() => node?.classList.remove('swiping'), 260);
    saveChatDebounced();
    await eventSource.emit(event_types.MESSAGE_SWIPED, id);
}

export async function swipeLeft() {
    const id = state.chat.length - 1;
    const mes = state.chat[id];
    if (!mes || mes.is_user || state.generating) return;
    if ((mes.swipe_id ?? 0) > 0) await swipeTo(id, mes.swipe_id - 1);
}

export async function swipeRight() {
    const id = state.chat.length - 1;
    const mes = state.chat[id];
    if (!mes || mes.is_user || state.generating) return;
    if (mes.swipes && (mes.swipe_id ?? 0) < mes.swipes.length - 1) return swipeTo(id, mes.swipe_id + 1);
    if (id === 0 && !state.chat.some(m => m.is_user)) return; // greeting with no more alternates
    if (state.settings.generation.askOnRegenerate) return regenerateWithNote();
    return generate('swipe');
}

/**
 * Reroll the last reply, telling the AI what to change ("too long", "she wouldn't say that").
 * The note only goes into this one regeneration.
 */
let skipSwipeClickUntil = 0;
let noteDialogOpen = false;
export async function regenerateWithNote() {
    const id = state.chat.length - 1;
    const mes = state.chat[id];
    if (!mes || mes.is_user || noteDialogOpen) return;
    if (state.generating) return toast('Wait for the current reply to finish', 'info', { timeout: 2000 });
    noteDialogOpen = true;
    const input = el('textarea', { class: 'input', rows: 3, placeholder: 'e.g. shorter · more tension · she wouldn\'t forgive him that fast · describe the room' });
    let submit = () => {};
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    // Three ways out: a note, a plain reroll (no note), or never mind.
    const note = await modal({
        title: 'Regenerate',
        content: el('div', { class: 'stack' }, el('label', { class: 'field' }, el('span', { class: 'field-label' }, 'What should be different this time? (optional)'), input),
            el('p', { class: 'hint' }, 'The note only goes into this one regeneration.')),
        buttons: [
            { label: 'Cancel', value: null },
            { label: 'Just regenerate', value: '', icon: 'rotate' },
            { label: 'Regenerate with note', value: () => input.value, primary: true, icon: 'comment-dots' },
        ],
        onOpen: (_b, close) => { submit = () => close(input.value); setTimeout(() => input.focus(), 60); },
    });
    noteDialogOpen = false;
    if (note === null || note === undefined) return;
    if (String(note).trim()) {
        const { oneShot } = await import('./agents/core.js');
        oneShot('rv_regen_note', `[OOC: The previous attempt at this reply was rejected. Write it again, and this time: ${String(note).trim()}]`);
    }
    return generate('swipe');
}

async function editMessage(id) {
    const mes = state.chat[id];
    const node = messageNode(id);
    if (!node || node.classList.contains('editing')) return;
    node.classList.add('editing');
    const textEl = node.querySelector('.mes_text');
    const editor = el('textarea', { class: 'edit_textarea input' });
    editor.value = mes.mes;
    const done = async save => {
        if (save) {
            const before = mes.mes;
            mes.mes = applyRegex(editor.value, mes.is_user ? REGEX_PLACEMENT.USER_INPUT : REGEX_PLACEMENT.AI_OUTPUT, { isEdit: true });
            recordEdit(mes, before, mes.mes, 'edit');
            syncSwipe(mes);
            await saveChat();
            await eventSource.emit(event_types.MESSAGE_EDITED, id);
        }
        node.classList.remove('editing');
        bar.remove();
        editor.remove();
        textEl.classList.remove('hidden');
        updateMessageBlock(id);
        if (save) await eventSource.emit(event_types.MESSAGE_UPDATED, id);
    };
    // Edit and send: for your own messages, resend from here. With replies after it, that happens in a
    // new branch so the original chat is kept as it was.
    const later = mes.is_user && id < state.chat.length - 1;
    const resend = mes.is_user ? el('button', {
        class: 'btn small', title: later ? 'Make a new branch with this edit and get a fresh reply — the original chat stays as it was' : 'Save and get a reply',
        onclick: async () => {
            if (state.generating) return;
            const text = applyRegex(editor.value, REGEX_PLACEMENT.USER_INPUT, { isEdit: true });
            if (!later) {
                await done(true);
                return generate('normal');
            }
            await done(false);
            const edited = { ...structuredClone(mes), mes: text, swipes: undefined, swipe_id: undefined, swipe_info: undefined, send_date: nowDate() };
            delete edited.swipes; delete edited.swipe_id; delete edited.swipe_info;
            const { newChat } = await import('./characters.js');
            await newChat({ messages: [...structuredClone(state.chat.slice(0, id)), edited] });
            toast('Branched with your edit — the original chat is untouched', 'success', { timeout: 3500 });
            await generate('normal');
        },
    }, icon(later ? 'code-branch' : 'paper-plane'), later ? 'Branch & send' : 'Save & send') : null;
    const bar = el('div', { class: 'edit-bar' },
        el('button', { class: 'btn small', onclick: () => done(false) }, icon('xmark'), 'Cancel'),
        resend,
        el('button', { class: 'btn small primary', onclick: () => done(true) }, icon('check'), 'Save'));
    textEl.classList.add('hidden');
    textEl.after(editor, bar);
    const fit = () => { editor.style.height = 'auto'; editor.style.height = `${Math.min(editor.scrollHeight + 4, window.innerHeight * 0.6)}px`; };
    editor.addEventListener('input', fit);
    editor.addEventListener('keydown', e => {
        if (e.key === 'Escape') done(false);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done(true);
    });
    requestAnimationFrame(() => { fit(); editor.focus(); });
}

export async function deleteMessage(id) {
    state.chat.splice(id, 1);
    printMessages();
    await saveChat();
    await eventSource.emit(event_types.MESSAGE_DELETED, state.chat.length);
}

async function deleteSwipe(id) {
    const mes = state.chat[id];
    if (!mes?.swipes || mes.swipes.length < 2) return deleteMessage(id);
    const removed = mes.swipe_id ?? 0;
    mes.swipes.splice(removed, 1);
    mes.swipe_info?.splice(removed, 1);
    mes.swipe_id = Math.max(0, removed - 1);
    mes.mes = mes.swipes[mes.swipe_id];
    if (mes.swipe_info?.[mes.swipe_id]?.extra) mes.extra = structuredClone(mes.swipe_info[mes.swipe_id].extra);
    updateMessageBlock(id);
    await saveChat();
    await eventSource.emit(event_types.MESSAGE_SWIPE_DELETED, { messageId: id, swipeId: removed });
}

function openHistory(id) {
    return showHistory(id, { onRestore: mes => { syncSwipe(mes); updateMessageBlock(id); } });
}

async function moreMenu(id, anchor) {
    const mes = state.chat[id];
    const items = [
        ['eye-slash', mes.is_system ? 'Show to AI' : 'Hide from AI', async () => {
            mes.is_system = !mes.is_system;
            updateMessageBlock(id);
            await saveChat();
        }],
        hasHistory(mes) ? ['clock-rotate-left', 'Edit history', () => openHistory(id)] : null,
        !mes.is_user && id === state.chat.length - 1 ? ['rotate', 'Regenerate', () => (state.generating ? toast('Wait for the current reply to finish', 'info', { timeout: 2000 }) : generate('swipe'))] : null,
        !mes.is_user && id === state.chat.length - 1 ? ['comment-dots', 'Regenerate with a note…', () => regenerateWithNote()] : null,
        ['code-branch', 'Branch from here', () => import('./characters.js').then(m => m.branchChat(id))],
        mes.is_user ? null : ['magnifying-glass-chart', 'Inspect prompt', () => showInspector({ mesKey: captureKey(messageId(state.chat[id]), state.chat[id]?.swipe_id), gen: state.chat[id]?.extra?.gen })],
        mes.swipes?.length > 1 ? ['delete-left', 'Delete this swipe', () => deleteSwipe(id)] : null,
        ['trash-can', 'Delete message', async () => {
            if (await confirmDialog('Delete this message?', { okLabel: 'Delete', danger: true })) deleteMessage(id);
        }, 'danger'],
        ['trash-arrow-up', 'Delete this and everything after', async () => {
            if (!await confirmDialog(`Delete ${state.chat.length - id} message(s)?`, { okLabel: 'Delete', danger: true })) return;
            state.chat.splice(id);
            printMessages();
            await saveChat();
            await eventSource.emit(event_types.MESSAGE_DELETED, state.chat.length);
        }, 'danger'],
    ].filter(Boolean);
    popMenu(anchor, items);
}

let closeOpenMenu = null;
export function popMenu(anchor, items) {
    closeOpenMenu?.();
    document.querySelector('.ctx-menu')?.remove();
    const menu = el('div', { class: 'ctx-menu popover-menu', role: 'menu' },
        items.filter(Boolean).map(([ic, label, fn, cls]) => el('button', {
            class: `menu-item ${cls || ''}`, onclick: () => { close(); fn(); },
        }, icon(ic), el('span', {}, label))));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
    menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
    requestAnimationFrame(() => menu.classList.add('open'));
    // Every way of closing (item picked, tap outside, Esc, another menu) removes the listeners too;
    // a leftover Esc listener would swallow the next Esc meant for a dialog.
    function close() {
        menu.remove();
        document.removeEventListener('pointerdown', off, true);
        document.removeEventListener('keydown', onKey, true);
        if (closeOpenMenu === close) closeOpenMenu = null;
    }
    closeOpenMenu = close;
    const off = e => { if (!menu.contains(e.target)) close(); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    setTimeout(() => {
        document.addEventListener('pointerdown', off, true);
        document.addEventListener('keydown', onKey, true);
    });
}

export async function showPromptPreview() {
    return showInspector();
}

export function bindChatEvents() {
    const root = chatEl();
    onPointsChanged(kind => { if (kind === 'messageActions' || kind === 'renderers') printMessages(); });
    // Scrolled up to reread? Streaming stops pulling you down; a button brings you back to the latest text.
    const jump = el('button', { id: 'jump-latest', class: 'jump-latest hidden', title: 'Jump to the latest message', onclick: () => {
        stickToBottom = true;
        root.scrollTo({ top: root.scrollHeight, behavior: 'smooth' });
    } }, icon('arrow-down'), el('span', { class: 'jump-dot' }));
    root.after(jump);
    const syncJump = () => {
        const away = root.scrollHeight - root.scrollTop - root.clientHeight > 240;
        jump.classList.toggle('hidden', !away || !state.chat.length);
        jump.classList.toggle('live', away && state.generating);
    };
    root.addEventListener('scroll', () => {
        stickToBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
        syncJump();
    }, { passive: true });
    eventSource.on(event_types.GENERATION_STARTED, syncJump);
    eventSource.on(event_types.GENERATION_ENDED, syncJump);
    eventSource.on(event_types.CHAT_CHANGED, () => { stickToBottom = true; syncJump(); });

    // Long-press (or right-click) the new-reply arrow to regenerate with a note.
    let holdTimer = 0;
    let held = false;
    root.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !e.target.closest('.swipe_right')) return;
        held = false;
        clearTimeout(holdTimer);
        holdTimer = setTimeout(() => { held = true; regenerateWithNote(); }, 550);
    });
    const holdEnd = () => {
        clearTimeout(holdTimer);
        if (held) skipSwipeClickUntil = Date.now() + 500; // the click that ends a long-press
        held = false;
    };
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) root.addEventListener(ev, holdEnd);
    root.addEventListener('contextmenu', e => {
        if (!e.target.closest('.swipe_right')) return;
        e.preventDefault();
        clearTimeout(holdTimer);
        regenerateWithNote(); // ignored if the long-press already opened it
    });

    root.addEventListener('click', async e => {
        const mesNode = e.target.closest('.mes');
        if (!mesNode) return;
        const id = Number(mesNode.getAttribute('mesid'));
        const extAction = e.target.closest('[data-rvext-action]');
        if (extAction) {
            const action = points.messageActions.list().find(a => a.id === extAction.dataset.rvextAction);
            try { await action?.onClick?.(plainMessage(state.chat[id], id), id); } catch (err) { toast(err.message, 'error'); }
            return;
        }
        const btn = e.target.closest('[data-act], .swipe_left, .swipe_right');
        if (e.target.closest('.rv-zoomable')) return zoomImage(e.target.closest('.rv-zoomable').src);
        if (!btn) {
            if (isMobile()) {
                root.querySelectorAll('.mes.show-actions').forEach(n => n !== mesNode && n.classList.remove('show-actions'));
                if (!e.target.closest('a, button, details, .rv-frame-wrap, .rv-python, textarea')) mesNode.classList.toggle('show-actions');
            }
            return;
        }
        if (btn.classList.contains('swipe_left')) return swipeLeft();
        if (btn.classList.contains('swipe_right')) {
            if (Date.now() < skipSwipeClickUntil) return; // the long-press already opened the note
            return swipeRight();
        }
        const mes = state.chat[id];
        switch (btn.dataset.act) {
            case 'copy':
                await navigator.clipboard?.writeText(mes.mes);
                toast('Copied', 'success', { timeout: 1500 });
                break;
            case 'edit': editMessage(id); break;
            case 'image': import('./imagegen.js').then(m => m.illustrateMessage(id)); break;
            case 'more': moreMenu(id, btn); break;
            case 'gen-toggle':
                toggleGenDetails();
                chatEl().querySelectorAll('.mes').forEach(n => { const i = Number(n.getAttribute('mesid')); if (state.chat[i]?.extra?.gen) renderGenDetails(n, state.chat[i], i, {}); });
                break;
            case 'history': openHistory(id); break;
            case 'inspect': showInspector({ mesKey: captureKey(messageId(mes), mes.swipe_id), gen: mes.extra?.gen }); break;
            default: break;
        }
    });

    // Touch swipe on the last message to change swipes.
    let sx = 0;
    let sy = 0;
    let target = null;
    root.addEventListener('touchstart', e => {
        const node = e.target.closest('.mes.last_mes');
        if (!node || e.target.closest('.rv-frame-wrap, textarea, pre')) { target = null; return; }
        // Scrolling something wide sideways (a table, a long thinking block) is not a swipe.
        for (let n = e.target; n && n !== node; n = n.parentElement) {
            if (n.scrollWidth > n.clientWidth + 2 && /auto|scroll/.test(getComputedStyle(n).overflowX)) { target = null; return; }
        }
        target = node;
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
    }, { passive: true });
    root.addEventListener('touchend', e => {
        if (!target) return;
        const dx = e.changedTouches[0].clientX - sx;
        const dy = e.changedTouches[0].clientY - sy;
        target = null;
        if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 2) {
            if (dx < 0) swipeRight();
            else swipeLeft();
        }
    }, { passive: true });
}

export function zoomImage(src) {
    const img = el('img', { src, class: 'zoomed-img' });
    modal({ content: img, buttons: [], className: 'image-viewer' });
}

// ====================================================================
// Generation
// ====================================================================

let speedShownAt = 0;
/** "Writing… 42 t/s" in the toolbar status while a reply streams (≈4 characters per token). */
function reportSpeed(chars, since) {
    const t = Date.now();
    if (t - speedShownAt < 500 || !since || t - since < 800) return;
    speedShownAt = t;
    const label = document.querySelector('#gen-status .label');
    if (label && document.getElementById('gen-status').classList.contains('writing')) label.textContent = `Writing… ${Math.round(chars / 4 / ((t - since) / 1000))} t/s`;
}

function setGenerating(on) {
    state.generating = on;
    document.body.classList.toggle('generating', on);
    document.getElementById('send_but').classList.toggle('hidden', on);
    document.getElementById('mes_stop').classList.toggle('hidden', !on);
}

export function stopGeneration() {
    if (state.abortController) {
        state.abortController.abort();
        state.abortController = null;
        eventSource.emit(event_types.GENERATION_STOPPED);
        return true;
    }
    return false;
}

function connectionBody() {
    const c = state.settings.connection;
    return connectionRequest(c);
}

async function runInterceptors(type, abortController) {
    const { getInterceptors } = await import('./st/extensions-loader.js');
    let aborted = false;
    const abort = () => { aborted = true; };
    for (const fn of getInterceptors()) {
        try {
            await fn(state.chat, state.preset.samplers.context_size, abort, type);
        } catch (err) {
            console.error('Generate interceptor failed', err);
        }
        if (aborted) break;
    }
    if (aborted) abortController.abort();
    return !aborted;
}

export async function sendMessage(text, { generateAfter = true } = {}) {
    if (!state.character || state.generating) return;
    const raw = String(text ?? '');
    if (raw.trim()) {
        const mes = {
            name: userName(),
            is_user: true,
            is_system: false,
            send_date: nowDate(),
            mes: applyRegex(substituteParams(raw), REGEX_PLACEMENT.USER_INPUT),
            extra: {},
            force_avatar: currentPersona().avatar || undefined,
        };
        state.chat.push(mes);
        const id = state.chat.length - 1;
        await eventSource.emit(event_types.MESSAGE_SENT, id);
        refreshSwipeControls();
        addOneMessage(mes, { forceId: id });
        await eventSource.emit(event_types.USER_MESSAGE_RENDERED, id);
        await saveChat();
    }
    if (generateAfter) await generate('normal');
}

/**
 * @param {'normal'|'swipe'|'regenerate'|'continue'|'impersonate'|'quiet'} type
 */
export async function generate(type = 'normal', { quietPrompt = '', quietToLoud = false } = {}) {
    if (!state.character) {
        toast('Pick a character first', 'warning');
        return;
    }
    if (state.generating) {
        // Extensions often ask the AI something quietly while (or right as) a reply is written: answer them
        // on the side instead of returning nothing.
        if (type === 'quiet' && !quietToLoud) return quietOnTheSide(quietPrompt);
        return;
    }
    if (!state.settings.connection.model) {
        toast('Choose an API and model in Settings → Connection first.', 'warning');
        import('./panels/settings.js').then(m => m.openSettings('connection'));
        return;
    }
    const controller = new AbortController();
    state.abortController = controller;
    setGenerating(true);
    document.getElementById('typing-indicator').classList.remove('hidden');

    let target = null; // message being written
    let targetId = -1;
    let prefixText = '';
    let newSlot = false; // a new message or swipe was made for this reply (removed again if it stays empty)
    try {
        if (!(await runInterceptors(type, controller))) return;
        await eventSource.emit(event_types.GENERATION_STARTED, type, {}, false);
        await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, {}, false);

        if (type === 'swipe' || type === 'regenerate') {
            targetId = state.chat.length - 1;
            target = state.chat[targetId];
            if (!target || target.is_user || target.is_system) {
                type = 'normal';
                target = null;
            }
        }
        if (type === 'continue') {
            targetId = state.chat.length - 1;
            target = state.chat[targetId];
            if (!target || target.is_system) { type = 'normal'; target = null; }
            else prefixText = target.mes;
        }

        const built = await buildPrompt({ type, quietPrompt, chat: type === 'swipe' || type === 'regenerate' ? state.chat.slice(0, -1) : state.chat });
        const { messages, prefill, extraParams } = built;
        if (controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
        const requestId = newRequestId();
        const body = { ...connectionBody(), messages, params: { ...samplerParams(), ...extraParams }, requestId };
        const capture = {
            type, requestId, messages, labels: built.labels, breakdown: built.breakdown, tokens: built.tokens, lore: built.lore,
            loreTotal: built.loreTotal, cut: built.cut, model: body.model, connection: connectionLabel(), body: { ...body, requestId: undefined },
        };
        if (type === 'quiet' || type === 'impersonate') recordCapture(capture);

        if (type === 'quiet' && !quietToLoud) {
            const res = await completion(body, { signal: controller.signal });
            return stripReasoning(res.text);
        }
        if (type === 'impersonate') {
            let text = prefill || '';
            const ta = textarea();
            const stream = state.preset.samplers.stream;
            if (stream) {
                await streamCompletion(body, { signal: controller.signal, onText: t => { text += t; ta.value = text; autoGrow(); } });
            } else text += (await completion(body, { signal: controller.signal })).text;
            ta.value = splitReasoning(text, { startsInside: endsInsideThinking(prefill) }).text.trim();
            autoGrow();
            await eventSource.emit(event_types.IMPERSONATE_READY, ta.value);
            return ta.value;
        }

        if (!target) {
            target = {
                name: charName(),
                is_user: false,
                is_system: false,
                send_date: nowDate(),
                mes: '',
                swipes: [''],
                swipe_id: 0,
                swipe_info: [{}],
                extra: {},
            };
            state.chat.push(target);
            targetId = state.chat.length - 1;
            newSlot = true;
            refreshSwipeControls();
            addOneMessage(target, { forceId: targetId });
        } else if (type === 'swipe' || type === 'regenerate') {
            syncSwipe(target);
            target.swipes ??= [target.mes];
            target.swipe_info ??= target.swipes.map(() => ({}));
            target.swipes.push('');
            target.swipe_info.push({});
            target.swipe_id = target.swipes.length - 1;
            target.mes = '';
            target.extra = {};
            target.send_date = nowDate();
            newSlot = true;
            messageNode(targetId)?.classList.add('swiping');
            setTimeout(() => messageNode(targetId)?.classList.remove('swiping'), 260);
        }
        target.gen_started = nowDate();
        const startedAt = Date.now();
        let reasoningEnd = 0;
        let firstTextAt = 0;
        let result = null;
        let partialError = null;

        let text = '';
        let reasoning = ''; // from the provider's reasoning channel
        // Inline <think> blocks: a prefill that opens one means the reply starts inside it.
        const startsInside = type !== 'continue' && endsInsideThinking(prefill);
        const streamsInside = startsInside || (type !== 'continue' && modelStartsInside(body.model));
        const shownPrefill = prefill && state.settings.generation.showPrefill && !endsInsideThinking(prefill) && !splitReasoning(prefill).reasoning ? prefill : '';
        const paint = (shownText = text) => {
            const split = splitReasoning(shownText, { streaming: true, startsInside: streamsInside });
            // Regex that changes the saved message (e.g. hiding status blocks) also applies while streaming.
            const shown = applyRegex(split.text, REGEX_PLACEMENT.AI_OUTPUT);
            target.mes = type === 'continue' ? prefixText + shown : shownPrefill + shown;
            const allReasoning = [reasoning, split.reasoning].filter(Boolean).join('\n\n');
            if (allReasoning) target.extra.reasoning = allReasoning;
            if (!reasoningEnd && allReasoning && split.text.trim()) reasoningEnd = Date.now();
            updateMessageBlock(targetId, target, { streaming: true });
            scrollToBottom();
        };
        // Steady reveal + render pacing (stream-view.js).
        const painter = createStreamPainter(paint, { smooth: state.settings.appearance.smoothStreaming !== false });
        messageNode(targetId)?.classList.add('streaming');

        if (state.preset.samplers.stream !== false) {
            try {
                result = await streamCompletion(body, {
                    signal: controller.signal,
                    onText: t => {
                        if (!firstTextAt) firstTextAt = Date.now();
                        if (!reasoningEnd && reasoning) reasoningEnd = Date.now();
                        text += t;
                        painter.push(t);
                        reportSpeed(text.length, firstTextAt);
                        eventSource.emitAndWait(event_types.STREAM_TOKEN_RECEIVED, text);
                    },
                    onReasoning: r => { reasoning += r; painter.refresh(); },
                });
                await painter.drain();
            } catch (err) {
                // The connection dropped part-way: keep what arrived (it's still useful) and say how to finish it.
                if (text.trim() && !controller.signal.aborted && err.name !== 'AbortError') {
                    painter.stop();
                    partialError = err;
                    result = { usage: null };
                } else {
                    // Stopped: show everything that arrived, not just what had been revealed so far.
                    if (text) { painter.stop(); paint(text); }
                    throw err;
                }
            } finally {
                painter.stop();
                messageNode(targetId)?.classList.remove('streaming');
            }
        } else {
            result = await completion(body, { signal: controller.signal });
            text = result.text || '';
            reasoning = result.reasoning || '';
        }
        const endedAt = Date.now();
        const split = splitReasoning(text, { startsInside });
        if (!startsInside && type !== 'continue' && learnStartsInside(body.model, text)) saveSettingsDebounced();
        reasoning = [reasoning, split.reasoning].filter(Boolean).join('\n\n');
        if (split.reasoning && reasoningEnd) firstTextAt = reasoningEnd; // inline thinking counts as think time
        if (reasoning) {
            target.extra.reasoning = applyRegex(reasoning, REGEX_PLACEMENT.REASONING);
            target.extra.reasoning_duration = (reasoningEnd || Date.now()) - startedAt;
        } else delete target.extra.reasoning;
        let final = split.text;
        if (state.settings.generation.trimIncomplete) final = trimIncomplete(final);
        final = applyRegex(final, REGEX_PLACEMENT.AI_OUTPUT);
        target.mes = type === 'continue' ? prefixText + final : (shownPrefill + final).trim();
        if (!target.mes.trim() && type !== 'continue') {
            target.mes = '';
            throw new Error(reasoning ? 'The AI only sent its thinking and no reply. Try again (or raise the max response length).' : 'The AI sent back an empty reply. Try again, or check the model and settings.');
        }
        target.extra.api = state.settings.connection.provider;
        target.extra.model = state.settings.connection.model;
        target.extra.gen = generationStats({
            startedAt, firstTextAt, endedAt, usage: result?.usage, promptTokens: built.tokens, outputText: text, reasoningText: reasoning, requestId,
        });
        recordCapture({ ...capture, mesKey: captureKey(messageId(target), target.swipe_id) });
        target.gen_finished = nowDate();
        syncSwipe(target);
        updateMessageBlock(targetId, target);
        refreshSwipeControls();
        await saveChat();
        await eventSource.emit(event_types.MESSAGE_RECEIVED, targetId, type);
        await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, targetId, type);
        if (state.settings.image.inlineTags && state.settings.image.autoGenerateInline) {
            import('./imagegen.js').then(m => m.autoInlinePics(targetId));
        }
        if (partialError) toast(`${partialError.message || partialError}. What arrived was kept; use Continue (✨ menu) to finish it.`, 'warning', { title: 'The reply was cut off', timeout: 8000 });
        return target.mes;
    } catch (err) {
        if (controller.signal.aborted || err.name === 'AbortError') {
            // Stopped before any text: drop the empty reply / swipe instead of saving it.
            if (target && !target.mes?.trim() && type !== 'continue' && newSlot) await dropEmpty();
            else if (target) {
                syncSwipe(target);
                updateMessageBlock(targetId, target);
                await saveChat();
            }
            return;
        }
        console.error(err);
        toast(err.message || String(err), 'error', { title: 'Generation failed' });
        // Remove an empty placeholder message (or empty swipe) on failure.
        if (target && !target.mes && type !== 'continue' && newSlot) await dropEmpty();
    } finally {
        state.abortController = null;
        setGenerating(false);
        document.getElementById('typing-indicator').classList.add('hidden');
        await eventSource.emit(event_types.GENERATION_ENDED, state.chat.length);
    }

    async function dropEmpty() {
        {
            if (target.swipes?.length > 1) {
                target.swipes.pop();
                target.swipe_info?.pop();
                target.swipe_id = target.swipes.length - 1;
                target.mes = target.swipes[target.swipe_id];
                if (target.swipe_info?.[target.swipe_id]?.extra) target.extra = structuredClone(target.swipe_info[target.swipe_id].extra);
                updateMessageBlock(targetId, target);
            } else {
                state.chat.splice(targetId, 1);
                messageNode(targetId)?.remove();
                refreshSwipeControls();
            }
            await saveChat();
        }
    }
}

async function quietOnTheSide(quietPrompt) {
    const built = await buildPrompt({ type: 'quiet', quietPrompt });
    const body = { ...connectionBody(), messages: built.messages, params: { ...samplerParams(), ...built.extraParams }, requestId: newRequestId() };
    const res = await completion(body);
    return stripReasoning(res.text);
}

function trimIncomplete(text) {
    const m = text.match(/^[\s\S]*[.!?…"”*)\]~>](?=\s*$|\s)/);
    return m ? m[0] : text;
}

/** ST-compatible quiet generation (used by extensions & image prompt writing). */
export async function generateQuietPrompt(quietPrompt = '', quietToLoud = false) {
    if (typeof quietPrompt === 'object' && quietPrompt) quietPrompt = quietPrompt.quietPrompt ?? '';
    return generate('quiet', { quietPrompt, quietToLoud });
}

/** ST-compatible raw generation: a plain prompt (string or messages) without the preset. */
export async function generateRaw(prompt, _api, _instructOverride, _quietToLoud, systemPrompt = '') {
    if (typeof prompt === 'object' && prompt && !Array.isArray(prompt)) ({ prompt, systemPrompt = '' } = prompt);
    const messages = Array.isArray(prompt) ? prompt : [
        ...(systemPrompt ? [{ role: 'system', content: substituteParams(systemPrompt) }] : []),
        { role: 'user', content: substituteParams(String(prompt)) },
    ];
    const res = await completion({ ...connectionBody(), messages, params: samplerParams() });
    return res.text;
}

export function autoGrow() {
    const ta = textarea();
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, window.innerHeight * 0.4)}px`;
}

export function sendSystemMessage(text, { name = 'System' } = {}) {
    const mes = { name, is_user: false, is_system: true, send_date: nowDate(), mes: String(text), extra: { type: 'narrator' }, force_avatar: 'icons/icon.svg' };
    state.chat.push(mes);
    addOneMessage(mes);
    saveChatDebounced();
}

export { escapeHtml, chatMetadata };
