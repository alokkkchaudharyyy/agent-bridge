const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
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
    confirmBeforeSend: cfg.get('confirmBeforeSend', true),
    newConversationMarker: cfg.get('newConversationMarker', '<!-- new-conversation -->'),
    lessonsFile: cfg.get('lessonsFile', 'AGENT_LESSONS.md'),
    lessonsMode: cfg.get('lessonsMode', 'reference')
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

function setStatus(kind) {
  if (!statusItem) return;

  if (kind !== 'sent' && revertTimer) {
    clearTimeout(revertTimer);
    revertTimer = null;
  }

  if (kind === 'error') {
    statusItem.text = '$(error) Agent Bridge: error';
    statusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  } else {
    statusItem.backgroundColor = undefined;
    if (kind === 'watching') {
      statusItem.text = '$(radio-tower) Agent Bridge: watching';
    } else if (kind === 'paused') {
      statusItem.text = '$(debug-pause) Agent Bridge: paused';
    } else if (kind === 'sent') {
      statusItem.text = '$(check) Agent Bridge: sent';
      if (revertTimer) {
        clearTimeout(revertTimer);
      }
      revertTimer = setTimeout(() => {
        revertTimer = null;
        setStatus(paused ? 'paused' : 'watching');
      }, 10000);
    } else if (kind === 'nofolder') {
      statusItem.text = 'Agent Bridge: no folder';
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deliver(parsed, label) {
  const settings = getSettings();
  const firstWs = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : undefined;

  let lessonsContent = '';
  if (settings.lessonsFile) {
    const lessonsPath = path.isAbsolute(settings.lessonsFile)
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

  const body = core.applyLessons(parsed.body, {
    mode: settings.lessonsMode,
    relPath: settings.lessonsFile,
    content: lessonsContent
  });

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
    const lessonsSuffix = body !== parsed.body ? ' (+lessons)' : '';
    log(`sent ${body.length} chars via ${via}: ${label}${newConvSuffix}${lessonsSuffix}`);
    setStatus('sent');
  } catch (e) {
    log(`send failed (${label}): ${e.message}`);
    setStatus('error');
  }
}

async function sendFile(entry, parsed) {
  const filePath = path.join(inboxDir, entry.name);
  const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'sent'));
  fs.renameSync(filePath, dest);
  await deliver(parsed, entry.name);
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
  const parsed = core.parsePrompt(text, settings.newConversationMarker);

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

  if (!settings.confirmBeforeSend) {
    await sendFile(entry, parsed);
    return;
  }

  const detail = core.preview(parsed.body) + (parsed.newConversation ? '\n\n(starts a new conversation)' : '');
  const choice = await vscode.window.showWarningMessage(
    `Agent Bridge: send "${entry.name}" to the agent?`,
    { modal: true, detail },
    'Send',
    'Discard',
    'View'
  );

  if (choice === 'Send') {
    await sendFile(entry, parsed);
  } else if (choice === 'Discard') {
    const dest = path.join(inboxDir, 'archive', core.archiveName(entry.name, Date.now(), 'discarded'));
    try {
      fs.renameSync(filePath, dest);
    } catch (_) {
      /* ignore rename errors */
    }
    log(`discarded: ${entry.name}`);
  } else if (choice === 'View') {
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
      const reParsed = core.parsePrompt(reReadText, settings.newConversationMarker);
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
      await sendFile(entry, reParsed);
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
  } else {
    skip.add(core.skipKey(entry));
    log(`cancelled: ${entry.name} (will ask again if the file changes)`);
  }
}

async function poll() {
  if (paused || busy || !inboxDir) return;
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
  } catch (_) {
    /* ignore directory creation errors */
  }

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
      const parsed = core.parsePrompt(doc.getText(), settings.newConversationMarker);
      if (parsed.isEmpty) {
        vscode.window.showWarningMessage('Agent Bridge: the file is empty.');
        return;
      }
      await deliver(parsed, path.basename(doc.fileName));
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
