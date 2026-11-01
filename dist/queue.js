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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * The per-user FIFO review queue. `enqueue` never runs the work on the
 * caller's stack — it appends to the user's chain; `idle()` resolves
 * when NO user has work in flight or queued.
 */
export class ReviewQueue {
    /** One promise chain per user (the FIFO + the one-in-flight rule). */
    chains = new Map();
    /** Jobs not yet finished, across every user (the `idle()` counter). */
    pending = 0;
    /** Every live `idle()` waiter, released together at drain. */
    waiters = [];
    /** Append one job to its user's chain. */
    enqueue(job) {
        const previous = this.chains.get(job.user) ?? Promise.resolve();
        this.pending += 1;
        const next = previous
            .then(job.work)
            .catch(() => undefined)
            .finally(() => {
            this.pending -= 1;
            if (this.chains.get(job.user) === next)
                this.chains.delete(job.user);
            if (this.pending === 0 && this.waiters.length > 0) {
                const waiters = this.waiters;
                this.waiters = [];
                for (const resolve of waiters)
                    resolve();
            }
        });
        this.chains.set(job.user, next);
    }
    /**
     * Resolve when every enqueued job has finished (immediately when
     * the queue is empty). Tests await this; production never does.
     */
    idle() {
        if (this.pending === 0)
            return Promise.resolve();
        return new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }
}
/** The digest-queue file name under the user's state dir. */
const DIGEST_QUEUE_FILE = "digest-queue.json";
/**
 * Read one JSON state file with a fallback: absent or malformed → the
 * fallback value (state files are the loop's own bookkeeping — a bad
 * file degrades to defaults, never a broken loop).
 */
export async function readStateJson(file, fallback) {
    let raw;
    try {
        raw = await readFile(file, "utf8");
    }
    catch {
        return fallback; // absent: never written
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return fallback;
    }
}
/** Write one JSON state file under the user's state dir (tab indents). */
export async function writeStateJson(stateDir, name, value) {
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, name), `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}
/** Read the digest queue's entries; absent/malformed → []. */
async function readDigestQueue(file) {
    const parsed = await readStateJson(file, {});
    if (!Array.isArray(parsed.conversations))
        return [];
    return parsed.conversations.filter((entry) => typeof entry === "object" &&
        entry !== null &&
        typeof entry.id === "number" &&
        Array.isArray(entry.hints));
}
/**
 * Queue one conversation for loop 2's digest (Task B4 consumes): append
 * to `digest-queue.json` under the user's state dir, dedup by id, the
 * taken hints merged into the existing entry by hint id (never dropped).
 */
export async function queueDigest(host, user, conversationId, hints = []) {
    const stateDir = host.stores.user(user).paths.state;
    const queue = [...(await readDigestQueue(join(stateDir, DIGEST_QUEUE_FILE)))];
    const existing = queue.find((entry) => entry.id === conversationId);
    if (existing === undefined) {
        queue.push({ id: conversationId, hints });
    }
    else {
        const seen = new Set(existing.hints.map((hint) => hint.id));
        const merged = [
            ...existing.hints,
            ...hints.filter((hint) => !seen.has(hint.id)),
        ];
        if (merged.length === existing.hints.length)
            return; // nothing new
        queue[queue.indexOf(existing)] = { id: conversationId, hints: merged };
    }
    await writeStateJson(stateDir, DIGEST_QUEUE_FILE, { conversations: queue });
}
/** The refunded-hints file name under the user's state dir. */
const PENDING_HINTS_FILE = "pending-hints.json";
/** Read the refunded-hints file; absent/malformed → []. */
async function readPendingHints(file) {
    const parsed = await readStateJson(file, []);
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((entry) => typeof entry === "object" &&
        entry !== null &&
        typeof entry.conversationId === "number" &&
        Array.isArray(entry.hints));
}
/** Merge two hint batches into one, deduped by hint id. */
export function mergeHints(first, second) {
    const seen = new Set(first.map((hint) => hint.id));
    return [...first, ...second.filter((hint) => !seen.has(hint.id))];
}
/** The hints refunded for one conversation (a read; nothing is cleared). */
export async function pendingHintsFor(host, user, conversationId) {
    const entries = await readPendingHints(join(host.stores.user(user).paths.state, PENDING_HINTS_FILE));
    return entries.find((entry) => entry.conversationId === conversationId)
        ?.hints ?? [];
}
/**
 * Refund: write a non-completed review's hints back, merged into the
 * conversation's refunded batch by hint id (never dropped, never
 * duplicated — an unchanged entry is not rewritten).
 */
export async function refundHints(host, user, conversationId, hints) {
    if (hints.length === 0)
        return;
    const stateDir = host.stores.user(user).paths.state;
    const entries = [
        ...(await readPendingHints(join(stateDir, PENDING_HINTS_FILE))),
    ];
    const existing = entries.find((entry) => entry.conversationId === conversationId);
    if (existing === undefined) {
        entries.push({ conversationId, hints });
    }
    else {
        const merged = mergeHints(existing.hints, hints);
        if (merged.length === existing.hints.length)
            return; // nothing new
        entries[entries.indexOf(existing)] = {
            conversationId,
            hints: merged,
        };
    }
    await writeStateJson(stateDir, PENDING_HINTS_FILE, entries);
}
/**
 * Clear: drop the hint ids a consumer took ownership of (a completed
 * review, or a digest entry that persists them); the conversation's
 * entry leaves when it empties. An unknown id (e.g. a fresh hint that
 * was never refunded) is a no-op, and so is an untouched file.
 */
export async function clearPendingHints(host, user, conversationId, hints) {
    const stateDir = host.stores.user(user).paths.state;
    const entries = [
        ...(await readPendingHints(join(stateDir, PENDING_HINTS_FILE))),
    ];
    const index = entries.findIndex((entry) => entry.conversationId === conversationId);
    if (index === -1)
        return; // nothing refunded: no entry to clear
    const consumed = new Set(hints.map((hint) => hint.id));
    const remaining = entries[index].hints.filter((hint) => !consumed.has(hint.id));
    if (remaining.length === entries[index].hints.length)
        return; // untouched
    if (remaining.length === 0)
        entries.splice(index, 1);
    else
        entries[index] = { conversationId, hints: remaining };
    await writeStateJson(stateDir, PENDING_HINTS_FILE, entries);
}
