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

module.exports = {
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
  idFromFileName
};

