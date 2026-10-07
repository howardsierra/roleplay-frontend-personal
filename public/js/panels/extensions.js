import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { loaded } from '../st/extensions-loader.js';
import { active, isEnabled, setEnabled, setExtensionSetting } from '../rv-ext/loader.js';
import { PERMISSIONS, settingDefaults } from '../rv-ext/api.js';
import { el, icon, section, toast, confirmDialog, promptDialog, field, textInput, textArea, select } from '../ui.js';

let rootBody;
const rerender = () => {
    // Keep the ST settings host alive: it lives in the drawer and is moved into this panel on render.
    const host = document.getElementById('extensions_settings_host');
    host.classList.add('hidden');
    document.getElementById('right-nav-panel').append(host);
    rootBody.replaceChildren();
    render(rootBody);
};

export async function render(body) {
    rootBody = body;
    const all = await api.get('extensions');
    const list = all.filter(e => e.type !== 'reverie');
    const native = all.filter(e => e.type === 'reverie');
    const disabled = new Set(state.settings.extensions.disabled || []);
    const url = el('input', { class: 'input', type: 'url', placeholder: 'https://github.com/user/SillyTavern-Extension' });
    const install = el('button', { class: 'btn primary', onclick: async () => {
        if (!url.value.trim()) return;
        install.disabled = true;
        install.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Installing…';
        try {
            const ext = await api.post('extensions/install', { url: url.value.trim() });
            toast(`Installed ${ext.manifest.display_name || ext.name}. Reload to activate.`, 'success');
            rerender();
        } catch (err) {
            toast(err.message, 'error', { title: 'Install failed' });
            install.disabled = false;
            install.innerHTML = '<i class="fa-solid fa-download"></i> Install';
        }
    } }, icon('download'), 'Install');

    const rows = list.map(ext => {
        const m = ext.manifest;
        const status = loaded.get(ext.name);
        const sw = el('input', { type: 'checkbox', class: 'switch-input' });
        sw.checked = !disabled.has(ext.name);
        sw.addEventListener('change', () => {
            const set = new Set(state.settings.extensions.disabled || []);
            if (sw.checked) set.delete(ext.name); else set.add(ext.name);
            state.settings.extensions.disabled = [...set];
            saveSettingsDebounced();
            toast('Reload the page to apply', 'info', { timeout: 2500 });
        });
        return el('div', { class: `ext-row${status?.error ? ' error' : ''}` },
            el('div', { class: 'ext-info' },
                el('div', { class: 'ext-name' }, m.display_name || ext.name, m.version ? el('span', { class: 'dim' }, ` v${m.version}`) : null),
                el('div', { class: 'hint' }, m.author ? `by ${m.author}` : '', status?.error ? ` · ⚠ ${status.error}` : status?.skipped ? ' · not loaded' : status ? ' · loaded' : disabled.has(ext.name) ? ' · disabled' : ' · reload to load'),
                status?.skipped ? el('div', { class: 'hint warn' }, status.skipped, ' ',
                    el('button', { class: 'link-btn', onclick: () => {
                        state.settings.appearance.layout = 'classic';
                        saveSettingsDebounced();
                        toast('Switched to the classic layout. Reloading…', 'success');
                        setTimeout(() => location.reload(), 900);
                    } }, 'Switch to classic layout'), ' · ',
                    el('button', { class: 'link-btn', onclick: () => {
                        state.settings.extensions.forceLoad = [...new Set([...(state.settings.extensions.forceLoad || []), ext.name])];
                        saveSettingsDebounced();
                        toast('Reload to load it anyway', 'info');
                    } }, 'Load anyway in Reverie layout')) : null),
            el('div', { class: 'row gap' },
                el('button', { class: 'icon-btn', title: 'Update', onclick: async () => {
                    try { await api.post(`extensions/${encodeURIComponent(ext.name)}/update`); toast('Updated. Reload to apply.', 'success'); } catch (err) { toast(err.message, 'error'); }
                } }, icon('rotate')),
                el('button', { class: 'icon-btn danger', title: 'Uninstall', onclick: async () => {
                    if (!await confirmDialog(`Uninstall ${m.display_name || ext.name}?`, { danger: true, okLabel: 'Uninstall' })) return;
                    await api.del(`extensions/${encodeURIComponent(ext.name)}`);
                    toast('Uninstalled. Reload to fully unload it.', 'success');
                    rerender();
                } }, icon('trash-can')),
                el('label', { class: 'switch small' }, sw, el('span', { class: 'switch-track' }))));
    });

    body.append(
        section('Reverie extensions', reverieSection(native)),
        section('Install an extension',
            el('div', { class: 'row gap' }, url, install),
            el('p', { class: 'hint' }, icon('triangle-exclamation'), ' Extensions run with full access to this app, just like in SillyTavern. Only install ones you trust. Reverie emulates SillyTavern\'s extension API (getContext, events, slash commands, popups, settings); extensions that depend on SillyTavern server endpoints may only partly work.')),
        section('Installed', rows.length ? el('div', { class: 'stack' }, rows) : el('div', { class: 'empty' }, 'No extensions installed.'),
            list.length ? el('button', { class: 'btn small', onclick: () => location.reload() }, icon('rotate-right'), 'Reload app') : null));

    // Extension settings panels (the same #extensions_settings containers SillyTavern provides).
    const host = document.getElementById('extensions_settings_host');
    host.classList.remove('hidden');
    body.append(section('Extension settings', host));
    if (!host.querySelector('#extensions_settings > *, #extensions_settings2 > *')) {
        body.append(el('p', { class: 'hint' }, 'Settings for loaded extensions appear here.'));
    }
}

