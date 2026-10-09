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
