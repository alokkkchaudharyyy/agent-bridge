const path = require('path');

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

module.exports = {
  selectNext,
  skipKey,
  parsePrompt,
  archiveName,
  preview,
  resolveInboxPath,
  gitignoreCovers
};
