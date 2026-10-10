# Agent Bridge Completion Protocol

Agent Bridge allows an orchestrator (a human, a script, or another AI) to send tasks to an IDE agent and wait for a response.

## Folder layout tree

```
.agent-inbox/
├── prompt.md
├── NNN.prompt.md
├── archive/
├── sent/
│   └── <id>.json
├── done/
│   └── <id>.json
├── question/
│   └── <id>.md
└── bridge.log
```

## Task ids

You can set an explicit task id by including a header on the first line of your prompt:
`<!-- id: task-42 -->`

Rules:
- Letters, digits, `.`, `_`, `-`
- Max 64 characters
- Must start with a letter or digit
- Can be placed before or after the `<!-- new-conversation -->` marker

If you do not provide an id, the bridge generates one like `20261009-1830-a1b2`.
**Recommendation**: Orchestrators should always set their own id to track the task reliably.

## sent/ receipts

When the bridge successfully sends your prompt to the agent, it writes a receipt to `sent/<id>.json`:

```json
{
  "id": "task-42",
  "file": "prompt.md",
  "sentAt": "2026-10-09T18:30:00.000Z",
  "via": "antigravity",
  "chars": 150,
  "completionSignal": true
}
```

Note: unless auto-send is on for the project ("Always for this project", or `confirmBeforeSend: never` in user settings), someone must click Send before the receipt is written and the clock starts. Orchestrators should wait for `sent/<id>.json` before starting any timeouts.

## The footer text

If `completionSignal` is on, the bridge appends this footer (example for id `task-42` in `D:\Code\my-app`):

```text
---
Agent Bridge task id: task-42
When you have completely finished this task, as your very last action create this file (use exactly this absolute path, not a path relative to any workspace folder): D:\Code\my-app\.agent-inbox\done\task-42.json
It must contain JSON like: {"id": "task-42", "status": "done", "summary": "<one or two sentences>", "commits": ["<sha>"]}
Use status "failed" if you could not complete it, or "blocked" if something outside your control stopped you.
If you are blocked or need a decision, instead write D:\Code\my-app\.agent-inbox\question\task-42.md (exactly this absolute path) explaining what you need, then stop and wait.
```

The paths are always **absolute**. In a multi-root workspace a relative path could be resolved against the wrong folder, and the bridge would never see the file.

## done/<id>.json shape

The agent must write `done/<id>.json` with the following shape:

```json
{
  "id": "task-42",
  "status": "done",
  "summary": "Added the /health endpoint and tested it.",
  "commits": ["a1b2c3d"]
}
```

- Valid statuses: `"done"`, `"failed"`, `"blocked"`. (Unknown statuses are shown as "unknown").
- The filename id wins if it mismatches the JSON id.

## question/<id>.md

The agent can write free Markdown to `question/<id>.md`.
After the orchestrator or human answers, they should send a new prompt (you can reuse the same id).

### Quota stops (Antigravity)

When the Antigravity agent stops on a model quota error ("Individual quota reached"), it writes nothing. With `detectQuotaErrors` on (default `auto`: on inside Antigravity), the bridge spots the error in Antigravity's conversation files and writes the question file itself:

```text
status: blocked
reason: quota
resets: 2026-10-09T22:17:26.000Z
detected: 2026-10-09T21:12:04.000Z
message: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h5m26s
```

Orchestrators should check the first lines: on `reason: quota`, wait until `resets`, then resume. Either send a new prompt with the same id, or ask the user to run **Agent Bridge: Resend last prompt with 'continue'**. A resend reuses the id and moves the old question file to `archive/`.

This reads Antigravity's internal conversation files (`~/.gemini/antigravity-ide/conversations/*.db`), read-only. That format isn't a public API and may change. If it does, detection silently stops working, and the stuck warning is the fallback.

## Queue hold

With `waitForDone` on (default), the bridge sends the next queued `*.prompt.md` only after the previous task has a `done/` or `question/` file, or has passed the stuck timeout. **Agent Bridge: Send next now** skips the wait once. Orchestrators can queue several prompts and let the bridge pace them.

## Stuck

If no `done/` or `question/` file arrives within `stuckAfterMinutes` (default 20), the bridge warns the user and shows the last log lines. It also releases the queue hold. No file is written.

## onDoneCommand env vars

If `onDoneCommand` is configured, it receives these environment variables:

| Variable | Description |
| --- | --- |
| `AGENT_BRIDGE_EVENT` | `done`, `question`, or `stuck` |
| `AGENT_BRIDGE_ID` | The task id |
| `AGENT_BRIDGE_STATUS` | The status from the done JSON, or `question` / `stuck` |
| `AGENT_BRIDGE_FILE` | The path to the done/question file (empty for stuck) |
| `AGENT_BRIDGE_SUMMARY` | The summary from the done JSON, or the question text preview |
| `AGENT_BRIDGE_INBOX` | The absolute path to the `.agent-inbox` folder |

## Example orchestrator loop

Bash:
```bash
INBOX=.agent-inbox
ID="task-$(date +%Y%m%d-%H%M%S)"

# Use .tmp then rename so the bridge only sees the completed file
printf '<!-- id: %s -->\n%s\n' "$ID" "Add a /health endpoint, test it, and commit." > "$INBOX/$ID.tmp"
mv "$INBOX/$ID.tmp" "$INBOX/$ID.prompt.md"

# Wait for completion
until [ -f "$INBOX/done/$ID.json" ] || [ -f "$INBOX/question/$ID.md" ]; do
  sleep 10
done

cat "$INBOX/done/$ID.json" 2>/dev/null || cat "$INBOX/question/$ID.md"
```

PowerShell:
```powershell
$INBOX = ".agent-inbox"
$ID = "task-$(Get-Date -Format 'yyyyMMdd-HHmmss')"

"<!-- id: $ID -->`nAdd a /health endpoint, test it, and commit." | Set-Content "$INBOX/$ID.tmp"
Move-Item "$INBOX/$ID.tmp" "$INBOX/$ID.prompt.md"

while (-not (Test-Path "$INBOX/done/$ID.json") -and -not (Test-Path "$INBOX/question/$ID.md")) {
  Start-Sleep 10
}

if (Test-Path "$INBOX/done/$ID.json") { Get-Content "$INBOX/done/$ID.json" }
if (Test-Path "$INBOX/question/$ID.md") { Get-Content "$INBOX/question/$ID.md" }
```

## Lessons file

`AGENT_LESSONS.md` (setting `agentBridge.lessonsFile`) holds durable rules learned from reviews, one per line:

```markdown
- YYYY-MM-DD · area: mistake → rule
```

How the bridge uses it (`agentBridge.lessonsMode`):

| Mode | Effect on every sent prompt |
| --- | --- |
| `reference` (default) | Adds one line asking the agent to read the lessons file first. |
| `inline` | Pastes the newest lessons into the prompt (up to ~4000 characters). |
| `off` | Nothing. |

Nothing is added while the file has no `- ` lines. The command **Agent Bridge: Add lesson** appends an entry interactively and skips duplicates.

Rules for whoever writes lessons (usually the reviewing agent):

- One line per real mistake that could happen again, with a concrete rule. No lessons for one-off typos.
- No duplicates. Keep the file under ~50 lines by merging or removing stale entries.
- The model is not retrained. It is reminded of these rules on every prompt.
