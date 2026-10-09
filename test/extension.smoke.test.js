// End-to-end smoke test: loads the real src/extension.js with a fake `vscode`
// module and drives send -> done -> question -> stuck -> empty-prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ws-'));
const inbox = path.join(ws, '.agent-inbox');
const calls = [];
const msgs = [];
const status = { text: '', show() {}, dispose() {} };
const state = new Map();
const hookScript = "require('fs').writeFileSync('hook.txt', [process.env.AGENT_BRIDGE_EVENT, process.env.AGENT_BRIDGE_ID, process.env.AGENT_BRIDGE_STATUS].join(' '))";
const cfg = {
  confirmBeforeSend: false,
  pollIntervalMs: 1000,
  stuckAfterMinutes: 0.02,
  onDoneCommand: `"${process.execPath}" -e "${hookScript}"`
};

const noop = { dispose() {} };
const notify = (kind) => (message) => {
  msgs.push([kind, message]);
  return Promise.resolve();
};
const fakeVscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws } }],
    isTrusted: true,
    getConfiguration: () => ({
      get: (k, d) => (k in cfg ? cfg[k] : d),
      inspect: () => ({ globalValue: cfg.onDoneCommand })
    }),
    onDidChangeConfiguration: () => noop,
    onDidChangeWorkspaceFolders: () => noop,
    openTextDocument: async () => ({})
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
    createStatusBarItem: () => status,
    showInformationMessage: notify('info'),
    showWarningMessage: notify('warn'),
    showErrorMessage: notify('error'),
    showTextDocument: async () => {}
  },
  commands: {
    getCommands: async () => ['antigravity.sendPromptToAgentPanel', 'antigravity.startNewConversation'],
    executeCommand: async (c, a) => {
      calls.push([c, a]);
    },
    registerCommand: () => noop
  },
  StatusBarAlignment: { Right: 2 },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  }
};

function put(rel, text) {
  const file = path.join(inbox, rel);
  fs.writeFileSync(file, text);
  const past = (Date.now() - 5000) / 1000;
  fs.utimesSync(file, past, past);
}

async function waitFor(predicate, what, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const sends = () => calls.filter((c) => c[0] === 'antigravity.sendPromptToAgentPanel');
const hasMsg = (kind, text) => msgs.some((m) => (!kind || m[0] === kind) && m[1].includes(text));
const readLog = () => fs.readFileSync(path.join(inbox, 'bridge.log'), 'utf8');

test('extension flow: send, done, question, stuck, empty prompt', { timeout: 30000 }, async () => {
  const origLoad = Module._load;
  Module._load = function (req, ...rest) {
    return req === 'vscode' ? fakeVscode : origLoad.call(this, req, ...rest);
  };
  const ctx = {
    subscriptions: [],
    workspaceState: {
      get: (k, d) => (state.has(k) ? state.get(k) : d),
      update: async (k, v) => state.set(k, v)
    }
  };
  let ext;
  try {
    ext = require('../src/extension');
    ext.activate(ctx);

    // 1. Send with markers and an id header.
    put('001.prompt.md', '<!-- new-conversation -->\n<!-- id: task-42 -->\nDo the thing.');
    await waitFor(() => sends().length === 1, 'first send');
    assert.equal(calls[0][0], 'antigravity.startNewConversation');
    const sent = sends()[0][1];
    assert.ok(sent.startsWith('Do the thing.'), 'markers stripped');
    assert.ok(sent.includes(path.join(inbox, 'done', 'task-42.json')), 'footer has absolute done path');
    assert.ok(fs.existsSync(path.join(inbox, 'sent', 'task-42.json')), 'sent receipt');
    assert.ok(state.get('agentBridge.pending')['task-42'], 'pending recorded');
    assert.match(readLog(), /id=task-42/);
    assert.doesNotMatch(readLog(), /\+lessons/);

    // 1b. Lessons are referenced by absolute path (multi-root safe).
    fs.writeFileSync(path.join(ws, 'AGENT_LESSONS.md'), '- 2026-10-09 · x: mistake → rule\n');
    put('001b.prompt.md', 'Second task.');
    await waitFor(() => sends().length === 2, 'send with lessons');
    assert.ok(sends()[1][1].includes(`read ${path.join(ws, 'AGENT_LESSONS.md')}`), 'absolute lessons path');
    fs.rmSync(path.join(ws, 'AGENT_LESSONS.md'));

    // 2. Done file -> notification, status, pending cleared, hook ran.
    put('done/task-42.json', JSON.stringify({ id: 'task-42', status: 'done', summary: 'Built it.', commits: ['abc123'] }));
    await waitFor(() => hasMsg('info', 'task-42 done. Built it.'), 'done notification');
    assert.match(status.text, /task-42 done/);
    assert.equal(state.get('agentBridge.pending')['task-42'], undefined);
    const hookFile = path.join(ws, 'hook.txt');
    await waitFor(() => fs.existsSync(hookFile) && fs.readFileSync(hookFile, 'utf8') === 'done task-42 done', 'onDoneCommand');

    // 3. Question file.
    put('002.prompt.md', '<!-- id: q-1 -->\nAsk me.');
    await waitFor(() => fs.existsSync(path.join(inbox, 'sent', 'q-1.json')), 'second send');
    put('question/q-1.md', 'Which DB?');
    await waitFor(() => hasMsg('warn', 'q-1 needs a decision'), 'question notification');

    // 4. Generated id, then stuck warning.
    put('003.prompt.md', 'No id here.');
    await waitFor(() => hasMsg(null, 'may be stuck'), 'stuck warning');
    assert.ok(fs.readdirSync(path.join(inbox, 'sent')).some((f) => /^\d{8}-\d{4}-[0-9a-f]{4}\.json$/.test(f)), 'generated id');

    // 5. Marker-only prompt is discarded, not sent.
    const before = sends().length;
    put('prompt.md', '<!-- new-conversation -->');
    await waitFor(() => fs.readdirSync(path.join(inbox, 'archive')).some((f) => f.startsWith('discarded-')), 'empty discard');
    assert.equal(sends().length, before);
  } finally {
    if (ext) ext.deactivate();
    for (const d of ctx.subscriptions) {
      try { d.dispose(); } catch (_) { /* ignore */ }
    }
    Module._load = origLoad;
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
});
