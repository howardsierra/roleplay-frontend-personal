// Enhance My Reply: rewrites what you've typed in the message box into a fuller, more polished reply,
// using the story so far (the active preset, card, lore and chat) and your connection, without sending it.
// The original stays one shortcut away (Ctrl+Shift+Z) until you type over it.
import { state, saveSettingsDebounced } from './state.js';
import { el, toast, toggle, textArea, section, field } from './ui.js';

export const DEFAULT_ENHANCE_INSTRUCTION = 'Rewrite my draft below as my next roleplay reply: keep what I meant to say and do, but make it read well, with vivid, specific detail, natural flow and emotional texture. Reply with the rewritten text only: no notes, labels or quotation marks around it.';

const OPTIONS = [
    ['keepFormatting', 'Keep my formatting', 'Asterisks, quotes and paragraph breaks stay the way I use them.'],
    ['keepDialogue', 'Keep my dialogue', 'Every line I wrote is kept, with its meaning; only its delivery is polished.'],
    ['onlyMe', 'Only my character', "Don't add actions, thoughts or speech for anyone else."],
    ['expandShort', 'Grow short drafts', 'A one-liner is fleshed out from what just happened in the scene, without new big decisions.'],
    ['firstPerson', 'First person, present tense', 'Keep the reply in “I …” narration, in the present.'],
];

export function enhanceSettings() {
    state.settings.enhance = {
        instruction: DEFAULT_ENHANCE_INSTRUCTION,
        keepFormatting: true, keepDialogue: true, onlyMe: true, expandShort: true, firstPerson: false,
        ...(state.settings.enhance || {}),
    };
    return state.settings.enhance;
}

function instructionFor(draft) {
    const s = enhanceSettings();
    const rules = [];
    if (s.keepFormatting) rules.push('Use the same formatting conventions as the draft (asterisks for actions, quotation marks for speech, paragraph breaks).');
    if (s.keepDialogue) rules.push('Keep every line of dialogue in the draft and what it means; improve how it is delivered, never drop it.');
    if (s.onlyMe) rules.push('Write only my character ({{user}}): no actions, thoughts, feelings or new dialogue for {{char}} or anyone else.');
    if (s.expandShort) rules.push('If the draft is short, build it into a full reply from the latest message and the scene around it, staying true to what I intended and without deciding anything big for me or repeating the previous message.');
    if (s.firstPerson) rules.push('Write in the first person and the present tense.');
    return `${String(s.instruction || DEFAULT_ENHANCE_INSTRUCTION).trim()}${rules.length ? `\n\nRules:\n- ${rules.join('\n- ')}` : ''}\n\nMy draft:\n<draft>\n${draft}\n</draft>`;
}

const cleanUp = text => {
    let t = String(text ?? '').trim();
    const fenced = t.match(/^```[\w-]*\s*\n([\s\S]*?)\n```$/);
    if (fenced) t = fenced[1].trim();
    return t.replace(/^<draft>\s*|\s*<\/draft>$/g, '').trim();
};

let undo = null; // { text, enhanced } — the draft before the last enhancement
const box = () => document.getElementById('send_textarea');

export async function enhanceDraft() {
    const ta = box();
    const draft = ta?.value || '';
    if (!state.character) return toast('Open a chat first', 'warning');
    if (!draft.trim()) return toast('Type a draft first, then enhance it', 'info');
    if (state.generating) return toast('Wait for the current reply to finish', 'warning');
    document.body.classList.add('enhancing');
    try {
        const { generateQuietPrompt } = await import('./chat.js');
        const out = cleanUp(await generateQuietPrompt(instructionFor(draft)));
        if (!out) throw new Error('The model sent back nothing');
        if (ta.value !== draft) return; // you kept typing meanwhile: don't overwrite it
        undo = { text: draft, enhanced: out };
        ta.value = out;
        ta.dispatchEvent(new Event('input'));
        ta.focus();
        toast('Draft enhanced. Ctrl+Shift+Z brings the original back.', 'success', { timeout: 3500 });
    } catch (err) {
        if (err?.name !== 'AbortError') toast(`Couldn't enhance it: ${err.message}`, 'error');
    } finally {
        document.body.classList.remove('enhancing');
    }
}

/** Brings back the draft from before the last enhancement (unless you've edited the result since). */
export function restoreDraft() {
    const ta = box();
    if (!undo || !ta) return false;
    if (ta.value !== undo.enhanced) { undo = null; return false; }
    ta.value = undo.text;
    undo = null;
    ta.dispatchEvent(new Event('input'));
    ta.focus();
    return true;
}

export function bindEnhance() {
    document.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return;
        const key = e.key.toLowerCase();
        if (key === 'e' && document.activeElement === box()) { e.preventDefault(); enhanceDraft(); }
        if (key === 'z' && document.activeElement === box() && undo) { e.preventDefault(); restoreDraft(); }
    });
}

export function enhanceSettingsSection() {
    const s = enhanceSettings();
    const save = () => saveSettingsDebounced();
    return section('Enhance my reply',
        el('p', { class: 'hint' }, 'Polishes what you’ve typed before you send it, using the story so far. ✨ menu → Enhance my reply, or Ctrl+Shift+E in the message box (Ctrl+Shift+Z undoes it).'),
        ...OPTIONS.map(([key, label, hint]) => toggle(label, !!s[key], v => { s[key] = v; save(); }, hint)),
        field('Instruction', textArea(s.instruction, v => { s.instruction = v || DEFAULT_ENHANCE_INSTRUCTION; save(); }, { rows: 4 }), 'Macros like {{user}} and {{char}} work here.'));
}
