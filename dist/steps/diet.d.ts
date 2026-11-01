/**
 * The skill-diet step (`src/steps/diet.ts`, Task B4 — loop 2 step
 * `diet`): ONE oversized learned skill per pass is rewritten so its
 * `##` sections move out to `references/` files verbatim (openclaw's
 * diet), and a SECOND model run compares old and new and answers
 * `{"loss": false}` — anything else (a reported loss, or an unparseable
 * answer) undoes the rewrite through `skills.undo`, so no unverified
 * diet ever stands.
 *
 * Eligibility (the brief): a learned skill whose SKILL.md is > 12 KB
 * and unchanged for 24h — "unchanged" reads the skill store's feed: the
 * newest curator/agent-authored entry for the skill must be older than
 * 24h (a skill with no feed entry at all counts as its creation, so a
 * freshly created giant waits a day before its first diet).
 *
 * The runs: the FIRST carries the full SKILL.md and instructs the
 * move-to-references rewrite (the run performs it through its allowed
 * `skill_manage` tool — `write_file` under `references/` plus the
 * trimmed patch); the SECOND carries old and new side by side and asks
 * only the fixed JSON loss answer. Both are ordinary budget-spending
 * digest runs on the idle model.
 */
import { type ModelStepDeps } from "./run.js";
/** The diet threshold (the brief: > 12 KB). */
export declare const DIET_BYTES: number;
/** How long a skill must be unchanged before a diet (the brief: 24h). */
export declare const DIET_UNCHANGED_MS: number;
/** The loop-2 diet step: diet at most one eligible skill. */
export declare function dietStep(deps: ModelStepDeps): Promise<boolean>;
