// Floating overlays that extensions attach to <body> (Context Lens, launchers, widgets) sit above
// Reverie. When a popup, the Persona Manager or the persona picker opens, or on phones a drawer or
// the ✨ menu, the overlays already on screen step aside; anything opened from inside stays visible.
const CORE = new Set(['bg_layer', 'app', 'left-nav-panel', 'sheet-panel', 'right-nav-panel', 'scrim', 'toast-container', 'modal-root', 'pm_modal', 'rv-ambient', 'movingDivs', 'st-dom', 'root']);
const IGNORE_TAGS = new Set(['SCRIPT', 'TEMPLATE', 'STYLE', 'LINK', 'INPUT']);
const phone = () => matchMedia('(max-width: 760px)').matches;

function covering() {
    if (document.querySelector('#modal-root .modal-wrap, .persona-switch-pop')) return true;
    if (document.querySelector('#pm_modal:not(.pm_hidden)')) return true;
    return phone() && !!document.querySelector('.drawer.open, #extensionsMenu:not(.hidden)');
}

const isOverlay = n => !CORE.has(n.id) && !IGNORE_TAGS.has(n.tagName)
    && !n.classList.contains('modal-wrap') && !n.classList.contains('ctx-menu') && !n.classList.contains('persona-switch-pop')
    && !n.hasAttribute('data-rv-step-aside');

let active = false;
function sync() {
    const now = covering();
    if (now && !active) {
        for (const n of document.body.children) if (isOverlay(n)) n.setAttribute('data-rv-step-aside', '');
    } else if (!now && active) {
        document.querySelectorAll('[data-rv-step-aside]').forEach(n => n.removeAttribute('data-rv-step-aside'));
    }
    active = now;
}

/**
 * On wide screens a drawer doesn't hide every overlay, but small launcher buttons that extensions pin to the
 * screen edges would sit on top of an open side panel and catch its clicks; those step aside while it's open.
 */
function clearDrawers() {
    const open = phone() ? [] : [...document.querySelectorAll('.drawer.open')].map(d => d.getBoundingClientRect()).filter(r => r.width && r.height);
    for (const n of document.body.children) {
        if (n.hasAttribute('data-rv-step-aside') && !n.hasAttribute('data-rv-clear-drawer')) continue;
        let hide = false;
        if (open.length && !CORE.has(n.id) && !IGNORE_TAGS.has(n.tagName) && !n.classList.contains('modal-wrap') && !n.classList.contains('ctx-menu')) {
            n.removeAttribute('data-rv-clear-drawer'); // measure where it really is
            const r = n.getBoundingClientRect();
            const small = r.width > 0 && r.width <= 280 && r.height <= 180;
            hide = small && getComputedStyle(n).position === 'fixed'
                && open.some(d => r.left < d.right && r.right > d.left && r.top < d.bottom && r.bottom > d.top);
        }
        n.toggleAttribute('data-rv-clear-drawer', hide);
    }
}

export function bindStepAside() {
    let queued = false;
    const later = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; sync(); clearDrawers(); }); } };
    // Drawers slide in; measure again once they've arrived.
    document.addEventListener('transitionend', e => { if (e.target.classList?.contains('drawer')) later(); });
    addEventListener('resize', later);
    new MutationObserver(later).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    matchMedia('(max-width: 760px)').addEventListener('change', later);
}
