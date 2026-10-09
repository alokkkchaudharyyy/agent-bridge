# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
