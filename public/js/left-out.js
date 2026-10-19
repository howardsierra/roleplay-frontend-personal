// What a prompt left out, and why: shown in the sheet's Lore tab and the Prompt Inspector.
import { el, icon } from './ui.js';

/** "Left out of the last reply": history that didn't fit, lore that matched but was kept out, unused memories. */
export function leftOutView(cut) {
    if (!cut) return null;
    const rows = [];
    if (cut.history) {
        const mem = cut.memories?.used?.length || 0;
        rows.push(el('div', { class: 'cut-row' }, icon('scissors'),
            el('div', {}, el('b', {}, `${cut.history.dropped} older message${cut.history.dropped === 1 ? '' : 's'}`),
                el('span', { class: 'dim' }, ` didn't fit in the context window (messages 1–${cut.history.dropped}). `
                    + (mem ? `${mem} memor${mem === 1 ? 'y' : 'ies'} stood in for them.` : 'No memories covered them yet: see the Memory tab.')))));
    }
    for (const l of cut.lore || []) {
        rows.push(el('div', { class: 'cut-row' }, icon('book'),
            el('div', {}, el('b', {}, l.title), el('span', { class: 'dim' }, ` · ${l.book}: ${l.reason}`))));
    }
    for (const m of cut.memories?.skipped || []) {
        rows.push(el('div', { class: 'cut-row' }, icon('brain'),
            el('div', {}, el('b', {}, m.title), el('span', { class: 'dim' }, ` · memory: ${m.reason}`))));
    }
    return el('div', { class: 'stack cut-list' }, rows.length ? rows : el('div', { class: 'empty small' }, 'Nothing was left out.'));
}
