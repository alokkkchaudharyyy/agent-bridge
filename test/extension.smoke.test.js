// End-to-end smoke test: loads the real src/extension.js with a fake `vscode`
// module and drives send -> done -> question -> stuck -> empty-prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ws-'));
const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-ws2-')); // second root: multi-root workspace
const inbox = path.join(ws, '.agent-inbox');
const calls = [];
const handlers = {};
const msgs = [];
const status = { text: '', show() {}, dispose() {} };
const state = new Map();
const hookScript = "require('fs').writeFileSync('hook.txt', [process.env.AGENT_BRIDGE_EVENT, process.env.AGENT_BRIDGE_ID, process.env.AGENT_BRIDGE_STATUS].join(' '))";
const cfg = {
  confirmBeforeSend: 'auto',
  waitForDone: false, // steps 1-5 run without the queue hold; step 6 turns it on
  pollIntervalMs: 1000,
  stuckAfterMinutes: 0.02,
  onDoneCommand: `"${process.execPath}" -e "${hookScript}"`
};

const noop = { dispose() {} };
const notify = (kind) => (message) => {
  msgs.push([kind, message]);
  // Answer the one-time auto-send question; everything else is dismissed.
  return Promise.resolve(message.includes('auto-send prompts') ? 'Always for this project' : undefined);
};
const fakeVscode = {
  workspace: {
    workspaceFolders: [{ uri: { fsPath: ws } }, { uri: { fsPath: ws2 } }],
    isTrusted: true,
    getConfiguration: () => ({
      get: (k, d) => (k in cfg ? cfg[k] : d),
      inspect: (k) => ({ globalValue: cfg[k] })
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
    registerCommand: (id, fn) => {
      handlers[id] = fn;
      return noop;
    }
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
  let tail = '';
  try { tail = fs.readFileSync(path.join(inbox, 'bridge.log'), 'utf8').trim().split('\n').slice(-6).join('\n'); } catch (_) { /* no log */ }
  assert.fail(`timed out waiting for: ${what}\nlast log lines:\n${tail}`);
}

const sends = () => calls.filter((c) => c[0] === 'antigravity.sendPromptToAgentPanel');
const hasMsg = (kind, text) => msgs.some((m) => (!kind || m[0] === kind) && m[1].includes(text));
const readLog = () => fs.readFileSync(path.join(inbox, 'bridge.log'), 'utf8');

test('extension flow: first-time choice, multi-root paths, send, done, question, stuck, queue hold, quota, resend', { timeout: 30000 }, async () => {
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
    assert.equal(msgs.filter((m) => m[1].includes('auto-send prompts')).length, 1, 'one-time question asked once');
    assert.equal(state.get('agentBridge.autoSend'), 'always', 'choice saved for the project');
    assert.ok(!fs.existsSync(path.join(ws2, '.agent-inbox')), 'second root untouched');

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
    assert.ok(msgs.find((m) => m[1].includes('may be stuck'))[1].includes('Last log:'), 'stuck warning shows log lines');
    assert.ok(fs.readdirSync(path.join(inbox, 'sent')).some((f) => /^\d{8}-\d{4}-[0-9a-f]{4}\.json$/.test(f)), 'generated id');

    // 5. Marker-only prompt is discarded, not sent.
    const before = sends().length;
    put('prompt.md', '<!-- new-conversation -->');
    await waitFor(() => fs.readdirSync(path.join(inbox, 'archive')).some((f) => f.startsWith('discarded-')), 'empty discard');
    assert.equal(sends().length, before);

    // 6. Queue hold: the next prompt waits for the previous task's done file.
    const openTasks = () => Object.values(state.get('agentBridge.pending') || {}).filter((p) => !p.stuckNotified);
    const queued = () => fs.readdirSync(inbox).filter((f) => f === 'prompt.md' || f.endsWith('.prompt.md'));
    await waitFor(() => queued().length === 0 && openTasks().length === 0, 'queue empty and earlier tasks released', 8000);
    cfg.stuckAfterMinutes = 0; // no stuck timeout, so only done/question releases the hold
    cfg.waitForDone = true;
    put('006.prompt.md', '<!-- id: g-1 -->\nFirst queued.');
    await waitFor(() => fs.existsSync(path.join(inbox, 'sent', 'g-1.json')), 'g-1 sent');
    put('007.prompt.md', '<!-- id: g-2 -->\nSecond queued.');
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!fs.existsSync(path.join(inbox, 'sent', 'g-2.json')), 'g-2 held while g-1 is open');
    assert.match(status.text, /waiting for g-1/);
    put('done/g-1.json', JSON.stringify({ id: 'g-1', status: 'done', summary: 'ok', commits: [] }));
    await waitFor(() => fs.existsSync(path.join(inbox, 'sent', 'g-2.json')), 'g-2 sent after g-1 done');

    // 7. "Send next now" skips the hold once.
    put('008.prompt.md', '<!-- id: g-3 -->\nThird queued.');
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(!fs.existsSync(path.join(inbox, 'sent', 'g-3.json')), 'g-3 held while g-2 is open');
    await handlers['agentBridge.sendNextNow']();
    await waitFor(() => fs.existsSync(path.join(inbox, 'sent', 'g-3.json')), 'g-3 sent by Send next now');

    // 8. Quota stop in the (fake) Antigravity conversation file -> question/g-3.md.
    const convDir = path.join(ws2, 'conversations');
    fs.mkdirSync(convDir);
    cfg.conversationsPath = convDir;
    cfg.detectQuotaErrors = 'on';
    const errDate = new Date(Date.now() + 1000).toUTCString();
    fs.writeFileSync(path.join(convDir, 'c1.db'), Buffer.concat([
      Buffer.from([0, 1, 2]),
      Buffer.from('RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h5m26s', 'latin1'),
      Buffer.from([0, 0]),
      Buffer.from(`HTTP 429 Headers: {"Date":["${errDate}"]}`, 'latin1')
    ]));
    const quotaFile = path.join(inbox, 'question', 'g-3.md');
    await waitFor(() => fs.existsSync(quotaFile), 'quota question written');
    assert.match(fs.readFileSync(quotaFile, 'utf8'), /^status: blocked\nreason: quota\nresets: \d{4}-/);
    await waitFor(() => hasMsg('warn', 'g-3 needs a decision'), 'quota notification');

    // 9. Resend with 'continue' reuses the id and reopens the task.
    const sendsBefore = sends().length;
    await handlers['agentBridge.resendContinue']();
    assert.equal(sends().length, sendsBefore + 1);
    const resent = sends()[sends().length - 1][1];
    assert.ok(resent.startsWith('Continue where you left off'), 'continue prefix');
    assert.ok(resent.includes('Third queued.'), 'original body included once');
    assert.ok(resent.includes(path.join(inbox, 'done', 'g-3.json')), 'same id in footer');
    assert.ok(!fs.existsSync(quotaFile), 'old question archived');
    await handlers['agentBridge.resendLast']();
    assert.ok(sends()[sends().length - 1][1].startsWith('Third queued.'), 'plain resend uses the original prompt');
  } finally {
    if (ext) ext.deactivate();
    for (const d of ctx.subscriptions) {
      try { d.dispose(); } catch (_) { /* ignore */ }
    }
    Module._load = origLoad;
    for (const d of [ws, ws2]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  }
});
