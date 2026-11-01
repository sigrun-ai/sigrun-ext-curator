/**
 * The review queues (`src/queue.ts`, Task B2):
 *
 * - `ReviewQueue` — one in-flight review PER USER, FIFO per user (a
 *   burst of settles on one user's conversations reviews in order,
 *   never concurrently; two users never serialize against each other).
 *   `onRunSettled` enqueues and returns; the queue owns the run. The
 *   auto-namer's pattern: a per-key promise chain, `idle()` for tests.
 * - `queueDigest` — the mixed-conversation spill: loop 1 never forks a
 *   shared conversation, it appends the id to the per-user
 *   `digest-queue.json` (state), and loop 2's digest step (Task B4)
 *   consumes the list. Dedup by conversation id — one pending entry per
 *   conversation, however many runs triggered it — with the taken
 *   hints merged into the entry (the decision took them read-and-clear;
 *   the digest run folds them into its instruction).
 * - the refunded-hints file (`pending-hints.json`) — the fix for the
 *   dropped-hints bug: `takeHints` is read-and-clear, so a review that
 *   ends failed / cancelled / deadline would otherwise lose its hints
 *   for good. Non-completed reviews write them back (refund, merged by
 *   hint id); the decision merges a conversation's refunded batch into
 *   every fresh take; a COMPLETED review (or a digest entry that takes
 *   ownership) clears the ids it consumed. The transfer is deliberately
 *   at-least-once: a crash between refund and clear duplicates a hint
 *   (dedup absorbs it), never drops one.
 *
 * Errors never break a chain: the queue's contract is that a job's
 * failure is the job's business (the loop records it); the chain keeps
 * draining.
 *
 * Every hints helper here dedups by hint id: a hint may briefly live in
 * two places (host + refund file, refund file + digest entry) around a
 * crash, and dedup makes the overlap harmless.
 */
import type { SigrunHost, CurationHint } from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
/** One queued review: the user it belongs to, and the work. */
export interface ReviewJob {
    /** The reviewed user — the one-in-flight key. */
    readonly user: string;
    /** The review body; must not throw (record failures inside). */
    readonly work: () => Promise<void>;
}
/**
 * The per-user FIFO review queue. `enqueue` never runs the work on the
 * caller's stack — it appends to the user's chain; `idle()` resolves
 * when NO user has work in flight or queued.
 */
export declare class ReviewQueue {
    /** One promise chain per user (the FIFO + the one-in-flight rule). */
    private readonly chains;
    /** Jobs not yet finished, across every user (the `idle()` counter). */
    private pending;
    /** Every live `idle()` waiter, released together at drain. */
    private waiters;
    /** Append one job to its user's chain. */
    enqueue(job: ReviewJob): void;
    /**
     * Resolve when every enqueued job has finished (immediately when
     * the queue is empty). Tests await this; production never does.
     */
    idle(): Promise<void>;
}
/**
 * Read one JSON state file with a fallback: absent or malformed → the
 * fallback value (state files are the loop's own bookkeeping — a bad
 * file degrades to defaults, never a broken loop).
 */
export declare function readStateJson<T>(file: string, fallback: T): Promise<T>;
/** Write one JSON state file under the user's state dir (tab indents). */
export declare function writeStateJson<T>(stateDir: string, name: string, value: T): Promise<void>;
/** The digest-queue file: pending mixed conversations, deduped by id. */
export interface DigestQueueFile {
    readonly conversations: readonly DigestQueueEntry[];
}
/** One pending digest: the conversation, with the hints it triggered on. */
export interface DigestQueueEntry {
    readonly id: ConversationId;
    readonly hints: readonly CurationHint[];
}
/**
 * Queue one conversation for loop 2's digest (Task B4 consumes): append
 * to `digest-queue.json` under the user's state dir, dedup by id, the
 * taken hints merged into the existing entry by hint id (never dropped).
 */
export declare function queueDigest(host: SigrunHost, user: string, conversationId: ConversationId, hints?: readonly CurationHint[]): Promise<void>;
/** Merge two hint batches into one, deduped by hint id. */
export declare function mergeHints(first: readonly CurationHint[], second: readonly CurationHint[]): readonly CurationHint[];
/** The hints refunded for one conversation (a read; nothing is cleared). */
export declare function pendingHintsFor(host: SigrunHost, user: string, conversationId: ConversationId): Promise<readonly CurationHint[]>;
/**
 * Refund: write a non-completed review's hints back, merged into the
 * conversation's refunded batch by hint id (never dropped, never
 * duplicated — an unchanged entry is not rewritten).
 */
export declare function refundHints(host: SigrunHost, user: string, conversationId: ConversationId, hints: readonly CurationHint[]): Promise<void>;
/**
 * Clear: drop the hint ids a consumer took ownership of (a completed
 * review, or a digest entry that persists them); the conversation's
 * entry leaves when it empties. An unknown id (e.g. a fresh hint that
 * was never refunded) is a no-op, and so is an untouched file.
 */
export declare function clearPendingHints(host: SigrunHost, user: string, conversationId: ConversationId, hints: readonly CurationHint[]): Promise<void>;
