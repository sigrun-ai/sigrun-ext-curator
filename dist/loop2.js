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
import { join } from "node:path";
import { readStateJson, writeStateJson } from "./queue.js";
import { readSettings } from "./settings.js";
import { archiveUnused } from "./steps/archive.js";
import { detectOverlayDrift } from "./steps/overlays.js";
/**
 * The idle threshold (spec §5 pins SIGRUN_IDLE_THRESHOLD's default at
 * 10 minutes; the extension reads the semantics, not the env — the
 * host's activity seam already carries it).
 */
export const IDLE_THRESHOLD_MS = 600_000;
/**
 * The tick's self-imposed deadline: 5 minutes, well under the worker/
 * job deadline, so a pass fragment always outlives its own tick.
 */
export const LOOP2_TICK_DEADLINE_MS = 300_000;
/** The first-run grace: no pass until 24h after the first tick ever. */
export const FIRST_RUN_GRACE_MS = 24 * 60 * 60 * 1000;
/** How long a completed pass keeps its user ineligible. */
export const FULL_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The per-user pass-cursor file name (under the user's state dir). */
export const PASS_FILE = "pass.json";
/**
 * The extension-scope state file holding the install-wide first-tick
 * instant (the grace anchor). Chosen name; recorded here as the seam.
 */
export const FIRST_TICK_FILE = "loop2-first-tick.json";
/** One pass's step kinds, in run order (deterministic steps first). */
export const PASS_STEPS = [
    "archive",
    "overlay-detect",
    "overlay-recheck",
    "digests",
    "diet",
    "merge",
    "targets",
];
/** The step-queue kinds Task B4 owns (no-ops until it lands). */
const MODEL_STEPS = new Set([
    "overlay-recheck",
    "digests",
    "diet",
    "merge",
    "targets",
]);
/** The UTC calendar day of `at` (budget days are UTC). */
function dayOf(at) {
    return at.toISOString().slice(0, 10);
}
/** Read the install-wide first-tick instant; absent/malformed → none. */
async function readFirstTick(host) {
    const parsed = await readStateJson(join(host.stores.paths.state, FIRST_TICK_FILE), {});
    if (typeof parsed.firstTickAt !== "string")
        return undefined;
    const at = Date.parse(parsed.firstTickAt);
    return Number.isFinite(at) ? new Date(at) : undefined;
}
/** Record the install's first-tick instant (once — the grace anchor). */
async function writeFirstTick(host, at) {
    await writeStateJson(host.stores.paths.state, FIRST_TICK_FILE, {
        firstTickAt: at.toISOString(),
    });
}
/** Read one user's pass cursor; absent/malformed → none (a fresh pass). */
async function readPass(host, user) {
    const parsed = await readStateJson(join(host.stores.user(user).paths.state, PASS_FILE), {});
    const known = new Set(PASS_STEPS);
    if (typeof parsed.startedAt !== "string")
        return undefined;
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0)
        return undefined;
    if (!parsed.steps.every((step) => typeof step === "string" && known.has(step))) {
        return undefined;
    }
    if (typeof parsed.done !== "number" ||
        !Number.isInteger(parsed.done) ||
        parsed.done < 0 ||
        parsed.done > parsed.steps.length) {
        return undefined;
    }
    if (typeof parsed.dailyRunsUsed !== "number" ||
        !Number.isInteger(parsed.dailyRunsUsed) ||
        parsed.dailyRunsUsed < 0) {
        return undefined;
    }
    if (typeof parsed.day !== "string")
        return undefined;
    return {
        startedAt: parsed.startedAt,
        steps: parsed.steps,
        done: parsed.done,
        dailyRunsUsed: parsed.dailyRunsUsed,
        day: parsed.day,
    };
}
/** Persist one user's pass cursor (after every step — the resume point). */
async function writePass(host, user, cursor) {
    await writeStateJson(host.stores.user(user).paths.state, PASS_FILE, cursor);
}
/**
 * Whether the user is QUIET: their newest conversation activity is
 * older than the idle threshold. No activity at all is quiet. A live
 * run stamps activity at admission, so it is never quiet mid-run.
 */
async function isQuiet(host, user, now) {
    const conversations = await host.conversations.list({ owner: user });
    let newest;
    for (const conversation of conversations) {
        if (conversation.lastActivityAt === undefined)
            continue;
        const at = Date.parse(conversation.lastActivityAt);
        if (Number.isFinite(at) && (newest === undefined || at > newest)) {
            newest = at;
        }
    }
    return newest === undefined || now.getTime() - newest >= IDLE_THRESHOLD_MS;
}
/**
 * The users due for a pass (spec §6.2): quiet, settings on, past the
 * first-run grace, and without a completed pass in the last 24h. An
 * INCOMPLETE pass does not block — the next tick resumes it.
 */
