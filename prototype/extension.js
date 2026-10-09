// Nexera agent bridge: sends prompts written to <repo>/.agent-inbox/prompt.md
// into the Antigravity agent side panel, so tasks can be queued from outside.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const INBOXES = ['D:\\Code\\nexera-app\\.agent-inbox'];

function log(dir, line) {
  try {
    fs.appendFileSync(path.join(dir, 'bridge.log'), `${new Date().toISOString()} ${line}\n`);
  } catch (_) { /* ignore */ }
}

async function check(dir) {
  const file = path.join(dir, 'prompt.md');
  if (!fs.existsSync(file)) return;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    fs.renameSync(file, path.join(dir, `sent-${Date.now()}.md`));
  } catch (e) {
    log(dir, `read failed: ${e}`);
    return;
  }
  if (!text.trim()) return;
  try {
    if (text.startsWith('<!-- new-conversation -->')) {
      await vscode.commands.executeCommand('antigravity.startNewConversation');
      await new Promise((r) => setTimeout(r, 1500));
    }
    await vscode.commands.executeCommand('antigravity.sendPromptToAgentPanel', text);
    log(dir, `sent ${text.length} chars`);
  } catch (e) {
    log(dir, `send failed: ${e}`);
  }
}

function activate(context) {
  for (const dir of INBOXES) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
    log(dir, 'bridge active');
  }
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { for (const dir of INBOXES) await check(dir); } finally { busy = false; }
  }, 4000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() {}

module.exports = { activate, deactivate };
