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
  gitignoreCovers,
  parseLessons,
  formatLesson,
  hasLesson,
  applyLessons,
  makeId,
  isValidId,
  extractId,
  idFromFileName,
  relInboxForPrompt,
  buildFooter,
  withFooter,
  parseDoneFile,
  findStuck
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

test('parseLessons', () => {
  assert.deepEqual(parseLessons(undefined), []);
  assert.deepEqual(parseLessons(''), []);

  const content = `# Project Lessons
Here is some introductory prose that should be ignored.

- 2026-10-09 · core: forgot settleMs check → always check settleMs
Some more prose in between.

  - 2026-10-08 · tests: missed CRLF edge case → test both LF and CRLF

### Another heading
- general: do not rush → take time to read requirements
`;
  assert.deepEqual(parseLessons(content), [
    '2026-10-09 · core: forgot settleMs check → always check settleMs',
    '2026-10-08 · tests: missed CRLF edge case → test both LF and CRLF',
    'general: do not rush → take time to read requirements'
  ]);

  // CRLF handling
  const crlfContent = '# Heading\r\n- First lesson\r\n\r\nProse line\r\n- Second lesson\r\n';
  assert.deepEqual(parseLessons(crlfContent), ['First lesson', 'Second lesson']);
});

test('formatLesson', () => {
  const fixedNowMs = Date.UTC(2026, 9, 9, 12, 0, 0);

  // Exact match for a fixed nowMs
  const formatted = formatLesson('core', 'forgot settleMs', 'check settleMs', fixedNowMs);
  assert.equal(formatted, '- 2026-10-09 · core: forgot settleMs → check settleMs');

  // Whitespace collapsing inside area, mistake, and rule
  const messy = formatLesson('  core \n\t bridge  ', ' did \n  something   wrong \t', '  do\n  this   instead ', fixedNowMs);
  assert.equal(messy, '- 2026-10-09 · core bridge: did something wrong → do this instead');

  // 'general' default if area is empty after trimming
  assert.equal(formatLesson('', 'mistake', 'rule', fixedNowMs), '- 2026-10-09 · general: mistake → rule');
  assert.equal(formatLesson('   \n\t  ', 'mistake', 'rule', fixedNowMs), '- 2026-10-09 · general: mistake → rule');
  assert.equal(formatLesson(undefined, 'mistake', 'rule', fixedNowMs), '- 2026-10-09 · general: mistake → rule');

  // Throws on empty mistake or rule
  assert.throws(() => formatLesson('area', '', 'rule', fixedNowMs), /empty/);
  assert.throws(() => formatLesson('area', '   ', 'rule', fixedNowMs), /empty/);
  assert.throws(() => formatLesson('area', 'mistake', '', fixedNowMs), /empty/);
  assert.throws(() => formatLesson('area', 'mistake', '   ', fixedNowMs), /empty/);
});

test('hasLesson', () => {
  const content = `# Lessons
- 2026-10-09 · core: forgot settleMs check → always check settleMs
- 2026-10-08 · git: bad commit msg → use exact message
`;

  // Matches both mistake and rule
  assert.equal(hasLesson(content, 'forgot settleMs check', 'always check settleMs'), true);

  // Case-insensitive
  assert.equal(hasLesson(content, 'FORGOT SETTLEMS CHECK', 'ALWAYS CHECK SETTLEMS'), true);

  // Whitespace-collapsed matching
  assert.equal(hasLesson(content, 'forgot  \n settleMs   check', 'always \t check   settleMs'), true);

  // Partial match in text
  assert.equal(hasLesson(content, 'settleMs check', 'check settleMs'), true);

  // Missing rule or mistake -> false
  assert.equal(hasLesson(content, 'forgot settleMs check', 'nonexistent rule'), false);
  assert.equal(hasLesson(content, 'nonexistent mistake', 'always check settleMs'), false);

  // Empty or non-matching content
  assert.equal(hasLesson('', 'mistake', 'rule'), false);
  assert.equal(hasLesson(undefined, 'mistake', 'rule'), false);
});

