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
 *
 * Errors never break a chain: the queue's contract is that a job's
 * failure is the job's business (the loop records it); the chain keeps
 * draining.
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
