// Settings → More → Backup: download everything, restore (merge or replace), and the automatic
// snapshots kept on the server. Also a gentle reminder when a downloaded backup is overdue.
import { api } from './api.js';
import { el, icon, toast, toggle, pickFile, modal } from './ui.js';

const REMIND_AFTER = 14 * 24 * 60 * 60 * 1000;

const fmtSize = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const ago = t => {
    if (!t) return 'never';
    const d = (Date.now() - t) / 1000;
    if (d < 90) return 'just now';
    if (d < 5400) return `${Math.round(d / 60)} min ago`;
    if (d < 129600) return `${Math.round(d / 3600)} h ago`;
    return `${Math.round(d / 86400)} days ago`;
};
const REASONS = { daily: 'Daily', manual: 'Taken by you', 'before-restore': 'Before a restore' };

/** Uploads with progress (fetch can't report upload progress). */
function upload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `api/${url}`);
        xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
        xhr.onload = () => {
            let body = null;
            try { body = JSON.parse(xhr.responseText); } catch { /* not json */ }
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new Error(body?.error || `Restore failed (${xhr.status})`));
        };
        xhr.onerror = () => reject(new Error('Upload failed — check your connection.'));
        xhr.send(file);
    });
}

async function chooseMode(what) {
    let mode = 'merge';
    const options = [
        ['merge', 'Merge', 'Add the backup\'s files and replace ones with the same names. Things made since the backup stay.'],
        ['replace', 'Replace everything', 'Make Reverie exactly like the backup. Anything made since is removed (a snapshot is taken first).'],
    ];
    const list = el('div', { class: 'backup-modes' }, options.map(([id, label, hint]) => el('label', { class: 'backup-mode' },
        el('input', { type: 'radio', name: 'backup-mode', value: id, checked: id === mode, onchange: () => { mode = id; } }),
        el('span', {}, el('b', {}, label), el('small', {}, hint)))));
    const ok = await modal({
        title: `Restore ${what}?`,
        content: el('div', { class: 'stack' }, list, el('p', { class: 'hint' }, 'Your current data is saved as a snapshot first, so you can undo this from the list below.')),
        buttons: [{ label: 'Cancel', value: false }, { label: 'Restore', value: true, primary: true, icon: 'clock-rotate-left' }],
    });
    return ok ? mode : null;
}

function finished(res) {
    toast(`Restored ${res.files} files${res.from ? ` from ${new Date(res.from).toLocaleDateString()}` : ''}. Reloading…`, 'success', { timeout: 4000 });
    setTimeout(() => location.reload(), 1500);
}

