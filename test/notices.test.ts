/**
 * Core-notices move tests (`src/notices.ts`, notices Task 9): the
 * post-review "Learned:" notice is now a CORE per-user notice posted
 * through `host.notices.post` — keyed `review:<reviewId>` (a re-run of
 * one review REPLACES its notice), aimed at the review's owner,
 * carrying the review's originating conversation id, with two actions:
 * an **Undo** extension action (the declared `undoReview` handler,
 * payload `{reviewId}`, a confirm prompt) and a **Review** navigate
 * action to the curator view anchored at the review.
 *
 * The ambient seam keeps NO role in the notice itself: `setAmbient` is
 * never called by `notify` any more (the one-time migration sweep
 * clears the pre-move ambient notices instead — see the loop 2 sweep
 * tests), and the per-user notices ledger file is gone (core's notice
 * store owns durability now).
 *
 * The wiring is pinned too: loop 1's completed review and loop 2's
 * digest review both fire `notify` themselves (a changed review
 * announces, an unchanged one does not), and a notice failure degrades
 * to a missing notice, never a failed review/step.
 */

import { describe, expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	ConversationId,
	EntryId,
	SubmissionId,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	CurationHint,
	CurationRunResult,
	HandlerContext,
	MemoryEventApi,
	RunSettledEvent,
	UserNoticeInput,
} from "@sigrun/sigrun/extension";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";
import { notify } from "../src/notices.js";
import { Backoff } from "../src/backoff.js";
import { createLoop1 } from "../src/loop1.js";
import { ReviewQueue } from "../src/queue.js";
import { queueDigest } from "../src/queue.js";
import { digestsStep } from "../src/steps/digests.js";
import type { ModelStepDeps, RunBudget } from "../src/steps/run.js";
import { LOOP2_TICK_DEADLINE_MS } from "../src/loop2.js";

/** The acting user these fixtures run as (tests own their literals). */
const ALICE = "alice";

/** The inert event API stub — the loops read the host, not the event api. */
const API = {} as MemoryEventApi;

/** One pending-review hint (the refund-file discriminator). */
function noticeHint(n: number): CurationHint {
	return {
		id: `hint-${n}`,
		tool: "memory_write",
		args: { file: "memory" },
		at: "2026-11-01T12:00:00.000Z",
	};
}

/** Read one user's refunded-hints file (absent → rejects ENOENT). */
async function pendingHintsRaw(
	host: FakeHost,
	user: string,
): Promise<string> {
	return await readFile(
		join(host.stores.user(user).paths.state, "pending-hints.json"),
		"utf8",
	);
}

/** The shared invocation context (the fake host's own). */
const CONTEXT: HandlerContext = { abortSignal: undefined };

/** A completed review result with changes. */
function reviewed(
	changes: readonly { changeId: string; summary: string; target: string }[],
): CurationRunResult {
	return { status: "completed", text: "saved", changes };
}

/** The notices.post inputs the host recorded. */
function postedNotices(
	calls: readonly { method: string; args: readonly unknown[] }[],
): UserNoticeInput[] {
	return calls
		.filter((call) => call.method === "notices.post")
		.map((call) => call.args[0] as UserNoticeInput);
}

