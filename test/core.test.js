const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  selectNext,
  skipKey,
  parsePrompt,
  archiveName,
  preview,
  resolveInboxPath,
  gitignoreCovers
} = require('../src/core.js');

test('selectNext', async (t) => {
  await t.test('returns null for empty or non-array entries', () => {
    assert.equal(selectNext([], 10000), null);
    assert.equal(selectNext(null, 10000), null);
    assert.equal(selectNext(undefined, 10000), null);
  });

  await t.test('prompt.md beats 001.prompt.md', () => {
    const entries = [
      { name: '001.prompt.md', isFile: true, mtimeMs: 1000 },
      { name: 'prompt.md', isFile: true, mtimeMs: 1000 }
    ];
    const chosen = selectNext(entries, 10000);
    assert.equal(chosen.name, 'prompt.md');
  });

  await t.test('numeric order sorts 2 before 10', () => {
    const entries = [
      { name: '10.prompt.md', isFile: true, mtimeMs: 1000 },
      { name: '2.prompt.md', isFile: true, mtimeMs: 1000 }
    ];
    const chosen = selectNext(entries, 10000);
    assert.equal(chosen.name, '2.prompt.md');
  });

  await t.test('ignores non-files, notes.md, .prompt.md, prompt.md.bak, sent-1.md', () => {
    const entries = [
      { name: 'prompt.md', isFile: false, mtimeMs: 1000 },
      { name: 'notes.md', isFile: true, mtimeMs: 1000 },
      { name: '.prompt.md', isFile: true, mtimeMs: 1000 },
      { name: 'prompt.md.bak', isFile: true, mtimeMs: 1000 },
      { name: 'sent-1.md', isFile: true, mtimeMs: 1000 }
    ];
    assert.equal(selectNext(entries, 10000), null);
  });

  await t.test('ignores files newer than settleMs', () => {
    const nowMs = 10000;
    const entries = [
      { name: 'prompt.md', isFile: true, mtimeMs: 9000 },
      { name: '1.prompt.md', isFile: true, mtimeMs: 8000 }
    ];
    // Default settleMs is 1500 (10000 - 1500 = 8500). prompt.md is 9000 > 8500 -> settling.
    const chosen = selectNext(entries, nowMs);
    assert.equal(chosen.name, '1.prompt.md');

    // Both settling
    assert.equal(selectNext([{ name: '1.prompt.md', isFile: true, mtimeMs: 9000 }], nowMs), null);

    // Custom settleMs: 500 -> 9000 <= 9500 -> prompt.md is settled
    const chosenCustom = selectNext(entries, nowMs, { settleMs: 500 });
    assert.equal(chosenCustom.name, 'prompt.md');
  });

  await t.test('honors skip set and retries after mtime change', () => {
    const nowMs = 10000;
    const entries = [
      { name: 'prompt.md', isFile: true, mtimeMs: 5000 },
      { name: '2.prompt.md', isFile: true, mtimeMs: 5000 }
    ];
    const skip = new Set(['prompt.md|5000']);
    const chosen = selectNext(entries, nowMs, { skip });
    assert.equal(chosen.name, '2.prompt.md');

    // After prompt.md is modified, mtime changes and skip no longer matches
    const updatedEntries = [
      { name: 'prompt.md', isFile: true, mtimeMs: 6000 },
      { name: '2.prompt.md', isFile: true, mtimeMs: 5000 }
    ];
    const chosenUpdated = selectNext(updatedEntries, nowMs, { skip });
    assert.equal(chosenUpdated.name, 'prompt.md');
  });
});

test('skipKey', () => {
  assert.equal(skipKey({ name: 'prompt.md', mtimeMs: 123456 }), 'prompt.md|123456');
  assert.equal(skipKey({ name: '01.prompt.md', mtimeMs: 0 }), '01.prompt.md|0');
});

