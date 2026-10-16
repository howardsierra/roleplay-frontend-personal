// Context meter: a small ring in the chat toolbar showing how full the model's context was on the last
// reply (prompt tokens vs. the preset's context size). Tap it to open the Prompt Inspector.
import { state } from './state.js';
import { eventSource, event_types } from './events.js';
import { el } from './ui.js';

export function contextSize() {
    return Number(state.settings.generation.maxContextOverride || state.preset?.samplers?.context_size || 64000);
}

/** Prompt tokens of the latest reply that has generation details (provider-reported when available). */
export function lastPromptTokens() {
    for (let i = state.chat.length - 1; i >= 0; i--) {
        const gen = state.chat[i]?.extra?.gen;
        if (gen?.in) return { tokens: Number(gen.in), estimated: !!gen.estimated };
    }
    return null;
}

const fmt = n => (n >= 10000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function paint() {
    const chip = document.getElementById('ctx-meter');
    if (!chip) return;
    const last = state.chatId ? lastPromptTokens() : null;
    chip.classList.toggle('hidden', !last);
    if (!last) return;
    const size = contextSize();
    const pct = Math.min(100, Math.round((last.tokens / size) * 100));
    const level = pct >= 92 ? 'full' : pct >= 75 ? 'high' : 'ok';
    chip.dataset.level = level;
    chip.style.setProperty('--pct', pct);
    chip.querySelector('.ctx-pct').textContent = `${pct}%`;
    chip.title = `Context: ${last.estimated ? '≈' : ''}${fmt(last.tokens)} of ${fmt(size)} tokens on the last reply`
        + (level === 'full' ? '. The oldest messages are being left out; lorebooks, the summary and trackers keep the story straight.' : '')
        + '\nTap to inspect the prompt.';
}

export function bindContextMeter() {
    const status = document.getElementById('gen-status');
    if (!status || document.getElementById('ctx-meter')) return;
    const chip = el('button', { id: 'ctx-meter', class: 'ctx-meter hidden', type: 'button', onclick: () => import('./inspector.js').then(m => m.showInspector()) },
        el('span', { class: 'ctx-ring', 'aria-hidden': 'true' }), el('span', { class: 'ctx-pct' }));
    status.before(chip);
    for (const ev of [event_types.MESSAGE_RECEIVED, event_types.CHAT_CHANGED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED, event_types.SETTINGS_UPDATED, event_types.PRESET_CHANGED]) {
        if (ev) eventSource.on(ev, () => setTimeout(paint, 0));
    }
    paint();
}
