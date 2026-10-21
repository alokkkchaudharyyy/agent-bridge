# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-10-21

### Added
- **Copy orchestrator prompt** command: copies the setup prompt for Claude Code, Codex, Gemini CLI etc. with this project's absolute paths filled in. No more editing `{PROJECT_PATH}` by hand.
- **Status-bar menu**: clicking *Agent Bridge* shows the current task, the queue, and the actions that make sense right now.
- **Open inbox folder** command.
- A one-time welcome notification after install that points to the orchestrator prompt.
- `agentBridge.archiveRetentionDays` (default 30): old files in `archive/` and `sent/` are cleaned up. `done/` and `question/` are never deleted.

### Changed
- The inbox is created lazily. Projects that never use the bridge no longer get an `.agent-inbox/` folder or a `.gitignore` question; the status bar shows *idle* until something creates the folder.
- `bridge.log` is rotated to `bridge.log.1` past 1 MB.
- README rewritten for the extension page inside the IDE (absolute links, no mermaid).

### Fixed
- With two windows on the same folder, a prompt already sent by the other window is skipped quietly instead of showing an error.

## [0.3.2] - 2026-10-10

### Added
- **Queue hold** (`agentBridge.waitForDone`, default on): the next queued `*.prompt.md` waits until the previous task has a `done/` or `question/` file, or passes the stuck timeout. The status bar shows "waiting for <id>". New command **Agent Bridge: Send next now** skips the wait once.
- **Quota stop detection** for Antigravity (`agentBridge.detectQuotaErrors`, default `auto` = on inside Antigravity): when the agent stops on "Individual quota reached", the bridge writes `question/<id>.md` with `status: blocked`, `reason: quota` and the reset time, so orchestrators don't wait blindly. It reads Antigravity's internal conversation files read-only (format may change). `agentBridge.conversationsPath` overrides their location.
- Commands **Agent Bridge: Resend last prompt** and **Resend last prompt with 'continue'**: they reuse the task id and archive an old question file, so the task counts as open again.

### Changed
- Stuck warning: default 20 minutes (was 30), and it shows the last log lines.

## [0.3.1] - 2026-10-09

### Fixed
- Completion footer now uses the **absolute** inbox path for `done/` and `question/`. In multi-root workspaces the agent could resolve the old relative path against the wrong folder, so the bridge never saw the done file.
- The lessons reminder (`lessonsMode: reference`) also points at the absolute lessons file path.

### Changed
- `agentBridge.confirmBeforeSend` is now `"auto" | "always" | "never"`, default `"auto"`: the first prompt in a project asks once ("Always for this project" / "Ask each time" / "View prompt") and the answer is remembered per project. Old `true` / `false` values still work as `always` / `never`.
- `never` is only honored from user settings, so a workspace's `.vscode/settings.json` can't switch confirmation off.

### Added
- Command **Agent Bridge: Reset auto-send choice**.
- Tests for multi-root footer paths and the first-time auto-send choice.

## [0.3.0] - 2026-10-09

### Added
- task ids (generated or via <!-- id: --> header)
- completion footer + completionSignal setting
- sent/ receipts
- done/ and question/ watcher with notifications and status bar
- stuck detection + stuckAfterMinutes
- onDoneCommand hook (user settings only, env vars, untrusted-workspace restricted)
- PROTOCOL.md
- tests

## [0.2.0] - 2026-10-09

### Added
- Workspace inbox watching with `agentBridge.inboxPath` setting.
- Automatic `.gitignore` offer for the inbox folder.
- `confirmBeforeSend` confirmation dialog with Send, Discard, and View options.
- `*.prompt.md` numbered file queue support with numeric sorting (`prompt.md` prioritized).
- Status bar item with current status and quick link to log.
- Commands: `sendCurrentFile`, `togglePause`, `openLog`, and `addLesson`.
- VS Code chat fallback (`workbench.action.chat.open`) when Antigravity panel is unavailable.
- Lessons support with `AGENT_LESSONS.md`, `lessonsMode` setting, and `Add lesson` command.
- Extension configuration settings.
- Unit test suite for core logic using Node's built-in test runner.

### Changed
- Sent files are moved to `.agent-inbox/archive/` instead of renamed in place.
- Marker line (`<!-- new-conversation -->`) is stripped before sending prompt body.
- Replaced hard-coded inbox path with workspace-relative path resolution.

## [0.0.1]

- Initial private prototype.
