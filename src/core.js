const path = require('path');
const crypto = require('crypto');

function skipKey(entry) {
  return `${entry.name}|${entry.mtimeMs}`;
}

function isEligible(entry, nowMs, settleMs, skip) {
  if (!entry || !entry.isFile) {
    return false;
  }
  const name = entry.name;
  if (typeof name !== 'string') {
    return false;
  }
  const isPromptMd = name === 'prompt.md';
  const isNumberedPrompt = name.endsWith('.prompt.md') && name.length > '.prompt.md'.length;
  if (!isPromptMd && !isNumberedPrompt) {
    return false;
  }
  if (typeof entry.mtimeMs === 'number' && entry.mtimeMs > nowMs - settleMs) {
    return false;
  }
  if (skip && skip.has(skipKey(entry))) {
    return false;
  }
  return true;
}

function selectNext(entries, nowMs, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }
  const settleMs = typeof opts.settleMs === 'number' ? opts.settleMs : 1500;
  const skip = opts.skip;

  let promptEntry = null;
  const numberedEntries = [];

  for (const entry of entries) {
    if (!isEligible(entry, nowMs, settleMs, skip)) {
      continue;
    }
    if (entry.name === 'prompt.md') {
      if (!promptEntry) {
        promptEntry = entry;
      }
    } else {
      numberedEntries.push(entry);
    }
  }

  if (promptEntry) {
    return promptEntry;
  }

  if (numberedEntries.length === 0) {
    return null;
  }

  const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  numberedEntries.sort((a, b) => collator.compare(a.name, b.name));

  return numberedEntries[0];
}

function parsePrompt(text, marker = '<!-- new-conversation -->') {
  const textWithoutBOM = typeof text === 'string' && text.startsWith('\uFEFF')
    ? text.slice(1)
    : (typeof text === 'string' ? text : '');

  if (typeof marker === 'string' && marker.length > 0) {
    const trimmedLeading = textWithoutBOM.trimStart();
    if (trimmedLeading.startsWith(marker)) {
      const body = trimmedLeading.slice(marker.length).trimStart();
      return {
        newConversation: true,
        body,
        isEmpty: body.trim() === ''
      };
    }
  }

  return {
    newConversation: false,
    body: textWithoutBOM,
    isEmpty: textWithoutBOM.trim() === ''
  };
}

function archiveName(name, nowMs, kind = 'sent') {
  const stamp = new Date(nowMs).toISOString().replace(/[:.]/g, '-');
  const prefix = kind === 'discarded' ? 'discarded-' : '';
  return `${prefix}${stamp}-${name}`;
}

function preview(text, maxChars = 400) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed.length > maxChars) {
    const remaining = trimmed.length - maxChars;
    return `${trimmed.slice(0, maxChars)}\n… (${remaining} more chars)`;
  }
  return trimmed;
}

function resolveInboxPath(setting, workspaceFolderPath) {
  const trimmed = typeof setting === 'string' ? setting.trim() : '';
  if (trimmed.length > 0) {
    if (path.isAbsolute(trimmed)) {
      return path.normalize(trimmed);
    }
    if (workspaceFolderPath) {
      return path.join(workspaceFolderPath, trimmed);
    }
    return null;
  }
  return workspaceFolderPath ? path.join(workspaceFolderPath, '.agent-inbox') : null;
}

function gitignoreCovers(content, dirName = '.agent-inbox') {
  if (typeof content !== 'string' || content.length === 0) {
    return false;
  }
  const targets = new Set([
    dirName,
    `${dirName}/`,
    `/${dirName}`,
    `/${dirName}/`
  ]);
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      continue;
    }
    if (targets.has(trimmed)) {
      return true;
    }
  }
  return false;
}

function normalizeWhitespace(str) {
  return typeof str === 'string' ? str.replace(/\s+/g, ' ').trim() : '';
}

function parseLessons(content) {
  if (typeof content !== 'string' || content.length === 0) {
    return [];
  }
  const lessons = [];
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      lessons.push(trimmed.slice(2).trim());
    }
  }
  return lessons;
}

function formatLesson(area, mistake, rule, nowMs) {
  const cleanArea = normalizeWhitespace(area) || 'general';
  const cleanMistake = normalizeWhitespace(mistake);
  const cleanRule = normalizeWhitespace(rule);
  if (!cleanMistake || !cleanRule) {
    throw new Error('Mistake and rule must not be empty');
  }
  const date = new Date(nowMs).toISOString().slice(0, 10);
  return `- ${date} · ${cleanArea}: ${cleanMistake} → ${cleanRule}`;
}

function hasLesson(content, mistake, rule) {
  const normMistake = normalizeWhitespace(mistake).toLowerCase();
  const normRule = normalizeWhitespace(rule).toLowerCase();
  if (!normMistake || !normRule) {
    return false;
  }
  const lessons = parseLessons(content);
  for (const lesson of lessons) {
    const normLesson = normalizeWhitespace(lesson).toLowerCase();
    if (normLesson.includes(normMistake) && normLesson.includes(normRule)) {
      return true;
    }
  }
  return false;
}

