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
