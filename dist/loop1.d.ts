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
 *    run's hints stay pending until the next settle), the run answered
 *    at/over the threshold, or a served target asks (`wantsReview`,
 *    consulted only below the threshold on an answered run);
 * 4. anything else (mixed authorship, unattributed entries) → the
 *    threshold trigger alone queues a `queueDigest` entry: never
 *    forked, handed to loop 2 (Task B4). (Hints ride in that durable
 *    entry — taken read-and-clear and folded into the digest run's
 *    instruction by Task B4 — and the refund file drains into it, so
 *    no hint can wait on both.)
 *
 * The review itself: the allow-list is `skill_manage` + the served
 * targets' tools and read tools + `read` when the parent's selection
 * carries it; the
 * bounds are the spec's (8 tool calls, 2048 output tokens, 2 minutes);
 * a watch on the parent aborts the run's signal the moment the parent
 * moves. Success anchors the per-conversation cursor
 * (`cursors.json`) at the eligibility snapshot's newest entry; a
 * failed run steps that user's backoff ladder; any NON-completed
 * outcome (failed, cancelled, deadline — or a thrown review) refunds
 * its hints to `pending-hints.json`, so a consumed-but-unreviewed
 * hint survives until some review completes with it in hand.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExtensionRunSettledHandler, SigrunHost } from "@sigrun/sigrun/extension";
import { Backoff } from "./backoff.js";
import { type LearnOutcome } from "./learn.js";
/** The per-conversation cursor file under the user's state dir. */
export declare const CURSORS_FILE = "cursors.json";
/** The fork-review bounds (spec §6.2: a handful of calls, small output, ~2 minutes). */
export declare const LOOP1_MAX_TOOL_CALLS = 8;
export declare const LOOP1_MAX_OUTPUT_TOKENS = 2048;
export declare const LOOP1_DEADLINE_MS = 120000;
/** What {@link createLoop1} needs (all but `now` are required). */
export interface Loop1Deps {
    readonly host: SigrunHost;
    /** The per-user review queue — the handler never runs a review itself. */
    readonly queue: {
        enqueue(job: {
            readonly user: string;
            readonly work: () => Promise<void>;
        }): void;
    };
    /** The per-user failure ladder this loop steps. */
    readonly backoff: Backoff;
    /** The clock every backoff decision reads (tests fake it). */
    readonly now?: () => Date;
    /** One line per unexpected error; defaults to `console.error`. */
    readonly log?: (message: string) => void;
}
/**
 * Create loop 1: the `runSettled` handler the factory wires, and the
 * `learnNow` seam `/learn` runs the same review path through. The
 * handler owns only the decision; the queue owns the review.
 */
export declare function createLoop1(deps: Loop1Deps): {
    readonly onRunSettled: ExtensionRunSettledHandler;
    readonly learnNow: (conversationId: ConversationId, user: string, focus: string | undefined) => Promise<LearnOutcome>;
};