describe("notify (the post-review core notice)", () => {
	test("a review posts one keyed notice with Undo + Review", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await notify(host, id, ALICE, {
				...reviewed([
					{
						changeId: "chg-1",
						summary: "updated `deploy-staging`",
						target: "skills",
					},
				]),
				reviewId: "review-acme",
			});

			const posts = postedNotices(host.calls);
			expect(posts).toHaveLength(1);
			const notice = posts[0];
			expect(notice.user).toBe(ALICE);
			expect(notice.conversationId).toBe(id);
			expect(notice.key).toBe("review:review-acme");
			expect(notice.title).toBe("Learned: updated `deploy-staging`");
			expect(notice.body).toBe("Open the curator view to review or undo.");
			const undo = notice.actions?.find((action) => action.id === "undo");
			expect(undo).toMatchObject({
				label: "Undo",
				kind: "extension",
				name: "undoReview",
				payload: { reviewId: "review-acme" },
				confirm: "Undo every change this review made?",
			});

			const review = notice.actions?.find((action) => action.id === "review");
			expect(review).toMatchObject({
				label: "Review",
				kind: "navigate",
				target: {
					view: {
						extension: "curator",
						id: "curator",
						params: { review: "review-acme" },
					},
				},
			});

			// The ambient seam carries NOTHING any more.
			expect(
				host.calls.some((call) => call.method === "setAmbient"),
			).toBe(false);
		} finally {
			await host.close();
		}
	});

	test("a second review in the same conversation posts its own notice", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await notify(host, id, ALICE, {
				...reviewed([
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				]),
				reviewId: "review-one",
			});
			await notify(host, id, ALICE, {
				...reviewed([
					{ changeId: "chg-2", summary: "created `release-flow`", target: "skills" },
				]),
				reviewId: "review-two",
			});

			const posts = postedNotices(host.calls);
			expect(posts).toHaveLength(2);
			// Each review keys its OWN notice — a second review never
			// replaces the first review's (they undo separately).
			expect(posts.map((notice) => notice.key)).toEqual([
				"review:review-one",
				"review:review-two",
			]);
			expect(posts[1]?.title).toBe("Learned: created `release-flow`");
		} finally {
			await host.close();
		}
	});

	test("a review whose joined title would exceed 200 chars posts a truncated title ending in …", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			// Six changes whose joined "Learned: …" lines exceed core's
			// 200-char title cap — the notice must still post (an over-cap
			// post would throw, and the caller's catch would swallow the
			// notice entirely).
			const changes = Array.from({ length: 6 }, (_, i) => ({
				changeId: `chg-${i}`,
				summary: `updated \`acme-deploy-step-${i}\` with the rollout quirk`,
				target: "skills",
			}));
			const joined = changes
				.map((change) => `Learned: ${change.summary}`)
				.join(" · ");
			expect(joined.length).toBeGreaterThan(200);

			await notify(host, id, ALICE, {
				...reviewed(changes),
				reviewId: "review-long",
			});

			const posts = postedNotices(host.calls);
			expect(posts).toHaveLength(1);
			expect(posts[0]?.title.length).toBeLessThanOrEqual(200);
			expect(posts[0]?.title.endsWith("…")).toBe(true);
			expect(posts[0]?.title).toContain("Learned: updated `acme-deploy-step-0`");
		} finally {
			await host.close();
		}
	});

	test("the notice is never written to the transcript and never sent to a notifier", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await notify(host, id, ALICE, {
				...reviewed([
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				]),
				reviewId: "review-acme",
			});

			// No transcript entry: the notice never submits to the
			// conversation (a fork would replay it otherwise).
			expect(
				host.calls.some((call) => call.method === "conversations.submit"),
			).toBe(false);
			// The notices channel is the ONLY carrier: nothing that looks
			// like a notifier or channel delivery was touched ("notices.*"
			// is the one allowed match).
			for (const call of host.calls) {
				if (call.method.startsWith("notices.")) continue;
				expect(call.method).not.toMatch(/notif|channel|deliver/i);
			}
		} finally {
			await host.close();
		}
	});

	test("a review with no changes or no review id posts nothing", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await notify(host, id, ALICE, {
				...reviewed([]),
				reviewId: "review-nothing",
			});
			await notify(host, id, ALICE, {
				status: "failed",
				text: "",
				changes: [
					{ changeId: "chg-1", summary: "half-applied", target: "skills" },
				],
				error: "upstream 502",
				reviewId: "review-failed",
			});
			await notify(host, id, ALICE, {
				...reviewed([
					{ changeId: "chg-1", summary: "orphan", target: "skills" },
				]),
			});
			expect(postedNotices(host.calls)).toHaveLength(0);
		} finally {
			await host.close();
		}
	});
});

// ─── The wiring: the loops fire notify themselves ──────────────────────────

