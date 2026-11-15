const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const os = require('os');
const core = require('./core');

let outputChannel;
let statusItem;
let inboxDir = null;
let timer = null;
let revertTimer = null;
let paused = false;
let busy = false;
let skip = new Set();
let noTargetWarned = false;
let gitignoreOffered = false;
let extensionContext = null;
let pending = {};
let seen = new Set();
let scanning = false;
let forceNext = false;
let heldFor = null;
let inboxReady = false;

const LOG_MAX_BYTES = 1024 * 1024;

function firstFolder() {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
}

function lessonsPathFor(settings) {
  if (!settings.lessonsFile) return null;
  if (path.isAbsolute(settings.lessonsFile)) return settings.lessonsFile;
  const ws = firstFolder();
  return ws ? path.join(ws, settings.lessonsFile) : null;
}

function savePending() {
  if (extensionContext) {
    extensionContext.workspaceState.update('agentBridge.pending', pending);
  }
}

function checkGitignore(wsFolder, rel) {
  if (extensionContext && extensionContext.workspaceState.get('agentBridge.gitignoreDeclined') === true) {
    return;
  }

  const gitignorePath = path.join(wsFolder, '.gitignore');
  // Only ask in folders that use git; elsewhere the question is noise.
  if (!fs.existsSync(path.join(wsFolder, '.git')) && !fs.existsSync(gitignorePath)) {
    return;
  }
  let content = '';
  try {
    if (fs.existsSync(gitignorePath)) {
      content = fs.readFileSync(gitignorePath, 'utf8');
    }
  } catch (_) {
    content = '';
  }

  if (!core.gitignoreCovers(content, rel)) {
    vscode.window.showInformationMessage(
      `Agent Bridge: add ${rel}/ to .gitignore?`,
      'Add',
      'Not now',
      "Don't ask again"
    ).then((choice) => {
      if (choice === 'Add') {
        try {
          let toAppend = `${rel}/\n`;
          if (content && !content.endsWith('\n')) {
            toAppend = '\n' + toAppend;
          }
          fs.appendFileSync(gitignorePath, toAppend, 'utf8');
          log(`added ${rel}/ to .gitignore`);
        } catch (e) {
          log(`failed to update .gitignore: ${e.message}`);
        }
      } else if (choice === "Don't ask again") {
        if (extensionContext) {
          extensionContext.workspaceState.update('agentBridge.gitignoreDeclined', true);
        }
      }
    });
  }
}

function getSettings() {
  const cfg = vscode.workspace.getConfiguration('agentBridge');
  return {
    inboxPath: cfg.get('inboxPath', ''),
    pollIntervalMs: Math.max(1000, cfg.get('pollIntervalMs', 4000)),
    confirmMode: core.effectiveConfirmMode(cfg.inspect('confirmBeforeSend')),
    newConversationMarker: cfg.get('newConversationMarker', '<!-- new-conversation -->'),
    lessonsFile: cfg.get('lessonsFile', 'AGENT_LESSONS.md'),
    lessonsMode: cfg.get('lessonsMode', 'reference'),
    completionSignal: cfg.get('completionSignal', true),
    stuckAfterMinutes: cfg.get('stuckAfterMinutes', 20),
    waitForDone: cfg.get('waitForDone', true),
    detectQuotaErrors: cfg.get('detectQuotaErrors', 'auto'),
    conversationsPath: cfg.get('conversationsPath', ''),
    archiveRetentionDays: cfg.get('archiveRetentionDays', 30),
    conversationMode: cfg.get('conversationMode', 'perTask'),
    maxPromptsPerConversation: cfg.get('maxPromptsPerConversation', 6),
    acceptChanges: cfg.get('acceptChanges', 'onDone'),
    sendMethod: cfg.get('sendMethod', 'auto')
  };
}

function log(line) {
  const timestamp = new Date().toISOString();
  const entry = `${timestamp} ${line}\n`;
  if (inboxDir) {
    try {
      fs.appendFileSync(path.join(inboxDir, 'bridge.log'), entry, 'utf8');
    } catch (_) {
      /* ignore file log errors */
    }
  }
  if (outputChannel) {
    outputChannel.appendLine(`${timestamp} ${line}`);
  }
}

// What the status bar shows when nothing else is going on.
function restStatus() {
  setStatus(paused ? 'paused' : (inboxReady ? 'watching' : 'idle'));
}

