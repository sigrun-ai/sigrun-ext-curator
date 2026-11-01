# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- Scaffold: the `createCurator` factory (the loader contract) declaring the
  `curator` extension, the `curator-tick` job over the `curator.tick` task,
  the `/learn` command, the `curator.notice` ambient kind, the
  `curator.overlay-question` interaction kind, the curator view surface, and
  per-user settings (`enabled`, `paused`, `idleModel`, `threshold`,
  `dailyRuns`) read with defaults.
