// Stable ids for chat messages (Lumiverse extensions address messages by id, not index).
// Kept on the message itself (not in `extra`, which changes per swipe), so they survive reloads.
export function messageId(mes) {
    if (!mes) return null;
    mes.rv_id ??= mes.extra?.rv_id || `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    return mes.rv_id;
}
