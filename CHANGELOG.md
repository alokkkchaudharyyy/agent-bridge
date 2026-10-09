# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