function applyLessons(body, opts = {}) {
  const {
    mode = 'reference',
    relPath = '',
    content = '',
    maxChars = 4000
  } = opts;

  const lessons = parseLessons(content);
  if (mode === 'off' || lessons.length === 0) {
    return body;
  }

  if (mode === 'inline') {
    const kept = [];
    let currentChars = 0;
    for (let i = lessons.length - 1; i >= 0; i--) {
      const rendered = '- ' + lessons[i] + '\n';
      if (currentChars + rendered.length <= maxChars) {
        kept.unshift(rendered);
        currentChars += rendered.length;
      } else {
        break;
      }
    }

    const droppedCount = lessons.length - kept.length;
    let lines = kept.join('').trimEnd();
    if (droppedCount > 0) {
      lines += (lines.length > 0 ? '\n' : '') + `(${droppedCount} older lessons in ${relPath})`;
    }

    return body + '\n\n---\nLessons from past reviews of your work in this repo (do not repeat these mistakes):\n' + lines;
  }

  return body + '\n\n---\n' + `Before you start: read ${relPath} (lessons from past reviews of your work in this repo) and do not repeat those mistakes.`;
}

function makeId(date = new Date(), randomHex) {
  const pad = n => String(n).padStart(2, '0');
  const YYYY = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const DD = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  let rand = randomHex;
  if (!rand) {
    rand = crypto.randomBytes(2).toString('hex');
  }
  return `${YYYY}${MM}${DD}-${HH}${mm}-${rand}`;
}

function isValidId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id);
}

function extractId(text) {
  if (typeof text !== 'string') return { id: null, text: '' };
  const textWithoutBOM = text.startsWith('\uFEFF') ? text.slice(1) : text;
  
  const lines = textWithoutBOM.split('\n');
  let idFound = null;
  let removeIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStr = line.endsWith('\r') ? line.slice(0, -1) : line;
    
    if (!/^\s*(?:<!--.*-->)?\s*$/.test(lineStr)) {
      break;
    }
    const match = /^\s*<!--\s*id:\s*(\S+?)\s*-->\s*$/.exec(lineStr);
    if (match && isValidId(match[1])) {
      idFound = match[1];
      removeIndex = i;
      break;
    }
  }

  if (idFound !== null) {
    lines.splice(removeIndex, 1);
    return { id: idFound, text: lines.join('\n') };
  }

  return { id: null, text: textWithoutBOM };
}

function idFromFileName(name, ext) {
  if (typeof name !== 'string' || typeof ext !== 'string') return null;
  if (name.endsWith(ext) && name.length > ext.length) {
    const part = name.slice(0, -ext.length);
    if (isValidId(part)) return part;
  }
  return null;
}

function buildFooter({ id, inboxDir }) {
  const donePath = path.join(inboxDir, 'done', `${id}.json`);
  const questionPath = path.join(inboxDir, 'question', `${id}.md`);
  return [
    '---',
    `Agent Bridge task id: ${id}`,
    `When you have completely finished this task, as your very last action create this file (use exactly this absolute path, not a path relative to any workspace folder): ${donePath}`,
    `It must contain JSON like: {"id": "${id}", "status": "done", "summary": "<one or two sentences>", "commits": ["<sha>"]}`,
    'Use status "failed" if you could not complete it, or "blocked" if something outside your control stopped you.',
    `If you are blocked or need a decision, instead write ${questionPath} (exactly this absolute path) explaining what you need, then stop and wait.`
  ].join('\n');
}

function withFooter(body, footer) {
  return footer ? `${body}\n\n${footer}` : body;
}

function parseDoneFile(text, fileId) {
  const textWithoutBOM = (typeof text === 'string' && text.startsWith('\uFEFF')) ? text.slice(1) : (typeof text === 'string' ? text : '');
  
  let json;
  try {
    json = JSON.parse(textWithoutBOM);
  } catch (err) {
    return { id: fileId, status: 'invalid', summary: '', commits: [], valid: false, error: 'invalid JSON' };
  }
  
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { id: fileId, status: 'invalid', summary: '', commits: [], valid: false, error: 'invalid JSON' };
  }
  
  let status = 'unknown';
  if (typeof json.status === 'string') {
    const lower = json.status.toLowerCase();
    if (['done', 'failed', 'blocked'].includes(lower)) {
      status = lower;
    }
  }
  
  let summary = '';
  if (typeof json.summary === 'string') {
    summary = normalizeWhitespace(json.summary);
    if (summary.length > 300) {
      summary = summary.slice(0, 300) + '…';
    }
  }
  
  let commits = [];
  if (Array.isArray(json.commits)) {
    commits = json.commits
      .filter(c => typeof c === 'string')
      .map(c => c.trim())
      .filter(c => c.length > 0)
      .slice(0, 20);
  }
  
  let error = null;
  if (typeof json.id === 'string' && json.id !== fileId) {
    error = `id mismatch: file says ${json.id}`;
  }
  
  return { id: fileId, status, summary, commits, valid: true, error };
}

