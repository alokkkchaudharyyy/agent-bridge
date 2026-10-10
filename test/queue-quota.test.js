const test = require('node:test');
const assert = require('node:assert/strict');
const {
  openPendingId,
  lastLogLines,
  parseDuration,
  findQuotaError,
  buildQuotaQuestion
} = require('../src/core.js');

test('openPendingId picks the newest open task', () => {
  assert.equal(openPendingId({}), null);
  assert.equal(openPendingId(undefined), null);
  assert.equal(openPendingId({ a: { sentAt: 1, stuckNotified: false } }), 'a');
  assert.equal(openPendingId({
    a: { sentAt: 1, stuckNotified: false },
    b: { sentAt: 5, stuckNotified: false },
    c: { sentAt: 9, stuckNotified: true }
  }), 'b');
  assert.equal(openPendingId({ c: { sentAt: 9, stuckNotified: true } }), null);
});

test('lastLogLines returns the last lines with short times', () => {
  const log = '2026-10-10T01:02:03.456Z bridge active\n\n2026-10-10T01:05:00.000Z sent 10 chars\r\n2026-10-10T01:06:07.890Z done id=x\n';
  assert.deepEqual(lastLogLines(log, 2), ['01:05:00 sent 10 chars', '01:06:07 done id=x']);
  assert.deepEqual(lastLogLines(log, 9).length, 3);
  assert.deepEqual(lastLogLines(undefined), []);
});

test('parseDuration', () => {
  assert.equal(parseDuration('1h5m26s'), (3600 + 300 + 26) * 1000);
  assert.equal(parseDuration('5m'), 300000);
  assert.equal(parseDuration('26s'), 26000);
  assert.equal(parseDuration('2h'), 7200000);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration('soon'), null);
});

function quotaBlob(dateStr, resets = 'Resets in 1h5m26s') {
  const noise = Buffer.from([0, 1, 2, 250, 251, 0]);
  return Buffer.concat([
    noise,
    Buffer.from(`RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. ${resets}`, 'latin1'),
    noise,
    Buffer.from(`HTTP 429 Too Many Requests Headers: {"Content-Type":["text/event-stream"],"Date":["${dateStr}"],"Server":["ESF"]}`, 'latin1'),
    noise
  ]);
}

test('findQuotaError finds a quota error after the send time', () => {
  const at = Date.parse('Fri, 09 Oct 2026 21:12:00 GMT');
  const hit = findQuotaError(quotaBlob('Fri, 09 Oct 2026 21:12:00 GMT'), at - 60000);
  assert.ok(hit);
  assert.equal(hit.at, at);
  assert.equal(hit.resetsAt, at + (3600 + 300 + 26) * 1000);
  assert.match(hit.message, /^Individual quota reached\./);
  assert.match(hit.message, /Resets in 1h5m26s$/);
});

test('findQuotaError ignores errors from before the send', () => {
  const at = Date.parse('Fri, 09 Oct 2026 21:12:00 GMT');
  assert.equal(findQuotaError(quotaBlob('Fri, 09 Oct 2026 21:12:00 GMT'), at + 1000), null);
});

test('findQuotaError picks the newest of several hits and handles no reset time', () => {
  const buf = Buffer.concat([
    quotaBlob('Fri, 09 Oct 2026 23:00:00 GMT', ''),
    quotaBlob('Fri, 09 Oct 2026 21:00:00 GMT')
  ]);
  const hit = findQuotaError(buf, 0);
  assert.equal(hit.at, Date.parse('Fri, 09 Oct 2026 23:00:00 GMT'));
  assert.equal(hit.resetsAt, null);
});

test('findQuotaError ignores hits without a Date and non-buffers', () => {
  const buf = Buffer.from('RESOURCE_EXHAUSTED (code 429): Individual quota reached.', 'latin1');
  assert.equal(findQuotaError(buf, 0), null);
  assert.equal(findQuotaError(Buffer.from('nothing here'), 0), null);
  assert.equal(findQuotaError('not a buffer', 0), null);
});

test('buildQuotaQuestion', () => {
  const at = Date.parse('2026-10-09T21:12:00Z');
  const text = buildQuotaQuestion('task-7', { message: 'Individual quota reached. Resets in 5m', at, resetsAt: at + 300000 }, at + 1000);
  assert.match(text, /^status: blocked\nreason: quota\nresets: 2026-10-09T21:17:00\.000Z\n/);
  assert.match(text, /task-7/);
  assert.match(buildQuotaQuestion('x', { message: 'm', at, resetsAt: null }, at), /resets: unknown/);
});
