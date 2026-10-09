# Agent lessons

Mistakes found in code review. Agents: read this before every task and do not repeat them.
Format: - YYYY-MM-DD · area: mistake → rule

- 2026-10-09 · js: Used a new parameter (requestedId) in deliver() without adding it to the function signature; node --check passed but every send threw → When you start using a new argument, update the function signature and every call site, then exercise the code path, not just a syntax check.
- 2026-10-09 · hygiene: Left an untracked scratch_ext.js copy in the repo root → Delete scratch files before finishing; run git status and leave it clean.
