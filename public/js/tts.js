// Read aloud: speaks messages with the browser's built-in voices (free, works offline on most devices).
// Settings live in settings.tts; each character can have its own voice.
import { state, saveSettingsDebounced } from './state.js';
import { eventSource, event_types } from './events.js';
import { points, pointsChanged } from './rv-ext/points.js';
import { toast } from './ui.js';

export const ttsSupported = () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

export function ttsSettings() {
    const s = state.settings;
    s.tts = { auto: false, mode: 'all', rate: 1, pitch: 1, voice: '', voices: {}, ...(s.tts || {}) };
    return s.tts;
}

let voicesCache = [];
export function voices() {
    if (!ttsSupported()) return [];
    const list = speechSynthesis.getVoices();
    if (list.length) voicesCache = list;
    return voicesCache;
}
/** Resolves once the browser has loaded its voice list (it arrives late on Chrome and Safari). */
export function voicesReady() {
    if (!ttsSupported()) return Promise.resolve([]);
    if (voices().length) return Promise.resolve(voicesCache);
    return new Promise(resolve => {
        const done = () => resolve(voices());
        speechSynthesis.addEventListener('voiceschanged', done, { once: true });
        setTimeout(done, 1500);
    });
}

/** Plain text a person would hear: no markup, code, images, OOC notes or HTML apps. */
export function speakableText(raw, mode = 'all') {
    let t = String(raw || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<pic\b[^>]*>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
        .replace(/\(\(OOC:[\s\S]*?\)\)|\[OOC:[\s\S]*?]/gi, ' ')
        .replace(/[*_~`#>|]+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (mode === 'dialogue') {
        const quotes = t.match(/"[^"]+"|“[^”]+”|«[^»]+»|「[^」]+」/g) || [];
        t = quotes.map(q => q.slice(1, -1).trim()).join(' … ');
    }
    return t;
}

/** Short utterances: some browsers silently stop speaking after ~15 seconds of one long utterance. */
function chunks(text, max = 220) {
    const out = [];
    for (const sentence of text.match(/[^.!?…]+[.!?…]+["”»]?\s*|[^.!?…]+$/g) || [text]) {
        const last = out.at(-1);
        if (last && last.length + sentence.length <= max) out[out.length - 1] = last + sentence;
        else if (sentence.length <= max) out.push(sentence);
        else out.push(...sentence.match(new RegExp(`.{1,${max}}(\\s|$)`, 'g')));
    }
    return out.map(s => s.trim()).filter(Boolean);
}

function voiceFor(name) {
    const s = ttsSettings();
    const wanted = s.voices?.[name] || s.voice;
    const list = voices();
    return list.find(v => v.voiceURI === wanted || v.name === wanted) || null;
}

let speakingIndex = null;
export const speakingNow = () => speakingIndex;

export function stopSpeaking() {
    if (!ttsSupported()) return;
    speakingIndex = null;
    speechSynthesis.cancel();
    document.body.classList.remove('rv-speaking');
    document.querySelectorAll('.mes.rv-speaking').forEach(n => n.classList.remove('rv-speaking'));
}

/** Reads one message aloud; reading the same message again stops it. */
export async function speakMessage(index) {
    if (!ttsSupported()) return toast('This browser can’t read aloud', 'warning');
    if (speakingIndex === index) return stopSpeaking();
    stopSpeaking();
    const mes = state.chat[index];
    if (!mes) return;
    const s = ttsSettings();
    const text = speakableText(mes.mes, mes.is_user ? 'all' : s.mode);
    if (!text) return toast(s.mode === 'dialogue' ? 'No dialogue in this message to read' : 'Nothing to read in this message');
    await voicesReady();
    speakingIndex = index;
    const node = document.querySelector(`#chat .mes[mesid="${index}"]`);
    node?.classList.add('rv-speaking');
    document.body.classList.add('rv-speaking');
    const voice = voiceFor(mes.name);
    const parts = chunks(text);
    parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part);
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.rate = Number(s.rate) || 1;
        u.pitch = Number(s.pitch) || 1;
        if (i === parts.length - 1) u.onend = u.onerror = () => { if (speakingIndex === index) stopSpeaking(); };
        speechSynthesis.speak(u);
    });
}

export function setCharacterVoice(name, voiceURI) {
    const s = ttsSettings();
    if (voiceURI) s.voices[name] = voiceURI;
    else delete s.voices[name];
    saveSettingsDebounced();
}

export function bindTts() {
    if (!ttsSupported()) return;
    voices();
    points.messageActions.add({
        id: 'rv-read-aloud', icon: 'volume-high', title: 'Read aloud',
        onClick: (_m, index) => speakMessage(index),
    });
    pointsChanged('messageActions');
    // After agents that rewrite the reply (Prose Guardian) are done, so the final text is read.
    eventSource.on('rv_reply_final', (index, type) => {
        if (!ttsSettings().auto || type === 'quiet' || type === 'impersonate') return;
        if (state.chat[index] && !state.chat[index].is_user) speakMessage(index);
    });
    eventSource.on(event_types.CHAT_CHANGED, stopSpeaking);
    eventSource.on(event_types.GENERATION_STARTED, (type) => { if (type !== 'quiet') stopSpeaking(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && speakingIndex !== null) stopSpeaking(); });
}
