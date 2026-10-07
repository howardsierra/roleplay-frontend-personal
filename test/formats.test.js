// Unit tests for format compatibility: SillyTavern & Lumiverse presets, macros, regex,
// PNG character cards and the extension import rewriter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { importPreset, toSillyTavern, toLumiverse, fromSillyTavern } from '../public/js/presets.js';
import { state } from '../public/js/state.js';
import { substituteParams } from '../public/js/macros.js';
import { applyRegex, REGEX_PLACEMENT } from '../public/js/regex.js';
import { readCardText, writeCardText } from '../server/lib/png.js';
import { normalizeCard, placeholderPng } from '../server/lib/card.js';
import { rewriteImports, buildShimModule } from '../server/lib/esm-shim.js';
import { importTheme, exportTheme } from '../public/js/themes.js';

const fixture = name => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('imports the SillyTavern default chat-completion preset', () => {
    const st = fixture('st-default-preset.json');
    const p = importPreset(st, 'Default');
    assert.equal(p.source, 'sillytavern');
    assert.equal(p.name, 'Default');
    const markers = p.blocks.map(b => b.marker).filter(Boolean);
    for (const m of ['main_prompt', 'chat_history', 'char_description', 'world_info_before', 'jailbreak']) assert.ok(markers.includes(m), m);
    assert.equal(p.samplers.max_tokens, st.openai_max_tokens);
    assert.equal(p.samplers.context_size, st.openai_max_context);
    const main = p.blocks.find(b => b.marker === 'main_prompt');
    assert.match(main.content, /\{\{char\}\}/);
});

test('round-trips SillyTavern presets', () => {
    const st = fixture('st-default-preset.json');
    const p = importPreset(st, 'Default');
    const back = toSillyTavern(p);
    const again = fromSillyTavern(back, 'Default');
    assert.deepEqual(again.blocks.map(b => [b.marker, b.enabled, b.content]), p.blocks.map(b => [b.marker, b.enabled, b.content]));
    assert.equal(back.prompt_order[0].character_id, 100001);
});

test('imports a Lumiverse (Loom) preset with variables and regex', () => {
    const p = importPreset(fixture('lumiverse-preset.json'));
    assert.equal(p.source, 'lumiverse');
    assert.equal(p.samplers.temperature, 0.85);
    assert.equal(p.samplers.max_tokens, 1500);
    assert.deepEqual(p.stopStrings, ['</end>']);
    assert.equal(p.regex.length, 1);
    const loom = toLumiverse(p);
    assert.equal(loom.blocks.length, 5);
    assert.equal(loom.samplerOverrides.temperature, 0.85);
});

test('macros: names, Lumiverse {{var::}}, variables, random/pick, comments, trim', () => {
    state.settings.personas = [{ id: 'u', name: 'Howard', description: 'A wanderer' }];
    state.settings.personaId = 'u';
    state.character = { card: { data: { name: 'Elara', description: '{{char}} the mage', personality: '', scenario: '' } } };
    state.preset = importPreset(fixture('lumiverse-preset.json'));
    state.chatMeta = { chat_metadata: {} };
    assert.equal(substituteParams('Hi {{user}}, I am {{char}}.'), 'Hi Howard, I am Elara.');
    assert.equal(substituteParams('{{var::tone}}'), 'light-hearted');
    assert.equal(substituteParams('{{var::length}}'), '300');
    assert.equal(substituteParams('{{var::extras}}'), ' Beta.');
    assert.equal(substituteParams('{{var::extras::ison::b}}'), 'true');
    assert.equal(substituteParams('{{setvar::hp::10}}{{addvar::hp::5}}{{getvar::hp}}'), '15');
    assert.equal(substituteParams('a{{// hidden }}b'), 'ab');
    assert.equal(substituteParams('line\n\n{{trim}}\n\nnext'), 'linenext');
    assert.ok(['x', 'y'].includes(substituteParams('{{random::x::y}}')));
    assert.equal(substituteParams('{{pick::a::b::c}}'), substituteParams('{{pick::a::b::c}}'));
    assert.match(substituteParams('{{roll:1d6}}'), /^[1-6]$/);
    assert.equal(substituteParams('{{unknownmacro}} {{user}}'), '{{unknownmacro}} Howard');
    assert.equal(substituteParams('{{setvar::n::{{user}}}}{{getvar::n}}'), 'Howard');
    assert.equal(substituteParams('{{description}}'), 'Elara the mage');
});

