# Agent Bridge

Let scripts, schedulers, or another AI agent send prompts into your IDE's AI agent chat by writing a file.

![Agent Bridge demo](media/demo.gif)
<!-- TODO: record demo.gif -->

## What it does

- Watches `<workspace>/.agent-inbox/` for incoming prompt files.
- Processes `prompt.md` first, or a queue of files like `001.prompt.md`, `002.prompt.md` in numeric name order (one file per poll).
- Asks for confirmation before sending each prompt (enabled by default).
- Sends prompts to Antigravity's agent panel, with a fallback to VS Code chat.
- Supports a lessons file so the agent learns from review and avoids repeating past mistakes.

Agent Bridge only types text into your IDE's agent chat. It never runs commands itself.

## Install

### Open VSX
Search for "Agent Bridge" in the Extensions view of Antigravity, VSCodium, or Cursor, then click Install.

### From VSIX
1. Download `agent-bridge-0.2.0.vsix` from [GitHub Releases](https://github.com/alokkkchaudharyyy/agent-bridge/releases).
2. Open the Extensions view in your IDE.
3. Click the `...` menu in the top right corner of the Extensions view.
4. Select **Install from VSIX...** and choose the downloaded file.
5. Reload the window.

## Quick start (60 seconds)

1. Open a folder in your IDE.
2. Look for "Agent Bridge: watching" in the status bar.
3. Accept the prompt offering to add `.agent-inbox/` to `.gitignore`.
4. Create `.agent-inbox/prompt.md` with a line of text.
5. Click **Send** in the confirmation dialog.
6. Watch your prompt appear in the agent chat.

Sent files move automatically to `.agent-inbox/archive/`.

## Use it from any AI agent or script

You can pair external tools with your IDE agent. For example, Claude Code can write task prompts, the IDE agent builds them, and a reviewer checks the results.

### Instructions to give your agent

Copy and paste this into your agent's instructions:

```markdown
Write your prompt as Markdown to `<workspace>/.agent-inbox/prompt.md`.
To queue multiple prompts, use zero-padded names like `001.prompt.md`, `002.prompt.md`.
Write the full file in one go (write to a temporary file first and rename it, if you can).
Start the file with `<!-- new-conversation -->` to begin a fresh conversation.
Never write into `.agent-inbox/archive/`.
Check `.agent-inbox/bridge.log` to confirm it was sent.
```

### Shell examples

Bash:
```bash
echo "Refactor auth helper functions in src/auth.js" > .agent-inbox/prompt.md
```

PowerShell:
```powershell
"Refactor auth helper functions in src/auth.js" | Set-Content .agent-inbox/prompt.md
```

## Lessons: make the agent learn from review

You can record review feedback in `AGENT_LESSONS.md` in the root of your workspace. Each lesson is recorded on a single line in this format:

```markdown
- YYYY-MM-DD · area: mistake → rule
```

Configure how lessons are attached using the `agentBridge.lessonsMode` setting:
- `reference` (default): appends one line asking the agent to read `AGENT_LESSONS.md`.
- `inline`: pastes the newest lessons directly into each prompt (up to ~4000 characters).
- `off`: disables lesson reminders.

You can also use the **Agent Bridge: Add lesson** command from the Command Palette to record a new lesson interactively.

### Instructions to give your reviewing agent

Copy and paste this into your reviewing agent's instructions:

```markdown
After reviewing the IDE agent's work, check for real mistakes that could happen again.
For each mistake, append one line to `AGENT_LESSONS.md` using this format:
- YYYY-MM-DD · area: mistake → rule

Rules:
- Record one lesson per mistake, with a concrete rule.
- Do not add duplicates.
- Do not add lessons for one-off typos.
- Keep the file under approximately 50 lines by merging or removing stale ones.
```

Note: The model is not retrained. It is reminded of past review rules before each task.

## Commands

| Command | What it does |
| --- | --- |
| `Agent Bridge: Send current file as prompt` | Sends the active file directly to the agent chat without confirmation. |
| `Agent Bridge: Pause/Resume` | Toggles queue polling on or off. |
| `Agent Bridge: Open log` | Opens `.agent-inbox/bridge.log` in the editor. |
| `Agent Bridge: Add lesson` | Prompts for area, mistake, and rule, then appends to `AGENT_LESSONS.md`. |

Clicking the status bar item also opens `.agent-inbox/bridge.log`.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `agentBridge.inboxPath` | `""` | Folder to watch for prompts. Empty = `<workspace>/.agent-inbox`. Relative paths are resolved against the first workspace folder. |
| `agentBridge.pollIntervalMs` | `4000` | How often to check the inbox folder for new prompt files (in milliseconds). Minimum is 1000. |
| `agentBridge.confirmBeforeSend` | `true` | Ask before sending each prompt. **Keep this on** unless you trust everything that can write to the inbox. |
| `agentBridge.newConversationMarker` | `"<!-- new-conversation -->"` | If a prompt file starts with this, a new agent conversation is started first. Empty = disabled. |
| `agentBridge.lessonsFile` | `"AGENT_LESSONS.md"` | Lessons file (relative to the workspace or absolute) that reviewers append mistakes to. |
| `agentBridge.lessonsMode` | `"reference"` | How to include review lessons in prompts sent to the agent (`reference`, `inline`, or `off`). |

## Safety

> Anything that can write to the inbox can talk to your agent. Do NOT turn off confirmBeforeSend while your agent is allowed to auto-run terminal commands, especially on a machine or folder others can write to (shared drives, synced folders, CI). Keep the inbox out of git (the .gitignore offer does this).

## Known limits

- Relies on the internal Antigravity command `antigravity.sendPromptToAgentPanel`, which is not a public API and may change.
- In plain VS Code, the fallback uses `workbench.action.chat.open`, which in some versions only prefills the chat instead of sending.
- Multi-root workspaces use the first workspace folder.
- Polling (default 4 seconds), not instant.

## Troubleshooting

- **Check logs**: Check `.agent-inbox/bridge.log` or click the status bar item to inspect details.
- **"no supported agent chat found"**: Neither Antigravity nor VS Code chat commands exist in the current environment.
- **Status stuck on error**: Read the log, then run `Developer: Reload Window`.
- **Nothing happens**: Make sure the file name is exactly `prompt.md` or ends in `.prompt.md`, and that the bridge is not paused.
- **Files modified recently**: Files modified in the last ~1.5s are skipped until writing finishes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and project layout.

## License

[MIT](LICENSE)
