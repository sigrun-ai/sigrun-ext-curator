# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
