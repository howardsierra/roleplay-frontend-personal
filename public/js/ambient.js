// Scene-reactive lighting: reads the latest messages for where/when the scene is (candlelight,
// a storm, moonlight, snow…) and slowly shifts the room's light to match. Per chat it can be left on
// auto, pinned to one scene, or turned off from the toolbar chip.
import { state, chatMetadata, saveChatDebounced } from './state.js';
import { eventSource, event_types } from './events.js';
import { el, icon } from './ui.js';

export const SCENES = {
    candle: { label: 'Candlelight', icon: 'fire', colors: ['#ffb347', '#c2410c'], fx: 'flicker',
        words: 'candle|candles|candlelight|candlelit|fireplace|hearth|torch|torches|torchlight|lantern|lanterns|firelight|embers|flame|flames|campfire|bonfire|tavern|inn' },
    night: { label: 'Moonlight', icon: 'moon', colors: ['#6d8bff', '#1e1b4b'], fx: 'stars',
        words: 'night|nighttime|moon|moonlight|moonlit|stars|starlight|starlit|midnight|nocturnal|darkness' },
    storm: { label: 'Storm', icon: 'cloud-bolt', colors: ['#7c8db5', '#1e293b'], fx: 'rain',
        words: 'storm|stormy|thunder|thunderstorm|lightning|rain|raining|rainfall|downpour|drizzle|rainy|tempest|puddles' },
    snow: { label: 'Snow', icon: 'snowflake', colors: ['#dbeafe', '#7dd3fc'], fx: 'snow',
        words: 'snow|snowy|snowfall|snowflakes|blizzard|frost|frosted|frozen|icy|winter|sleet' },
    dusk: { label: 'Golden hour', icon: 'cloud-sun', colors: ['#fb923c', '#db2777'], fx: '',
        words: 'sunset|dusk|twilight|sunrise|dawn|daybreak|golden hour|evening light|setting sun' },
    day: { label: 'Daylight', icon: 'sun', colors: ['#fde68a', '#fef3c7'], fx: '',
        words: 'sunlight|sunlit|sunny|sunshine|daylight|noon|midday|bright morning|blue sky|summer' },
    forest: { label: 'Forest', icon: 'tree', colors: ['#4ade80', '#14532d'], fx: '',
        words: 'forest|woods|woodland|trees|grove|moss|mossy|meadow|glade|leaves|canopy|ferns|thicket' },
    ocean: { label: 'Ocean', icon: 'water', colors: ['#22d3ee', '#1e3a8a'], fx: '',
        words: 'ocean|sea|seas|waves|beach|shore|shoreline|tide|harbor|harbour|ship|deck|sailing|surf|coast|underwater' },
    blood: { label: 'Danger', icon: 'droplet', colors: ['#ef4444', '#450a0a'], fx: 'pulse',
        words: 'blood|bloody|bleeding|wound|wounded|battle|sword|swords|blade|fight|fighting|kill|killed|scream|screams|danger|attack|attacked' },
};
const PATTERNS = Object.fromEntries(Object.entries(SCENES).map(([id, s]) => [id, new RegExp(`\\b(?:${s.words})\\b`, 'gi')]));

const plain = text => String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ');

/** Picks the scene from the last few messages, the newest weighing most. Returns an id or ''. */
export function detectScene(chat = state.chat) {
    const recent = chat.filter(m => !m.is_system).slice(-4);
    const scores = {};
    recent.forEach((m, i) => {
        const weight = (i + 1) / recent.length * (m.is_user ? 0.6 : 1);
        const text = plain(m.mes);
        for (const [id, re] of Object.entries(PATTERNS)) {
            const hits = text.match(re)?.length || 0;
            if (hits) scores[id] = (scores[id] || 0) + Math.min(hits, 4) * weight;
        }
    });
    const [best, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0] || [];
    return score >= 1.5 ? best : '';
}

// ---------------------------------------------------------------- DOM
let overlay = null;
let fx = null;
let chip = null;
let current = '';

function ensureLayers() {
    if (overlay) return;
    overlay = el('div', { id: 'rv-ambient', 'aria-hidden': 'true' });
    fx = el('div', { id: 'rv-ambient-fx', 'aria-hidden': 'true' });
    document.body.append(overlay);
    (document.getElementById('bg_layer') || document.body).append(fx);
}

const mode = () => chatMetadata().rv_ambient || 'auto'; // 'auto' | 'off' | a scene id

export function applyAmbient() {
    ensureLayers();
    const a = state.settings.appearance;
    const on = a.ambient !== false && state.character && mode() !== 'off';
    const scene = !on ? '' : SCENES[mode()] ? mode() : detectScene();
    document.body.style.setProperty('--rv-ambient-strength', String(a.ambientIntensity ?? 0.5));
    if (scene !== current) {
        current = scene;
        const s = SCENES[scene];
        overlay.classList.toggle('on', !!s);
        fx.classList.toggle('on', !!s);
        if (s) {
            overlay.style.setProperty('--amb-1', s.colors[0]);
            overlay.style.setProperty('--amb-2', s.colors[1]);
            fx.style.setProperty('--amb-1', s.colors[0]);
            fx.style.setProperty('--amb-2', s.colors[1]);
        }
        fx.dataset.fx = s?.fx || '';
        if (s?.fx && !fx.childElementCount) fx.append(...Array.from({ length: 36 }, (_, i) => el('i', { style: { '--i': i, '--r': Math.random().toFixed(3), '--r2': Math.random().toFixed(3) } })));
        document.body.dataset.scene = scene;
    }
    renderChip();
}

function renderChip() {
    chip ??= document.getElementById('ambient-chip');
    if (!chip) return;
    const a = state.settings.appearance;
    chip.classList.toggle('hidden', a.ambient === false || !state.character);
    const s = SCENES[current];
    const m = mode();
    chip.replaceChildren(icon(s ? s.icon : m === 'off' ? 'lightbulb' : 'wand-magic-sparkles'), el('span', {}, s ? s.label : m === 'off' ? 'Lighting off' : 'Ambient'));
    chip.classList.toggle('active', !!s);
    if (s) chip.style.setProperty('--amb-chip', s.colors[0]);
    chip.classList.toggle('pinned', !!SCENES[m]);
    chip.title = m === 'off' ? 'Scene lighting is off for this chat' : SCENES[m] ? `Lighting pinned to ${SCENES[m].label}` : 'Scene lighting follows the story';
}

async function openMenu() {
    const { popMenu } = await import('./chat.js');
    const set = value => {
        if (value === 'auto') delete chatMetadata().rv_ambient; else chatMetadata().rv_ambient = value;
        saveChatDebounced();
        applyAmbient();
    };
    const m = mode();
    popMenu(chip, [
        [m === 'auto' ? 'check' : 'wand-magic-sparkles', 'Follow the story', () => set('auto')],
        ...Object.entries(SCENES).map(([id, s]) => [m === id ? 'check' : s.icon, s.label, () => set(id)]),
        [m === 'off' ? 'check' : 'lightbulb', 'Off for this chat', () => set('off')],
    ]);
}

let timer = 0;
const later = () => { clearTimeout(timer); timer = setTimeout(applyAmbient, 250); };

export function bindAmbient() {
    ensureLayers();
    chip = document.getElementById('ambient-chip');
    chip?.addEventListener('click', openMenu);
    for (const ev of [event_types.CHAT_CHANGED, event_types.MESSAGE_RECEIVED, event_types.MESSAGE_SENT, event_types.MESSAGE_EDITED,
        event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED, event_types.SETTINGS_UPDATED]) eventSource.on(ev, later);
    applyAmbient();
}
