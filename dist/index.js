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
 * - `runSettled` — loop 1's decision hook (one call per settled run;
 *   Task B2 implements the enqueue).
 * - `commands` — `/learn [focus]`: request a review of this
 *   conversation on demand (Task B5 implements the enqueue; the
 *   scaffold answers honestly that the request was noted).
 * - `ambientKinds` / `interactionKinds` — the seam's write-gate
 *   declarations: `curator.notice` (the post-review ambient notice) and
 *   `curator.overlay-question` (the unsure-overlay question).
 * - `surfaces` — the curator view (learned skills, overlays, the feed
 *   with per-review undo, the pause switch; Task B5 implements the
 *   rendering).
 *
 * Per-user settings (`src/settings.ts`) are read live per event through
 * the host's per-user scoped store — nothing is captured at factory time.
 */
import { defineExtension, defineTask } from "@earendil-works/pi-durable";
/** The durable task kind the tick job fires (TaskRecord.kind). */
export const CURATOR_TICK_TASK = "curator.tick";
/** The definition version persisted with the task. */
export const CURATOR_TICK_VERSION = 1;
/** The tick job's name (spec §5: every 15 minutes). */
export const CURATOR_TICK_JOB = "curator-tick";
/** The post-review ambient notice key (Task B5's display surface). */
export const CURATOR_NOTICE_KIND = "curator.notice";
/** The unsure-overlay question kind (Task B4's interaction). */
export const CURATOR_OVERLAY_QUESTION_KIND = "curator.overlay-question";
/**
 * Loop 2's durable body (Task B3 implements the pass; the scaffold's
 * phase commits terminal immediately — a fired tick is a completed tick
 * until the pass lands). One phase; the tick's own deadline is
 * self-imposed inside the pass.
 */
export function createTickTask(host) {
    void host; // The pass reads the host (Task B3); the scaffold does not.
    return defineTask({
        name: CURATOR_TICK_TASK,
        version: CURATOR_TICK_VERSION,
        initial: () => ({ phase: "tick" }),
        phases: {
            tick: async (_task, runtime, context) => {
                await runtime.commit(() => ({
                    status: "terminal",
                    outcome: { status: "completed", result: undefined },
                }), context);
            },
        },
        abort: async (_task, runtime, context) => {
            await runtime.commit(() => ({
                status: "terminal",
                outcome: { status: "aborted", reason: "job disabled or deleted" },
            }), context);
        },
    });
}
/**
 * `/learn [focus]` (Task B5 enqueues a review bypassing the threshold
 * but not eligibility; the scaffold notes the request). The command
 * runs with the invoking principal — its `user` is the owner the
 * review would learn for.
 */
export function createLearnCommand() {
    return {
        name: "learn",
        description: "Ask the curator to review this conversation now",
        args: "[focus]",
        run: async (ctx) => ({
            notice: ctx.args.length > 0
                ? `Curator review requested (focus: ${ctx.args}).`
                : "Curator review requested.",
        }),
    };
}
/**
 * The curator view (Task B5 renders skills, overlays, the feed and the
 * undo/pause actions; the scaffold declares the surface with its
 * placement so the id is claimable from day one).
 */
export const curatorView = {
    id: "curator",
    title: "Curator",
    icon: "book",
    placement: "view",
    render: async (ctx) => ({
        tree: {
            v: 1,
            root: {
                type: "page",
                title: "Curator",
                main: [
                    {
                        type: "markdown",
                        text: ctx.principal.user === undefined
                            ? "Sign in to see your curator activity."
                            : `Curator activity for ${ctx.principal.user}.`,
                    },
                ],
            },
        },
        data: {},
        access: ctx.principal.user === undefined ? "none" : "read",
    }),
};
/**
 * The sigrun extension-package factory: builds the curator's declared
 * surface over the host. One factory call, one wiring.
 */
export default function createCurator(host) {
    return {
        extension: defineExtension({
            name: "curator",
            tasks: [createTickTask(host)],
        }),
        // Loop 1's decision hook (Task B2 decides and enqueues; the
        // scaffold observes and returns — never work inside the hook
        // deadline).
        runSettled: async () => undefined,
        // Loop 2's cadence: the ONLY time-based scheduler (the worker
        // `every` is retired; jobs are the timer).
        jobs: [
            {
                name: CURATOR_TICK_JOB,
                schedule: { every: "15m" },
                action: { kind: "task", task: CURATOR_TICK_TASK },
            },
        ],
        commands: [createLearnCommand()],
        ambientKinds: [CURATOR_NOTICE_KIND],
        interactionKinds: [CURATOR_OVERLAY_QUESTION_KIND],
        surfaces: { views: [curatorView] },
    };
}
export { parseCuratorSettings, readSettings, DEFAULT_CURATOR_SETTINGS, } from "./settings.js";