function setStatus(kind, customText, warn) {
  if (!statusItem) return;

  if (kind !== 'sent' && kind !== 'event' && revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }

  if (kind === 'error') {
    statusItem.text = '$(error) Agent Bridge: error';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else if (kind === 'event') {
    statusItem.text = customText;
    statusItem.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    if (revertTimer) {
      clearTimeout(revertTimer);
    }
    revertTimer = setTimeout(() => {
      revertTimer = null;
      restStatus();
    }, 60000);
  } else {
    statusItem.backgroundColor = undefined;
    if (kind === 'watching') {
      statusItem.text = '$(radio-tower) Agent Bridge: watching';
    } else if (kind === 'paused') {
      statusItem.text = '$(debug-pause) Agent Bridge: paused';
    } else if (kind === 'sent') {
      statusItem.text = customText || '$(check) Agent Bridge: sent';
      if (revertTimer) {
        clearTimeout(revertTimer);
      }
      revertTimer = setTimeout(() => {
        revertTimer = null;
        restStatus();
      }, 10000);
    } else if (kind === 'waiting') {
      statusItem.text = customText;
    } else if (kind === 'idle') {
      statusItem.text = '$(radio-tower) Agent Bridge: idle';
    } else if (kind === 'nofolder') {
      statusItem.text = 'Agent Bridge: no folder';
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliver(parsed, label, requestedId, opts = {}) {
  const settings = getSettings();
  ensureInbox();

  let lessonsContent = '';
  const lessonsPath = lessonsPathFor(settings);
  if (lessonsPath) {
    try {
      if (fs.existsSync(lessonsPath)) {
        lessonsContent = fs.readFileSync(lessonsPath, 'utf8');
      }
    } catch (_) {
      lessonsContent = '';
    }
  }

  let body = core.applyLessons(parsed.body, {
    mode: settings.lessonsMode,
    relPath: lessonsPath || settings.lessonsFile,
    content: lessonsContent
  });
  const lessonsAdded = body !== parsed.body;
  
  const id = requestedId || core.makeId();
  if (settings.completionSignal && inboxDir) {
    body = core.withFooter(body, core.buildFooter({ id, inboxDir }));
  }

  try {
    const cmdsList = await vscode.commands.getCommands(true);
    const cmds = new Set(cmdsList);
    let via = null;

    const convState = extensionContext ? extensionContext.workspaceState.get('agentBridge.conversation') || null : null;
    const conv = core.decideConversation({
      mode: settings.conversationMode,
      marker: opts.resend ? 'same' : (parsed.conversation || (parsed.newConversation ? 'new' : null)),
      id,
      current: convState,
      maxPrompts: settings.maxPromptsPerConversation
    });

    // Newer Antigravity builds (agent panel from the bundled "agy" extension) take prompts through
    // addContext + triggerSend; the older sendPromptToAgentPanel command still exists there but
    // can silently do nothing. sendMethod lets users force one path if an update breaks the other.
    const canInput = cmds.has('antigravity.addContext') && cmds.has('antigravity.triggerSend');
    const useInput = canInput && settings.sendMethod !== 'agentPanel';
    const usePanel = cmds.has('antigravity.sendPromptToAgentPanel') && settings.sendMethod !== 'agentInput';

    if (useInput || usePanel) {
      await acceptAgentEdits(cmds, 'before sending');
      if (conv.newConversation && cmds.has('antigravity.startNewConversation')) {
        await vscode.commands.executeCommand('antigravity.startNewConversation');
        await sleep(1500);
      }
      if (useInput) {
        await vscode.commands.executeCommand('antigravity.addContext', body);
        await sleep(400);
        await vscode.commands.executeCommand('antigravity.triggerSend');
        via = 'antigravity-input';
      } else {
        await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', body);
        via = 'antigravity';
      }
    } else if (cmds.has('workbench.action.chat.open')) {
      if (conv.newConversation && cmds.has('workbench.action.chat.newChat')) {
        await vscode.commands.executeCommand('workbench.action.chat.newChat');
        await sleep(500);
      }
      await vscode.commands.executeCommand('workbench.action.chat.open', { query: body });
      via = 'vscode-chat';
    } else {
      log(`no agent chat command found; ${label} not sent (kept in archive)`);
      setStatus('error');
      if (!noTargetWarned) {
        vscode.window.showErrorMessage(
          'Agent Bridge: no supported agent chat found. It needs Antigravity, or VS Code with a chat extension. Your prompt was kept in .agent-inbox/archive.'
        );
        noTargetWarned = true;
      }
      return;
    }

    if (extensionContext) {
      extensionContext.workspaceState.update('agentBridge.conversation', conv.next);
    }
    const newConvSuffix = conv.newConversation ? ` (new conversation: ${conv.reason})` : '';
    const lessonsSuffix = lessonsAdded ? ' (+lessons)' : '';
    log(`sent ${body.length} chars via ${via}: ${label}${newConvSuffix}${lessonsSuffix} id=${id}`);
    
    if (inboxDir) {
      try {
        const receipt = JSON.stringify({ id, file: label, sentAt: new Date().toISOString(), via, chars: body.length, completionSignal: settings.completionSignal }, null, 2);
        fs.writeFileSync(path.join(inboxDir, 'sent', `${id}.json`), receipt, 'utf8');
      } catch (e) {
        log(`failed to write sent receipt: ${e.message}`);
      }
    }
    if (!opts.resend && extensionContext) {
      extensionContext.workspaceState.update('agentBridge.lastSent', { id, label, body: parsed.body });
    }
    if (settings.completionSignal) {
      pending[id] = { sentAt: Date.now(), label, stuckNotified: false };
      savePending();
    }
    rotateLog();

    setStatus('sent', '$(check) Agent Bridge: sent ' + id);
  } catch (e) {
    log(`send failed (${label}): ${e.message}`);
    setStatus('error');
  }
}

// Antigravity writes agent edits to disk right away; Accept/Reject is only a review layer that
// piles up across tasks. The orchestrator reviews with git, so clear it when a task ends.
async function acceptAgentEdits(cmds, when) {
  if (getSettings().acceptChanges !== 'onDone') return;
  try {
    const available = cmds || new Set(await vscode.commands.getCommands(true));
    if (!available.has('antigravity.acceptAllChanges')) return;
    await vscode.commands.executeCommand('antigravity.acceptAllChanges');
    log(`accepted pending agent edits (${when})`);
  } catch (e) {
    log(`accepting agent edits failed: ${e.message}`);
  }
}

async function sendFile(entry, parsed, headerId) {
  const filePath = path.join(inboxDir, entry.name);
  const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'sent'));
  try {
    fs.renameSync(filePath, dest);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Another window on the same folder took it first.
      log(`${entry.name} is gone (sent from another window?), skipped`);
      return;
    }
    throw e;
  }
  await deliver(parsed, entry.name, headerId);
}

function runHook(event, id, status, file, summary) {
  const v = vscode.workspace.getConfiguration('agentBridge').inspect('onDoneCommand');
  const cmd = (v && typeof v.globalValue === 'string') ? v.globalValue.trim() : '';
  if (!cmd) return;
  if (!vscode.workspace.isTrusted) {
    log('onDoneCommand skipped: workspace not trusted');
    return;
  }
  const child = child_process.spawn(cmd, {
    shell: true,
    cwd: firstFolder() || inboxDir,
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      AGENT_BRIDGE_EVENT: event,
      AGENT_BRIDGE_ID: id,
      AGENT_BRIDGE_STATUS: status,
      AGENT_BRIDGE_FILE: file || '',
      AGENT_BRIDGE_SUMMARY: summary || '',
      AGENT_BRIDGE_INBOX: inboxDir || ''
    }
  });

  const timeout = setTimeout(() => {
    try { child.kill(); } catch (_) {}
  }, 60000);

  child.on('error', (e) => {
    log(`onDoneCommand error: ${e.message}`);
  });
  child.on('exit', (code) => {
    clearTimeout(timeout);
    log(`onDoneCommand (${event} ${id}) exited ${code}`);
  });
}