/** One minimal answered assistant message (the event's answer payload). */
function answerMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "acme deploy notes" }],
		api: "openai-completions",
		provider: "faux",
		model: "m",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("the loops fire notify on a changed review", () => {
	test("loop 1's completed review with changes posts the notice; without changes it does not", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			const queue = new ReviewQueue();
			const loop = createLoop1({ host, queue, backoff: new Backoff() });
			const event: RunSettledEvent = {
				conversationId: id,
				owner: ALICE,
				inputs: [1 as SubmissionId],
				inputTexts: ["acme deploy notes"],
				outcome: {
					status: "answered",
					answerEntryId: 7 as EntryId,
					answer: answerMessage(),
				},
			};

			// With changes: one posted notice naming the change.
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async () =>
					reviewed([
						{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
					]),
			});
			await loop.onRunSettled(event, API, CONTEXT);
			await queue.idle();
			expect(postedNotices(host.calls)).toHaveLength(1);
			expect(postedNotices(host.calls)[0]?.conversationId).toBe(id);

			// Without changes: still exactly one notice overall (the second
			// review added none).
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async () => reviewed([]),
			});
			await loop.onRunSettled(event, API, CONTEXT);
			await queue.idle();
			expect(postedNotices(host.calls)).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	test("loop 2's digest review with changes posts the notice aimed at the mixed conversation", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await queueDigest(host, ALICE, id);
			host.setCuration({
				targets: async () => [],
				eligibility: async () => ({
					owner: ALICE,
					deleted: false,
					internal: false,
					ownerOnly: false,
					unattributed: 0,
				}),
				authors: async () => new Map([[10 as EntryId, ALICE]]),
				digestRun: async () =>
					reviewed([
						{ changeId: "chg-1", summary: "noted the acme port quirk", target: "memory:markdown" },
					]),
			});

			const budget: RunBudget = { left: () => 12, spend: async () => true };
			const deps: ModelStepDeps = {
				host,
				user: ALICE,
				now: () => new Date("2026-11-01T12:00:00.000Z"),
				deadlineAt: Date.parse("2026-11-01T12:00:00.000Z") + LOOP2_TICK_DEADLINE_MS,
				budget,
				log: () => undefined,
			};
			const work = digestsStep(deps);
			const push = async () => {
				for (let i = 0; i < 50; i += 1) {
					if (host.calls.some((call) => call.method === "conversations.watch")) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				host.pushView(id, {
					conversation: { id },
					entries: [
						{ id: 10, kind: "pi.user", model: [{ role: "user", content: "acme advice" }] },
					],
					docs: {},
					steer: { busy: false, queued: 0 },
				} as never);
			};
			await push();
			await work;

			const posts = postedNotices(host.calls);
			expect(posts).toHaveLength(1);
			expect(posts[0]?.conversationId).toBe(id);
			expect(posts[0]?.user).toBe(ALICE);
			expect(posts[0]?.key).toMatch(/^review:/);
		} finally {
			await host.close();
		}
	});

	test("a notice failure never corrupts loop 1's completed review: no refund, no backoff, no error log", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			const queue = new ReviewQueue();
			const backoff = new Backoff();
			const logs: string[] = [];
			const loop = createLoop1({
				host,
				queue,
				backoff,
				log: (message) => logs.push(message),
			});
			const event: RunSettledEvent = {
				conversationId: id,
				owner: ALICE,
				inputs: [1 as SubmissionId],
				inputTexts: ["acme deploy notes"],
				outcome: {
					status: "answered",
					answerEntryId: 7 as EntryId,
					answer: answerMessage(),
				},
			};

			// The review COMPLETES with changes after consuming a hint; the
			// notice post then rejects (the notices seam hiccuping).
			host.setCuration({
				takeHints: async () => [noticeHint(1)],
				forkReview: async () =>
					reviewed([
						{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
					]),
			});
			host.notices.post = async () => {
				throw new Error("notices seam unavailable");
			};

			await loop.onRunSettled(event, API, CONTEXT);
			await queue.idle();

			// (a) No phantom refund: the review completed, so its consumed
			// hint is gone for good — the pending-hints file was never
			// written.
			await expect(pendingHintsRaw(host, ALICE)).rejects.toMatchObject({
				code: "ENOENT",
			});
			// (b) No backoff step: a later settle at the SAME instant runs a
			// review immediately.
			host.setCuration({
				takeHints: async () => [noticeHint(2)],
				forkReview: async () => reviewed([]),
			});
			await loop.onRunSettled(event, API, CONTEXT);
			await queue.idle();
			expect(
				host.calls.filter((call) => call.method === "curation.takeHints").length,
			).toBe(2);
			// (c) The completion stood: exactly two reviews ran, and neither
			// was logged as a failed review (the notice failure may log a
			// notice line — never the phantom "review ... failed" one).
			expect(
				host.calls.filter((call) => call.method === "curation.forkReview").length,
			).toBe(2);
			expect(logs.some((line) => /review of conversation .+ failed/.test(line))).toBe(
				false,
			);
		} finally {
			await host.close();
		}
	});

	test("a notice failure never fails loop 2's digest step (the entry is still consumed)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await queueDigest(host, ALICE, id);
			host.setCuration({
				targets: async () => [],
				eligibility: async () => ({
					owner: ALICE,
					deleted: false,
					internal: false,
					ownerOnly: false,
					unattributed: 0,
				}),
				authors: async () => new Map([[10 as EntryId, ALICE]]),
				digestRun: async () =>
					reviewed([
						{ changeId: "chg-1", summary: "noted the acme port quirk", target: "memory:markdown" },
					]),
			});
			host.notices.post = async () => {
				throw new Error("notices seam unavailable");
			};

			const budget: RunBudget = { left: () => 12, spend: async () => true };
			const logs: string[] = [];
			const deps: ModelStepDeps = {
				host,
				user: ALICE,
				now: () => new Date("2026-11-01T12:00:00.000Z"),
				deadlineAt:
					Date.parse("2026-11-01T12:00:00.000Z") + LOOP2_TICK_DEADLINE_MS,
				budget,
				log: (message) => logs.push(message),
			};
			const work = digestsStep(deps);
			const push = async () => {
				for (let i = 0; i < 50; i += 1) {
					if (host.calls.some((call) => call.method === "conversations.watch")) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				host.pushView(id, {
					conversation: { id },
					entries: [
						{ id: 10, kind: "pi.user", model: [{ role: "user", content: "acme advice" }] },
					],
					docs: {},
					steer: { busy: false, queued: 0 },
				} as never);
			};
			await push();
			await work;

			// The step reported success: no phantom "digest ... failed"
			// error log (the notice failure may log a notice line), and
			// the completed entry was consumed despite the notice failure.
			expect(
				logs.some((line) => /digest of conversation .+ failed/.test(line)),
			).toBe(false);
			expect(logs.some((line) => line.includes("notices seam unavailable"))).toBe(
				true,
			);
			const queueFile = JSON.parse(
				await readFile(
					join(host.stores.user(ALICE).paths.state, "digest-queue.json"),
					"utf8",
				),
			) as { conversations: unknown[] };
			expect(queueFile.conversations).toEqual([]);
		} finally {
			await host.close();
		}
	});
});
