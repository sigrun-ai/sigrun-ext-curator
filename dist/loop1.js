/**
 * Loop 1 — the post-run fork review (`src/loop1.ts`, Task B2, spec
 * §6.2).
 *
 * `onRunSettled` DECIDES and ENQUEUES, then returns: runSettled
 * handlers are abandoned at `SIGRUN_HOOK_DEADLINE` (30 s), so the
 * review body NEVER runs on the handler's stack — it runs through the
 * per-user `ReviewQueue`.
 *
 * The decision tree (the brief, verbatim authority):
 *
 * 1. owner present, settings enabled and not paused, not backed off —
 *    else return (the hints are left pending, never consumed by a
 *    review that will not run);
 * 2. an internal conversation returns (the bus already withholds
 *    internal settles; this read-side gate is the belt);
 * 3. `eligibility.ownerOnly && unattributed === 0` → the fork path:
 *    take the hints (read-and-clear), count
 *    `modelCallsSince(id, lastReviewedEntry)`, and review when hints
 *    are pending (answered or not — an aborted run's hints stay
 *    pending until the next settle) or the run answered at/over the
 *    threshold;
 * 4. anything else (mixed authorship, unattributed entries) → the
 *    threshold trigger alone queues a `queueDigest` entry: never
 *    forked, handed to loop 2 (Task B4). (Hints are NOT taken on
 *    this branch — `takeHints` is read-and-clear and the digest run
 *    is their consumer, so they stay pending until Task B4 takes
 *    them; a destructively-taken hint with no consumer would be
 *    dropped.)
 *
 * The review itself: the allow-list is `skill_manage` + the served
 * targets' tools + `read` when the parent's selection carries it; the
 * bounds are the spec's (8 tool calls, 2048 output tokens, 2 minutes);
 * a watch on the parent aborts the run's signal the moment the parent
 * moves. Success anchors the per-conversation cursor
 * (`cursors.json`) at the eligibility snapshot's newest entry; a
 * failed run steps that user's backoff ladder.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { reviewInstruction } from "./prompts.js";
import { queueDigest, readStateJson, writeStateJson } from "./queue.js";
import { readSettings } from "./settings.js";
/** The per-conversation cursor file under the user's state dir. */
export const CURSORS_FILE = "cursors.json";
/** The fork-review bounds (spec §6.2: a handful of calls, small output, ~2 minutes). */
export const LOOP1_MAX_TOOL_CALLS = 8;
export const LOOP1_MAX_OUTPUT_TOKENS = 2048;
export const LOOP1_DEADLINE_MS = 120_000;
/**
 * Create loop 1: the `runSettled` handler the factory wires. The
 * handler owns only the decision; the queue owns the review.
 */
