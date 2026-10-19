import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropic } from '../server/lib/providers.js';
import { parseJsonl } from '../server/routes/chats.js';

test('Claude conversion: leading system → system param, merges roles, starts with user', () => {
    const { system, messages } = toAnthropic([
        { role: 'system', content: 'You are Elara.' },
        { role: 'system', content: 'Lore.' },
        { role: 'assistant', content: 'Greeting' },
        { role: 'system', content: '[mid-chat note]' },
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Again' },
        { role: 'assistant', content: 'Prefill' },
    ]);
    assert.equal(system[0].text, 'You are Elara.\n\nLore.');
    assert.deepEqual(system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(messages[0].content, '[Start]');
    assert.equal(messages[2].content, '[mid-chat note]\n\nHi\n\nAgain');
    assert.equal(messages[3].content, 'Prefill');
});

test('SillyTavern JSONL chats parse with and without a header line', () => {
    const withHeader = `${JSON.stringify({ user_name: 'U', character_name: 'C', create_date: 'x', chat_metadata: { note_prompt: 'n' } })}\n${JSON.stringify({ name: 'C', is_user: false, mes: 'hello' })}\n`;
    const a = parseJsonl(withHeader);
    assert.equal(a.meta.chat_metadata.note_prompt, 'n');
    assert.equal(a.messages.length, 1);
    const b = parseJsonl(`${JSON.stringify({ name: 'U', is_user: true, mes: 'yo' })}\n`);
    assert.deepEqual(b.meta, {});
    assert.equal(b.messages[0].mes, 'yo');
});

test('Claude conversion: OpenAI-style image parts become Anthropic image blocks', () => {
    const { messages } = toAnthropic([
        { role: 'system', content: 'Describe.' },
        { role: 'user', content: [{ type: 'text', text: 'Who is this?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
});

test('Search snippets centre on the match and cut at word boundaries', async () => {
    const { searchSnippet } = await import('../server/routes/chats.js');
    const text = 'Elara glances up from the ancient tome, candlelight dancing across her silver hair. "Ah, a visitor at this hour? How delightfully unexpected." She closes the book with a soft thud and gestures to the chair across from her.';
    const s = searchSnippet(text, 'silver');
    assert.ok(s.includes('silver hair'));
    assert.ok(s.startsWith('…') && !s.startsWith('…lara'), s); // never starts mid-word
    assert.ok(s.endsWith('…'));
    assert.equal(searchSnippet('Short line.', 'short'), 'Short line.');
});

test('A named provider never sends its key to another host', async () => {
    const { resolveBase } = await import('../server/lib/providers.js');
    assert.equal(resolveBase('openai', 'https://evil.example/v1'), 'https://api.openai.com/v1');
    assert.equal(resolveBase('openai', 'https://api.openai.com/v1/'), 'https://api.openai.com/v1');
    assert.equal(resolveBase('custom', 'http://127.0.0.1:5001/v1'), 'http://127.0.0.1:5001/v1');
});

test('File names keep SillyTavern chat names and never escape their folder', async () => {
    const { safeName } = await import('../server/lib/storage.js');
    assert.equal(safeName('Elara - 2024-05-12@14h33m02s'), 'Elara - 2024-05-12@14h33m02s');
    assert.equal(safeName('../../etc/passwd'), 'etcpasswd');
    assert.throws(() => safeName('///'));
});

// ---------------------------------------------------------------- importers (cards and chats)
import JSZip from 'jszip';
import { normalizeCard, exportableCard, worldToCharacterBook, placeholderPng } from '../server/lib/card.js';
import { parseCharacterUpload, convertChatImport } from '../server/lib/importers.js';

test('V1 cards upconvert like SillyTavern (extensions, leftovers, comma tags)', () => {
    const card = normalizeCard({
        name: 'Old', description: 'd', personality: 'p', scenario: 's', first_mes: 'hi', mes_example: '',
        creatorcomment: 'notes', talkativeness: '0.7', fav: 'true', tags: 'a, b,,c', avatar: 'old.png', chat: 'Old - x',
        create_date: 'yesterday', json_data: '{}', depth_prompt_prompt: 'dp', depth_prompt_depth: '2', depth_prompt_role: 'user',
    });
    assert.equal(card.spec, 'chara_card_v2');
    assert.deepEqual(card.data.tags, ['a', 'b', 'c']);
    assert.equal(card.data.creator_notes, 'notes');
    assert.equal(card.data.extensions.talkativeness, '0.7');
    assert.equal(card.data.extensions.fav, true);
    assert.deepEqual(card.data.extensions.depth_prompt, { prompt: 'dp', depth: 2, role: 'user' });
    for (const k of ['avatar', 'chat', 'create_date', 'creatorcomment', 'json_data', 'talkativeness', 'depth_prompt_prompt']) assert.ok(!(k in card.data), k);
});

test('gradio / Pygmalion JSON cards import', async () => {
    const { card } = await parseCharacterUpload(Buffer.from(JSON.stringify({ char_name: 'Pyg', char_persona: 'persona', char_greeting: 'hello', world_scenario: 'world', example_dialogue: '<START>' })));
    const n = normalizeCard(card, { fromImport: true });
    assert.equal(n.data.name, 'Pyg');
    assert.equal(n.data.description, 'persona');
    assert.equal(n.data.first_mes, 'hello');
    assert.equal(n.data.scenario, 'world');
    assert.equal(n.data.mes_example, '<START>');
});

test('V3 cards keep their spec; JSON export adds V1 mirror fields and clears fav', () => {
    const card = normalizeCard({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Three', description: 'x', extensions: { fav: true, talkativeness: 0.4 } } });
    assert.equal(card.spec, 'chara_card_v3');
    assert.equal(card.spec_version, '3.0');
    const out = exportableCard(card);
    assert.equal(out.name, 'Three');
    assert.equal(out.description, 'x');
    assert.equal(out.fav, false);
    assert.equal(out.data.extensions.fav, false);
    assert.equal(out.talkativeness, 0.4);
    assert.equal(out.spec, 'chara_card_v3');
    assert.equal(card.data.extensions.fav, true); // the stored card is untouched
});

test('Marinara native character exports unwrap with avatar, backstory and appearance', async () => {
    const png = placeholderPng('m', 8);
    const envelope = {
        type: 'marinara_character', version: 1, exportedAt: 'now',
        data: { spec: 'chara_card_v2', spec_version: '2.0', data: { name: 'Mari', description: 'Desc', extensions: { backstory: 'Born in a lab.', appearance: 'Red hair.' } }, avatar: `data:image/png;base64,${png.toString('base64')}`, metadata: {} },
    };
    const { card, avatar } = await parseCharacterUpload(Buffer.from(JSON.stringify(envelope)));
    assert.ok(avatar.equals(png));
    const n = normalizeCard(card, { fromImport: true });
    assert.equal(n.data.name, 'Mari');
    assert.equal(n.data.description, 'Desc\n\nBackstory:\nBorn in a lab.\n\nAppearance:\nRed hair.');
    assert.ok(!('backstory' in n.data.extensions));
    // Already in the description: not added twice.
    const again = normalizeCard({ spec: 'chara_card_v2', data: { name: 'M', description: 'Red hair.', extensions: { appearance: 'Red hair.' } } }, { fromImport: true });
    assert.equal(again.data.description, 'Red hair.');
});

test('CharX archives import card.json, the main icon and Lumiverse world books', async () => {
    const icon = placeholderPng('icon', 8);
    const zip = new JSZip();
    zip.file('card.json', JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Zipped', assets: [{ type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' }] } }));
    zip.file('assets/icon/images/main.png', icon);
    zip.file('lumiverse_modules.json', JSON.stringify({ world_books: [{ name: 'Book', entries: [{ key: ['k'], content: 'c' }] }] }));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const { card, avatar, books } = await parseCharacterUpload(buf);
    assert.equal(card.data.name, 'Zipped');
    assert.ok(avatar.equals(icon));
    assert.equal(books[0].name, 'Book');
    await assert.rejects(parseCharacterUpload(Buffer.from('not a card')), /Not a PNG/);
});

test('Linked lorebooks embed as character_book field for field like SillyTavern', () => {
    const book = worldToCharacterBook('World', { 5: { uid: 5, key: ['a'], keysecondary: [], comment: 'c', content: 'x', constant: false, selective: true, order: 10, disable: false, position: 4, caseSensitive: true, displayIndex: 2, extensions: { custom: 1 } } });
    const e = book.entries[0];
    assert.equal(book.name, 'World');
    assert.equal(e.id, 5);
    assert.equal(e.position, 'after_char');
    assert.equal(e.use_regex, true);
    assert.equal(e.extensions.position, 4);
    assert.equal(e.extensions.case_sensitive, true);
    assert.equal(e.extensions.display_index, 2);
    assert.equal(e.extensions.custom, 1);
    assert.deepEqual(e.extensions.triggers, []);
});

test('JSONL chat import skips bad lines and fills a header', () => {
    const src = `${JSON.stringify({ name: 'U', is_user: true, mes: 'one' })}\n{not json\n${JSON.stringify({ name: 'C', is_user: false, mes: 'two' })}\n`;
    const { chats, skipped } = convertChatImport(src, { userName: 'Me', characterName: 'Elara' });
    assert.equal(skipped, 1);
    assert.equal(chats[0].messages.length, 2);
    assert.equal(chats[0].meta.character_name, 'Elara');
    assert.deepEqual(parseJsonl(src).messages.map(m => m.mes), ['one', 'two']);
});

test('Chat imports: oobabooga, Agnai, CAI Tools, Kobold Lite, RisuAI and Chub', () => {
    const opts = { userName: 'Me', characterName: 'Elara' };
    const ooba = convertChatImport(JSON.stringify({ data_visible: [['hi', 'hello'], ['', 'more']] }), opts);
    assert.equal(ooba.format, 'ooba');
    assert.deepEqual(ooba.chats[0].messages.map(m => [m.name, m.is_user, m.mes]), [['Me', true, 'hi'], ['Elara', false, 'hello'], ['Elara', false, 'more']]);
    const agnai = convertChatImport(JSON.stringify({ messages: [{ userId: 'u', msg: 'a' }, { msg: 'b' }] }), opts);
    assert.deepEqual(agnai.chats[0].messages.map(m => m.is_user), [true, false]);
    const cai = convertChatImport(JSON.stringify({ histories: { histories: [{ msgs: [{ src: { is_human: true }, text: 'x' }] }, { msgs: [{ src: { is_human: false }, text: 'y' }] }] } }), opts);
    assert.equal(cai.chats.length, 2);
    const kobold = convertChatImport(JSON.stringify({ savedsettings: { chatname: 'K', chatopponent: 'Bot||$||x' }, prompt: '{{[OUTPUT]}}Hi', actions: ['{{[INPUT]}}yo', '{{[OUTPUT]}}sup'] }), opts);
    assert.deepEqual(kobold.chats[0].messages.map(m => [m.name, m.mes]), [['Bot', 'Hi'], ['K', 'yo'], ['Bot', 'sup']]);
    const risu = convertChatImport(JSON.stringify({ type: 'risuChat', data: { message: [{ role: 'user', data: 'q', time: 0 }, { role: 'char', data: 'a' }] } }), opts);
    assert.deepEqual(risu.chats[0].messages.map(m => [m.name, m.mes]), [['Me', 'q'], ['Elara', 'a']]);
    const chub = convertChatImport(`${JSON.stringify({ user_name: 'U', character_name: 'C', chat_metadata: {} })}\n${JSON.stringify({ name: 'C', mes: { message: 'flat' }, swipes: [{ message: 'flat' }, 'two'] })}`, opts);
    assert.equal(chub.chats[0].messages[0].mes, 'flat');
    assert.deepEqual(chub.chats[0].messages[0].swipes, ['flat', 'two']);
});

test('Marinara chat exports keep message ids, reasoning and summaries (as memories)', () => {
    const header = { user_name: 'U', character_name: 'C', chat_metadata: { summaryEntries: [{ id: 's1', title: 'Act 1', content: 'They met.', enabled: true, messageIds: ['a', 'b'], createdAt: '2025-01-01T00:00:00Z' }] } };
    const lines = [header, { name: 'U', is_user: true, mes: 'hi', marinara_message_id: 'a' }, { name: 'C', mes: 'hello', reasoning_content: 'thinking…', marinara_message_id: 'b' }, { name: 'U', is_user: true, mes: 'later' }];
    const { chats } = convertChatImport(lines.map(l => JSON.stringify(l)).join('\n'));
    const [chat] = chats;
    assert.equal(chat.messages[0].rv_id, 'a');
    assert.equal(chat.messages[1].extra.reasoning, 'thinking…');
    assert.ok(!('reasoning_content' in chat.messages[1]));
    const [mem] = chat.meta.chat_metadata.rv_memory.entries;
    assert.deepEqual([mem.title, mem.text, mem.fromId, mem.toId, mem.toIndex, mem.enabled, mem.pinned], ['Act 1', 'They met.', 'a', 'b', 2, true, false]);
    assert.deepEqual(mem.keys, []);
});
