/**
 * `/learn [focus]` (`src/learn.ts`, Task B5): the foreground command
 * that asks for a review NOW — the same review loop 1 would run, but
 * bypassing the THRESHOLD (the user asked; no call-count gate stands
 * between them and a review) while keeping every ELIGIBILITY rule (an
 * internal conversation, or a conversation whose owner is not the
 * caller, still gets nothing).
 *
 * The command only ENQUEUES (loop 1's queue owns the review body —
 * the command's route deadline never bounds a review) and answers
 * `{notice}` naming what will happen:
 *
 * - owner-only conversation → "a curator review of this conversation
 *   will run now" (with the focus when given);
 * - a MIXED conversation (loop 1 would never fork it) → the answer
 *   says the curator only learns from the owner's own messages: the
 *   conversation goes to loop 2's digest queue, which reviews only
 *   the owner's attributed turns.
 *
 * The hint set folds in like every review (pending hints, refunded
 * batches), and `focus` rides the instruction (`reviewInstruction`).
 */
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { CurationHint, ExtensionCommandContribution, SigrunHost } from "@sigrun/sigrun/extension";
/** What {@link createLearnCommand} runs the request through (loop 1's
 *  `learnNow`, so the command and the settle hook share ONE review
 *  path). */
export type LearnNow = (conversationId: ConversationId, user: string, focus: string | undefined) => Promise<LearnOutcome>;
/** What `learnNow` answers: which path took the request. */
export type LearnOutcome = {
    readonly kind: "queued";
} | {
    readonly kind: "digest";
} | {
    readonly kind: "refused";
    readonly reason: string;
};
/**
 * The `/learn` command contribution, bound to the host and loop 1's
 * `learnNow`. Runs with the invoking principal: its `user` is the
 * owner the review would learn for.
 */
export declare function createLearnCommand(host: SigrunHost, learnNow: LearnNow): ExtensionCommandContribution;
/**
 * The `/learn` enqueue path, shared by the command and usable directly:
 * decide eligibility, then fork-queue or digest-queue — never running a
 * review on the caller's stack. Exported for loop 1 to expose as its
 * `learnNow` seam (the same decision tree the settle hook walks, minus
 * the threshold gate and the paused/enabled gates: `/learn` works while
 * paused — the vacation switch stops the LOOPS, not the user's own
 * explicit ask).
 */
export declare function enqueueLearn(host: SigrunHost, queue: {
    enqueue(job: {
        readonly user: string;
        readonly work: () => Promise<void>;
    }): void;
}, conversationId: ConversationId, user: string, focus: string | undefined, reviewBody: (owner: string, id: ConversationId, hints: readonly CurationHint[], newestEntry: EntryId | undefined, focus: string | undefined) => Promise<void>): Promise<LearnOutcome>;
/** The review id a `/learn`-triggered review runs under. */
export declare function learnReviewId(): string;
