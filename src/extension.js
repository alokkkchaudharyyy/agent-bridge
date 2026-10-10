const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
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
    stuckAfterMinutes: cfg.get('stuckAfterMinutes', 30),
    waitForDone: cfg.get('waitForDone', true)
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
      setStatus(paused ? 'paused' : 'watching');
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
        setStatus(paused ? 'paused' : 'watching');
      }, 10000);
    } else if (kind === 'waiting') {
      statusItem.text = customText;
    } else if (kind === 'nofolder') {
      statusItem.text = 'Agent Bridge: no folder';
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliver(parsed, label, requestedId) {
  const settings = getSettings();
  const firstWs = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : undefined;

  let lessonsContent = '';
  let lessonsPath = null;
  if (settings.lessonsFile) {
    lessonsPath = path.isAbsolute(settings.lessonsFile)
      ? settings.lessonsFile
      : (firstWs ? path.join(firstWs, settings.lessonsFile) : null);
    if (lessonsPath) {
      try {
        if (fs.existsSync(lessonsPath)) {
          lessonsContent = fs.readFileSync(lessonsPath, 'utf8');
        }
      } catch (_) {
        lessonsContent = '';
      }
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

    if (cmds.has('antigravity.sendPromptToAgentPanel')) {
      if (parsed.newConversation && cmds.has('antigravity.startNewConversation')) {
        await vscode.commands.executeCommand('antigravity.startNewConversation');
        await sleep(1500);
      }
      await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', body);
      via = 'antigravity';
    } else if (cmds.has('workbench.action.chat.open')) {
      if (parsed.newConversation && cmds.has('workbench.action.chat.newChat')) {
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

    const newConvSuffix = parsed.newConversation ? ' (new conversation)' : '';
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
    if (settings.completionSignal) {
      pending[id] = { sentAt: Date.now(), label, stuckNotified: false };
      savePending();
    }
    
    setStatus('sent', '$(check) Agent Bridge: sent ' + id);
  } catch (e) {
    log(`send failed (${label}): ${e.message}`);
    setStatus('error');
  }
}

async function sendFile(entry, parsed, headerId) {
  const filePath = path.join(inboxDir, entry.name);
  const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'sent'));
  fs.renameSync(filePath, dest);
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
  const firstWs = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : undefined;
  
  const child = child_process.spawn(cmd, {
    shell: true,
    cwd: firstWs || inboxDir,
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

function checkStuck() {
  const settings = getSettings();
  const ids = core.findStuck(pending, Date.now(), settings.stuckAfterMinutes);
  for (const id of ids) {
    pending[id].stuckNotified = true;
    savePending();
    log(`may be stuck: id=${id} (no done/question after ${settings.stuckAfterMinutes} min)`);
    setStatus('event', `$(clock) Agent Bridge: ${id} may be stuck`, true);
    vscode.window.showWarningMessage(
      `Agent Bridge: the agent may be stuck on ${id} (no reply after ${settings.stuckAfterMinutes} min).`,
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
  const decision = core.decideConfirm(settings.confirmMode, savedChoice);

  if (decision === 'send') {
    await sendFile(entry, parsed, headerId);
    return;
  }

  const detail = core.preview(parsed.body) + (parsed.newConversation ? '\n\n(starts a new conversation)' : '');

  if (decision === 'first') {
    const first = await vscode.window.showWarningMessage(
      'Agent Bridge: auto-send prompts from this project\'s inbox to the agent?',
      {
        modal: true,
        detail: `First prompt: "${entry.name}"\n\n${detail}\n\nYour answer is saved for this project only. Change it any time with "Agent Bridge: Reset auto-send choice".`
      },
      'Always for this project',
      'Ask each time',
      'View prompt'
    );
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
  if (!scanning) {
    scanning = true;
    try {
      scanOutbox();
      checkStuck();
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
      const openId = getSettings().waitForDone && !forceNext ? core.openPendingId(pending) : null;
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
  const firstWs = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : undefined;

  inboxDir = core.resolveInboxPath(settings.inboxPath, firstWs);
  if (!inboxDir) {
    setStatus('nofolder');
    if (statusItem) {
      statusItem.tooltip = 'Agent Bridge: no folder';
    }
    return;
  }

  try {
    fs.mkdirSync(inboxDir, { recursive: true });
    fs.mkdirSync(path.join(inboxDir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(inboxDir, 'done'), { recursive: true });
    fs.mkdirSync(path.join(inboxDir, 'question'), { recursive: true });
    fs.mkdirSync(path.join(inboxDir, 'sent'), { recursive: true });
  } catch (_) {
    /* ignore directory creation errors */
  }

  baselineOutbox();

  if (statusItem) {
    statusItem.tooltip = `Inbox: ${inboxDir}\nClick to open the log`;
  }
  log(`bridge active (inbox: ${inboxDir})`);
  setStatus(paused ? 'paused' : 'watching');

  if (!gitignoreOffered && firstWs && inboxDir) {
    const rel = path.relative(firstWs, inboxDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel) && rel !== '') {
      gitignoreOffered = true;
      checkGitignore(firstWs, rel.replace(/\\/g, '/'));
    }
  }

  timer = setInterval(poll, settings.pollIntervalMs);
  poll();
}

function activate(context) {
  extensionContext = context;
  paused = Boolean(context.workspaceState.get('agentBridge.paused', false));
  pending = context.workspaceState.get('agentBridge.pending', {});

  outputChannel = vscode.window.createOutputChannel('Agent Bridge');
  context.subscriptions.push(outputChannel);

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'agentBridge.openLog';
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
      setStatus(paused ? 'paused' : 'watching');
      vscode.window.showInformationMessage(`Agent Bridge ${paused ? 'paused' : 'resumed'}.`);
    })
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
      log('auto-send choice reset');
      vscode.window.showInformationMessage('Agent Bridge: auto-send choice reset. You will be asked again on the next prompt.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agentBridge.openLog', async () => {
      if (!inboxDir) {
        vscode.window.showWarningMessage('Agent Bridge: open a folder first.');
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
      const firstWs = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : undefined;

      if (!firstWs) {
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

      const settings = getSettings();
      const lessonsFile = settings.lessonsFile;
      const lessonsPath = path.isAbsolute(lessonsFile)
        ? lessonsFile
        : path.join(firstWs, lessonsFile);

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
}

function deactivate() {
  stop();
}

module.exports = {
  activate,
  deactivate
};
