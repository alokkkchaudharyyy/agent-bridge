const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { expiredFiles, orchestratorPrompt } = require('../src/core.js');

const DAY = 24 * 60 * 60 * 1000;

test('expiredFiles returns files older than the retention window', () => {
  const now = 100 * DAY;
  const entries = [
    { name: 'old.md', mtimeMs: now - 31 * DAY },
    { name: 'new.md', mtimeMs: now - 2 * DAY },
    { name: 'edge.md', mtimeMs: now - 30 * DAY }
  ];
  assert.deepEqual(expiredFiles(entries, now, 30), ['old.md']);
  assert.deepEqual(expiredFiles(entries, now, 1), ['old.md', 'new.md', 'edge.md']);
});

test('expiredFiles keeps everything when retention is off or invalid', () => {
  const entries = [{ name: 'a', mtimeMs: 0 }];
  assert.deepEqual(expiredFiles(entries, Date.now(), 0), []);
  assert.deepEqual(expiredFiles(entries, Date.now(), -5), []);
  assert.deepEqual(expiredFiles(entries, Date.now(), 'x'), []);
  assert.deepEqual(expiredFiles(undefined, Date.now(), 30), []);
});

test('orchestratorPrompt inserts the real paths', () => {
  const text = orchestratorPrompt({
    projectPath: 'D:\\Code\\app',
    inboxDir: 'D:\\Code\\app\\.agent-inbox',
    lessonsPath: 'D:\\Code\\app\\AGENT_LESSONS.md'
  });
  assert.match(text, /^PROJECT: D:\\Code\\app$/m);
  assert.match(text, /^INBOX: {3}D:\\Code\\app\\\.agent-inbox$/m);
  assert.ok(text.includes('INBOX="D:\\Code\\app\\.agent-inbox"'), 'bash loop uses the inbox');
  assert.ok(text.includes("$inbox = 'D:\\Code\\app\\.agent-inbox'"), 'PowerShell loop uses the inbox');
  assert.ok(text.includes('  D:\\Code\\app\\AGENT_LESSONS.md:'), 'lessons path');
  assert.doesNotMatch(text, /\{PROJECT_PATH\}/);
  assert.ok(text.endsWith('\n'));
});

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/g, '\n');

test('README shows the same orchestrator prompt as the copy command', () => {
  const template = orchestratorPrompt({
    projectPath: '{PROJECT_PATH}',
    inboxDir: '{PROJECT_PATH}/.agent-inbox',
    lessonsPath: '{PROJECT_PATH}/AGENT_LESSONS.md'
  });
  assert.ok(readme.includes('````text\n' + template + '````'), 'README prompt is out of date: copy it from core.orchestratorPrompt');
});

test('README links are absolute (relative links break in the IDE extension page)', () => {
  const links = [...readme.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length > 0);
  for (const link of links) {
    assert.match(link, /^https:\/\//, `relative link in README: ${link}`);
  }
  assert.doesNotMatch(readme, /```mermaid/, 'mermaid does not render in the IDE extension page');
});
