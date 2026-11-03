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
 *    take the hints (read-and-clear) merged with any refunded batch
 *    (`pending-hints.json` — hints a previous review consumed but
 *    never reviewed), count `modelCallsSince(id, lastReviewedEntry)`,
 *    and review when hints are pending (answered or not — an aborted
 *    run's hints stay pending until the next settle) or the run
 *    answered at/over the threshold;
 * 4. anything else (mixed authorship, unattributed entries) → the
 *    threshold trigger alone queues a `queueDigest` entry: never
 *    forked, handed to loop 2 (Task B4). (Hints ride in that durable
 *    entry — taken read-and-clear and folded into the digest run's
 *    instruction by Task B4 — and the refund file drains into it, so
 *    no hint can wait on both.)
 *
 * The review itself: the allow-list is `skill_manage` + the served
 * targets' tools + `read` when the parent's selection carries it; the
 * bounds are the spec's (8 tool calls, 2048 output tokens, 2 minutes);
 * a watch on the parent aborts the run's signal the moment the parent
 * moves. Success anchors the per-conversation cursor
 * (`cursors.json`) at the eligibility snapshot's newest entry; a
 * failed run steps that user's backoff ladder; any NON-completed
 * outcome (failed, cancelled, deadline — or a thrown review) refunds
 * its hints to `pending-hints.json`, so a consumed-but-unreviewed
 * hint survives until some review completes with it in hand.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { notify } from "./notices.js";
import { enqueueLearn } from "./learn.js";
import { reviewInstruction } from "./prompts.js";
import { clearPendingHints, mergeHints, pendingHintsFor, queueDigest, readStateJson, refundHints, writeStateJson, } from "./queue.js";
import { readSettings } from "./settings.js";
/** The per-conversation cursor file under the user's state dir. */
export const CURSORS_FILE = "cursors.json";
/** The fork-review bounds (spec §6.2: a handful of calls, small output, ~2 minutes). */
export const LOOP1_MAX_TOOL_CALLS = 8;
export const LOOP1_MAX_OUTPUT_TOKENS = 2048;
export const LOOP1_DEADLINE_MS = 120_000;
/**
 * Create loop 1: the `runSettled` handler the factory wires, and the
 * `learnNow` seam `/learn` runs the same review path through. The
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
            const hints = mergeHints(await pendingHintsFor(deps.host, owner, id), await deps.host.curation.takeHints(id));
            if (hints.length === 0) {
                if (event.outcome.status !== "answered")
                    return;
                const cursors = await readCursors(deps.host, owner);
                const calls = await deps.host.curation.modelCallsSince(id, cursors.lastReviewedEntry[String(id)]);
                if (calls < settings.threshold)
                    return;
            }
            await queueDigest(deps.host, owner, id, hints);
            // The digest entry is durable and owns these ids now — drain the
            // refund file so a later owner-only settle cannot re-fire them.
            // After the write, never before: a crash in between duplicates a
            // hint into two durable places (queueDigest dedups by id), it
            // never drops one.
            await clearPendingHints(deps.host, owner, id, hints);
        }
    };
    /**
     * Trigger evaluation for one owner-only conversation: hints always
     * fire; otherwise the run must have answered at/over the threshold.
     */
    async function enqueueForkReview(owner, id, event, newestEntry, threshold) {
        // Hints first (read-and-clear), merged with anything a previous
        // non-completed review refunded for this conversation (dedup by
        // hint id): a hint stays pending across failures until some
        // review actually completes with it in hand. When the merged set
        // is empty, only the threshold can fire and nothing was consumed.
        const hints = mergeHints(await pendingHintsFor(deps.host, owner, id), await deps.host.curation.takeHints(id));
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
            work: () => runForkReview(owner, id, hints, newestEntry, undefined, `review-${randomUUID()}`).catch((error) => {
                log(`loop 1: review of conversation ${String(id)} failed: ${error instanceof Error ? error.message : String(error)}`);
            }),
        });
    }
    /** The review body (queue-owned; never on the handler's stack). */
    async function runForkReview(owner, id, hints, newestEntry, focus, reviewId) {
        try {
            await reviewBody(owner, id, hints, newestEntry, focus, reviewId);
        }
        catch (error) {
            // The body threw before any outcome was recorded (a host read,
            // the watch, the run itself): the hints were no more consumed
            // than the run was — refund them, then let the queue's logger
            // have the error. A refund that itself fails must not mask the
            // original error.
            await refundHints(deps.host, owner, id, hints).catch(() => undefined);
            throw error;
        }
    }
    /** The review proper, factored out of {@link runForkReview}'s refund guard. */
    async function reviewBody(owner, id, hints, newestEntry, focus, reviewId) {
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
            ...(focus === undefined ? {} : { focus }),
        });
        // The parent abort: CHURN on the parent while the review runs
        // fires the signal — the review reviews the conversation it saw
        // (the host-side driver re-checks the same state itself). The
        // watch's first frame is the acquisition snapshot (the baseline),
        // never churn; only a frame carrying MORE model entries than the
        // baseline means the parent actually moved. A re-rendered view
        // (a status refresh at the same entry count) is not churn and
        // must not kill an in-flight review (the coarse-abort ruling).
        const abort = new AbortController();
        let baseline;
        const stopWatch = await deps.host.conversations.watch(id, (view) => {
            const count = view.entries.length;
            if (baseline === undefined) {
                baseline = count; // the snapshot is the baseline, never churn
                return;
            }
            if (count > baseline)
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
                reviewId,
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
            // The review consumed these hints for good — clear their
            // refunded ids so a later settle cannot re-fire on them.
            await clearPendingHints(deps.host, owner, id, hints);
            // Task B5: announce the changes (no changes → no notice). The
            // notice is isolated: a failing setAmbient or ledger write
            // degrades to a missing notice — never a thrown body, which the
            // refund guard would answer with a phantom refund of an
            // already-applied review (re-reviewing learned material).
            await notify(deps.host, id, owner, { ...result, reviewId }).catch((error) => {
                log(`loop 1: notice after the review of conversation ${String(id)} could not be set: ${error instanceof Error ? error.message : String(error)}`);
            });
        }
        else {
            if (result.status === "failed")
                deps.backoff.failure(owner, now());
            // No review happened for these hints (provider failure, the
            // parent moving, or the deadline): refund them — the host was
            // cleared at decision time, so the refund file is the only
            // place they survive; the next settle merges them back in.
            await refundHints(deps.host, owner, id, hints);
        }
    }
    /** `/learn`'s seam (Task B5): the same review path minus the
     *  threshold gate — eligibility still decides, and a mixed
     *  conversation goes to the digest queue with the mixed-conversation
     *  notice. The paused/enabled gates deliberately do NOT apply: the
     *  vacation switch stops the loops, not the user's explicit ask. */
    const learnNow = (conversationId, user, focus) => enqueueLearn(deps.host, deps.queue, conversationId, user, focus, (owner, id, hints, newestEntry, reviewFocus) => runForkReview(owner, id, hints, newestEntry, reviewFocus, `learn-${randomUUID()}`).catch((error) => {
        log(`loop 1: /learn review of conversation ${String(id)} failed: ${error instanceof Error ? error.message : String(error)}`);
    }));
    return { onRunSettled, learnNow };
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
