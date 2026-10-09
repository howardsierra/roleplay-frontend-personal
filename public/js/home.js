// Home screen: a greeting, recent stories to jump back into, and the character gallery.
import { api } from './api.js';
import { state, currentPersona } from './state.js';
import { el, icon } from './ui.js';

const $id = id => document.getElementById(id);
const avatarUrl = file => (file ? `files/avatars/${encodeURIComponent(file)}` : 'icons/icon.svg');

function timeAgo(ms) {
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString();
}

function greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? 'Still up' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    const name = currentPersona()?.name;
    return name && name !== 'User' ? `${part}, ${name}` : part;
}

const chatTitle = item => item.chatId.replace(new RegExp(`^${item.charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*-\\s*`), '') || item.chatId;

async function open(item) {
    const { openCharacter } = await import('./characters.js');
    await openCharacter(item.charId, { chatId: item.chatId });
}

export async function renderHome() {
    if (!$id('home')) return;
    document.dispatchEvent(new Event('rv:home'));
    $id('home-greeting').textContent = state.characters.length ? greeting() : 'Reverie';
    $id('home-sub').textContent = state.characters.length
        ? 'Pick up a story where you left off, or start something new.'
        : 'Step into a story. Import a character card or create your own.';

    let recent = [];
    try { recent = await api.get('chats?limit=8'); } catch { /* offline */ }
    const cont = $id('home-continue');
    cont.classList.toggle('hidden', !recent.length);
    if (recent.length) {
        cont.querySelector('span').textContent = `Continue with ${recent[0].charName}`;
        cont.onclick = () => open(recent[0]);
    }
    $id('home-stories-section').classList.toggle('hidden', !recent.length);
    $id('home-stories').replaceChildren(...recent.map(item => el('button', { class: 'home-story', title: `${item.charName} · ${item.chatId}`, onclick: () => open(item) },
        el('div', { class: `home-story-art${item.banner ? ' has-banner' : ''}`, style: { backgroundImage: `url("${item.banner ? `api/characters/${encodeURIComponent(item.charId)}/banner?v=${item.charUpdated || 0}` : avatarUrl(item.avatar)}")` } }),
        el('div', { class: 'home-story-body' },
            el('div', { class: 'home-story-name' }, item.charName),
            el('div', { class: 'home-story-meta' }, icon('clock'), ` ${timeAgo(item.updated)} · ${item.count ?? 0} messages`),
            el('div', { class: 'home-story-chat' }, chatTitle(item)),
            el('div', { class: 'home-story-preview' }, item.preview || '…')))));
}

export function bindHome() {
    const goHome = async () => {
        const { closeChat } = await import('./characters.js');
        if (state.character) await closeChat();
        renderHome();
    };
    $id('btn-home')?.addEventListener('click', goHome);
    document.querySelector('.sidebar-brand')?.addEventListener('click', goHome);
    $id('home-search')?.addEventListener('input', async () => (await import('./characters.js')).renderLibrary());
}
