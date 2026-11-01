# @sigrun/ext-curator

The curator built-in extension for
[sigrun](https://github.com/sigrun-ai/sigrun): per-user curation loops
over learned skills and curation targets.

- **Loop 1 — fork review.** After a settled run in an owned conversation
  (threshold model calls since the last review, or pending review hints),
  the curator forks the conversation at its newest entry and drives a
  bounded review run whose writes land in the owner's learned-skill
  store.
- **Loop 2 — idle pass.** The `curator-tick` job (every 15 minutes)
  walks idle users through a resumable pass: archiving unused skills,
  re-checking drifted overlays, digesting conversations, dieting and
  merging skills, and running target maintenance.

Per-user settings (via the user's scoped settings store) control it:
`enabled` (default true), `paused` (default false), `idleModel`,
`threshold` (default 10), `dailyRuns` (default 12). `/learn [focus]`
requests a review on demand; the curator view lists skills, overlays and
the change feed with per-review undo.

This package is a sigrun built-in: sigrun core ships and loads it by
default (`builtinExtensions.curator: false` disables it). It is not
useful outside sigrun.
