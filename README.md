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

## What you see

Mostly nothing. When a review CHANGES something, a **notice** appears
in your notices (a `Learned: …` title naming the change, tied to the
originating conversation) with two buttons: **Review** opens the
**Curator** view anchored at the review, and **Undo** — after a
confirm — reverts every change that review made (the notice never
lands in the transcript, so forks never replay it, and it is never
pushed to a notifier or chat channel).

The **Curator** view (per user; only your own data ever renders) lists

- **Learned skills** — name, description, last used, with a pin toggle
  and archive/restore on each;
- **Overlays** — your notes on upstream skills, flagged `orphaned`
  when the upstream vanished;
- **The change feed** — the newest 50 changes, grouped by review, each
  group with an **Undo review** button that reverts every change that
  review made (and clears its notice);
- a **pause switch** — `Pause curation` stops both loops for you
  without disabling anything else; the view and `/learn` keep working
  while paused.

Undo is one click from the notice itself (the notice's **Undo** action
runs the extension's declared notice-action handler); the view's
per-review **Undo review** does the same from the feed.

## `/learn [focus]`

`/learn` asks for a review of the conversation NOW — bypassing the
call-count threshold but keeping every eligibility rule. In a
conversation with other participants the answer says so and the
owner's hints are queued; the digest reviews the OWNER'S attributed
turns only — another participant's words never enter it. Focus, when
given, rides the review's instruction. `/learn` works
while paused: the pause switch stops the automatic loops, not your
own explicit ask.

This package is a sigrun built-in: sigrun core ships and loads it by
default (`builtinExtensions.curator: false` disables it). It is not
useful outside sigrun.
