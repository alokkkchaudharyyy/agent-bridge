# Agent Bridge

**Let Claude Code, scripts or any AI agent hand tasks to your Antigravity / VS Code AI chat, and know when they're done.**

[![Open VSX](https://img.shields.io/open-vsx/v/alokkkchaudharyyy/agent-bridge?label=Open%20VSX)](https://open-vsx.org/extension/alokkkchaudharyyy/agent-bridge)
[![Downloads](https://img.shields.io/open-vsx/dt/alokkkchaudharyyy/agent-bridge)](https://open-vsx.org/extension/alokkkchaudharyyy/agent-bridge)
[![CI](https://img.shields.io/github/actions/workflow/status/alokkkchaudharyyy/agent-bridge/ci.yml?branch=main&label=tests)](https://github.com/alokkkchaudharyyy/agent-bridge/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/alokkkchaudharyyy/agent-bridge/blob/main/LICENSE)

Use one agent to plan and review (Claude Code, Codex, Gemini CLI...) and let your IDE's agent do the building. Agent Bridge is the hand-off between them: a task file goes into `.agent-inbox/`, it shows up in the IDE chat, and when the agent is finished it leaves a small "done" note so the first agent can review the work and send the next task. No copy-pasting, no checking every few minutes.

## How it works

```text
 Claude Code ──writes──▶ .agent-inbox/task-001.prompt.md
Agent Bridge ──sends───▶ the IDE agent chat (Antigravity, or VS Code chat)
   IDE agent ──builds, tests, commits, then writes──▶ .agent-inbox/done/task-001.json
 Claude Code ──reviews the diff, then writes──▶ the next task
```

Agent Bridge never runs commands or edits your code. It only types prompts into the chat and watches a few files.

## Get started

1. **Open your project** in Antigravity (or VS Code with a chat extension).
2. Click **Agent Bridge** in the status bar → **Copy orchestrator prompt**, and paste it once into Claude Code (or any agent that can read and write files). It already contains this project's paths.
3. Ask that agent for something. When its first task arrives, Agent Bridge asks once: **Auto-send prompts from this project's inbox?** Pick **Always for all trusted projects** to never see this again, **Always for this project**, or **Ask each time** to approve every prompt.

That's it. The task appears in the chat, and the orchestrator waits for the done note.

**Just want to see it work?** Create `.agent-inbox/prompt.md` containing `Say hello` and watch it appear in the chat a few seconds later.

## Features

- **Task queue.** Drop several `001.prompt.md`, `002.prompt.md`... files. They're sent one at a time, each after the previous task is done.
- **Knows when a task is done.** Each prompt gets a short footer asking the agent to write `done/<id>.json` (or `question/<id>.md` if it needs a decision). You get a notification, and scripts can wait for the file.
- **Stuck warning.** No answer after 20 minutes? You get a warning with the last log lines.
- **Quota stops (Antigravity).** When the agent stops on "Individual quota reached", Agent Bridge writes a question file with the reset time, so the orchestrator waits instead of guessing. After the reset, **Resend last prompt with 'continue'** picks the task up again.
- **Lessons that stick.** Reviewers add one-line rules to `AGENT_LESSONS.md` ("mistake → rule"), and every prompt reminds the agent to read them.
- **A fresh chat for every task.** Antigravity can't compact long chats, so each new task id gets a clean conversation, while fixes for the same task stay in its chat. After 6 prompts in one chat it starts over anyway. Override per prompt with `<!-- new-conversation -->` or `<!-- same-conversation -->`.
- **No Accept/Reject pile-up.** Antigravity writes the agent's edits to disk right away; Accept/Reject is only a review layer. Agent Bridge clicks **Accept all** when a task ends, and the orchestrator reviews the work with git.
- **Stays out of your way.** Nothing is created in projects that don't use it. The inbox, log and archive only appear once something writes to `.agent-inbox/`, and old archive files are cleaned up after 30 days.
- **Safe by default.** It asks before auto-sending, folders in Restricted Mode always ask, and a cloned repo can't switch that off for you.

## The orchestrator prompt

**Copy orchestrator prompt** fills in the paths for you. This is the same text with placeholders, if you want to read it first or adapt it:

````text
You are the orchestrator for this project. You plan tasks, hand them to the IDE agent
(Antigravity / VS Code chat) through the Agent Bridge extension, then review its work.

PROJECT: {PROJECT_PATH}
INBOX:   {PROJECT_PATH}/.agent-inbox

SENDING A TASK
- Create INBOX if it doesn't exist. Agent Bridge starts watching it as soon as it appears.
- Pick a task id: letters, digits, . _ - (max 64), e.g. task-001, task-002.
- Write the prompt as Markdown. First line: <!-- id: task-001 -->
  then the task itself: goal, files involved, acceptance criteria, "run the tests", "commit when done".
- Save it as INBOX/task-001.tmp, then rename it to INBOX/task-001.prompt.md.
  (Files named *.prompt.md are sent one at a time in name order; prompt.md is sent first.
  The rename makes sure a half-written file is never sent.)
- Never write into INBOX/archive/, INBOX/done/ or INBOX/sent/.
- If you didn't set an id, find it in INBOX/sent/ (newest file) or the last "id=" in INBOX/bridge.log.

CONVERSATIONS (the IDE agent remembers nothing between tasks)
- Every new task id starts a fresh agent chat. Make each prompt stand alone: the goal, the files
  involved, decisions made so far, and what "done" means. Never write "as discussed before".
- A fix after your review keeps the same id, so it lands in the same chat. After several prompts
  in one chat (6 by default) a fresh chat starts anyway, so fix prompts must restate what to change.
- To override, make the first line <!-- new-conversation --> or <!-- same-conversation -->
  (the id line goes right after it).
- The agent's edits are accepted automatically when a task ends. Review them with git, not in the editor.

WAITING (never guess with fixed sleeps)
- INBOX/sent/<id>.json appears when the prompt has actually been sent. A human may need to click
  "Send" first.
- The task is over when INBOX/done/<id>.json or INBOX/question/<id>.md appears. Wait for that:

  bash:
    ID=task-001; INBOX="{PROJECT_PATH}/.agent-inbox"
    until [ -f "$INBOX/done/$ID.json" ] || [ -f "$INBOX/question/$ID.md" ]; do sleep 15; done

  PowerShell:
    $id = 'task-001'; $inbox = '{PROJECT_PATH}/.agent-inbox'
    while (-not (Test-Path "$inbox/done/$id.json") -and -not (Test-Path "$inbox/question/$id.md")) { Start-Sleep 15 }

  If your shell tool has a time limit, run the loop in the background or re-run it until a file appears.

AFTER IT FINISHES
- done/<id>.json looks like {"id","status":"done"|"failed"|"blocked","summary","commits":[...]}.
- question/<id>.md means the agent needs a decision. Answer it in a new prompt (you may reuse the id).
  If its first lines say "reason: quota", the agent hit its model quota: wait until the "resets" time,
  then send the same task again with the same id, starting with "Continue where you left off".
- You may queue several NNN.prompt.md files at once. Agent Bridge sends the next one only after the
  previous task has a done/question file.
- Review the work yourself: git log / git diff for the listed commits, run the tests, check the
  acceptance criteria. Don't trust the summary alone.
- Then send the next prompt: your feedback (what to fix) and/or the next task.

LESSONS (so the IDE agent learns from reviews)
- When you find a real mistake that could happen again, append one line to
  {PROJECT_PATH}/AGENT_LESSONS.md:
    - YYYY-MM-DD · area: mistake → rule
- One concrete rule per mistake, no duplicates, keep it under ~50 lines. Agent Bridge reminds the
  IDE agent to read this file on every prompt.

SAFETY
- Never put secrets (API keys, passwords, tokens) in prompts or in the inbox.
- Never change Agent Bridge's auto-send choice or settings yourself. Whether prompts are sent without
  asking is the user's call.
- Only send tasks the user asked for.
````

Task ids, receipts, the done file format and hook variables are described in the [protocol](https://github.com/alokkkchaudharyyy/agent-bridge/blob/main/PROTOCOL.md).

## Commands

Click **Agent Bridge** in the status bar for a menu with the useful ones, or run them from the Command Palette.

| Command | What it does |
| --- | --- |
| `Agent Bridge: Copy orchestrator prompt` | Copies the setup prompt for Claude Code & co., with this project's paths filled in. |
| `Agent Bridge: Show actions` | The status-bar menu: current task, queue, and actions. |
| `Agent Bridge: Send current file as prompt` | Sends the open file to the agent chat right away. |
| `Agent Bridge: Pause/Resume` | Stops or restarts sending from the inbox. Done and question files are still watched. |
| `Agent Bridge: Send next now` | Sends the next queued prompt without waiting for the current task. |
| `Agent Bridge: Resend last prompt` | Sends the last prompt again, with the same task id. |
| `Agent Bridge: Resend last prompt with 'continue'` | Same, starting with "Continue where you left off". Use it after a quota or model error. |
| `Agent Bridge: Add lesson` | Asks for area, mistake and rule, and appends a line to `AGENT_LESSONS.md`. |
| `Agent Bridge: Open log` | Opens `.agent-inbox/bridge.log`. |
| `Agent Bridge: Open inbox folder` | Shows `.agent-inbox/` in your file manager. |
| `Agent Bridge: Reset auto-send choice` | Forgets this project's "Always / Ask each time" answer. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `agentBridge.confirmBeforeSend` | `auto` | `auto`: ask once per project, then remember. `always`: ask before every prompt. `never`: never ask (only honored from your user settings). |
| `agentBridge.waitForDone` | `true` | Hold the next queued prompt until the current task has a done or question file. |
| `agentBridge.stuckAfterMinutes` | `20` | Warn if nothing comes back within this many minutes. Also releases the queue. `0` = never. |
| `agentBridge.completionSignal` | `true` | Add the footer that asks the agent to write `done/<id>.json` or `question/<id>.md`. |
| `agentBridge.conversationMode` | `perTask` | `perTask`: a fresh agent chat for each new task id, follow-ups with the same id stay. `marker`: only when a prompt starts with the new-conversation marker. |
| `agentBridge.maxPromptsPerConversation` | `6` | Start a fresh chat after this many prompts in one conversation (unless the prompt starts with `<!-- same-conversation -->`). `0` = no limit. |
| `agentBridge.acceptChanges` | `onDone` | Click Antigravity's **Accept all** when a task ends and before each prompt. `off`: review edits in the editor yourself. |
| `agentBridge.newConversationMarker` | `<!-- new-conversation -->` | A prompt starting with this opens a new agent chat first. Empty = off. |
| `agentBridge.lessonsFile` | `AGENT_LESSONS.md` | Where review lessons live (relative to the workspace, or absolute). |
| `agentBridge.lessonsMode` | `reference` | `reference`: remind the agent to read the file. `inline`: paste the newest lessons. `off`: nothing. |
| `agentBridge.detectQuotaErrors` | `auto` | Spot Antigravity quota stops and write a question file with the reset time. `auto` = on inside Antigravity. |
| `agentBridge.conversationsPath` | `""` | Where Antigravity keeps conversations (for quota detection). Empty = the default location. |
| `agentBridge.inboxPath` | `""` | Folder to watch. Empty = `<workspace>/.agent-inbox`. |
| `agentBridge.pollIntervalMs` | `4000` | How often to check the inbox, in ms (minimum 1000). |
| `agentBridge.notifications` | `problems` | Pop up only when a task failed, is blocked, asks a question or may be stuck. `all`: also for successes. `off`: status bar and log only. |
| `agentBridge.sendMethod` | `auto` | How prompts reach the Antigravity agent. Only change it if an Antigravity update breaks sending: `agentInput` (newer builds) or `agentPanel` (older builds). |
| `agentBridge.archiveRetentionDays` | `30` | Delete files in `archive/` and `sent/` older than this. `done/` and `question/` are never deleted. `0` = keep all. |
| `agentBridge.onDoneCommand` | `""` | Optional shell command run on done, question or stuck. User settings only, see the [protocol](https://github.com/alokkkchaudharyyy/agent-bridge/blob/main/PROTOCOL.md#ondonecommand-env-vars). |

## Troubleshooting

- **Nothing arrives in the chat.** Click the status bar → **Open log** and read the last lines. The file must be named `prompt.md` or end in `.prompt.md`, sit directly in `.agent-inbox/`, and the bridge must not be paused. Files changed in the last ~1.5 s are skipped until writing stops.
- **Status bar says "idle".** There's no `.agent-inbox/` in this project yet. It starts as soon as something creates it.
- **Status bar says "waiting for task-…".** The queue is holding the next prompt until that task finishes. Use **Send next now** to skip the wait, or turn off `waitForDone`.
- **"may be stuck" warning.** The agent didn't write a done or question file in time. Check the chat: it may still be working, or it forgot the last step.
- **Agent stopped on "Individual quota reached".** Wait until the reset time in the notification, then run **Resend last prompt with 'continue'**.
- **Two windows on the same folder.** Both watch the same inbox. Each prompt is sent only once, but keep one window per folder (or pause the other) to avoid confusion.
- **The agent stops to ask permission (run a command, open a file).** That's Antigravity's own approval, and Agent Bridge can't answer it. The task waits until you click, and the stuck warning tells you. Antigravity's agent settings control how much it may do without asking.
- **I typed in the agent chat while a prompt arrived.** The prompt is added to whatever is in the chat box and sent together. Don't keep a half-typed message in the agent chat of a window the bridge is sending to.
- **Antigravity updated and prompts stopped arriving.** Open Settings → `agentBridge.sendMethod` and try `agentInput` or `agentPanel`, then report it as an issue.
- **Plain VS Code, Cursor and others.** Agent Bridge falls back to VS Code's chat. Some versions only fill in the chat box, so you press Enter.

## Safety & privacy

- Anything that can write to `.agent-inbox/` can talk to your agent. Only choose **Always for this project** where you trust everything that can write there, and don't combine auto-send with an agent that auto-runs terminal commands in shared or synced folders.
- The auto-send answer is stored on your machine, never in the repo, and `never` is ignored in workspace settings, so a cloned repo can't turn confirmation off.
- `onDoneCommand` is the only thing Agent Bridge runs. It's read only from your user settings, gets task details only as environment variables, and is off in untrusted workspaces.
- Agent Bridge makes no network requests and collects no telemetry. Everything stays in your project folder.
- Keep `.agent-inbox/` out of git (Agent Bridge offers to add it to `.gitignore`) and never put secrets in prompts.

## Known limits

- Antigravity support uses the internal command `antigravity.sendPromptToAgentPanel`, and quota detection reads Antigravity's internal conversation files. Neither is a public API, so an Antigravity update could break them.
- The done signal depends on the agent following the footer. Most do, not always. That's what the stuck warning is for.
- Multi-root workspaces use the first folder.

## More

- [Protocol](https://github.com/alokkkchaudharyyy/agent-bridge/blob/main/PROTOCOL.md): file formats for people writing orchestrators and scripts.
- [Changelog](https://github.com/alokkkchaudharyyy/agent-bridge/blob/main/CHANGELOG.md) · [Report an issue](https://github.com/alokkkchaudharyyy/agent-bridge/issues) · [Contributing](https://github.com/alokkkchaudharyyy/agent-bridge/blob/main/CONTRIBUTING.md)
- Offline install: every [GitHub release](https://github.com/alokkkchaudharyyy/agent-bridge/releases) has a `.vsix` file (Extensions → `⋯` → **Install from VSIX…**).

MIT licensed. Made by [@alokkkchaudharyyy](https://github.com/alokkkchaudharyyy).