function listOutbox(sub, ext) {
  const dir = path.join(inboxDir, sub);
  let dirEntries;
  try {
    dirEntries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const files = [];
  for (const de of dirEntries) {
    if (de.isFile()) {
      const id = core.idFromFileName(de.name, ext);
      if (id !== null) {
        try {
          const mtimeMs = fs.statSync(path.join(dir, de.name)).mtimeMs;
          files.push({ id, name: de.name, file: path.join(dir, de.name), mtimeMs });
        } catch (_) {}
      }
    }
  }
  return files;
}

function baselineOutbox() {
  const doneFiles = listOutbox('done', '.json');
  const questionFiles = listOutbox('question', '.md');
  for (const item of [...doneFiles, ...questionFiles]) {
    const sub = item.name.endsWith('.json') ? 'done' : 'question';
    seen.add(`${sub}/${item.name}|${item.mtimeMs}`);
    if (pending[item.id]) {
      delete pending[item.id];
    }
  }
  savePending();
}

function handleDone(item) {
  let text;
  try { text = fs.readFileSync(item.file, 'utf8'); } catch(e) { log(`done file read failed: ${e.message}`); return; }
  const info = core.parseDoneFile(text, item.id);
  delete pending[item.id];
  savePending();
  log(`done id=${item.id} status=${info.status} commits=${info.commits.length}${info.summary ? ` summary="${info.summary}"` : ''}${info.error ? ` (${info.error})` : ''}`);
  
  if (info.status === 'done') {
    setStatus('event', `$(pass) Agent Bridge: ${item.id} done`, false);
    vscode.window.showInformationMessage(`Agent Bridge: ${item.id} done. ${info.summary}`.trim(), 'Open', 'Open log').then(choice => {
      if (choice === 'Open') vscode.workspace.openTextDocument(item.file).then(doc => vscode.window.showTextDocument(doc));
      else if (choice === 'Open log') vscode.commands.executeCommand('agentBridge.openLog');
    });
  } else {
    setStatus('event', `$(warning) Agent Bridge: ${item.id} ${info.status}`, true);
    vscode.window.showWarningMessage(`Agent Bridge: ${item.id} ${info.status}. ${info.summary}`.trim(), 'Open', 'Open log').then(choice => {
      if (choice === 'Open') vscode.workspace.openTextDocument(item.file).then(doc => vscode.window.showTextDocument(doc));
      else if (choice === 'Open log') vscode.commands.executeCommand('agentBridge.openLog');
    });
  }
  
  acceptAgentEdits(null, `${item.id} finished`);
  runHook('done', item.id, info.status, item.file, info.summary);
}

function handleQuestion(item) {
  let text;
  try { text = fs.readFileSync(item.file, 'utf8'); } catch(e) { log(`question file read failed: ${e.message}`); return; }
  delete pending[item.id];
  savePending();
  log(`question id=${item.id}`);
  setStatus('event', `$(question) Agent Bridge: ${item.id} needs input`, true);
  vscode.window.showWarningMessage(`Agent Bridge: ${item.id} needs a decision: ${core.preview(text, 160)}`, 'Open', 'Open log').then(choice => {
    if (choice === 'Open') vscode.workspace.openTextDocument(item.file).then(doc => vscode.window.showTextDocument(doc));
    else if (choice === 'Open log') vscode.commands.executeCommand('agentBridge.openLog');
  });
  
  runHook('question', item.id, 'question', item.file, core.preview(text, 300));
}

function scanOutbox() {
  const doneFiles = listOutbox('done', '.json');
  const questionFiles = listOutbox('question', '.md');
  const now = Date.now();
  for (const item of doneFiles) {
    const key = `done/${item.name}|${item.mtimeMs}`;
    if (seen.has(key)) continue;
    if (item.mtimeMs > now - 1500) continue;
    seen.add(key);
    try { handleDone(item); } catch (e) { log(`handleDone error: ${e.message}`); }
  }
  for (const item of questionFiles) {
    const key = `question/${item.name}|${item.mtimeMs}`;
    if (seen.has(key)) continue;
    if (item.mtimeMs > now - 1500) continue;
    seen.add(key);
    try { handleQuestion(item); } catch (e) { log(`handleQuestion error: ${e.message}`); }
  }
}

let quotaSeen = { file: null, mtimeMs: 0 };
let lastQuotaRead = 0;

function quotaDetectionOn(settings) {
  if (settings.detectQuotaErrors === 'on') return true;
  if (settings.detectQuotaErrors === 'off') return false;
  const appName = (vscode.env && vscode.env.appName) || '';
  return /antigravity/i.test(appName);
}

// Antigravity stores each conversation in an internal SQLite file. When the model stops on a
// quota error nothing reaches the inbox, so we read the newest file (read-only, raw bytes) for a
// quota error newer than the last send and turn it into question/<id>.md.
function checkQuota() {
  const settings = getSettings();
  if (!quotaDetectionOn(settings)) return;
  const now = Date.now();
  let id = null;
  for (const key of Object.keys(pending)) {
    if (!id || pending[key].sentAt > pending[id].sentAt) id = key;
  }
  if (!id) return;
  const sentAt = pending[id].sentAt;

  // Antigravity IDE 1.107+ keeps conversations in ~/.gemini/antigravity; older builds used
  // ~/.gemini/antigravity-ide. The databases run in WAL mode, so fresh steps sit in <name>.db-wal.
  const dirs = settings.conversationsPath.trim()
    ? [settings.conversationsPath.trim()]
    : ['antigravity', 'antigravity-ide'].map((d) => path.join(os.homedir(), '.gemini', d, 'conversations'));
  let newest = null;
  for (const dir of dirs) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.db')) continue;
      const file = path.join(dir, name);
      let mtimeMs = 0;
      for (const f of [file, file + '-wal']) {
        try {
          mtimeMs = Math.max(mtimeMs, fs.statSync(f).mtimeMs);
        } catch (_) {
          /* no WAL file */
        }
      }
      if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
    }
  }
  // Same 30 s tolerance as the error time: the agent writes this file around the moment we send.
  if (!newest || newest.mtimeMs < sentAt - 30000) return;
  if (quotaSeen.file === newest.file && quotaSeen.mtimeMs === newest.mtimeMs) return;
  // The file changes on every agent step and can be tens of MB: read it at most every 15 s.
  if (now - lastQuotaRead < 15000) return;
  lastQuotaRead = now;
  quotaSeen = newest;

  let hit;
  try {
    const parts = [fs.readFileSync(newest.file)];
    try {
      parts.push(fs.readFileSync(newest.file + '-wal'));
    } catch (_) {
      /* no WAL file */
    }
    hit = core.findQuotaError(Buffer.concat(parts), sentAt - 30000);
  } catch (e) {
    log(`quota check failed: ${e.message}`);
    return;
  }
  if (!hit) return;
  const questionFile = path.join(inboxDir, 'question', `${id}.md`);
  if (fs.existsSync(questionFile) || fs.existsSync(path.join(inboxDir, 'done', `${id}.json`))) return;
  try {
    fs.writeFileSync(questionFile, core.buildQuotaQuestion(id, hit, now), 'utf8');
    log(`quota stop detected for ${id}: ${hit.message}`);
  } catch (e) {
    log(`failed to write quota question: ${e.message}`);
  }
}

