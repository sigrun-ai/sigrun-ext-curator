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
