// Streaming display: providers send text in uneven bursts (a word, then half a paragraph). This reveals it
// at a steady pace, speeding up when it falls behind, and re-renders the message no more often than the
// device can keep up with (long replies with lots of markup cost more per render).
const now = () => performance.now();

/**
 * @param {(shown: string) => void} paint renders the text revealed so far
 * @param {{ smooth?: boolean }} opts smooth: reveal gradually instead of in bursts
 */
export function createStreamPainter(paint, { smooth = true } = {}) {
    let full = '';
    let shown = 0;
    let raf = 0;
    let lastPaint = 0;
    let cost = 0; // smoothed render time, ms
    let painted = -1; // how much of `full` the last paint showed
    let stale = false; // something besides the text changed
    let stopped = false;
    let drainResolve = null;

    const frame = t => {
        raf = 0;
        if (stopped) return;
        const backlog = full.length - shown;
        if (backlog > 0) {
            // Catch up within about a third of a second, but never crawl: at least a few characters a frame.
            shown = smooth ? Math.min(full.length, shown + Math.max(3, Math.ceil(backlog / 18))) : full.length;
            // Don't stop in the middle of a surrogate pair (emoji).
            if (shown < full.length && /[\uD800-\uDBFF]/.test(full[shown - 1])) shown++;
        }
        // Expensive renders (long replies, heavy markup) are spaced out so typing stays smooth.
        const gap = Math.min(220, cost * 3);
        const dirty = painted !== shown || stale;
        if (dirty && (t - lastPaint >= gap || (shown === full.length && drainResolve))) {
            const t0 = now();
            paint(full.slice(0, shown));
            cost = cost ? cost * 0.7 + (now() - t0) * 0.3 : now() - t0;
            lastPaint = t;
            painted = shown;
            stale = false;
        }
        if (shown < full.length || painted !== shown || stale) raf = requestAnimationFrame(frame);
        else if (drainResolve) { drainResolve(); drainResolve = null; }
    };
    const wake = () => { if (!raf && !stopped) raf = requestAnimationFrame(frame); };

    return {
        /** More text arrived. */
        push(text) { full += text; wake(); },
        /** Something else changed (e.g. reasoning): render again soon. */
        refresh() { stale = true; wake(); },
        get text() { return full; },
        /** Wait (briefly) for the revealed text to catch up with what arrived. */
        drain(maxMs = 500) {
            if (shown >= full.length || document.hidden) return Promise.resolve();
            return new Promise(resolve => {
                drainResolve = resolve;
                wake();
                setTimeout(() => { if (drainResolve === resolve) { drainResolve = null; resolve(); } }, maxMs);
            });
        },
        stop() { stopped = true; if (raf) cancelAnimationFrame(raf); raf = 0; },
    };
}