const uninstall = async ext => {
    const label = ext.manifest.name || ext.manifest.display_name || ext.name;
    if (!await confirmDialog(`Uninstall ${label}?`, { danger: true, okLabel: 'Uninstall' })) return false;
    await api.del(`extensions/${encodeURIComponent(ext.name)}`);
    return true;
};

/** Settings form generated from the manifest's `settings` array. */
function settingsForm(ext) {
    const m = ext.manifest;
    const id = m.id || ext.name;
    const values = { ...settingDefaults(m), ...(state.settings.rvext?.[id]?.settings || {}) };
    const set = key => v => setExtensionSetting(ext, key, v);
    return (m.settings || []).map(s => {
        const v = values[s.key];
        switch (s.type) {
            case 'toggle': {
                const cb = el('input', { type: 'checkbox', class: 'switch-input' });
                cb.checked = !!v;
                cb.addEventListener('change', () => set(s.key)(cb.checked));
                return el('label', { class: 'row gap toggle-row' }, el('span', { class: 'switch small' }, cb, el('span', { class: 'switch-track' })), el('span', {}, s.label || s.key), s.hint ? el('small', { class: 'hint' }, s.hint) : null);
            }
            case 'select': return field(s.label || s.key, select(s.options || [], v, set(s.key)), s.hint);
            case 'number': case 'slider': {
                const input = textInput(v, x => set(s.key)(Number(x)), { type: s.type === 'slider' ? 'range' : 'number', min: s.min, max: s.max, step: s.step ?? 1 });
                return field(s.label || s.key, input, s.hint);
            }
            case 'textarea': return field(s.label || s.key, textArea(v, set(s.key), { rows: s.rows || 3 }), s.hint);
            case 'color': return field(s.label || s.key, textInput(v, set(s.key), { type: 'color' }), s.hint);
            default: return field(s.label || s.key, textInput(v, set(s.key), { placeholder: s.placeholder || '' }), s.hint);
        }
    });
}

function reverieSection(native) {
    const rows = native.map(ext => {
        const m = ext.manifest;
        const id = m.id || ext.name;
        const record = active.get(id);
        const sw = el('input', { type: 'checkbox', class: 'switch-input' });
        sw.checked = isEnabled(id);
        const status = el('span', {});
        const paint = () => {
            const r = active.get(id);
            status.textContent = `${m.author ? ' · ' : ''}${r?.error ? `⚠ ${r.error}` : r ? 'running' : 'off'}`;
        };
        paint();
        sw.addEventListener('change', async () => {
            sw.disabled = true;
            await setEnabled(ext, sw.checked);
            sw.disabled = false;
            paint();
            toast(`${m.name || id} ${sw.checked ? 'turned on' : 'turned off'}`, 'success', { timeout: 1800 });
        });
        const perms = (m.permissions || []).map(p => el('span', { class: 'badge perm', title: PERMISSIONS[p] || 'Unknown permission' }, p));
        const form = settingsForm(ext);
        return el('div', { class: `ext-row rv-native${record?.error ? ' error' : ''}` },
            el('div', { class: 'ext-info' },
                el('div', { class: 'ext-name' }, icon('feather', 'dim'), ' ', m.name || ext.name, m.version ? el('span', { class: 'dim' }, ` v${m.version}`) : null),
                el('div', { class: 'hint' }, m.author ? `by ${m.author}` : '', status),
                m.description ? el('div', { class: 'hint' }, m.description) : null,
                el('div', { class: 'row gap wrap perm-row' }, perms.length ? perms : el('span', { class: 'hint' }, 'No special permissions')),
                form.length ? el('details', { class: 'ext-settings' }, el('summary', {}, icon('sliders'), ' Settings'), el('div', { class: 'stack' }, form)) : null),
            el('div', { class: 'row gap' },
                ext.source?.url ? el('button', { class: 'icon-btn', title: 'Update', onclick: async () => {
                    try {
                        await api.post(`extensions/${encodeURIComponent(ext.name)}/update`);
                        if (active.has(id)) { await setEnabled(ext, false); await setEnabled(ext, true); }
                        toast('Updated', 'success');
                    } catch (err) { toast(err.message, 'error'); }
                } }, icon('rotate')) : null,
                el('button', { class: 'icon-btn danger', title: 'Uninstall', onclick: async () => {
                    if (!await uninstall(ext)) return;
                    await setEnabled(ext, false);
                    toast('Uninstalled', 'success');
                    rerender();
                } }, icon('trash-can')),
                el('label', { class: 'switch small' }, sw, el('span', { class: 'switch-track' }))));
    });
    const create = el('button', { class: 'btn small', onclick: async () => {
        const name = await promptDialog('Name your extension', '', { placeholder: 'My Extension' });
        if (!name?.trim()) return;
        try {
            const ext = await api.post('extensions/create', { name: name.trim() });
            await setEnabled(ext, true);
            toast(`Created ${ext.manifest.name}. Edit it in data/extensions/${ext.name}/`, 'success', { timeout: 6000 });
            rerender();
        } catch (err) { toast(err.message, 'error'); }
    } }, icon('wand-magic-sparkles'), 'Create starter extension');
    return [
        el('p', { class: 'hint' }, 'Built for Reverie: they turn on and off instantly, ask for permissions up front, keep their settings in sync across devices, and can add sheet tabs, composer buttons and custom message blocks in both layouts.'),
        rows.length ? el('div', { class: 'stack' }, rows) : el('div', { class: 'empty' }, 'None installed yet. Install one by URL below, or create a starter to build your own.'),
        el('div', { class: 'row gap' }, create),
    ];
}