export async function eligibleUsers(host, now) {
    const firstTick = await readFirstTick(host);
    if (firstTick === undefined)
        return []; // the grace never started
    const at = now();
    if (at.getTime() - firstTick.getTime() < FIRST_RUN_GRACE_MS)
        return [];
    const due = [];
    for (const row of await host.users.list()) {
        const settings = await readSettings(host, row.user);
        if (!settings.enabled || settings.paused)
            continue;
        if (!(await isQuiet(host, row.user, at)))
            continue;
        const pass = await readPass(host, row.user);
        if (pass !== undefined && pass.done >= pass.steps.length) {
            // A completed pass: due again only past its 24h window.
            if (at.getTime() - Date.parse(pass.startedAt) < FULL_PASS_INTERVAL_MS) {
                continue;
            }
        }
        due.push(row.user);
    }
    return due;
}
/**
 * Create loop 2: the tick the factory's task calls (a thin binding of
 * {@link tick} to its deps). The durable cadence stays the job's —
 * this creates no timers.
 */
export function createLoop2(deps) {
    const now = deps.now ?? (() => new Date());
    return {
        tick: () => tick(deps.host, now, { log: deps.log }),
    };
}
/**
 * One tick: as many pass fragments as fit before the 5-minute
 * self-deadline. Per-user failures are logged and never break the
 * tick — the cursor makes every user resumable.
 */
export async function tick(host, now, opts = {}) {
    const log = opts.log ?? ((message) => console.error(`curator: ${message}`));
    const startedAt = now();
    const firstTick = await readFirstTick(host);
    if (firstTick === undefined) {
        // The install instant: the grace window opens now, and no pass
        // runs before it ends (24h of quiet install first).
        await writeFirstTick(host, startedAt);
        return;
    }
    if (startedAt.getTime() - firstTick.getTime() < FIRST_RUN_GRACE_MS)
        return;
    const deadlineAt = startedAt.getTime() + LOOP2_TICK_DEADLINE_MS;
    for (const user of await eligibleUsers(host, now)) {
        if (now().getTime() >= deadlineAt)
            break;
        await runPass(host, user, now, deadlineAt, log).catch((error) => {
            log(`loop 2: pass for ${user} failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    }
}
/** The deterministic step bodies; model steps are Task B4's no-ops. */
const STEP_RUNNERS = {
    archive: archiveUnused,
    "overlay-detect": detectOverlayDrift,
};
/**
 * Walk one user's pass from its cursor: run steps while the tick's
 * deadline holds, persisting `done` after every step. The five model
 * steps complete as no-ops here (Task B4 gives them bodies — the
 * cursor already traverses them, so B4 needs no migration).
 */
async function runPass(host, user, now, deadlineAt, log) {
    const today = dayOf(now());
    let cursor = await readPass(host, user);
    if (cursor === undefined || cursor.done >= cursor.steps.length) {
        // No pass yet, or the previous pass completed (its 24h window is
        // why the user is eligible again): a fresh cursor from step one.
        cursor = {
            startedAt: now().toISOString(),
            steps: [...PASS_STEPS],
            done: 0,
            dailyRunsUsed: 0,
            day: today,
        };
        await writePass(host, user, cursor);
    }
    else if (cursor.day !== today) {
        // A new day re-arms the model-run budget mid-pass.
        cursor = { ...cursor, day: today, dailyRunsUsed: 0 };
        await writePass(host, user, cursor);
    }
    while (cursor.done < cursor.steps.length) {
        // Out of tick budget: stop BEFORE the next step — the cursor is
        // the resume point the next tick picks up.
        if (now().getTime() >= deadlineAt)
            return;
        const step = cursor.steps[cursor.done];
        const runner = STEP_RUNNERS[step];
        if (runner !== undefined) {
            try {
                await runner(host, user, now);
            }
            catch (error) {
                // The step failed; the pass moves on — a deterministic step
                // wedging the cursor forever would be worse than skipping it
                // this pass (idempotent steps make a later pass safe).
                log(`loop 2: ${user} step "${step}" failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        else if (!MODEL_STEPS.has(step)) {
            log(`loop 2: ${user} has no runner for step "${step}"`);
        }
        cursor = { ...cursor, done: cursor.done + 1 };
        await writePass(host, user, cursor);
    }
}
