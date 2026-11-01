/**
 * Task B5 tests: the post-review notice (`src/notices.ts`).
 *
 * The contract under test: a COMPLETED review with changes sets ONE
 * ambient record (`curator.notice`, place `status`) — one line per
 * change (`Learned: <summary>`) plus a `navigate` action to the curator
 * view anchored at the review — and a review with no changes sets
 * nothing. The notice is NEVER a transcript entry (no conversation
 * submit) and NEVER a notifier or channel delivery (the ambient seam is
 * the only carrier).
 *
 * The undo bookkeeping the view consumes is pinned here too: the notice
 * remembers the conversation it was set on, so the view's Undo review
 * action can clear exactly that conversation's notice. And the WIRING
 * is pinned: loop 1's completed review and loop 2's digest review both
 * fire `notify` themselves (a changed review announces, an unchanged
 * one does not).
 */

import { describe, expect, test } from "vitest";
import type {
	ConversationId,
	EntryId,
	SubmissionId,
} from "@earendil-works/pi-durable";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	CurationRunResult,
	HandlerContext,
	MemoryEventApi,
	RunSettledEvent,
} from "@sigrun/sigrun/extension";
import { validateTree } from "@sigrun/sigrun/blocks";
import type { ConversationViewWire } from "@sigrun/shared/views";
import { createFakeHost } from "./fake-host.js";
import { CURATOR_NOTICE_KIND, notify, readNotices } from "../src/notices.js";
import type { NoticeRecord } from "../src/notices.js";
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

/** The shared invocation context (the fake host's own). */
const CONTEXT: HandlerContext = { abortSignal: undefined };

/** A completed review result with changes. */
function reviewed(
	changes: readonly { changeId: string; summary: string; target: string }[],
): CurationRunResult {
	return { status: "completed", text: "saved", changes };
}

/** The setAmbient calls the host recorded, narrowed to their specs. */
function ambientWrites(
	calls: readonly { method: string; args: readonly unknown[] }[],
): { conversationId: number; spec: Record<string, unknown> }[] {
	return calls
		.filter((call) => call.method === "setAmbient")
		.map((call) => ({
			conversationId: call.args[0] as number,
			spec: call.args[1] as Record<string, unknown>,
		}));
}

describe("notify (the post-review ambient notice)", () => {
	test("a review with changes sets one ambient notice with a navigate action", async () => {
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
					{
						changeId: "chg-2",
						summary: "noted the acme port quirk",
						target: "memory:markdown",
					},
				]),
				reviewId: "review-acme",
			});

			const writes = ambientWrites(host.calls);
			expect(writes).toHaveLength(1);
			const { spec } = writes[0];
			expect(spec.key).toBe(CURATOR_NOTICE_KIND);
			expect(spec.place).toBe("status");
			// One line per change, each "Learned: <summary>".
			const root = spec.body as { root: Record<string, unknown> };
			expect(spec.body).toBeDefined();
			const title = root.root.title;
			expect(String(title)).toContain("Learned: updated `deploy-staging`");
			expect(String(title)).toContain("Learned: noted the acme port quirk");
			// A navigate action to the curator view anchored at the review.
			const actions = (root.root.actions ?? []) as {
				action: { type: string; target?: unknown };
			}[];
			expect(actions.length).toBeGreaterThan(0);
			const navigate = actions.find((button) => button.action.type === "navigate");
			expect(navigate).toBeDefined();
			expect(JSON.stringify(navigate?.action.target)).toContain("curator");
			expect(JSON.stringify(navigate?.action.target)).toContain("review-acme");
			// The body passes the server's OWN ambient validation (the
			// one-line rule for a status slot) — the exact walk the host
			// runs on write.
			const verdict = validateTree(spec.body, {
				placement: "ambient",
				ambientPlace: "status",
			});
			expect(verdict.ok).toBe(true);
		} finally {
			await host.close();
		}
	});

	test("a completed review with no changes sets no notice", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await notify(host, id, ALICE, {
				...reviewed([]),
				reviewId: "review-nothing",
			});
			expect(ambientWrites(host.calls)).toHaveLength(0);
			expect(await readNotices(host, ALICE)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("a non-completed review with changes sets no notice", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await notify(host, id, ALICE, {
				status: "failed",
				text: "",
				changes: [
					{ changeId: "chg-1", summary: "half-applied", target: "skills" },
				],
				error: "upstream 502",
				reviewId: "review-failed",
			});
			expect(ambientWrites(host.calls)).toHaveLength(0);
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
			// The ambient seam is the ONLY carrier: nothing that looks like a
			// notifier or channel delivery was touched, and exactly one
			// ambient write happened.
			const methods = new Set(host.calls.map((call) => call.method));
			expect(methods.has("setAmbient")).toBe(true);
			for (const method of methods) {
				expect(method).not.toMatch(/notif|channel|deliver/i);
			}
			expect(host.calls.filter((call) => call.method === "setAmbient")).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	test("the notice records the conversation for the view's undo clear", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			const result = await notify(host, id, ALICE, {
				...reviewed([
					{ changeId: "chg-1", summary: "created `release-flow`", target: "skills" },
				]),
				reviewId: "review-undo",
			});

			// notify answers the durable notice record the view's Undo
			// action uses: which conversation's ambient to clear.
			const record: NoticeRecord | undefined = result;
			expect(record).toBeDefined();
			expect(record?.conversationId).toBe(id);
			expect(record?.reviewId).toBe("review-undo");
			// The per-user notice file is durable: an undo after a restart
			// still knows which conversation to clear.
			expect(
				(await readNotices(host, ALICE)).find(
					(entry) => entry.reviewId === "review-undo",
				),
			).toMatchObject({
				conversationId: id,
				reviewId: "review-undo",
			});
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
	test("loop 1's completed review with changes sets the notice; without changes it does not", async () => {
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

			// With changes: one ambient notice naming the change.
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
			expect(ambientWrites(host.calls)).toHaveLength(1);
			expect(ambientWrites(host.calls)[0]?.conversationId).toBe(id);

			// Without changes: still exactly one notice overall (the second
			// review added none).
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async () => reviewed([]),
			});
			await loop.onRunSettled(event, API, CONTEXT);
			await queue.idle();
			expect(ambientWrites(host.calls)).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	test("loop 2's digest review with changes sets the notice on the mixed conversation", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await queueDigest(host, ALICE, id);
			host.setCuration({
				targets: async () => [],
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: false,
					unattributed: 0,
				}),
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
			await (async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
			})();
			const view: ConversationViewWire = {
				conversation: { id },
				entries: [
					{ id: 10, kind: "pi.user", model: [{ role: "user", content: "acme advice" }] },
				],
				docs: { "sigrun.authors": { byEntry: { "10": ALICE } } },
				steer: { busy: false, queued: 0 },
			} as never;
			// Push the frame the step waits for.
			const push = async () => {
				for (let i = 0; i < 50; i += 1) {
					if (host.calls.some((call) => call.method === "conversations.watch")) break;
					await new Promise((resolve) => setTimeout(resolve, 10));
				}
				host.pushView(id, view);
			};
			await push();
			await work;

			const writes = ambientWrites(host.calls);
			expect(writes).toHaveLength(1);
			expect(writes[0]?.conversationId).toBe(id);
			expect((writes[0]?.spec as { key: string }).key).toBe(CURATOR_NOTICE_KIND);
		} finally {
			await host.close();
		}
	});
});
