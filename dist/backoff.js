/**
 * The per-user review backoff (`src/backoff.ts`, Task B2): a failed
 * review pauses THAT user's reviews on openclaw's ladder — 15, then
 * 30, then 60 minutes (spec §6.2) — so background curation never adds
 * to an already degraded provider. A success resets the ladder.
 *
 * In-memory by design (the plan's interface): the ladder protects the
 * provider, not the user's data, and a restart re-arms it clean.
 */
/** The ladder steps, in minutes (15 → 30 → 60). */
const STEPS_MINUTES = [15, 30, 60];
/**
 * The backoff ladder, per user. Every method takes `now` (the fake
 * clock seam) — the loop reads one clock for every decision.
 */
export class Backoff {
    users = new Map();
    /** Whether `user`'s reviews are paused at `now`. */
    blocked(user, now) {
        const state = this.users.get(user);
        if (state === undefined || state.unblockAt === undefined)
            return false;
        return now.getTime() < state.unblockAt;
    }
    /** Step the ladder: block `user` for 15, then 30, then 60 minutes. */
    failure(user, now) {
        const state = this.users.get(user) ?? { failures: 0 };
        const step = Math.min(state.failures, STEPS_MINUTES.length - 1);
        const minutes = STEPS_MINUTES[step];
        this.users.set(user, {
            failures: state.failures + 1,
            unblockAt: now.getTime() + minutes * 60_000,
        });
    }
    /** A success resets the ladder entirely. */
    success(user) {
        this.users.delete(user);
    }
}
