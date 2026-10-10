# Agent lessons

Mistakes found in code review. Agents: read this before every task and do not repeat them.
Format: - YYYY-MM-DD · area: mistake → rule

- 2026-10-09 · js: Used a new parameter (requestedId) in deliver() without adding it to the function signature; node --check passed but every send threw → When you start using a new argument, update the function signature and every call site, then exercise the code path, not just a syntax check.
- 2026-10-09 · hygiene: Left an untracked scratch_ext.js copy in the repo root → Delete scratch files before finishing; run git status and leave it clean.
- 2026-10-09 · tests: Added a test/index.js shim so `node --test test/` worked, which silently ran only core tests → Fix the npm test script instead of adding shims, and check the test count goes up when you add a test file.
- 2026-10-10 · tests: Committed a timing-sensitive test after one passing run; it failed 1 in 4 runs alone → Run new timing-sensitive tests several times on their own before committing, and compare timestamps with a tolerance.
