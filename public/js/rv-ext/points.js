// Contribution points for Reverie-native extensions. Core modules read from these registries;
// extensions add to them through the rv API (see rv-ext/api.js). Every add returns a disposer.

function registry() {
    const items = new Map();
    let seq = 0;
    return {
        add(item) {
            const key = ++seq;
            items.set(key, item);
            return () => items.delete(key);
        },
        list: () => [...items.values()],
    };
}

export const points = {
    sheetTabs: registry(),       // { id, title, icon, render(container, ctx) }
    composerButtons: registry(), // { id, icon, title, onClick }
    messageActions: registry(),  // { id, icon, title, when?(message, index), onClick(message, index) }
    menuItems: registry(),       // { id, icon, label, onClick }
    renderers: registry(),       // { lang, render(code, container, ctx) }
    promptHooks: registry(),     // fn(messages, ctx) → messages | void (may mutate)
};

/** Renderer for a fenced-code language, if an extension registered one. */
export function rendererFor(lang) {
    const l = String(lang || '').toLowerCase();
    return points.renderers.list().find(r => r.lang === l) || null;
}

const listeners = new Set();
/** Core UI subscribes here to re-render when extensions add or remove contributions. */
export function onPointsChanged(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
export function pointsChanged(kind) {
    for (const fn of listeners) {
        try { fn(kind); } catch (err) { console.error(err); }
    }
}

/** The plain message shape extensions receive. */
export const plainMessage = (m, i) => ({
    index: i, name: m.name, text: m.mes, isUser: !!m.is_user, hidden: !!m.is_system, date: m.send_date,
    reasoning: m.extra?.reasoning || '', swipe: m.swipe_id ?? 0, swipes: m.swipes?.length || 1,
});
