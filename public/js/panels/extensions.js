import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { loaded } from '../st/extensions-loader.js';
import { el, icon, section, toast, confirmDialog } from '../ui.js';

let rootBody;
const rerender = () => { rootBody.replaceChildren(); render(rootBody); };

export async function render(body) {
    rootBody = body;
    const list = await api.get('extensions');
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
                        state.settings.extensions.forceLoad = [...new Set([...(state.settings.extensions.forceLoad || []), ext.name])];
                        saveSettingsDebounced();
                        toast('Reload to load it anyway', 'info');
                    } }, 'Load anyway')) : null),
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
        section('Install SillyTavern extension',
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
