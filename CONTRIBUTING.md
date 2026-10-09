# Contributing to Agent Bridge

## Requirements

- Node.js 18+
- Python 3.8+ (for packaging)

## Project layout

- `src/core.js`: Pure helper logic (queue selection, prompt parsing, path resolution, lessons). No `vscode` imports. Thoroughly tested.
- `src/extension.js`: VS Code extension lifecycle, commands, status bar, and timer.
- `test/`: Unit tests using Node's built-in test runner (`node:test` and `node:assert/strict`).
- `scripts/pack.py`: Self-contained VSIX packager using Python standard libraries only.

## Development workflow

Run tests:
```bash
npm test
```

Build the VSIX package:
```bash
npm run package
```

This creates `agent-bridge-<version>.vsix` in the project root. To test it:
1. Open the Extensions view in VS Code or Antigravity.
2. Click the `...` menu in the top right corner.
3. Choose **Install from VSIX...** and select the built file.
4. Reload the window.

## Guidelines

- Keep `src/core.js` free of `vscode` dependencies so logic remains testable in plain Node.js.
- Add unit tests in `test/` for any new logic added to `src/core.js`.
- Keep pull requests small and focused.
- When reporting bugs, include relevant log lines from `.agent-inbox/bridge.log`.

## Releasing

Maintainers: see [docs/PUBLISHING.md](docs/PUBLISHING.md). Pushing a `v*` tag publishes automatically.
