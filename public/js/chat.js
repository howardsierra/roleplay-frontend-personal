// Chat view + generation flows (send, swipe/regenerate, continue, impersonate, quiet).
import { state, saveChat, saveChatDebounced, charName, userName, currentPersona, chatMetadata, connectionRequest } from './state.js';
import { streamCompletion, completion } from './api.js';
import { eventSource, event_types } from './events.js';
import { buildPrompt, samplerParams } from './prompt.js';
import { substituteParams } from './macros.js';
import { applyRegex, REGEX_PLACEMENT } from './regex.js';
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
    const result = formatMessage(mes.mes, { isUser: mes.is_user, depth, streaming, message: mes, id });
    textEl.innerHTML = result.html;
    hydrate(textEl, result, { streaming, message: mes, onPic: (prompt, force) => import('./imagegen.js').then(m => m.generateInlinePic(id, prompt, force)) });
    if (streaming && !mes.mes) textEl.innerHTML = '<span class="rv-dots"><span></span><span></span><span></span></span>';

    const reasoning = mes.extra?.reasoning;
    const det = node.querySelector('.mes_reasoning_details');
    det.classList.toggle('hidden', !reasoning);
    if (reasoning) {
        const r = formatMessage(reasoning, { isReasoning: true, streaming: true });
        const rEl = det.querySelector('.mes_reasoning');
        rEl.innerHTML = r.html;
        const secs = mes.extra?.reasoning_duration ? ` for ${Math.round(mes.extra.reasoning_duration / 1000)}s` : '';
        det.querySelector('.reasoning-label').textContent = streaming && !mes.mes ? 'Thinking…' : `Thought${secs}`;
        if (streaming && !mes.mes) det.open = true;
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

    const swipes = mes.swipes?.length || 1;
    const isLast = id === state.chat.length - 1;
    const canSwipe = isLast && !mes.is_user && (swipes > 1 || id > 0 || state.chat.length > 0);
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
    scrollToBottom(true);
}

export function clearChat() {
    chatEl().replaceChildren();
}