// Last few lines of bridge.log, reading only the end of the file.
function logTail(n) {
  try {
    const file = path.join(inboxDir, 'bridge.log');
    const size = fs.statSync(file).size;
    const fd = fs.openSync(file, 'r');
    try {
      const len = Math.min(size, 4096);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      return core.lastLogLines(buf.toString('utf8'), n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return [];
  }
}

function checkStuck() {
  const settings = getSettings();
  const ids = core.findStuck(pending, Date.now(), settings.stuckAfterMinutes);
  for (const id of ids) {
    pending[id].stuckNotified = true;
    savePending();
    const tail = logTail(3);
    log(`may be stuck: id=${id} (no done/question after ${settings.stuckAfterMinutes} min)`);
    setStatus('event', `$(clock) Agent Bridge: ${id} may be stuck`, true);
    vscode.window.showWarningMessage(
      `Agent Bridge: the agent may be stuck on ${id} (no reply after ${settings.stuckAfterMinutes} min).`
        + (tail.length ? ` Last log: ${tail.join(' | ')}` : ''),
      'Open log', 'Forget'
    ).then(choice => {
      if (choice === 'Open log') {
        vscode.commands.executeCommand('agentBridge.openLog');
      } else if (choice === 'Forget') {
        if (pending[id]) {
          delete pending[id];
          savePending();
        }
      }
    });
    
    runHook('stuck', id, 'stuck', '', '');
  }
}

async function handle(entry) {
  const filePath = path.join(inboxDir, entry.name);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    log(`read failed (${entry.name}): ${e.message}`);
    return;
  }

  const settings = getSettings();
  const { id: headerId, text: cleaned } = core.extractId(text);
  const parsed = core.parsePrompt(cleaned, settings.newConversationMarker);

  if (parsed.isEmpty) {
    const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'discarded'));
    try {
      fs.renameSync(filePath, dest);
    } catch (_) {
      /* ignore rename errors */
    }
    log(`empty prompt discarded: ${entry.name}`);
    return;
  }

  const savedChoice = extensionContext ? extensionContext.workspaceState.get('agentBridge.autoSend') : undefined;
  const trusted = vscode.workspace.isTrusted !== false;
  const decision = core.decideConfirm(settings.confirmMode, savedChoice, {
    trusted,
    allProjects: Boolean(extensionContext && extensionContext.globalState && extensionContext.globalState.get('agentBridge.autoSendAll') === true)
  });

  if (decision === 'send') {
    await sendFile(entry, parsed, headerId);
    return;
  }

  const detail = core.preview(parsed.body)
    + (parsed.newConversation ? '\n\n(starts a new conversation)' : '')
    + (trusted ? '' : '\n\nThis folder is not trusted (Restricted Mode), so Agent Bridge asks before every prompt.');

  if (decision === 'first') {
    const first = await vscode.window.showWarningMessage(
      'Agent Bridge: auto-send prompts from this project\'s inbox to the agent?',
      {
        modal: true,
        detail: `First prompt: "${entry.name}"\n\n${detail}\n\n"All trusted projects" stops this question in every folder you trust (Restricted Mode folders always ask). Your answer is stored on this computer, never in the repo. Change it any time with "Agent Bridge: Reset auto-send choice".`
      },
      'Always for this project',
      'Always for all trusted projects',
      'Ask each time',
      'View prompt'
    );
    if (first === 'Always for all trusted projects') {
      await extensionContext.globalState.update('agentBridge.autoSendAll', true);
      log('auto-send turned on for all trusted projects');
      await sendFile(entry, parsed, headerId);
      return;
    }
    if (first === 'Always for this project') {
      await extensionContext.workspaceState.update('agentBridge.autoSend', 'always');
      log('auto-send turned on for this project');
      await sendFile(entry, parsed, headerId);
      return;
    }
    if (first === 'View prompt') {
      await viewThenAsk(entry, filePath, settings);
      return;
    }
    if (first !== 'Ask each time') {
      skip.add(core.skipKey(entry));
      log(`cancelled: ${entry.name} (will ask again if the file changes)`);
      return;
    }
    await extensionContext.workspaceState.update('agentBridge.autoSend', 'ask');
    log('auto-send off for this project: will ask before each prompt');
  }

  const choice = await vscode.window.showWarningMessage(
    `Agent Bridge: send "${entry.name}" to the agent?`,
    { modal: true, detail },
    'Send',
    'Discard',
    'View'
  );

  if (choice === 'Send') {
    await sendFile(entry, parsed, headerId);
  } else if (choice === 'Discard') {
    const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'discarded'));
    try {
      fs.renameSync(filePath, dest);
    } catch (_) {
      /* ignore rename errors */
    }
    log(`discarded: ${entry.name}`);
  } else if (choice === 'View') {
    await viewThenAsk(entry, filePath, settings);
  } else {
    skip.add(core.skipKey(entry));
    log(`cancelled: ${entry.name} (will ask again if the file changes)`);
  }
}