function findStuck(pending, nowMs, stuckAfterMinutes) {
  if (typeof stuckAfterMinutes !== 'number' || stuckAfterMinutes <= 0) {
    return [];
  }
  const thresholdMs = stuckAfterMinutes * 60000;
  const ids = [];
  for (const id of Object.keys(pending)) {
    const item = pending[id];
    if (!item.stuckNotified && (nowMs - item.sentAt) >= thresholdMs) {
      ids.push(id);
    }
  }
  return ids;
}

// The newest pending task that is still open (no done/question file, not past the stuck timeout).
// While one exists and waitForDone is on, the next queued prompt is held back.
function openPendingId(pending) {
  let best = null;
  for (const id of Object.keys(pending || {})) {
    const p = pending[id];
    if (p && !p.stuckNotified && (!best || p.sentAt > pending[best].sentAt)) {
      best = id;
    }
  }
  return best;
}

// Last n non-empty log lines, with the ISO date shortened to HH:MM:SS.
function lastLogLines(text, n = 3) {
  if (typeof text !== 'string') return [];
  return text.split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-n)
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z /, '$1 '));
}

// "1h5m26s" -> ms. Returns null if nothing matches.
function parseDuration(text) {
  const m = /^\s*(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+)s)?/.exec(text || '');
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000;
}

const QUOTA_MARKER = 'RESOURCE_EXHAUSTED (code 429)';

// Scans raw bytes of an Antigravity conversation file (internal format, may change) for the
// newest quota error that happened at or after sinceMs. The time comes from the HTTP "Date"
// header stored next to the error; hits without a Date are ignored.
// Returns { message, at, resetsAt } (ms timestamps; resetsAt may be null) or null.
function findQuotaError(buf, sinceMs, maxHits = 50) {
  if (!Buffer.isBuffer(buf)) return null;
  const marker = Buffer.from(QUOTA_MARKER, 'latin1');
  let best = null;
  let pos = buf.length;
  for (let i = 0; i < maxHits; i++) {
    pos = buf.lastIndexOf(marker, pos - 1);
    if (pos < 0) break;
    const win = buf.subarray(pos, pos + 4000).toString('latin1');
    const dateMatch = /"Date":\["([^"]+)"\]/.exec(win);
    const at = dateMatch ? Date.parse(dateMatch[1]) : NaN;
    if (Number.isNaN(at) || at < sinceMs) continue;
    if (best && at <= best.at) continue;
    const msgMatch = /^RESOURCE_EXHAUSTED \(code 429\): ([\x20-\x7e]{1,300})/.exec(win);
    const message = msgMatch ? msgMatch[1].trim() : 'Quota reached';
    const resetMatch = /Resets in (\d+h)?(\d+m)?(\d+s)?/.exec(message);
    const resetMs = resetMatch ? parseDuration(resetMatch[0].slice('Resets in '.length)) : null;
    best = { message, at, resetsAt: resetMs === null ? null : at + resetMs };
  }
  return best;
}

// Content of question/<id>.md written when a quota stop is detected.
function buildQuotaQuestion(id, hit, nowMs) {
  const resets = hit.resetsAt ? new Date(hit.resetsAt).toISOString() : 'unknown';
  return [
    'status: blocked',
    'reason: quota',
    `resets: ${resets}`,
    `detected: ${new Date(nowMs).toISOString()}`,
    `message: ${hit.message}`,
    '',
    `The IDE agent stopped on a model quota error while working on ${id}. It did not finish the task.`,
    'After the reset time, run "Agent Bridge: Resend last prompt with \'continue\'" in the IDE, or send a new prompt with the same id.',
    ''
  ].join('\n');
}

// confirmBeforeSend: 'auto' (ask once per project), 'always' (ask every time), 'never'.
// Old boolean values map to 'always' / 'never'.
function normalizeConfirmMode(value) {
  if (value === true) return 'always';
  if (value === false) return 'never';
  if (value === 'auto' || value === 'always' || value === 'never') return value;
  return 'auto';
}

// 'never' only counts when it comes from user settings, so a cloned repo's
// .vscode/settings.json cannot switch confirmation off.
function effectiveConfirmMode(inspected) {
  const i = inspected || {};
  const pick = [i.workspaceFolderValue, i.workspaceValue, i.globalValue, i.defaultValue]
    .find((v) => v !== undefined);
  const mode = normalizeConfirmMode(pick);
  if (mode === 'never' && normalizeConfirmMode(i.globalValue) !== 'never') {
    return 'auto';
  }
  return mode;
}

// savedChoice is the per-workspace answer to the one-time question: 'always' | 'ask' | undefined.
// Returns 'send' (no dialog), 'ask' (per-prompt dialog) or 'first' (the one-time question).
function decideConfirm(mode, savedChoice) {
  if (mode === 'never') return 'send';
  if (mode === 'always') return 'ask';
  if (savedChoice === 'always') return 'send';
  if (savedChoice === 'ask') return 'ask';
  return 'first';
}

module.exports = {
  openPendingId,
  lastLogLines,
  parseDuration,
  findQuotaError,
  buildQuotaQuestion,
  normalizeConfirmMode,
  effectiveConfirmMode,
  decideConfirm,
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
  buildFooter,
  withFooter,
  parseDoneFile,
  findStuck
};

