import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition, checkCondition, modelMatches } from '../public/js/conditions.js';
import { importPreset, toReverie, defaultPreset, normalizePreset, makeBlock } from '../public/js/presets.js';

const ctx = {
    type: 'normal', model: 'anthropic/claude-sonnet-4.5', provider: 'openrouter',
    chat: { length: 25, last: 'She smiles.' }, char: { name: 'Elara', tags: ['Fantasy', 'magic'] },
    var: { get: n => ({ tone: 'dark', nsfw: '' }[n] ?? '') },
};

test('conditions: comparisons, contains, has, regex, boolean logic', () => {
    assert.equal(evaluateCondition("type == 'normal'", ctx), true);
    assert.equal(evaluateCondition('chat.length > 20 and chat.length <= 25', ctx), true);
    assert.equal(evaluateCondition("model ~ 'claude'", ctx), true);
    assert.equal(evaluateCondition('model ~ /gemini|gpt/', ctx), false);
    assert.equal(evaluateCondition("char.tags has 'fantasy'", ctx), true);
    assert.equal(evaluateCondition("var.tone == 'dark' and not var.nsfw", ctx), true);
    assert.equal(evaluateCondition("(provider == 'anthropic' or provider == 'openrouter') and type != 'impersonate'", ctx), true);
    assert.equal(evaluateCondition('', ctx), true);
    assert.match(checkCondition('chat.length >'), /end/i);
    assert.match(checkCondition("type == 'x' )"), /Unexpected/);
    assert.equal(checkCondition("char.name == 'Elara'"), '');
});

test('model profile matching', () => {
    assert.equal(modelMatches('claude', 'anthropic/claude-opus'), true);
    assert.equal(modelMatches('/^gpt-5/', 'gpt-5-mini'), true);
    assert.equal(modelMatches('', 'anything'), false);
});

test('Reverie presets round-trip conditions, profiles and metadata', () => {
    const p = normalizePreset({
        ...defaultPreset(),
        name: 'Mine',
        blocks: [makeBlock({ name: 'Long chat recap', content: 'Recap.', when: 'chat.length > 40' })],
        modelProfiles: [{ name: 'Claude', match: 'claude', samplers: { temperature: 1 }, assistantPrefill: '<thinking>' }],
        meta: { author: 'Howard', version: '1.2' },
    });
    const file = toReverie({ ...p, id: 'x', raw: { junk: true } });
    assert.equal(file.format, 'reverie-preset');
    assert.equal(file.id, undefined);
    assert.equal(file.raw, undefined);
    const back = importPreset(JSON.parse(JSON.stringify(file)));
    assert.equal(back.source, 'reverie');
    assert.equal(back.blocks[0].when, 'chat.length > 40');
    assert.equal(back.modelProfiles[0].assistantPrefill, '<thinking>');
    assert.equal(back.modelProfiles[0].samplers.temperature, 1);
    assert.equal(back.meta.author, 'Howard');
});

test('Reverie themes resolve variants, fonts, assets and export to SillyTavern', async () => {
    const { resolveReverieTheme, toReverieTheme, reverieToSillyTavern, BUILTIN_THEMES } = await import('../public/js/themes.js');
    const rt = {
        format: 'reverie-theme', formatVersion: 1, name: 'Test',
        variants: { dark: { text: 'rgba(1, 2, 3, 1)', accent: '#ff00aa', background: '#000' }, light: { text: 'rgba(9, 9, 9, 1)', background: '#fff' } },
        fonts: { ui: 'Nunito' }, radius: 10, assets: { flower: 'data:image/svg+xml,<svg/>', bad: 'javascript:alert(1)' }, css: '.x{}',
        layout: { messageStyle: 'bubbles' },
    };
    const dark = resolveReverieTheme(rt, false);
    assert.equal(dark.main_text_color, 'rgba(1, 2, 3, 1)');
    assert.equal(dark.rv_accent, '#ff00aa');
    assert.match(dark.custom_css, /--rv-asset-flower: url\("data:image\/svg\+xml/);
    assert.doesNotMatch(dark.custom_css, /javascript:/);
    assert.match(dark.custom_css, /--rv-ui-font: 'Nunito'/);
    assert.equal(dark.chat_display, 'bubbles');
    const light = resolveReverieTheme(rt, true);
    assert.equal(light.main_text_color, 'rgba(9, 9, 9, 1)');
    assert.equal(light.rv_light, true);
    const st = reverieToSillyTavern(rt);
    assert.equal(typeof st.chat_display, 'number');
    const back = toReverieTheme(BUILTIN_THEMES[0]);
    assert.equal(back.format, 'reverie-theme');
    assert.ok(back.variants.dark.text);
});
