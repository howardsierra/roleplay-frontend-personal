// Reply alerts and keeping the screen awake.
// - While a reply is being written, the screen stays on (Screen Wake Lock), so a phone doesn't sleep mid-reply.
// - If you've switched away when it finishes: the tab title says so, the phone can buzz, and (if allowed)
//   a system notification appears; tapping it brings you back.
import { state } from './state.js';
import { eventSource, event_types } from './events.js';

export function notifySettings() {
    const s = state.settings;
    s.notify = { wakeLock: true, title: true, vibrate: true, system: false, ...(s.notify || {}) };
    return s.notify;
}

export const wakeLockSupported = () => 'wakeLock' in navigator;
export const notificationsSupported = () => 'Notification' in window;

// ---------------------------------------------------------------- wake lock
let lock = null;
let wantLock = false;
async function acquire() {
    if (!wantLock || lock || !wakeLockSupported() || document.hidden) return;
    try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
    } catch { lock = null; } // battery saver, or not allowed: nothing to do
}
function release() {
    wantLock = false;
    lock?.release().catch(() => {});
    lock = null;
}

// ---------------------------------------------------------------- "replied" alerts
const baseTitle = () => document.title.replace(/^✦ .*? — /, '');
let titleRestore = null;
function flagTitle(text) {
    if (!notifySettings().title) return;
    const base = titleRestore ?? baseTitle();
    titleRestore = base;
    document.title = `✦ ${text} — ${base}`;
}
function clearTitle() {
    if (titleRestore == null) return;
    document.title = titleRestore;
    titleRestore = null;
}

/** Asks for permission to show system notifications; returns whether they're allowed. */
export async function enableSystemNotifications() {
    if (!notificationsSupported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
}

async function systemNotify(title, body) {
    if (!notifySettings().system || !notificationsSupported() || Notification.permission !== 'granted') return;
    const avatar = state.character?.avatar ? `files/avatars/${state.character.avatar}` : 'icons/icon.svg';
    const opts = { body, icon: avatar, badge: 'icons/icon.svg', tag: 'reverie-reply', renotify: true };
    try {
        // Android Chrome only shows notifications through the service worker.
        const reg = await navigator.serviceWorker?.getRegistration?.();
        if (reg?.showNotification) return await reg.showNotification(title, opts);
        const n = new Notification(title, opts);
        n.onclick = () => { window.focus(); n.close(); };
    } catch { /* not allowed here */ }
}

function replied(index) {
    const mes = state.chat[index];
    if (!mes || mes.is_user || !document.hidden) return;
    const s = notifySettings();
    const name = mes.name || state.character?.card?.data?.name || 'Reverie';
    flagTitle(`${name} replied`);
    if (s.vibrate) navigator.vibrate?.([60, 80, 60]);
    const preview = String(mes.mes || '').replace(/<[^>]+>/g, ' ').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140);
    systemNotify(`${name} replied`, preview);
}

export function bindNotify() {
    notifySettings();
    eventSource.on(event_types.GENERATION_STARTED, (type, _o, dryRun) => {
        if (dryRun || type === 'quiet' || !notifySettings().wakeLock) return;
        wantLock = true;
        acquire();
    });
    eventSource.on(event_types.GENERATION_ENDED, release);
    eventSource.on(event_types.GENERATION_STOPPED, release);
    eventSource.on('rv_reply_final', (index, type) => { if (type !== 'quiet' && type !== 'impersonate') replied(index); });
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) return;
        clearTitle();
        acquire(); // the lock is dropped whenever the page is hidden; take it back if still writing
    });
}
