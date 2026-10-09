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
let extensionContext = null;

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
  const body = parsed.body;
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
    log(`sent ${body.length} chars via ${via}: ${label}${newConvSuffix}`);
    setStatus('sent');
  } catch (e) {
    log(`send failed (${label}): ${e.message}`);
    setStatus('error');
  }
}

async function poll() {
  if (paused || busy || !inboxDir) return;
  // Poll logic will be implemented in subsequent step
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
