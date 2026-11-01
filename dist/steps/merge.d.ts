/**
 * The merge step (`src/steps/merge.ts`, Task B4 — loop 2 step `merge`):
 * ONE pair of learned skills a run judges same-class merges — the run
 * patches the survivor and the step archives the other with
 * `absorbed_into` naming the survivor (the spec's merge shape).
 *
 * The verdict (`{"merge": ["a","b"], "survivor": "a"}`) is the run's
 * final text in the fixed JSON shape. It must name exactly two KNOWN,
 * unarchived, learned skills with a known survivor among them —
 * anything else (unparseable text, unknown names, a mismatched
 * survivor) changes nothing, and a run that already wrote through its
 * tools is reverted with `undoReview` (an unverified merge never
 * stands, mirroring the diet's compare rule).
 */
import { type ModelStepDeps } from "./run.js";
/** The loop-2 merge step: at most one judged merge per pass. */
export declare function mergeStep(deps: ModelStepDeps): Promise<boolean>;