test('applyLessons', async (t) => {
  const sampleLessons = `- 2026-10-07 · l1: mistake 1 → rule 1
- 2026-10-08 · l2: mistake 2 → rule 2
- 2026-10-09 · l3: mistake 3 → rule 3`;

  await t.test('mode off returns body unchanged', () => {
    const res = applyLessons('My prompt', {
      mode: 'off',
      relPath: '.agent-inbox/lessons.md',
      content: sampleLessons
    });
    assert.equal(res, 'My prompt');
  });

  await t.test('empty file / no lessons returns body unchanged', () => {
    const res1 = applyLessons('My prompt', {
      mode: 'reference',
      relPath: '.agent-inbox/lessons.md',
      content: '# Just heading\nNo lessons here'
    });
    assert.equal(res1, 'My prompt');

    const res2 = applyLessons('My prompt', {
      mode: 'inline',
      relPath: '.agent-inbox/lessons.md',
      content: ''
    });
    assert.equal(res2, 'My prompt');
  });

  await t.test('mode reference appends reference notice', () => {
    const res = applyLessons('My prompt', {
      mode: 'reference',
      relPath: '.agent-inbox/lessons.md',
      content: sampleLessons
    });
    assert.equal(
      res,
      'My prompt\n\n---\nBefore you start: read .agent-inbox/lessons.md (lessons from past reviews of your work in this repo) and do not repeat those mistakes.'
    );
  });

  await t.test('mode inline when all lessons fit keeps all without dropped note', () => {
    const res = applyLessons('My prompt', {
      mode: 'inline',
      relPath: '.agent-inbox/lessons.md',
      content: sampleLessons,
      maxChars: 4000
    });
    const expected = 'My prompt\n\n---\nLessons from past reviews of your work in this repo (do not repeat these mistakes):\n' +
      sampleLessons;
    assert.equal(res, expected);
  });

  await t.test('mode inline truncated keeps newest and reports dropped count', () => {
    const res = applyLessons('My prompt', {
      mode: 'inline',
      relPath: '.agent-inbox/lessons.md',
      content: sampleLessons,
      maxChars: 80
    });

    const expectedKept = '- 2026-10-08 · l2: mistake 2 → rule 2\n- 2026-10-09 · l3: mistake 3 → rule 3';
    const expected = 'My prompt\n\n---\nLessons from past reviews of your work in this repo (do not repeat these mistakes):\n' +
      expectedKept + '\n(1 older lessons in .agent-inbox/lessons.md)';
    assert.equal(res, expected);
  });

  await t.test('unknown mode behaves like reference', () => {
    const res = applyLessons('My prompt', {
      mode: 'something-else',
      relPath: '.agent-inbox/lessons.md',
      content: sampleLessons
    });
    assert.equal(
      res,
      'My prompt\n\n---\nBefore you start: read .agent-inbox/lessons.md (lessons from past reviews of your work in this repo) and do not repeat those mistakes.'
    );
  });
});

test('makeId', () => {
  assert.equal(makeId(new Date(2026, 9, 9, 18, 5), 'a1b2'), '20261009-1805-a1b2');
  const randomVariant = makeId();
  assert.match(randomVariant, /^\d{8}-\d{4}-[0-9a-f]{4}$/);
});

test('isValidId', () => {
  assert.equal(isValidId('task-42'), true);
  assert.equal(isValidId('a.b_c'), true);
  assert.equal(isValidId(''), false);
  assert.equal(isValidId('-x'), false);
  assert.equal(isValidId('a b'), false);
  assert.equal(isValidId('../x'), false);
  assert.equal(isValidId('a'.repeat(65)), false);
  assert.equal(isValidId('a'.repeat(64)), true);
});

test('extractId', async (t) => {
  await t.test('id first', () => {
    assert.deepEqual(extractId('<!-- id: abc-123 -->\nbody'), { id: 'abc-123', text: 'body' });
  });
  await t.test('id after marker', () => {
    assert.deepEqual(extractId('<!-- new-conversation -->\n<!-- id: a1 -->\ntext'), { id: 'a1', text: '<!-- new-conversation -->\ntext' });
  });
  await t.test('id after blank lines', () => {
    assert.deepEqual(extractId('\n  \n<!-- id: x -->\ntext'), { id: 'x', text: '\n  \ntext' });
  });
  await t.test('no id', () => {
    assert.deepEqual(extractId('body'), { id: null, text: 'body' });
  });
  await t.test('invalid id left untouched', () => {
    assert.deepEqual(extractId('<!-- id: a b -->\nbody'), { id: null, text: '<!-- id: a b -->\nbody' });
  });
  await t.test('id comment AFTER body text is ignored', () => {
    assert.deepEqual(extractId('body\n<!-- id: x -->'), { id: null, text: 'body\n<!-- id: x -->' });
  });
  await t.test('BOM', () => {
    assert.deepEqual(extractId('\uFEFF<!-- id: x -->\n'), { id: 'x', text: '' });
  });
  await t.test('CRLF', () => {
    assert.deepEqual(extractId('<!-- id: a -->\r\nbody'), { id: 'a', text: 'body' });
  });
});

test('idFromFileName', () => {
  assert.equal(idFromFileName('20261009-1830-a1b2.json', '.json'), '20261009-1830-a1b2');
  assert.equal(idFromFileName('x.txt', '.json'), null);
  assert.equal(idFromFileName('.json', '.json'), null);
});

