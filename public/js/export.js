// Readable chat exports: a styled HTML "book", Markdown, or plain text, alongside the
// SillyTavern-compatible .jsonl. Hidden messages, code-heavy widgets and image tags are left out.
import { marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';
import { api } from './api.js';
import { state } from './state.js';
import { download, escapeHtml, toast } from './ui.js';
import { popMenu } from './chat.js';

const clean = text => String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<pic\b[^>]*>(?:\s*<\/pic>)?/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const plain = text => clean(text).replace(/<[^>]+>/g, '').replace(/\*\*|__|[*_~`#>]/g, '').trim();
const fileSafe = s => String(s || 'chat').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);

async function load(charId, chatId) {
    if (charId === state.character?.id && chatId === state.chatId) return { meta: state.chatMeta, messages: state.chat };
    return api.get(`chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}`);
}

const visible = messages => messages.filter(m => m && !m.is_system && clean(m.mes));

export function toMarkdown(title, messages) {
    const lines = [`# ${title}`, ''];
    for (const m of visible(messages)) lines.push(`**${m.name}:** ${clean(m.mes)}`, '');
    return lines.join('\n');
}

export function toText(title, messages) {
    const lines = [title, '='.repeat(Math.min(60, title.length)), ''];
    for (const m of visible(messages)) lines.push(`${m.name}:`, plain(m.mes), '');
    return lines.join('\n');
}

export function toHtml(title, messages, { charName = '', userName = '' } = {}) {
    const body = visible(messages).map(m => {
        const html = DOMPurify.sanitize(marked.parse(clean(m.mes), { gfm: true, breaks: true }));
        // Curly quotes for dialogue, allowing inline emphasis inside it.
        const quoted = html.replace(/(^|[\s>(])(&quot;|"|“)((?:[^"“”<]|<\/?(?:em|i|strong|b|u|s)>){1,600}?)(&quot;|"|”)/g, '$1<q>$3</q>');
        return `<article class="${m.is_user ? 'you' : 'them'}"><h2>${escapeHtml(m.name)}</h2>${quoted}</article>`;
    }).join('\n');
    const date = new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: light dark; --bg: #faf7f2; --ink: #2a2622; --dim: #8a8178; --accent: #9a5b8e; --you: #3f6f8f; }
@media (prefers-color-scheme: dark) { :root { --bg: #15121b; --ink: #e9e3ef; --dim: #9a91a6; --accent: #d59bd0; --you: #8fc1e3; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 1.12rem/1.75 Georgia, 'Iowan Old Style', 'Palatino Linotype', serif; }
main { max-width: 42rem; margin: 0 auto; padding: 4rem 1.25rem 6rem; }
header { text-align: center; margin-bottom: 3rem; }
header h1 { font-weight: 400; font-size: 2.2rem; line-height: 1.2; margin: 0 0 .4rem; }
header p { color: var(--dim); font-size: .9rem; margin: 0; letter-spacing: .04em; }
article { margin: 0 0 2rem; }
article h2 { font: 600 .78rem/1 system-ui, sans-serif; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); margin: 0 0 .5rem; }
article.you h2 { color: var(--you); }
article p { margin: 0 0 .9rem; }
q { quotes: '“' '”'; }
em { color: color-mix(in srgb, var(--ink) 78%, var(--dim)); }
img { max-width: 100%; border-radius: 8px; }
hr { border: 0; text-align: center; margin: 2rem 0; } hr::after { content: '✦'; color: var(--dim); }
@media print { body { background: #fff; color: #000; } main { padding-top: 0; } }
</style></head>
<body><main>
<header><h1>${escapeHtml(title)}</h1><p>${escapeHtml([charName, userName].filter(Boolean).join(' & '))}${charName || userName ? ' · ' : ''}${escapeHtml(date)}</p></header>
${body}
</main></body></html>`;
}

/** Downloads a chat in the given format: 'html' | 'md' | 'txt' | 'jsonl'. */
export async function exportChat(charId, chatId, format) {
    if (format === 'jsonl') {
        location.href = `api/chats/${encodeURIComponent(charId)}/${encodeURIComponent(chatId)}/export`;
        return;
    }
    try {
        const chat = await load(charId, chatId);
        const messages = chat.messages || [];
        const charName = chat.meta?.character_name || state.characters.find(c => c.id === charId)?.name || '';
        const userName = chat.meta?.user_name || '';
        const title = chatId;
        const name = fileSafe(chatId);
        if (format === 'md') download(`${name}.md`, toMarkdown(title, messages), 'text/markdown');
        else if (format === 'txt') download(`${name}.txt`, toText(title, messages), 'text/plain');
        else download(`${name}.html`, toHtml(title, messages, { charName, userName }), 'text/html');
    } catch (err) {
        toast(`Couldn't export: ${err.message}`, 'error');
    }
}

export function exportMenu(anchor, charId = state.character?.id, chatId = state.chatId) {
    if (!charId || !chatId) return;
    popMenu(anchor, [
        ['book-open', 'Readable story (.html)', () => exportChat(charId, chatId, 'html')],
        ['file-lines', 'Markdown (.md)', () => exportChat(charId, chatId, 'md')],
        ['align-left', 'Plain text (.txt)', () => exportChat(charId, chatId, 'txt')],
        ['file-code', 'SillyTavern chat (.jsonl)', () => exportChat(charId, chatId, 'jsonl')],
    ]);
}
