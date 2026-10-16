// Screen mode, saved per device: Automatic (fit the screen), Tablet (900px wide) or Desktop (1280px wide).
// A wider layout on a phone or tablet works like the browser's "Request desktop site": everything is
// laid out for a computer screen and you can pinch to zoom. Applied before the page draws (index.html).
import { toast } from './ui.js';

export const VIEW_MODES = [
    ['auto', 'Automatic (fit this screen)'],
    ['tablet', 'Tablet (900 px wide)'],
    ['desktop', 'Desktop / computer (1280 px wide)'],
];

export function viewMode() {
    try { return localStorage.getItem('rv-view-mode') || 'auto'; } catch { return 'auto'; }
}

export function setViewMode(mode) {
    try {
        if (mode === 'auto') localStorage.removeItem('rv-view-mode');
        else localStorage.setItem('rv-view-mode', mode);
    } catch {
        return toast('This browser blocks saving settings on the device', 'error');
    }
    const label = VIEW_MODES.find(([id]) => id === mode)?.[1] || mode;
    if (mode !== 'auto' && screen.width >= (mode === 'desktop' ? 1280 : 900)) {
        toast('This screen is already that wide, so nothing changes here.', 'info');
    } else {
        toast(`${label}: reloading…`, 'info', { timeout: 1200 });
        setTimeout(() => location.reload(), 400);
    }
    paintNav();
}

/** Sidebar shortcut: flips between Desktop and Automatic. */
export function toggleDesktopMode() {
    setViewMode(viewMode() === 'desktop' ? 'auto' : 'desktop');
}

export function paintNav() {
    const item = document.getElementById('nav-view-mode');
    if (!item) return;
    const mode = viewMode();
    item.querySelector('.nav-state').textContent = mode === 'desktop' ? 'On' : mode === 'tablet' ? 'Tablet' : 'Off';
    item.classList.toggle('on', mode !== 'auto');
}
