const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePrompt, decideConfirm, decideConversation } = require('../src/core.js');

test('parsePrompt recognises the same-conversation marker', () => {
  const r = parsePrompt('<!-- same-conversation -->\nFix the test.');
  assert.equal(r.conversation, 'same');
  assert.equal(r.newConversation, false);
  assert.equal(r.body, 'Fix the test.');
  assert.equal(parsePrompt('Fix it.\n<!-- same-conversation -->').conversation, null, 'only at the start');
  assert.equal(parsePrompt('<!-- same-conversation -->').isEmpty, true);
});

test('decideConfirm: untrusted workspaces always ask', () => {
  assert.equal(decideConfirm('never', undefined, { trusted: false }), 'ask');
  assert.equal(decideConfirm('auto', 'always', { trusted: false, allProjects: true }), 'ask');
});

test('decideConfirm: "all trusted projects" skips the question unless the project said otherwise', () => {
  assert.equal(decideConfirm('auto', undefined, { trusted: true, allProjects: true }), 'send');
  assert.equal(decideConfirm('auto', 'ask', { trusted: true, allProjects: true }), 'ask', 'project choice wins');
  assert.equal(decideConfirm('always', undefined, { trusted: true, allProjects: true }), 'ask', 'always means always');
  assert.equal(decideConfirm('auto', undefined, { trusted: true }), 'first');
  assert.equal(decideConfirm('auto', undefined), 'first', 'old call shape still works');
});

test('decideConversation perTask: new task id -> new chat, same id -> same chat', () => {
  const first = decideConversation({ mode: 'perTask', marker: null, id: 't1', current: null, maxPrompts: 5 });
  assert.equal(first.newConversation, true);
  assert.deepEqual(first.next, { taskId: 't1', prompts: 1 });

  const fix = decideConversation({ mode: 'perTask', marker: null, id: 't1', current: first.next, maxPrompts: 5 });
  assert.equal(fix.newConversation, false);
  assert.deepEqual(fix.next, { taskId: 't1', prompts: 2 });

  const next = decideConversation({ mode: 'perTask', marker: null, id: 't2', current: fix.next, maxPrompts: 5 });
  assert.equal(next.newConversation, true);
  assert.equal(next.reason, 'new task');
});

test('decideConversation markers override the mode', () => {
  const cur = { taskId: 't1', prompts: 2 };
  assert.equal(decideConversation({ mode: 'perTask', marker: 'same', id: 't2', current: cur, maxPrompts: 5 }).newConversation, false);
  assert.deepEqual(decideConversation({ mode: 'perTask', marker: 'same', id: 't2', current: cur, maxPrompts: 5 }).next, { taskId: 't1', prompts: 3 });
  assert.equal(decideConversation({ mode: 'marker', marker: 'new', id: 't1', current: cur, maxPrompts: 0 }).newConversation, true);
  assert.equal(decideConversation({ mode: 'marker', marker: null, id: 't9', current: cur, maxPrompts: 0 }).newConversation, false);
  assert.equal(decideConversation({ mode: 'marker', marker: null, id: 't9', current: null, maxPrompts: 0 }).newConversation, false);
});

test('decideConversation starts over after maxPrompts, unless told "same"', () => {
  const cur = { taskId: 't1', prompts: 5 };
  const r = decideConversation({ mode: 'perTask', marker: null, id: 't1', current: cur, maxPrompts: 5 });
  assert.equal(r.newConversation, true);
  assert.match(r.reason, /5 prompts/);
  assert.deepEqual(r.next, { taskId: 't1', prompts: 1 });
  assert.equal(decideConversation({ mode: 'marker', marker: null, id: 'x', current: cur, maxPrompts: 5 }).newConversation, true);
  assert.equal(decideConversation({ mode: 'perTask', marker: 'same', id: 't1', current: cur, maxPrompts: 5 }).newConversation, false);
  assert.equal(decideConversation({ mode: 'perTask', marker: null, id: 't1', current: cur, maxPrompts: 0 }).newConversation, false, '0 = no limit');
});
