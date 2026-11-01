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

import { randomUUID } from "node:crypto";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type {
	CurationHint,
	ExtensionCommandContribution,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import {
	clearPendingHints,
	mergeHints,
	pendingHintsFor,
	queueDigest,
} from "./queue.js";
import { reviewInstruction } from "./prompts.js";

/** What {@link createLearnCommand} runs the request through (loop 1's
 *  `learnNow`, so the command and the settle hook share ONE review
 *  path). */
export type LearnNow = (
	conversationId: ConversationId,
	user: string,
	focus: string | undefined,
) => Promise<LearnOutcome>;

/** What `learnNow` answers: which path took the request. */
export type LearnOutcome =
	| { readonly kind: "queued" }
	| { readonly kind: "digest" }
	| { readonly kind: "refused"; readonly reason: string };

/** The command's `{notice}` for each outcome (the wording is pinned by
 *  the tests only in the mixed case; the queued wording names focus). */
function noticeFor(outcome: LearnOutcome, focus: string | undefined): string {
	switch (outcome.kind) {
		case "queued": {
			const withFocus = focus === "" ? "" : ` (focus: ${focus})`;
			return `A curator review of this conversation will run now${withFocus}.`;
		}
		case "digest":
			return "This conversation has other participants: the curator only learns from your own messages, and the review will run from those alone.";
		case "refused":
			return `No curator review: ${outcome.reason}`;
	}
}

/**
 * The `/learn` command contribution, bound to the host and loop 1's
 * `learnNow`. Runs with the invoking principal: its `user` is the
 * owner the review would learn for.
 */
export function createLearnCommand(
	host: SigrunHost,
	learnNow: LearnNow,
): ExtensionCommandContribution {
	return {
		name: "learn",
		description: "Ask the curator to review this conversation now",
		args: "[focus]",
		run: async (ctx) => {
			const user = ctx.principal.user;
			if (user === undefined) {
				return { notice: "No curator review: you are not signed in." };
			}
			const focus = ctx.args.trim();
			const outcome = await learnNow(ctx.conversationId, user, focus === "" ? undefined : focus);
			return { notice: noticeFor(outcome, focus === "" ? undefined : focus) };
		},
	};
}

/**
 * The `/learn` enqueue path, shared by the command and usable directly:
 * decide eligibility, then fork-queue or digest-queue — never running a
 * review on the caller's stack. Exported for loop 1 to expose as its
 * `learnNow` seam (the same decision tree the settle hook walks, minus
 * the threshold gate and the paused/enabled gates: `/learn` works while
 * paused — the vacation switch stops the LOOPS, not the user's own
 * explicit ask).
 */
export async function enqueueLearn(
	host: SigrunHost,
	queue: {
		enqueue(job: {
			readonly user: string;
			readonly work: () => Promise<void>;
		}): void;
	},
	conversationId: ConversationId,
	user: string,
	focus: string | undefined,
	reviewBody: (
		owner: string,
		id: ConversationId,
		hints: readonly CurationHint[],
		newestEntry: EntryId | undefined,
		focus: string | undefined,
	) => Promise<void>,
): Promise<LearnOutcome> {
	const eligibility = await host.curation.eligibility(conversationId);
	if (eligibility.internal) {
		return { kind: "refused", reason: "this conversation is internal" };
	}
	if (eligibility.owner !== user) {
		return {
			kind: "refused",
			reason: "this conversation belongs to another user",
		};
	}

	const hints = mergeHints(
		await pendingHintsFor(host, user, conversationId),
		await host.curation.takeHints(conversationId),
	);

	if (eligibility.ownerOnly && eligibility.unattributed === 0) {
		queue.enqueue({
			user,
			work: () =>
				reviewBody(user, conversationId, hints, eligibility.newestEntry, focus).catch(
					() => undefined,
				),
		});
		return { kind: "queued" };
	}

	// Mixed authorship or unattributed entries: never forked — the
	// digest queue (loop 2 reviews only the owner's attributed turns).
	await queueDigest(host, user, conversationId, hints);
	await clearPendingHints(host, user, conversationId, hints);
	return { kind: "digest" };
}

/** The review id a `/learn`-triggered review runs under. */
export function learnReviewId(): string {
	return `learn-${randomUUID()}`;
}
