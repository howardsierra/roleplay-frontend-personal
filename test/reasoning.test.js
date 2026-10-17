import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitReasoning, endsInsideThinking } from '../public/js/reasoning.js';
import { applyRegex, REGEX_PLACEMENT } from '../public/js/regex.js';
import { state } from '../public/js/state.js';

test('Inline thinking moves out of the reply', () => {
    assert.deepEqual(splitReasoning('<think>plan</think>\n\nElara smiles.'), { reasoning: 'plan', text: 'Elara smiles.', open: false });
    assert.equal(splitReasoning('<Thinking>a</Thinking>Hi').text, 'Hi');
    // The preset's prefill opened the tag: only the closing tag is in the reply.
    assert.deepEqual(splitReasoning('plan via prefill</think>Story', {}), { reasoning: 'plan via prefill', text: 'Story', open: false });
    assert.equal(splitReasoning('still going', { streaming: true, startsInside: true }).text, '');
    // Mid-reply blocks and half-typed tags while streaming.
    assert.equal(splitReasoning('A. <think>aside</think> B.').reasoning, 'aside');
    assert.equal(splitReasoning('Story <thi', { streaming: true }).text, 'Story ');
    assert.equal(splitReasoning('No tags, "quote" *action*').text, 'No tags, "quote" *action*');
    assert.ok(endsInsideThinking('Sure.\n<think>'));
    assert.ok(!endsInsideThinking('<think>x</think>'));
});

test('Custom thinking markers and turning parsing off', () => {
    state.settings.reasoning = { autoParse: true, tags: 'scratchpad', prefix: '[THINK]', suffix: '[/THINK]' };
    assert.equal(splitReasoning('<scratchpad>x</scratchpad>Hi').text, 'Hi');
    assert.equal(splitReasoning('[THINK]y[/THINK]Hey').reasoning, 'y');
    state.settings.reasoning = { autoParse: false };
    assert.equal(splitReasoning('<think>x</think>Hi').text, '<think>x</think>Hi');
    state.settings.reasoning = { autoParse: true };
});

test('Regex scripts: display / prompt / both / baked', () => {
    const base = { findRegex: '/secret/g', replaceString: 'X', placement: [REGEX_PLACEMENT.AI_OUTPUT] };
    state.settings.regex = [{ ...base, scriptName: 'both', markdownOnly: true, promptOnly: true }];
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }), 'a X');
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true }), 'a X');
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT), 'a secret');
    state.settings.regex = [{ ...base, scriptName: 'display', markdownOnly: true }];
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT, { isPrompt: true }), 'a secret');
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }), 'a X');
    state.settings.regex = [{ ...base, scriptName: 'baked' }];
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT), 'a X');
    assert.equal(applyRegex('a secret', REGEX_PLACEMENT.AI_OUTPUT, { isMarkdown: true }), 'a secret');
    state.settings.regex = [];
});