async function viewThenAsk(entry, filePath, settings) {
  try {
    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e) {
    log(`open failed (${entry.name}): ${e.message}`);
  }

  const viewChoice = await vscode.window.showInformationMessage(
    `Agent Bridge: send "${entry.name}" now?`,
    'Send',
    'Discard'
  );

  if (viewChoice === 'Send') {
    let reReadText;
    try {
      reReadText = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      log(`read failed (${entry.name}): ${e.message}`);
      return;
    }
    const { id: headerIdRe, text: cleanedRe } = core.extractId(reReadText);
    const reParsed = core.parsePrompt(cleanedRe, settings.newConversationMarker);
    if (reParsed.isEmpty) {
      const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'discarded'));
      try {
        fs.renameSync(filePath, dest);
      } catch (_) {
        /* ignore rename errors */
      }
      log(`empty prompt discarded: ${entry.name}`);
      return;
    }
    await sendFile(entry, reParsed, headerIdRe);
  } else if (viewChoice === 'Discard') {
    const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'discarded'));
    try {
      fs.renameSync(filePath, dest);
    } catch (_) {
      /* ignore rename errors */
    }
    log(`discarded: ${entry.name}`);
  } else {
    skip.add(core.skipKey(entry));
    log(`cancelled: ${entry.name} (will ask again if the file changes)`);
  }
}

