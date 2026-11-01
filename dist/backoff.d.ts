/**
 * The per-user review backoff (`src/backoff.ts`, Task B2): a failed
 * review pauses THAT user's reviews on openclaw's ladder — 15, then
 * 30, then 60 minutes (spec §6.2) — so background curation never adds
 * to an already degraded provider. A success resets the ladder.
 *
 * In-memory by design (the plan's interface): the ladder protects the
 * provider, not the user's data, and a restart re-arms it clean.
 */
/**
 * The backoff ladder, per user. Every method takes `now` (the fake
 * clock seam) — the loop reads one clock for every decision.
 */
export declare class Backoff {
    private readonly users;
    /** Whether `user`'s reviews are paused at `now`. */
    blocked(user: string, now: Date): boolean;
    /** Step the ladder: block `user` for 15, then 30, then 60 minutes. */
    failure(user: string, now: Date): void;
    /** A success resets the ladder entirely. */
    success(user: string): void;
}
