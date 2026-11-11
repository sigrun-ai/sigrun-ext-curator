# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] - 2026-11-11

### Added

- The idle-model setting declares the chat model kind, and every curator
  setting now has a title for generated settings forms.

## [0.3.5] - 2026-11-08

- CI: grant actions: read to the release workflow (the release-test skip lookup). No code change.

## [0.3.4] - 2026-11-08

### Changed

- Clicking a review in the change feed opens the review page instead of
  undoing it; undo is an explicit **Undo review** button in a callout with a
  confirm. The review page lists the review's changes (learned-store rows
  open the skill in core Skills; overlay rows explain they open from Skills),
  shows the undone state with a pointer back to Skills, and a deep link older
  than the recent changes keeps its undo. `undoReview` now requires the
  `review` view param (the notice's Undo action is unchanged). The restore
  path requires sigrun core with the Skills restore fix (core 0.11.2).

## [0.3.3] - 2026-11-07

## [0.4.0] - 2026-11-09

### Changed

- Settings are declared as a JSON Schema (user schema) via
  `host.settings.declare` and rendered as generated forms on the extension's
  settings page; the hand-written settings parser is gone. Raises the
  `@sigrun/sigrun` peer floor to the settings-rework core.
- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).

## [0.3.2] - 2026-11-06

### Added

- `curator-tick` now carries a description ("The curator's idle pass: every 15 minutes it reviews
  learned skills and memory for each user."), shown as its subtitle in the Jobs view (requires
  sigrun core with `JobSpec.description`).

### Fixed

- `test/fake-host.ts` implements the host members core 0.9.0 added (`jobs.activeRun`/`isJobRun`,
  `models.complete`, `declineInteraction`, `decisions.*`) — the release typecheck's 2 documented
  pre-existing errors, which first blocked a release here (the v0.3.1 tag burned on them; 0.3.1
  never reached npm).
- Loop-2 digest reviews: served targets' read tools join the digest
  allow list (the same merge loop 1's fork reviews made), so a digest
  review of the knowledge target can call `knowledge_find` and the
  find-before-creating de-dup guidance is achievable on that path.

## [0.3.0] - 2026-11-04
### Changed
- The post-review "Learned: …" notice moved from the conversation's
  ambient record to sigrun's core per-user notices: `notify` posts one
  keyed notice (`review:<reviewId>`) through `host.notices.post` with
  an **Undo** extension action (the new `noticeActions.undoReview`
  factory handler, behind a confirm prompt) and a **Review** navigate
  action to the curator view. The view's undo now clears the notice by
  key; the per-user notices ledger file is gone (core's notice store
  owns durability). The `curator.notice` ambient kind stays declared
  while the tick's one-time sweep clears pre-move ambient notices
  (marker `notices-migrated.json` per user).

## [0.2.0] - 2026-11-03
### Changed
- The curator view follows core Skills: the learned-skills and overlays
  sections are gone (the core `core/skills` view owns them), replaced by
  a "Skills" page action that navigates to the Skills tab. The view keeps
  the review feed, the pause switch, and the memory targets.
- The feed is git-backed: entry ids are commit SHAs, `actor` includes
  `outside` (rendered "outside sigrun"), undo groups key on the newest
  commit of a review, and a deep-linked `review` param filters the feed
  (paging up to three feed pages to find older reviews). Undo resolves
  the group sha back to the review id before dispatching; a failing undo
  is a named action error, never a thrown action.

## [0.1.1] - 2026-11-03
### Fixed
- Curator questions about your skill notes now open their own conversation
  instead of landing in your latest one; unanswered questions no longer
  accumulate. Questions asked before this version stay answerable where they
  were asked.
- A review in flight is no longer cancelled by a re-rendered conversation
  view; only genuinely new activity on the parent aborts it.

## [0.1.0] - 2026-11-02
### Added
- Scaffold: the `createCurator` factory (the loader contract) declaring the
  `curator` extension, the `curator-tick` job over the `curator.tick` task,
  the `/learn` command, the `curator.notice` ambient kind, the
  `curator.overlay-question` interaction kind, the curator view surface, and
  per-user settings (`enabled`, `paused`, `idleModel`, `threshold`,
  `dailyRuns`) read with defaults.
- Loop 2: the idle maintenance pass — the `curator.tick` task running one
  resumable pass fragment per fired tick (a durable per-user step cursor
  under a 5-minute self-deadline), the eligibility gate (quiet user, no
  full pass in 24h, first-run grace), and the deterministic steps:
  archiving skills unused for 30 days (pinned and job-referenced spared)
  and reaping overlays orphaned for 30 days; overlay drift detection
  queues changed upstreams for re-check.