async function poll() {
  if (!inboxDir) return;
  // The inbox is only set up once something creates it, so unrelated projects stay untouched.
  if (!fs.existsSync(inboxDir)) {
    if (inboxReady) {
      inboxReady = false;
      log(`inbox removed, waiting for it to appear again: ${inboxDir}`);
      updateTooltip();
      restStatus();
    }
    return;
  }
  if (!inboxReady) initInbox();
  if (!scanning) {
    scanning = true;
    try {
      scanOutbox();
      checkStuck();
      checkQuota();
    } finally {
      scanning = false;
    }
  }
  if (paused || busy) return;
  busy = true;
  try {
    const dirEntries = fs.readdirSync(inboxDir, { withFileTypes: true });
    const entries = [];
    for (const de of dirEntries) {
      if (de.name === 'prompt.md' || (de.name.endsWith('.prompt.md') && de.name.length > '.prompt.md'.length)) {
        try {
          const s = fs.statSync(path.join(inboxDir, de.name));
          entries.push({
            name: de.name,
            isFile: s.isFile(),
            mtimeMs: s.mtimeMs
          });
        } catch (_) {
          /* ignore stat errors */
        }
      }
    }
    const entry = core.selectNext(entries, Date.now(), { skip });
    if (entry) {
      let openId = getSettings().waitForDone && !forceNext ? core.openPendingId(pending) : null;
      if (openId) {
        // A prompt that reuses the open task's id is a correction or follow-up for that task,
        // so it must not wait for the task it replaces.
        try {
          if (core.extractId(fs.readFileSync(path.join(inboxDir, entry.name), 'utf8')).id === openId) openId = null;
        } catch (_) {
          /* unreadable now; the next poll retries */
        }
      }
      if (openId) {
        if (heldFor !== openId) {
          heldFor = openId;
          log(`queue held: ${entry.name} waits for ${openId} (done/question file, stuck timeout, or "Send next now")`);
          setStatus('waiting', `$(watch) Agent Bridge: waiting for ${openId}`);
        }
        return;
      }
      heldFor = null;
      forceNext = false;
      await handle(entry);
    }
  } catch (e) {
    log(`poll error: ${e.message}`);
    setStatus('error');
  } finally {
    busy = false;
  }
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }
}

function start() {
  stop();

  const settings = getSettings();
  inboxDir = core.resolveInboxPath(settings.inboxPath, firstFolder());
  inboxReady = false;
  if (!inboxDir) {
    setStatus('nofolder');
    if (statusItem) {
      statusItem.tooltip = 'Agent Bridge: no folder open';
    }
    return;
  }

  if (fs.existsSync(inboxDir)) {
    initInbox();
  } else {
    if (outputChannel) outputChannel.appendLine(`${new Date().toISOString()} waiting for the inbox to appear: ${inboxDir}`);
    updateTooltip();
    restStatus();
  }

  timer = setInterval(poll, settings.pollIntervalMs);
  poll();
}

function updateTooltip() {
  if (!statusItem || !inboxDir) return;
  statusItem.tooltip = inboxReady
    ? `Inbox: ${inboxDir}\nClick for actions`
    : `Waiting for ${inboxDir} to appear (an agent creates it, or run "Copy orchestrator prompt").\nClick for actions`;
}

// Creates the inbox if needed (for commands that send or set things up).
function ensureInbox() {
  if (!inboxDir || inboxReady) return;
  try {
    fs.mkdirSync(inboxDir, { recursive: true });
  } catch (_) {
    return;
  }
  initInbox();
}

function initInbox() {
  for (const sub of ['archive', 'done', 'question', 'sent']) {
    try {
      fs.mkdirSync(path.join(inboxDir, sub), { recursive: true });
    } catch (_) {
      /* ignore directory creation errors */
    }
  }
  inboxReady = true;
  rotateLog();
  cleanArchive();
  baselineOutbox();
  updateTooltip();
  log(`bridge active (inbox: ${inboxDir})`);
  restStatus();

  const firstWs = firstFolder();
  if (!gitignoreOffered && firstWs) {
    const rel = path.relative(firstWs, inboxDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
      gitignoreOffered = true;
      checkGitignore(firstWs, rel.replace(/\\/g, '/'));
    }
  }
}

// Keep bridge.log small: past 1 MB it becomes bridge.log.1 (one old copy is kept).
function rotateLog() {
  const file = path.join(inboxDir, 'bridge.log');
  try {
    if (fs.statSync(file).size > LOG_MAX_BYTES) {
      fs.renameSync(file, file + '.1');
    }
  } catch (_) {
    /* no log yet */
  }
}

// Old sent prompts and receipts are removed after archiveRetentionDays. done/ and question/
// belong to the orchestrator and are never touched.
function cleanArchive() {
  const days = getSettings().archiveRetentionDays;
  let removed = 0;
  for (const sub of ['archive', 'sent']) {
    const dir = path.join(inboxDir, sub);
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((de) => de.isFile())
        .map((de) => ({ name: de.name, mtimeMs: fs.statSync(path.join(dir, de.name)).mtimeMs }));
    } catch (_) {
      continue;
    }
    for (const name of core.expiredFiles(entries, Date.now(), days)) {
      try {
        fs.unlinkSync(path.join(dir, name));
        removed++;
      } catch (_) {
        /* ignore */
      }
    }
  }
  if (removed) log(`removed ${removed} file(s) older than ${days} days from archive/ and sent/`);
}

