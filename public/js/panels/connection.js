import { api } from '../api.js';
import { state, saveSettingsDebounced } from '../state.js';
import { eventSource, event_types } from '../events.js';
import { el, icon, field, select, textInput, section, toast, promptDialog, confirmDialog } from '../ui.js';

async function providers() {
    state.providers ??= await api.get('providers');
    return state.providers;
}

export function keyField(name, secrets, label = 'API key') {
    const input = el('input', { class: 'input', type: 'password', placeholder: secrets[name] || 'Paste your key', autocomplete: 'off' });
    const status = el('small', { class: 'hint' }, secrets[name] ? `Saved (${secrets[name]})` : 'Not set');
    const save = el('button', { class: 'btn small', onclick: async () => {
        const res = await api.put('secrets', { name, value: input.value });
        input.value = '';
        input.placeholder = res.masked || 'Paste your key';
        status.textContent = res.masked ? `Saved (${res.masked})` : 'Removed';
        toast(res.masked ? 'Key saved on the server' : 'Key removed', 'success');
        eventSource.emit(event_types.SECRET_WRITTEN, name);
    } }, icon('floppy-disk'), 'Save');
    return el('div', { class: 'field' }, el('span', { class: 'field-label' }, label), el('div', { class: 'row gap' }, input, save), status);
}

export async function render(body) {
    const conn = state.settings.connection;
    const prov = await providers();
    const secrets = await api.get('secrets');

    const modelList = el('datalist', { id: 'model-list' });
    const modelInput = textInput(conn.model, v => { conn.model = v.trim(); saveSettingsDebounced(); eventSource.emit(event_types.CHATCOMPLETION_MODEL_CHANGED, conn.model); }, { list: 'model-list', placeholder: 'e.g. anthropic/claude-sonnet-4.5' });
    const modelSelect = el('select', { class: 'input hidden' });
    const status = el('div', { class: 'conn-status' });

    const setStatus = (kind, text) => {
        status.className = `conn-status ${kind}`;
        status.replaceChildren(icon(kind === 'ok' ? 'circle-check' : kind === 'err' ? 'circle-exclamation' : 'circle-notch', kind === 'busy' ? 'fa-spin' : ''), el('span', {}, text));
    };

    const fetchModels = async () => {
        setStatus('busy', 'Connecting…');
        try {
            const models = await api.post('models', { provider: conn.provider, baseUrl: conn.baseUrl });
            modelList.replaceChildren(...models.map(m => el('option', { value: m.id }, m.name && m.name !== m.id ? m.name : '')));
            modelSelect.replaceChildren(el('option', { value: '' }, `— ${models.length} models — pick one —`), ...models.map(m => el('option', { value: m.id, selected: m.id === conn.model }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id)));
            modelSelect.classList.toggle('hidden', !models.length);
            setStatus('ok', `Connected · ${models.length} models available`);
        } catch (err) {
            setStatus('err', err.message);
        }
    };
    modelSelect.addEventListener('change', () => {
        if (!modelSelect.value) return;
        modelInput.value = modelSelect.value;
        modelInput.dispatchEvent(new Event('input'));
    });

    const keyBox = el('div');
    const baseBox = el('div');
    const renderProviderBits = () => {
        keyBox.replaceChildren(keyField(conn.provider, secrets));
        const def = prov.chat[conn.provider];
        baseBox.replaceChildren(field('API URL', textInput(conn.baseUrl, v => { conn.baseUrl = v.trim(); saveSettingsDebounced(); }, { placeholder: def?.base || 'https://your-server/v1' }),
            conn.provider === 'custom' ? 'Any OpenAI-compatible endpoint (KoboldCpp, LM Studio, vLLM, Ollama /v1, proxies…).' : 'Leave empty to use the default. Set this for reverse proxies.'));
    };
    renderProviderBits();

    const providerSelect = select(Object.entries(prov.chat).map(([k, v]) => [k, v.label]), conn.provider, v => {
        conn.provider = v;
        conn.baseUrl = '';
        saveSettingsDebounced();
        renderProviderBits();
        modelList.replaceChildren();
        modelSelect.classList.add('hidden');
        status.replaceChildren();
        eventSource.emit(event_types.CHATCOMPLETION_SOURCE_CHANGED, v);
    });

    // Connection profiles: quick switching between provider/model combos.
    const profilesBox = el('div', { class: 'stack' });
    const renderProfiles = () => {
        const list = conn.profiles || [];
        profilesBox.replaceChildren(
            el('div', { class: 'chip-row' }, list.map((p, i) => el('span', { class: `chip${p.provider === conn.provider && p.model === conn.model && (p.baseUrl || '') === (conn.baseUrl || '') ? ' active' : ''}` },
                el('button', { class: 'chip-main', title: `${p.provider} · ${p.model}`, onclick: () => {
                    Object.assign(conn, { provider: p.provider, model: p.model, baseUrl: p.baseUrl || '' });
                    saveSettingsDebounced();
                    toast(`Switched to ${p.name}`, 'success', { timeout: 1500 });
                    body.replaceChildren();
                    render(body);
                } }, p.name),
                el('button', { class: 'chip-x', title: 'Delete profile', onclick: async () => {
                    if (!await confirmDialog(`Delete profile “${p.name}”?`)) return;
                    list.splice(i, 1);
                    saveSettingsDebounced();
                    renderProfiles();
                } }, icon('xmark'))))),
            el('button', { class: 'btn small', onclick: async () => {
                const name = await promptDialog('Profile name', `${prov.chat[conn.provider]?.label?.split(' ')[0]} · ${conn.model.split('/').pop()}`, { title: 'Save connection profile' });
                if (!name) return;
                conn.profiles = [...list, { name, provider: conn.provider, model: conn.model, baseUrl: conn.baseUrl }];
                saveSettingsDebounced();
                renderProfiles();
            } }, icon('bookmark'), 'Save current as profile'));
    };
    renderProfiles();

    body.append(
        section('Chat completion',
            field('Provider', providerSelect),
            keyBox,
            baseBox,
            el('div', { class: 'row gap' }, el('button', { class: 'btn', onclick: fetchModels }, icon('rotate'), 'Connect & list models')),
            status,
            modelSelect,
            field('Model', modelInput, 'Type any model id, or connect to pick from the list.'),
            modelList),
        section('Profiles', profilesBox),
        section('', el('p', { class: 'hint' }, icon('lock'), ' API keys are stored on your Reverie server (data/secrets.json) and never sent back to the browser. On Railway you can also set them as environment variables, e.g. OPENROUTER_API_KEY.')));
    if (secrets[conn.provider] || conn.provider === 'custom') fetchModels();
}
