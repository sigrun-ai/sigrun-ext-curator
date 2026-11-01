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
const STEPS_MINUTES: readonly number[] = [15, 30, 60];

/** Per-user backoff state: the next step index and the unblock instant. */
interface BackoffState {
	/** How many failures this user has stacked (capped at the ladder top). */
	failures: number;
	/** When the current block lifts (epoch ms); `undefined` = not blocked. */
	unblockAt?: number;
}

/**
 * The backoff ladder, per user. Every method takes `now` (the fake
 * clock seam) — the loop reads one clock for every decision.
 */
export class Backoff {
	private readonly users = new Map<string, BackoffState>();

	/** Whether `user`'s reviews are paused at `now`. */
	blocked(user: string, now: Date): boolean {
		const state = this.users.get(user);
		if (state === undefined || state.unblockAt === undefined) return false;
		return now.getTime() < state.unblockAt;
	}

	/** Step the ladder: block `user` for 15, then 30, then 60 minutes. */
	failure(user: string, now: Date): void {
		const state = this.users.get(user) ?? { failures: 0 };
		const step = Math.min(state.failures, STEPS_MINUTES.length - 1);
		const minutes = STEPS_MINUTES[step];
		this.users.set(user, {
			failures: state.failures + 1,
			unblockAt: now.getTime() + minutes * 60_000,
		});
	}

	/** A success resets the ladder entirely. */
	success(user: string): void {
		this.users.delete(user);
	}
}