test('parsePrompt', async (t) => {
  await t.test('marker present returns newConversation true and trimmed body', () => {
    const result = parsePrompt('<!-- new-conversation -->\nHello agent');
    assert.deepEqual(result, {
      newConversation: true,
      body: 'Hello agent',
      isEmpty: false
    });
  });

  await t.test('marker absent returns newConversation false and full body', () => {
    const result = parsePrompt('Hello agent\n<!-- new-conversation -->');
    assert.deepEqual(result, {
      newConversation: false,
      body: 'Hello agent\n<!-- new-conversation -->',
      isEmpty: false
    });
  });

  await t.test('marker after leading blank lines is detected', () => {
    const result = parsePrompt('\n\r\n  \n<!-- new-conversation -->\n\nTask text\n');
    assert.deepEqual(result, {
      newConversation: true,
      body: 'Task text\n',
      isEmpty: false
    });
  });

  await t.test('strips leading UTF-8 BOM with or without marker', () => {
    const withMarker = parsePrompt('\uFEFF<!-- new-conversation -->\nTask text');
    assert.deepEqual(withMarker, {
      newConversation: true,
      body: 'Task text',
      isEmpty: false
    });

    const withoutMarker = parsePrompt('\uFEFFTask text');
    assert.deepEqual(withoutMarker, {
      newConversation: false,
      body: 'Task text',
      isEmpty: false
    });
  });

  await t.test('marker-only file yields isEmpty true', () => {
    const result = parsePrompt('<!-- new-conversation -->');
    assert.deepEqual(result, {
      newConversation: true,
      body: '',
      isEmpty: true
    });

    const resultWithWhitespace = parsePrompt('  \n<!-- new-conversation -->  \n\t  ');
    assert.deepEqual(resultWithWhitespace, {
      newConversation: true,
      body: '',
      isEmpty: true
    });

    const empty = parsePrompt('');
    assert.deepEqual(empty, {
      newConversation: false,
      body: '',
      isEmpty: true
    });
  });

  await t.test('custom marker works', () => {
    const result = parsePrompt('[NEW]\nCustom task', '[NEW]');
    assert.deepEqual(result, {
      newConversation: true,
      body: 'Custom task',
      isEmpty: false
    });
  });

  await t.test('empty marker or non-string marker disables new-conversation detection', () => {
    const emptyMarker = parsePrompt('<!-- new-conversation -->\nHello', '');
    assert.deepEqual(emptyMarker, {
      newConversation: false,
      body: '<!-- new-conversation -->\nHello',
      isEmpty: false
    });

    const nonStringMarker = parsePrompt('<!-- new-conversation -->\nHello', null);
    assert.deepEqual(nonStringMarker, {
      newConversation: false,
      body: '<!-- new-conversation -->\nHello',
      isEmpty: false
    });
  });
});

test('archiveName', () => {
  const nowMs = Date.UTC(2026, 9, 9, 14, 3, 22, 123);
  const sent = archiveName('001.prompt.md', nowMs, 'sent');
  assert.equal(sent, '2026-10-09T14-03-22-123Z-001.prompt.md');
  assert.equal(sent.includes(':'), false);

  const defaultKind = archiveName('001.prompt.md', nowMs);
  assert.equal(defaultKind, '2026-10-09T14-03-22-123Z-001.prompt.md');

  const discarded = archiveName('001.prompt.md', nowMs, 'discarded');
  assert.equal(discarded, 'discarded-2026-10-09T14-03-22-123Z-001.prompt.md');
  assert.equal(discarded.includes(':'), false);
});

test('preview', () => {
  assert.equal(preview('short text'), 'short text');
  assert.equal(preview('  short text with spaces  '), 'short text with spaces');

  const text450 = 'a'.repeat(450);
  assert.equal(preview(text450, 400), 'a'.repeat(400) + '\n… (50 more chars)');

  const exact400 = 'b'.repeat(400);
  assert.equal(preview(exact400, 400), exact400);
});

test('resolveInboxPath', () => {
  // default: setting is empty string or whitespace
  assert.equal(resolveInboxPath('', '/workspace'), path.join('/workspace', '.agent-inbox'));
  assert.equal(resolveInboxPath('   ', '/workspace'), path.join('/workspace', '.agent-inbox'));
  assert.equal(resolveInboxPath(undefined, '/workspace'), path.join('/workspace', '.agent-inbox'));

  // relative setting
  assert.equal(resolveInboxPath('custom/inbox', '/workspace'), path.join('/workspace', 'custom/inbox'));
  assert.equal(resolveInboxPath('  custom/inbox  ', '/workspace'), path.join('/workspace', 'custom/inbox'));

  // absolute setting
  const absPath = path.resolve('/var/custom-inbox');
  assert.equal(resolveInboxPath(absPath, '/workspace'), path.normalize(absPath));
  assert.equal(resolveInboxPath(absPath, null), path.normalize(absPath));

  // no workspace
  assert.equal(resolveInboxPath('', null), null);
  assert.equal(resolveInboxPath('relative/inbox', null), null);
  assert.equal(resolveInboxPath('relative/inbox', undefined), null);
});

test('gitignoreCovers', () => {
  // each accepted form
  assert.equal(gitignoreCovers('.agent-inbox'), true);
  assert.equal(gitignoreCovers('.agent-inbox/'), true);
  assert.equal(gitignoreCovers('/.agent-inbox'), true);
  assert.equal(gitignoreCovers('/.agent-inbox/'), true);

  // custom dirName
  assert.equal(gitignoreCovers('custom-inbox', 'custom-inbox'), true);
  assert.equal(gitignoreCovers('/custom-inbox/', 'custom-inbox'), true);

  // CRLF content
  const crlf = 'node_modules\r\n.agent-inbox/\r\nout\r\n';
  assert.equal(gitignoreCovers(crlf), true);

  // commented line does not count
  assert.equal(gitignoreCovers('# .agent-inbox'), false);
  assert.equal(gitignoreCovers('# .agent-inbox\n# /.agent-inbox/'), false);

  // commented line with real match
  assert.equal(gitignoreCovers('# .agent-inbox\n.agent-inbox'), true);

  // undefined or empty content
  assert.equal(gitignoreCovers(undefined), false);
  assert.equal(gitignoreCovers(''), false);
  assert.equal(gitignoreCovers(null), false);
  assert.equal(gitignoreCovers('other-folder'), false);
});
