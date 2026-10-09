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

Note: If `confirmBeforeSend` is on, a human must click Send before the receipt is written and the clock starts. Orchestrators should wait for `sent/<id>.json` before starting any timeouts.

## The footer text

If `completionSignal` is enabled, the bridge appends this footer to the prompt sent to the agent:

```markdown

---
**Task Completion Protocol**
When you have completely finished this task, you MUST write a JSON file to `.agent-inbox/done/task-42.json`.
The JSON must have this exact shape:
{
  "id": "task-42",
  "status": "done", // or "failed", or "blocked"
  "summary": "A short summary of what you did or why you failed",
  "commits": ["<commit-hash>"] // optional array of commit hashes if you made any
}
If you need to ask a question or need a human decision to proceed, write your question as a markdown file to `.agent-inbox/question/task-42.md`.
```

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

## Stuck

If no `done/` or `question/` file arrives within `stuckAfterMinutes` (default 30), the bridge warns the user. No file is written by the bridge.

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
