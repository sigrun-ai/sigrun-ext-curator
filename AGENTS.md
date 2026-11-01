# AGENTS.md — sigrun-ext-curator

Guidance for coding agents working in this repository.

## What this is

The curator built-in extension for [sigrun](https://github.com/sigrun-ai/sigrun):
per-user curation loops over learned skills and curation targets — a fork
review after conversation activity (loop 1) and a scheduled idle maintenance
pass (loop 2, the `curator-tick` job over the `curator.tick` task).

A sigrun extension (pi-durable loader contract): a default-export factory
taking the `SigrunHost`, returning a `SigrunExtensionResult` (types from
`@sigrun/sigrun/extension`, a types-only subpath — never a runtime import).

## Layout

- `src/index.ts` — the factory (the loader contract).
- `src/settings.ts` — per-user `CuratorSettings` with defaults.
- `test/fake-host.ts` — the in-memory `SigrunHost` with a scriptable
  `curation` member (unit tests never boot sigrun core).
- `test/` — vitest suites.
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # check-manifest + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design (see the `.gitignore` comment). If
  `git status` shows `dist/` changes after a build, those belong in the
  same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- Tests own their literals: synthetic users (`alice`, `bob`), hosts
  (`*.example.invalid`), names under `acme/`; no real tokens or private
  URLs in fixtures.
- Host modules (`@earendil-works/*`) are peerDependencies; development
  pins exact 1.4.0 devDependencies.