test('relInboxForPrompt', () => {
  assert.equal(relInboxForPrompt(path.join('/ws', '.agent-inbox'), '/ws'), '.agent-inbox');
  assert.equal(relInboxForPrompt(path.join('/ws', 'a', 'b'), '/ws'), 'a/b');
  assert.equal(relInboxForPrompt('/ws', '/ws'), '.');
  
  const outside = path.resolve('/other/dir');
  assert.equal(relInboxForPrompt(outside, '/ws'), outside.replace(/\\/g, '/'));
  assert.equal(relInboxForPrompt(outside, null), outside.replace(/\\/g, '/'));
});

test('buildFooter', () => {
  const footer = buildFooter({ id: 'task-123', inboxRel: '.agent-inbox' });
  assert.ok(footer.startsWith('---\nAgent Bridge task id: task-123\n'));
  assert.ok(footer.includes('.agent-inbox/done/task-123.json'));
  assert.ok(footer.includes('{"id": "task-123"'));
  assert.ok(footer.includes('.agent-inbox/question/task-123.md'));
});

test('withFooter', () => {
  assert.equal(withFooter('body text', 'footer text'), 'body text\n\nfooter text');
  assert.equal(withFooter('body text', ''), 'body text');
  assert.equal(withFooter('body text', null), 'body text');
});

test('parseDoneFile', async (t) => {
  await t.test('valid done file', () => {
    const res = parseDoneFile('{"id": "a", "status": "DONE", "summary": "  did  it ", "commits": [" abc "]}', 'a');
    assert.deepEqual(res, { id: 'a', status: 'done', summary: 'did it', commits: ['abc'], valid: true, error: null });
  });
  await t.test('failed', () => {
    const res = parseDoneFile('{"status": "Failed"}', 'a');
    assert.equal(res.status, 'failed');
  });
  await t.test('blocked', () => {
    const res = parseDoneFile('{"status": "bLOCKED"}', 'a');
    assert.equal(res.status, 'blocked');
  });
  await t.test('unknown status', () => {
    const res = parseDoneFile('{"status": "other"}', 'a');
    assert.equal(res.status, 'unknown');
  });
  await t.test('invalid JSON', () => {
    const res = parseDoneFile('{bad}', 'a');
    assert.deepEqual(res, { id: 'a', status: 'invalid', summary: '', commits: [], valid: false, error: 'invalid JSON' });
  });
  await t.test('array JSON', () => {
    const res = parseDoneFile('[]', 'a');
    assert.deepEqual(res, { id: 'a', status: 'invalid', summary: '', commits: [], valid: false, error: 'invalid JSON' });
  });
  await t.test('null JSON', () => {
    const res = parseDoneFile('null', 'a');
    assert.deepEqual(res, { id: 'a', status: 'invalid', summary: '', commits: [], valid: false, error: 'invalid JSON' });
  });
  await t.test('BOM', () => {
    const res = parseDoneFile('\uFEFF{"status": "done"}', 'a');
    assert.equal(res.status, 'done');
  });
  await t.test('long summary truncated with …', () => {
    const res = parseDoneFile(`{"summary": "${'a'.repeat(400)}"}`, 'x');
    assert.equal(res.summary.length, 301);
    assert.ok(res.summary.endsWith('…'));
  });
  await t.test('commits filtered and capped', () => {
    const res = parseDoneFile('{"commits": [1, "", " c1 ", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9", "c10", "c11", "c12", "c13", "c14", "c15", "c16", "c17", "c18", "c19", "c20", "c21"]}', 'a');
    assert.equal(res.commits.length, 20);
    assert.equal(res.commits[0], 'c1');
    assert.equal(res.commits[19], 'c20');
  });
  await t.test('id mismatch error', () => {
    const res = parseDoneFile('{"id": "b"}', 'a');
    assert.equal(res.error, 'id mismatch: file says b');
    assert.equal(res.id, 'a');
  });
});

test('findStuck', () => {
  const pending = {
    a: { sentAt: 1000, stuckNotified: false },
    b: { sentAt: 1000, stuckNotified: true },
    c: { sentAt: 5000, stuckNotified: false }
  };
  const nowMs = 10000;
  
  assert.deepEqual(findStuck(pending, nowMs, 9), []);
  assert.deepEqual(findStuck(pending, nowMs, 0.1), ['a']);
  assert.deepEqual(findStuck(pending, nowMs, 0), []);
  assert.deepEqual(findStuck(pending, nowMs, -1), []);
  assert.deepEqual(findStuck(pending, nowMs, undefined), []);
});

