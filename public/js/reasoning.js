// Inline thinking: models like DeepSeek R1, QwQ, GLM and many fine-tunes write their reasoning inside the
// reply, e.g. <think>…</think>. This pulls it out into the collapsible "Thoughts" box so it never shows in
// (or gets resent with) the story. Handles: the tag opened by the preset's prefill (only a closing tag in
// the reply), an unclosed block while streaming, several blocks, and custom prefix/suffix strings.
import { state } from './state.js';

// Tags that only ever mean reasoning are pulled out wherever they appear. The others are often in-story
// inner monologue, so they only count as thinking when they open the reply.
const DEFAULT_TAGS = ['think', 'thinking', 'reasoning'];
const LEADING_TAGS = ['thought', 'thoughts', 'reflection'];

export function reasoningSettings() {
    const s = state.settings;
    s.reasoning = { autoParse: true, tags: '', prefix: '', suffix: '', startsInside: {}, addToPrompts: false, maxAdditions: 1, separator: '\n\n', ...(s.reasoning || {}) };
    return s.reasoning;
}

const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** open/close match every thinking marker; strictOpen/strictClose leave out the leading-only tags. */
function patterns() {
    const r = reasoningSettings();
    const custom = String(r.tags || '').split(',').map(t => t.trim().replace(/^<\/?|>$/g, '')).filter(Boolean);
    const build = list => {
        const tags = [...new Set(list)].map(esc).join('|');
        const open = [`<(?:${tags})(?:\\s[^>]*)?>`];
        const close = [`<\\/(?:${tags})\\s*>`];
        if (r.prefix?.trim()) open.push(esc(r.prefix.trim()));
        if (r.suffix?.trim()) close.push(esc(r.suffix.trim()));
        return { open: open.join('|'), close: close.join('|') };
    };
    const strict = build([...DEFAULT_TAGS, ...custom]);
    return { ...build([...DEFAULT_TAGS, ...LEADING_TAGS, ...custom]), strictOpen: strict.open, strictClose: strict.close };
}

/** True when text (e.g. a prefill) ends inside an opened thinking block. */
export function endsInsideThinking(text) {
    if (!text || !reasoningSettings().autoParse) return false;
    const { open, close } = patterns();
    const lastOpen = [...String(text).matchAll(new RegExp(open, 'gi'))].at(-1);
    if (!lastOpen) return false;
    return !new RegExp(close, 'i').test(String(text).slice(lastOpen.index + lastOpen[0].length));
}

/**
 * Splits a reply into { reasoning, text }.
 * @param {string} raw the reply as the model wrote it
 * @param {{ streaming?: boolean, startsInside?: boolean }} opts startsInside: the prefill opened a thinking block
 */
export function splitReasoning(raw, { streaming = false, startsInside = false } = {}) {
    const src = String(raw ?? '');
    if (!reasoningSettings().autoParse || !src) return { reasoning: '', text: src, open: false };
    const { open, close, strictOpen, strictClose } = patterns();
    const openRx = new RegExp(`^\\s*(?:${open})`, 'i');
    const closeRx = new RegExp(close, 'i');
    const thoughts = [];
    let rest = src;
    let stillOpen = false;

    // 1) A leading block, or one the prefill opened.
    const lead = rest.match(openRx);
    // A closing reasoning tag with nothing opening it: the prefill (or chat template) opened the block.
    const closeAt = rest.search(new RegExp(strictClose, 'i'));
    const before = closeAt >= 0 ? rest.slice(0, closeAt) : '';
    const orphanClose = closeAt >= 0 && !new RegExp(open, 'i').test(before);
    if (lead || startsInside || orphanClose) {
        const body = lead ? rest.slice(lead[0].length) : rest;
        const end = body.search(closeRx);
        if (end >= 0) {
            thoughts.push(body.slice(0, end));
            rest = body.slice(end).replace(closeRx, '');
        } else if (streaming || startsInside || lead) {
            // Still thinking (or the model never closed it): everything so far is reasoning.
            thoughts.push(body);
            rest = '';
            stillOpen = true;
        }
    }

    // 2) Complete blocks anywhere else in the reply (genuine reasoning tags only; <thought> mid-story is prose).
    rest = rest.replace(new RegExp(`(?:${strictOpen})([\\s\\S]*?)(?:${strictClose})`, 'gi'), (_, inner) => { thoughts.push(inner); return ''; });

    // 3) While streaming, an opened-but-unclosed block at the end is reasoning in progress.
    if (streaming) {
        const m = rest.match(new RegExp(`(?:${strictOpen})([\\s\\S]*)$`, 'i'));
        if (m) { thoughts.push(m[1]); rest = rest.slice(0, m.index); stillOpen = true; }
        // Hide a half-typed tag like "<thi" at the very end.
        rest = rest.replace(/<\/?[a-z]{0,12}$/i, '');
    }

    const reasoning = thoughts.map(t => t.trim()).filter(Boolean).join('\n\n');
    return { reasoning, text: thoughts.length ? rest.replace(/^\s+/, '') : rest, open: stillOpen };
}

/**
 * Some models' chat templates open the thinking tag themselves, so the reply starts mid-thought and only
 * the closing tag arrives. Once seen for a model, later replies are shown as thinking from the first token.
 */
export function modelStartsInside(model) {
    return !!(model && reasoningSettings().startsInside?.[model]);
}
export function learnStartsInside(model, raw) {
    if (!model || !reasoningSettings().autoParse) return false;
    const { open, strictClose } = patterns();
    const text = String(raw || '');
    const closeAt = text.search(new RegExp(strictClose, 'i'));
    const orphan = closeAt >= 0 && !new RegExp(open, 'i').test(text.slice(0, closeAt));
    const r = reasoningSettings();
    if (orphan === !!r.startsInside[model]) return false;
    if (orphan) r.startsInside[model] = true;
    else if (!new RegExp(open, 'i').test(text)) delete r.startsInside[model]; // a reply with no thinking at all: stop assuming
    else return false;
    return true;
}

/** Text with thinking blocks removed (for prompts and agent replies). */
export function stripReasoning(text) {
    return splitReasoning(text).text;
}
