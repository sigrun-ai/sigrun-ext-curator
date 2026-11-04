/**
 * Loop 2 — the scheduled idle maintenance pass (`src/loop2.ts`, Task
 * B3, spec §6.2).
 *
 * Clocked by the `curator-tick` job (the only time-based scheduler);
 * each fired task runs {@link tick} once, and a tick does AT MOST one
 * pass-fragment: every user's pass is a small resumable queue of
 * steps with a durable cursor (`pass.json` under the user's state
 * dir), so a tick interrupted at its self-imposed 5-minute deadline
 * leaves the cursor pointing at the next step and the NEXT tick
 * resumes exactly there. Nothing depends on finishing in one go.
 *
 * The eligibility gate ({@link eligibleUsers}, spec): a user is due
 * when they are QUIET — the newest `lastActivityAt` across their
 * conversations is older than the idle threshold. "No live run" rides
 * the same clock: activity is stamped at submission admission AND at
 * run settlement (core's activity seam), so a user with a live run is
 * never past the idle threshold — the recency check observes it. A
 * user with no activity at all (never used, or quiet since before the
 * seam existed) is quiet too. Plus: settings enabled and not paused,
 * no full pass in the last 24h, and past the install's first-run
 * grace (the FIRST tick instant + 24h, recorded once in the
 * extension's own state — the grace is install-wide, per spec: "no
 * pass until one full interval after install").
 *
 * The cursor (`PassCursor`): `steps` is the pass's queue, `done` how
 * many steps finished (persisted after EVERY step — that is the
 * resume point), `dailyRunsUsed`/`day` the per-user model-run budget
 * Task B4's model steps spend (a calendar day rollover re-arms it).
 *
 * The step table: B3 owns the two deterministic steps (`archive`,
 * `overlay-detect`); the five model steps are declared in the queue
 * and run as no-ops here — Task B4 fills them in.
 */
import type { SigrunHost } from "@sigrun/sigrun/extension";
/**
 * The idle threshold (spec §5 pins SIGRUN_IDLE_THRESHOLD's default at
 * 10 minutes; the extension reads the semantics, not the env — the
 * host's activity seam already carries it).
 */
export declare const IDLE_THRESHOLD_MS = 600000;
/**
 * The tick's self-imposed deadline: 5 minutes, well under the worker/
 * job deadline, so a pass fragment always outlives its own tick.
 */
export declare const LOOP2_TICK_DEADLINE_MS = 300000;
/** The per-user sweep marker (notices Task 9): present → the one-time
 *  ambient-notice migration already ran for this user. */
export declare const NOTICES_MIGRATED_FILE = "notices-migrated.json";
/** The first-run grace: no pass until 24h after the first tick ever. */
export declare const FIRST_RUN_GRACE_MS: number;
/** How long a completed pass keeps its user ineligible. */
export declare const FULL_PASS_INTERVAL_MS: number;
/** The per-user pass-cursor file name (under the user's state dir). */
export declare const PASS_FILE = "pass.json";
/**
 * The extension-scope state file holding the install-wide first-tick
 * instant (the grace anchor). Chosen name; recorded here as the seam.
 */
export declare const FIRST_TICK_FILE = "loop2-first-tick.json";
/** One pass's step kinds, in run order (deterministic steps first). */
export declare const PASS_STEPS: readonly ["archive", "overlay-detect", "overlay-recheck", "digests", "diet", "merge", "targets"];
/** A pass step's kind (the cursor's queue entries). */
export type StepId = (typeof PASS_STEPS)[number];
/** The durable per-user pass cursor (the resume point). */
export interface PassCursor {
    /** When this pass started (ISO); the 24h window anchors here. */
    readonly startedAt: string;
    /** The step queue, in run order. */
    readonly steps: readonly StepId[];
    /** How many steps have finished — the next tick resumes at `steps[done]`. */
    readonly done: number;
    /** Model runs spent today (Task B4 decrements the budget). */
    readonly dailyRunsUsed: number;
    /** The UTC day the budget counts against (`YYYY-MM-DD`). */
    readonly day: string;
}
/** What {@link tick} accepts (all optional). */
export interface TickOptions {
    /** One line per unexpected error; defaults to `console.error`. */
    readonly log?: (message: string) => void;
}
/**
 * The users due for a pass (spec §6.2): quiet, settings on, past the
 * first-run grace, and without a completed pass in the last 24h. An
 * INCOMPLETE pass does not block — the next tick resumes it.
 */
export declare function eligibleUsers(host: SigrunHost, now: () => Date): Promise<readonly string[]>;
/** What {@link createLoop2} needs (all but `host` are optional). */
export interface Loop2Deps {
    /** The host the pass reads. */
    readonly host: SigrunHost;
    /** The clock every gate and step reads (tests fake it). */
    readonly now?: () => Date;
    /** One line per unexpected error; defaults to `console.error`. */
    readonly log?: (message: string) => void;
}
/**
 * Create loop 2: the tick the factory's task calls (a thin binding of
 * {@link tick} to its deps). The durable cadence stays the job's —
 * this creates no timers.
 */
export declare function createLoop2(deps: Loop2Deps): {
    readonly tick: () => Promise<void>;
};
/**
 * One tick: as many pass fragments as fit before the 5-minute
 * self-deadline. Per-user failures are logged and never break the
 * tick — the cursor makes every user resumable.
 */
export declare function tick(host: SigrunHost, now: () => Date, opts?: TickOptions): Promise<void>;