export function refreshSwipeControls() {
    const last = state.chat.length - 1;
    chatEl().querySelectorAll('.mes').forEach(node => {
        const id = Number(node.getAttribute('mesid'));
        if (id >= last - 1) renderMessageInto(node, state.chat[id], id);
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
    const bar = el('div', { class: 'edit-bar' },
        el('button', { class: 'btn small', onclick: () => done(false) }, icon('xmark'), 'Cancel'),
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

export function popMenu(anchor, items) {
    document.querySelector('.ctx-menu')?.remove();
    const menu = el('div', { class: 'ctx-menu popover-menu', role: 'menu' },
        items.map(([ic, label, fn, cls]) => el('button', {
            class: `menu-item ${cls || ''}`, onclick: () => { menu.remove(); fn(); },
        }, icon(ic), el('span', {}, label))));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
    menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
    requestAnimationFrame(() => menu.classList.add('open'));
    setTimeout(() => {
        const off = e => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('pointerdown', off, true);
            }
        };
        document.addEventListener('pointerdown', off, true);
    });
}

export async function showPromptPreview() {
    return showInspector();
}

export function bindChatEvents() {
    const root = chatEl();
    onPointsChanged(kind => { if (kind === 'messageActions' || kind === 'renderers') printMessages(); });
    root.addEventListener('scroll', () => {
        stickToBottom = root.scrollHeight - root.scrollTop - root.clientHeight < 80;
    }, { passive: true });

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
        if (btn.classList.contains('swipe_right')) return swipeRight();
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
    if (state.generating) return;
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
    try {
        if (!(await runInterceptors(type, controller))) return;
        await eventSource.emit(event_types.GENERATION_STARTED, type, {}, false);
        await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS, type, {}, false);

        if (type === 'swipe' || type === 'regenerate') {
            targetId = state.chat.length - 1;
            target = state.chat[targetId];
            if (!target || target.is_user) {
                type = 'normal';
                target = null;
            }
        }
        if (type === 'continue') {
            targetId = state.chat.length - 1;
            target = state.chat[targetId];
            if (!target) { type = 'normal'; target = null; }
            else prefixText = target.mes;
        }

        const built = await buildPrompt({ type, quietPrompt, chat: type === 'swipe' || type === 'regenerate' ? state.chat.slice(0, -1) : state.chat });
        const { messages, prefill, extraParams } = built;
        const requestId = newRequestId();
        const body = { ...connectionBody(), messages, params: { ...samplerParams(), ...extraParams }, requestId };
        const capture = {
            type, requestId, messages, labels: built.labels, breakdown: built.breakdown, tokens: built.tokens, lore: built.lore,
            loreTotal: built.loreTotal, model: body.model, connection: connectionLabel(), body: { ...body, requestId: undefined },
        };
        if (type === 'quiet' || type === 'impersonate') recordCapture(capture);

        if (type === 'quiet' && !quietToLoud) {
            const res = await completion(body, { signal: controller.signal });
            return res.text;
        }
        if (type === 'impersonate') {
            let text = prefill || '';
            const ta = textarea();
            const stream = state.preset.samplers.stream;
            if (stream) {
                await streamCompletion(body, { signal: controller.signal, onText: t => { text += t; ta.value = text; autoGrow(); } });
            } else text += (await completion(body, { signal: controller.signal })).text;
            ta.value = text.trim();
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
            messageNode(targetId)?.classList.add('swiping');
            setTimeout(() => messageNode(targetId)?.classList.remove('swiping'), 260);
        }
        target.gen_started = nowDate();
        const startedAt = Date.now();
        let reasoningEnd = 0;
        let firstTextAt = 0;
        let result = null;

        let text = '';
        let reasoning = '';
        let frame = 0;
        const paint = () => {
            frame = 0;
            target.mes = type === 'continue' ? prefixText + text : (prefill && state.settings.generation.showPrefill ? prefill : '') + text;
            if (reasoning) target.extra.reasoning = reasoning;
            updateMessageBlock(targetId, target, { streaming: true });
            scrollToBottom();
        };
        const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

        if (state.preset.samplers.stream !== false) {
            result = await streamCompletion(body, {
                signal: controller.signal,
                onText: t => {
                    if (!firstTextAt) firstTextAt = Date.now();
                    if (!reasoningEnd && reasoning) reasoningEnd = Date.now();
                    text += t;
                    eventSource.emitAndWait(event_types.STREAM_TOKEN_RECEIVED, text);
                    schedule();
                },
                onReasoning: r => { reasoning += r; schedule(); },
            });
        } else {
            result = await completion(body, { signal: controller.signal });
            text = result.text || '';
            reasoning = result.reasoning || '';
        }
        const endedAt = Date.now();
        if (frame) cancelAnimationFrame(frame);
        if (reasoning) {
            target.extra.reasoning = reasoning;
            target.extra.reasoning_duration = (reasoningEnd || Date.now()) - startedAt;
        }
        let final = text;
        if (state.settings.generation.trimIncomplete) final = trimIncomplete(final);
        final = applyRegex(final, REGEX_PLACEMENT.AI_OUTPUT);
        target.mes = type === 'continue' ? prefixText + final : final.trim();
        if (!target.mes.trim() && type !== 'continue') target.mes = '';
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
        return target.mes;
    } catch (err) {
        if (controller.signal.aborted || err.name === 'AbortError') {
            if (target) {
                syncSwipe(target);
                updateMessageBlock(targetId, target);
                await saveChat();
            }
            return;
        }
        console.error(err);
        toast(err.message || String(err), 'error', { title: 'Generation failed' });
        // Remove an empty placeholder message (or empty swipe) on failure.
        if (target && !target.mes && type !== 'continue') {
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
    } finally {
        state.abortController = null;
        setGenerating(false);
        document.getElementById('typing-indicator').classList.add('hidden');
        await eventSource.emit(event_types.GENERATION_ENDED, state.chat.length);
    }
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