test('regex scripts honour placement and markdown/prompt-only flags', () => {
    state.settings.regex = [
        { id: 'a', scriptName: 'shout', findRegex: '/hello/gi', replaceString: 'HELLO', placement: [REGEX_PLACEMENT.AI_OUTPUT] },
        { id: 'b', scriptName: 'panel', findRegex: '/<hp>(\\d+)<\\/hp>/g', replaceString: '<b>HP {{match}} $1</b>', placement: [REGEX_PLACEMENT.AI_OUTPUT], markdownOnly: true },
    ];
    state.preset = { regex: [] };
    assert.equal(applyRegex('hello <hp>5</hp>', REGEX_PLACEMENT.AI_OUTPUT), 'HELLO <hp>5</hp>');
    assert.equal(applyRegex('x <hp>5</hp>', REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }), 'x <b>HP <hp>5</hp> 5</b>');
    assert.equal(applyRegex('hello', REGEX_PLACEMENT.USER_INPUT), 'hello');
});

test('PNG character cards round-trip (V2 + V3 chunks)', () => {
    const card = normalizeCard({ name: 'Old V1', description: 'flat v1 card', first_mes: 'hi' });
    assert.equal(card.data.name, 'Old V1');
    const png = writeCardText(placeholderPng('x', 32), card);
    const text = readCardText(png);
    assert.equal(JSON.parse(text.chara).data.description, 'flat v1 card');
    assert.equal(JSON.parse(text.ccv3).spec, 'chara_card_v3');
    // Re-embedding replaces instead of duplicating.
    const again = readCardText(writeCardText(png, { ...card, data: { ...card.data, name: 'New' } }));
    assert.equal(JSON.parse(again.chara).data.name, 'New');
});

test('extension imports of ST core files are rewritten to shims', () => {
    const src = `import { eventSource, event_types as et } from '../../../../script.js';
import {
  extension_settings,
  getContext,
} from "../../../extensions.js";
import * as utils from '../../../utils.js';
import def from '../../../popup.js';
import { local } from './local.js';
import '../../../../lib.js';
export { foo } from '../../../extensions.js';
const later = await import('../../../../script.js');`;
    const out = rewriteImports(src, '/scripts/extensions/third-party/my-ext/index.js');
    assert.match(out, /from '\/st-shim\/script\.js\?n=eventSource%2Cevent_types'/);
    assert.match(out, /from "\/st-shim\/scripts\/extensions\.js\?n=extension_settings%2CgetContext"/);
    assert.match(out, /\/st-shim\/scripts\/utils\.js\?n=\*/);
    assert.match(out, /\/st-shim\/scripts\/popup\.js\?n=default/);
    assert.match(out, /from '\.\/local\.js'/);
    assert.match(out, /import '\/st-shim\/lib\.js\?n='/);
    assert.match(out, /export \{ foo \} from '\/st-shim\/scripts\/extensions\.js\?n=foo'/);
    assert.match(out, /import\('\/st-shim\/script\.js\?n=\*'\)/);
    const shim = buildShimModule('/script.js', 'eventSource,default,bad-name');
    assert.match(shim, /export let eventSource = S\.get\(M, "eventSource"\);/);
    assert.match(shim, /export \{ __rv_default as default \};/);
    assert.doesNotMatch(shim, /bad-name/);
});

test('SillyTavern themes import and export', () => {
    const t = importTheme(fixture('st-theme.json'));
    assert.equal(t.name, 'Celestial Macaron');
    assert.equal(typeof t.chat_display, 'string');
    const back = exportTheme(t);
    assert.equal(typeof back.chat_display, 'number');
    assert.equal(back.main_text_color, t.main_text_color);
});