export async function backupSection(section) {
    const box = el('div', { class: 'backup' });
    const opts = { secrets: false, extensions: true };
    const render = async () => {
        let info;
        try { info = await api.get('backup/info'); } catch (err) { box.replaceChildren(el('p', { class: 'hint' }, err.message)); return; }
        const c = info.contents || {};
        const overdue = !info.lastDownload || Date.now() - info.lastDownload > REMIND_AFTER;
        const href = () => `api/backup?secrets=${opts.secrets ? 1 : 0}&extensions=${opts.extensions ? 1 : 0}`;
        const dl = el('a', { class: 'btn primary', href: href(), onclick: () => setTimeout(render, 4000) }, icon('download'), 'Download backup');
        const progress = el('div', { class: 'backup-progress hidden' }, el('span'));
        box.replaceChildren(
            el('div', { class: 'backup-stats' },
                [['users', c.characters, 'characters'], ['comments', c.chats, 'chats'], ['user-astronaut', c.personas, 'personas'], ['book-atlas', c.lorebooks, 'lorebooks'], ['image', c.images, 'images']]
                    .map(([ic, n, label]) => el('div', { class: 'backup-stat' }, icon(ic), el('b', {}, String(n ?? 0)), el('span', {}, label)))),
            el('p', { class: `backup-last${overdue ? ' overdue' : ''}` }, icon(overdue ? 'triangle-exclamation' : 'circle-check'),
                ` Last downloaded: ${ago(info.lastDownload)}. ${overdue ? 'Your data only lives on the server — keep a copy somewhere else too.' : ''}`),
            toggle(`Include installed extensions (${fmtSize(info.extensionsSize)})`, opts.extensions, v => { opts.extensions = v; dl.href = href(); }, 'Leave them out for a smaller file; they can be reinstalled from their URLs.'),
            toggle('Include API keys', opts.secrets, v => { opts.secrets = v; dl.href = href(); }, 'Off by default. Anyone with the file could use your keys.'),
            el('div', { class: 'row gap wrap' }, dl,
                el('button', { class: 'btn', onclick: async () => {
                    const file = await pickFile('.gz,.tgz,application/gzip,application/x-gzip');
                    if (!file) return;
                    const mode = await chooseMode(`“${file.name}”`);
                    if (!mode) return;
                    progress.classList.remove('hidden');
                    try {
                        finished(await upload(`backup/restore?mode=${mode}`, file, f => { progress.firstChild.style.width = `${Math.round(f * 100)}%`; }));
                    } catch (err) {
                        toast(err.message, 'error', { title: 'Restore failed' });
                        progress.classList.add('hidden');
                    }
                } }, icon('upload'), 'Restore from file'),
                el('span', { class: 'hint' }, `≈ ${fmtSize(info.size - (opts.extensions ? 0 : info.extensionsSize))}`)),
            progress,
            el('div', { class: 'backup-snaps-head' }, el('b', {}, 'Snapshots on the server'),
                el('button', { class: 'btn small', onclick: async e => {
                    e.target.disabled = true;
                    try { await api.post('backup/snapshots'); toast('Snapshot taken', 'success'); } catch (err) { toast(err.message, 'error'); }
                    render();
                } }, icon('camera'), 'Take one now')),
            el('p', { class: 'hint' }, 'Taken daily and before every restore; the last 5 are kept. They live on the same server, so they protect against mistakes — download a backup to protect against losing the server.'),
            info.snapshots.length ? el('div', { class: 'backup-snaps' }, info.snapshots.map(s => el('div', { class: 'backup-snap' },
                el('span', { class: 'backup-snap-text' }, el('b', {}, new Date(s.created).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })), el('small', {}, `${REASONS[s.reason] || s.reason} · ${fmtSize(s.size)}`)),
                el('a', { class: 'icon-btn small', title: 'Download', href: `api/backup/snapshots/${encodeURIComponent(s.name)}` }, icon('download')),
                el('button', { class: 'icon-btn small', title: 'Restore this snapshot', onclick: async () => {
                    const mode = await chooseMode('this snapshot');
                    if (!mode) return;
                    try { finished(await api.post(`backup/snapshots/${encodeURIComponent(s.name)}/restore?mode=${mode}`)); } catch (err) { toast(err.message, 'error', { title: 'Restore failed' }); }
                } }, icon('clock-rotate-left')),
                el('button', { class: 'icon-btn small danger', title: 'Delete', onclick: async () => { await api.del(`backup/snapshots/${encodeURIComponent(s.name)}`); render(); } }, icon('trash-can'))))) : el('p', { class: 'hint' }, 'No snapshots yet.'));
    };
    render();
    return section('Backup', el('p', { class: 'hint' }, 'Everything — characters, chats, personas, presets, lorebooks, themes, images, extensions and settings — in one file.'), box);
}

/** Once a day at most: a nudge when there's data worth keeping and no recent downloaded backup. */
export async function backupReminder() {
    try {
        if (localStorage.getItem('rv-backup-nudge') === new Date().toDateString()) return;
        const info = await api.get('backup/info');
        if ((info.contents?.chats || 0) < 3) return;
        if (info.lastDownload && Date.now() - info.lastDownload < REMIND_AFTER) return;
        localStorage.setItem('rv-backup-nudge', new Date().toDateString());
        toast(`${info.lastDownload ? `Your last backup was ${ago(info.lastDownload)}.` : 'You haven\'t downloaded a backup yet.'} Settings → More → Backup keeps a copy off the server.`, 'info', { title: 'Back up your stories', timeout: 9000 });
    } catch { /* offline or not logged in */ }
}
