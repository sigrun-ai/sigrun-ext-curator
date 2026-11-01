/**
 * The targets step (`src/steps/targets.ts`, Task B4 — loop 2 step
 * `targets`, the pass's LAST step): run each maintain-capable curation
 * target's maintenance hook through `host.curation.maintain`, handing
 * it the tick's deadline and the REMAINING daily digest runs (the
 * budget the five model steps did not spend — the brief: "within the
 * remaining budget").
 *
 * The step itself spends nothing — the target's own `run` calls are
 * budgeted by the `runs` count it receives (one digest run each, per
 * the P6 contract), and a target that reports `more` keeps the rest for
 * the next pass. A failing target is logged and never blocks the others.
 */
import { type ModelStepDeps } from "./run.js";
/** The loop-2 targets step: maintain every maintain-capable target. */
export declare function maintainTargets(deps: ModelStepDeps): Promise<boolean>;
