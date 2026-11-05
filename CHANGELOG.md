# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