export function createLoop1(deps) {
    const now = deps.now ?? (() => new Date());
    const log = deps.log ?? ((message) => console.error(`curator: ${message}`));
    const onRunSettled = async (event) => {
        const owner = event.owner;
        if (owner === undefined)
            return;
        const id = event.conversationId;
        const settings = await readSettings(deps.host, owner);
        if (!settings.enabled || settings.paused)
            return;
        if (deps.backoff.blocked(owner, now()))
            return;
        const eligibility = await deps.host.curation.eligibility(id);
        if (eligibility.internal)
            return;
        if (eligibility.ownerOnly && eligibility.unattributed === 0) {
            await enqueueForkReview(owner, id, event, eligibility.newestEntry, settings.threshold);
        }
        else {
            // Mixed authorship: never forked, whatever triggered us — loop
            // 2's digest step (Task B4) reviews only the owner's turns.
            // The same trigger gates both routes: hints (taken read-and-clear,
            // merged into the queued entry so the digest run folds them in)
            // or an answered run at/over the threshold (the cursor never
            // advances on this branch, so that is "ever" — what a backlog
            // wants).
            const hints = await deps.host.curation.takeHints(id);
            if (hints.length === 0) {
                if (event.outcome.status !== "answered")
                    return;
                const cursors = await readCursors(deps.host, owner);
                const calls = await deps.host.curation.modelCallsSince(id, cursors.lastReviewedEntry[String(id)]);
                if (calls < settings.threshold)
                    return;
            }
            await queueDigest(deps.host, owner, id, hints);
        }
    };
    /**
     * Trigger evaluation for one owner-only conversation: hints always
     * fire; otherwise the run must have answered at/over the threshold.
     */
    async function enqueueForkReview(owner, id, event, newestEntry, threshold) {
        // Hints first (read-and-clear): a review triggered by them always
        // runs, so a taken hint is never dropped; when there are none,
        // only the threshold can fire and nothing was consumed.
        const hints = await deps.host.curation.takeHints(id);
        if (hints.length === 0) {
            if (event.outcome.status !== "answered")
                return;
            const cursors = await readCursors(deps.host, owner);
            const calls = await deps.host.curation.modelCallsSince(id, cursors.lastReviewedEntry[String(id)]);
            if (calls < threshold)
                return;
        }
        deps.queue.enqueue({
            user: owner,
            work: () => runForkReview(owner, id, hints, newestEntry).catch((error) => {
                log(`loop 1: review of conversation ${String(id)} failed: ${error instanceof Error ? error.message : String(error)}`);
            }),
        });
    }
    /** The review body (queue-owned; never on the handler's stack). */
    async function runForkReview(owner, id, hints, newestEntry) {
        const targets = await deps.host.curation.targets(owner, id);
        const selection = await deps.host.curation.tools(id);
        const allow = [
            ...new Set([
                "skill_manage",
                ...targets.flatMap((target) => [...target.tools]),
                ...(selection.includes("read") ? ["read"] : []),
            ]),
        ];
        const instruction = reviewInstruction({
            hints,
            targets: targets.map((target) => ({
                id: target.id,
                guidance: [...target.guidance],
            })),
            allow,
        });
        // The parent abort: any activity on the parent while the review
        // runs fires the signal — the review reviews the conversation it
        // saw (the host-side driver re-checks the same state itself).
        const abort = new AbortController();
        const stopWatch = await deps.host.conversations.watch(id, () => {
            abort.abort();
        });
        let result;
        try {
            result = await deps.host.curation.forkReview(id, {
                instruction,
                allow,
                maxToolCalls: LOOP1_MAX_TOOL_CALLS,
                maxOutputTokens: LOOP1_MAX_OUTPUT_TOKENS,
                deadlineMs: LOOP1_DEADLINE_MS,
                reviewId: `review-${randomUUID()}`,
                signal: abort.signal,
            });
        }
        finally {
            await stopWatch();
        }
        if (result.status === "completed") {
            deps.backoff.success(owner);
            // Anchor the next count at what this review covered. An absent
            // newestEntry cannot anchor anything — the next review counts
            // everything, an extra review at worst.
            if (newestEntry !== undefined) {
                await writeCursor(deps.host, owner, id, newestEntry);
            }
        }
        else if (result.status === "failed") {
            deps.backoff.failure(owner, now());
        }
        // cancelled (the parent moved) and deadline land nothing: the
        // next settle re-evaluates from the same cursor.
    }
    return { onRunSettled };
}
/** Read the per-user cursors file (absent or malformed → empty). */
async function readCursors(host, user) {
    const raw = await readStateJson(join(host.stores.user(user).paths.state, CURSORS_FILE), { lastReviewedEntry: {} });
    // Harden the shape before anyone writes through it: only a plain
    // object of conversation-id keys → integer entries is a cursor map.
    const entries = raw?.lastReviewedEntry;
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
        return { lastReviewedEntry: {} };
    }
    const lastReviewedEntry = {};
    for (const [key, value] of Object.entries(entries)) {
        if (typeof value === "number" && Number.isInteger(value)) {
            lastReviewedEntry[key] = value;
        }
    }
    return { lastReviewedEntry };
}
/** Write one conversation's anchor into the cursors file. */
async function writeCursor(host, user, id, entry) {
    const cursors = await readCursors(host, user);
    cursors.lastReviewedEntry[String(id)] = entry;
    await writeStateJson(host.stores.user(user).paths.state, CURSORS_FILE, cursors);
}
