/**
 * sigrun-ext-curator: the curator factory (the loader contract).
 *
 * The sigrun extension-package contract (sigrun's src/harness/loader.ts):
 * the default export is a FACTORY DECLARING the host parameter (arity 1 —
 * the host rule), called once at boot, before `Harness.open` reads the
 * registry. The factory registers handlers only — no timers, no I/O in
 * the factory body (the lifecycle rule); the loops start through their
 * own surfaces (the settled-run handler and the job's task).
 *
 * What the scaffold declares (Task B1; the behaviors land with their
 * tasks):
 *
 * - `extension` — `defineExtension({ name: "curator", tasks: [tickTask] })`:
 *   the name is the loader slug; the task is the durable body the job
 *   fires.
 * - `jobs` — `curator-tick`, `every: "15m"` (spec §5 pins the interval),
 *   `action: { kind: "task", task: "curator.tick" }` — jobs are the only
 *   time-based scheduler, so loop 2's cadence is a job, never a timer.
 * - `runSettled` — loop 1's decision hook (Task B2): decides on settle
 *   and enqueues a review; the review itself runs on the per-user
 *   queue, never inside the hook deadline.
 * - `commands` — `/learn [focus]`: enqueue a loop 1 review of this
 *   conversation now, bypassing the threshold but not eligibility
 *   (Task B5).
 * - `ambientKinds` / `interactionKinds` — the seam's write-gate
 *   declarations: `curator.notice` (the post-review ambient notice) and
 *   `curator.overlay-question` (the unsure-overlay question).
 * - `surfaces` — the curator view: learned skills (pin,
 *   archive/restore), overlays, the feed grouped by review with undo,
 *   and the pause switch (Task B5).
 *
 * Per-user settings (`src/settings.ts`) are read live per event through
 * the host's per-user scoped store — nothing is captured at factory time.
 */
import type { AnyTask } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
/** The durable task kind the tick job fires (TaskRecord.kind). */
export declare const CURATOR_TICK_TASK = "curator.tick";
/** The definition version persisted with the task. */
export declare const CURATOR_TICK_VERSION = 1;
/** The tick job's name (spec §5: every 15 minutes). */
export declare const CURATOR_TICK_JOB = "curator-tick";
/** The post-review ambient notice key (Task B5's display surface). */
export declare const CURATOR_NOTICE_KIND = "curator.notice";
/** The unsure-overlay question kind (Task B4's interaction). */
export declare const CURATOR_OVERLAY_QUESTION_KIND = "curator.overlay-question";
/**
 * Loop 2's durable body (Task B3): one phase calling `tick(host, now)`
 * — as many pass fragments as the tick's own 5-minute deadline
 * allows; unfinished steps resume on the next fired tick through the
 * per-user pass cursor (`pass.json`). The scaffold's terminal-commit
 * shape stays: whatever the pass did, the task phase itself only
 * runs the tick and completes.
 */
export declare function createTickTask(host: SigrunHost): AnyTask;
export { createLearnCommand } from "./learn.js";
export type { LearnNow, LearnOutcome } from "./learn.js";
export { createCuratorView, viewAccess, groupFeed, VIEW_FEED_LIMIT } from "./view.js";
export type { CuratorViewData } from "./view.js";
/**
 * The sigrun extension-package factory: builds the curator's declared
 * surface over the host. One factory call, one wiring. The constructed
 * loop-1 state (the review queue, the backoff ladder) is plain memory
 * the handlers use — no timers, no I/O run here.
 */
export default function createCurator(host: SigrunHost): SigrunExtensionResult;
export { declareSettings, readSettings } from "./settings.js";
export { CURATOR_USER_SCHEMA } from "./settings-schema.js";
export { notify, reviewNoticeKey } from "./notices.js";
export type { CuratorSettings } from "./settings.js";
export { createLoop1, CURSORS_FILE, LOOP1_MAX_TOOL_CALLS, LOOP1_MAX_OUTPUT_TOKENS, LOOP1_DEADLINE_MS, } from "./loop1.js";
export type { Loop1Deps } from "./loop1.js";
export { enqueueLearn, learnReviewId } from "./learn.js";
export { createLoop2, eligibleUsers, tick, IDLE_THRESHOLD_MS, LOOP2_TICK_DEADLINE_MS, FIRST_RUN_GRACE_MS, FULL_PASS_INTERVAL_MS, PASS_FILE, PASS_STEPS, FIRST_TICK_FILE, NOTICES_MIGRATED_FILE, } from "./loop2.js";
export type { StepId, PassCursor, TickOptions, Loop2Deps } from "./loop2.js";
export { archiveUnused, ARCHIVE_UNUSED_DAYS, ARCHIVE_UNUSED_MS, } from "./steps/archive.js";
export { detectOverlayDrift, OverlayRecheckQueue, RECHECK_QUEUE_FILE, recheckOverlays, overlayQuestionHandler, } from "./steps/overlays.js";
export { digestsStep, reviewDigest, DIGEST_VIEW_GRACE_MS } from "./steps/digests.js";
export { dietStep, DIET_BYTES, DIET_UNCHANGED_MS } from "./steps/diet.js";
export { mergeStep } from "./steps/merge.js";
export { maintainTargets } from "./steps/targets.js";
export { digestRunWithBudget, parseVerdict, MODEL_STEP_MAX_TOOL_CALLS, MODEL_STEP_MAX_OUTPUT_TOKENS, } from "./steps/run.js";
export type { ModelStepDeps, RunBudget, DigestRun, DigestRunInput } from "./steps/run.js";
export { Backoff } from "./backoff.js";
export { ReviewQueue, queueDigest, readDigestQueue, removeDigestEntry, } from "./queue.js";
export type { ReviewJob } from "./queue.js";
export { reviewInstruction } from "./prompts.js";
export type { ReviewInstructionOpts } from "./prompts.js";