function activate(context) {
  extensionContext = context;
  paused = Boolean(context.workspaceState.get('agentBridge.paused', false));
  pending = context.workspaceState.get('agentBridge.pending', {});

  outputChannel = vscode.window.createOutputChannel('Agent Bridge');
  context.subscriptions.push(outputChannel);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'agentBridge.showMenu';
  statusItem.show();
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.sendCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Agent Bridge: open a file first.');
        return;
      }
      const doc = editor.document;
      const settings = getSettings();
      const { id: headerId, text: cleaned } = core.extractId(doc.getText());
      const parsed = core.parsePrompt(cleaned, settings.newConversationMarker);
      if (parsed.isEmpty) {
        vscode.window.showWarningMessage('Agent Bridge: the file is empty.');
        return;
      }
      await deliver(parsed, path.basename(doc.fileName), headerId);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.togglePause', () => {
      paused = !paused;
      if (extensionContext) {
        extensionContext.workspaceState.update('agentBridge.paused', paused);
      }
      log(paused ? 'paused' : 'resumed');
      restStatus();
      vscode.window.showInformationMessage(`Agent Bridge ${paused ? 'paused' : 'resumed'}.`);
    })
  );

  const resendLast = async (withContinue) => {
    const last = context.workspaceState.get('agentBridge.lastSent');
    if (!last) {
      vscode.window.showWarningMessage('Agent Bridge: nothing has been sent from this project yet.');
      return;
    }
    // Reopen the task: move an old question file away so orchestrators see the id as open again.
    if (inboxDir) {
      const questionFile = path.join(inboxDir, 'question', `${last.id}.md`);
      if (fs.existsSync(questionFile)) {
        try {
          fs.renameSync(questionFile, path.join(inboxDir, 'archive', core.archiveName(`${last.id}.question.md`, Date.now())));
        } catch (e) {
          log(`could not archive question for ${last.id}: ${e.message}`);
        }
      }
    }
    const body = withContinue
      ? `Continue where you left off on this task. You were interrupted (for example by a quota or model error). Don't redo steps that are already finished.\n\nOriginal task:\n\n${last.body}`
      : last.body;
    log(`resending ${last.id}${withContinue ? ' with continue' : ''}`);
    await deliver({ body, newConversation: false, isEmpty: false }, `${last.label} (resend)`, last.id, { resend: true });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.resendLast', () => resendLast(false)),
    vscode.commands.registerCommand('agentBridge.resendContinue', () => resendLast(true))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.sendNextNow', async () => {
      forceNext = true;
      log('send next now: queue hold skipped once');
      vscode.window.showInformationMessage('Agent Bridge: sending the next queued prompt without waiting.');
      await poll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.resetAutoSend', async () => {
      await context.workspaceState.update('agentBridge.autoSend', undefined);
      const hadAll = context.globalState && context.globalState.get('agentBridge.autoSendAll') === true;
      if (hadAll) await context.globalState.update('agentBridge.autoSendAll', undefined);
      log(hadAll ? 'auto-send choice reset (this project and all projects)' : 'auto-send choice reset');
      vscode.window.showInformationMessage('Agent Bridge: auto-send choice reset. You will be asked again on the next prompt.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.openLog', async () => {
      if (!inboxDir) {
        vscode.window.showWarningMessage('Agent Bridge: open a folder first.');
        return;
      }
      if (!inboxReady) {
        vscode.window.showInformationMessage('Agent Bridge: no inbox yet, so there is no log. It starts when something creates .agent-inbox/ (or run "Copy orchestrator prompt").');
        return;
      }
      const logFile = path.join(inboxDir, 'bridge.log');
      try {
        fs.appendFileSync(logFile, '', 'utf8');
      } catch (e) {
        log(`failed to ensure log file: ${e.message}`);
      }
      try {
        const doc = await vscode.workspace.openTextDocument(logFile);
        await vscode.window.showTextDocument(doc);
      } catch (e) {
        log(`open log failed: ${e.message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.addLesson', async () => {
      if (!firstFolder()) {
        vscode.window.showWarningMessage('Agent Bridge: open a folder first.');
        return;
      }

      const area = await vscode.window.showInputBox({
        prompt: 'Area (optional), e.g. tests, ui, git'
      });
      if (area === undefined) return;

      const mistake = await vscode.window.showInputBox({
        prompt: 'What went wrong?',
        validateInput: (value) => (!value || !value.trim() ? 'Mistake cannot be empty' : null)
      });
      if (mistake === undefined) return;

      const rule = await vscode.window.showInputBox({
        prompt: 'Rule to follow next time',
        validateInput: (value) => (!value || !value.trim() ? 'Rule cannot be empty' : null)
      });
      if (rule === undefined) return;

      const lessonsPath = lessonsPathFor(getSettings());
      if (!lessonsPath) {
        vscode.window.showWarningMessage('Agent Bridge: set agentBridge.lessonsFile first.');
        return;
      }

      const defaultHeader = '# Agent lessons\n\nMistakes found in code review. Agents: read this before every task and do not repeat them.\nFormat: - YYYY-MM-DD · area: mistake → rule\n\n';

      let content = '';
      try {
        if (fs.existsSync(lessonsPath)) {
          content = fs.readFileSync(lessonsPath, 'utf8');
        } else {
          fs.writeFileSync(lessonsPath, defaultHeader, 'utf8');
          content = defaultHeader;
        }
      } catch (e) {
        log(`failed to access lessons file: ${e.message}`);
        return;
      }

      if (core.hasLesson(content, mistake, rule)) {
        vscode.window.showInformationMessage('Agent Bridge: that lesson is already recorded.');
        return;
      }

      let prefix = '';
      if (content && !content.endsWith('\n')) {
        prefix = '\n';
      }
      const formatted = core.formatLesson(area, mistake, rule, Date.now()) + '\n';
      try {
        fs.appendFileSync(lessonsPath, prefix + formatted, 'utf8');
      } catch (e) {
        log(`failed to append lesson: ${e.message}`);
        return;
      }

      log('lesson added');
      const action = await vscode.window.showInformationMessage('Agent Bridge: lesson added.', 'Open');
      if (action === 'Open') {
        try {
          const doc = await vscode.workspace.openTextDocument(lessonsPath);
          await vscode.window.showTextDocument(doc);
        } catch (e) {
          log(`failed to open lessons file: ${e.message}`);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.copyOrchestratorPrompt', async () => {
      const ws = firstFolder();
      if (!ws || !inboxDir) {
        vscode.window.showWarningMessage('Agent Bridge: open a folder first.');
        return;
      }
      ensureInbox();
      const text = core.orchestratorPrompt({
        projectPath: ws,
        inboxDir,
        lessonsPath: lessonsPathFor(getSettings()) || path.join(ws, 'AGENT_LESSONS.md')
      });
      await vscode.env.clipboard.writeText(text);
      log('orchestrator prompt copied to the clipboard');
      vscode.window.showInformationMessage(
        'Agent Bridge: orchestrator prompt copied. Paste it once into Claude Code, Codex, Gemini CLI or any agent that can read and write files.'
      );
    }),

    vscode.commands.registerCommand('agentBridge.openInbox', async () => {
      if (!inboxDir) {
        vscode.window.showWarningMessage('Agent Bridge: open a folder first.');
        return;
      }
      ensureInbox();
      await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(inboxDir));
    }),

    vscode.commands.registerCommand('agentBridge.showMenu', async () => {
      const items = menuItems();
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Agent Bridge' });
      if (pick && pick.command) {
        await vscode.commands.executeCommand(pick.command, ...(pick.args || []));
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('agentBridge')) {
        stop();
        start();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      stop();
      start();
    })
  );

  context.subscriptions.push({
    dispose: () => stop()
  });

  start();
  welcome(context);
}

// One notification after the first install, so people know where to start.
function welcome(context) {
  if (!context.globalState || context.globalState.get('agentBridge.welcomed')) return;
  context.globalState.update('agentBridge.welcomed', true);
  vscode.window.showInformationMessage(
    'Agent Bridge is installed. To let Claude Code or another agent send tasks to this chat, copy the orchestrator prompt and paste it into that agent.',
    'Copy orchestrator prompt',
    'Show actions'
  ).then((choice) => {
    if (choice === 'Copy orchestrator prompt') vscode.commands.executeCommand('agentBridge.copyOrchestratorPrompt');
    else if (choice === 'Show actions') vscode.commands.executeCommand('agentBridge.showMenu');
  });
}

function queuedCount() {
  try {
    return fs.readdirSync(inboxDir).filter((n) => n === 'prompt.md' || (n.endsWith('.prompt.md') && n.length > '.prompt.md'.length)).length;
  } catch (_) {
    return 0;
  }
}

// Status-bar menu: a summary line, then the actions that make sense right now.
function menuItems() {
  const items = [];
  const openId = core.openPendingId(pending);
  const queued = inboxReady ? queuedCount() : 0;

  let summary;
  if (!inboxDir) summary = 'No folder open';
  else if (!inboxReady) summary = 'Idle: waiting for .agent-inbox/ to appear';
  else if (openId) summary = `Working on ${openId} (${Math.round((Date.now() - pending[openId].sentAt) / 60000)} min)`;
  else summary = 'Watching the inbox, no open task';
  if (paused) summary = `Paused. ${summary}`;
  items.push({
    label: `$(info) ${summary}`,
    description: queued ? `${queued} queued` : '',
    command: inboxReady ? 'agentBridge.openLog' : undefined
  });

  items.push({ label: '$(copy) Copy orchestrator prompt', description: 'paste once into Claude Code, Codex, ...', command: 'agentBridge.copyOrchestratorPrompt' });
  items.push(paused
    ? { label: '$(debug-start) Resume', command: 'agentBridge.togglePause' }
    : { label: '$(debug-pause) Pause', description: 'stop sending from the inbox', command: 'agentBridge.togglePause' });
  if (queued && openId) {
    items.push({ label: '$(run) Send next now', description: `don't wait for ${openId}`, command: 'agentBridge.sendNextNow' });
  }
  const last = extensionContext && extensionContext.workspaceState.get('agentBridge.lastSent');
  if (last) {
    items.push({ label: '$(debug-continue) Resend last prompt with "continue"', description: last.id, command: 'agentBridge.resendContinue' });
    items.push({ label: '$(refresh) Resend last prompt', description: last.id, command: 'agentBridge.resendLast' });
  }
  items.push({ label: '$(go-to-file) Send current file as prompt', command: 'agentBridge.sendCurrentFile' });
  if (inboxReady) items.push({ label: '$(output) Open log', command: 'agentBridge.openLog' });
  if (inboxDir) items.push({ label: '$(folder-opened) Open inbox folder', command: 'agentBridge.openInbox' });
  items.push({ label: '$(lightbulb) Add lesson', description: 'a rule the agent should follow', command: 'agentBridge.addLesson' });
  if (extensionContext && (extensionContext.workspaceState.get('agentBridge.autoSend') || (extensionContext.globalState && extensionContext.globalState.get('agentBridge.autoSendAll')))) {
    items.push({ label: '$(discard) Reset auto-send choice', command: 'agentBridge.resetAutoSend' });
  }
  items.push({ label: '$(gear) Settings', command: 'workbench.action.openSettings', args: ['@ext:alokkkchaudharyyy.agent-bridge'] });
  return items;
}

function deactivate() {
  stop();
}

module.exports = {
  activate,
  deactivate
};
