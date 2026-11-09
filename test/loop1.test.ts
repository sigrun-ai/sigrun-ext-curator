/**
 * Task B2 tests: loop 1 — the fork review's decision and enqueue.
 *
 * The handler contract under test (`src/loop1.ts`): `onRunSettled`
 * DECIDES (owner present, settings on, not backed off, threshold or
 * hints) and ENQUEUES, then returns — never awaiting a review. The
 * review body runs through `ReviewQueue` (`src/queue.ts`) under the
 * brief's bounds, aborting when the parent moves; failures step the
 * backoff ladder (`src/backoff.ts`).
 *
 * Hermetic pattern (test/fake-host.ts): the in-memory host with the
 * scriptable `curation` member; `host.calls` asserts what the loop
 * did. The clock is fake where backoff cares.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	EntryId,
	SubmissionId,
} from "@earendil-works/pi-durable";
import type {
	CurationHint,
	CurationRunOpts,
	CurationRunResult,
	ExtensionRunSettledHandler,
	HandlerContext,
	MemoryEventApi,
	RunSettledEvent,
} from "@sigrun/sigrun/extension";
import { createFakeHost, type FakeHost } from "./fake-host.js";
import { declareSettings } from "../src/settings.js";
import { Backoff } from "../src/backoff.js";
import { createLoop1 } from "../src/loop1.js";
import { ReviewQueue } from "../src/queue.js";

/** The acting user these fixtures run as (tests own their literals). */
const ALICE = "alice";

/** The inert event API stub — loop 1's decision reads the host, not the event api. */
const API = {} as MemoryEventApi;

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

/** One settled-run event with the given outcome. */
function settled(
	id: ConversationId,
	outcome: RunSettledEvent["outcome"],
	owner: string | undefined = ALICE,
): RunSettledEvent {
	return {
		conversationId: id,
		...(owner === undefined ? {} : { owner }),
		inputs: [1 as SubmissionId],
		inputTexts: ["acme deploy notes"],
		outcome,
	};
}

/** An answered settle. */
function answered(
	id: ConversationId,
	answerEntryId: number = 7,
): RunSettledEvent {
	return settled(id, {
		status: "answered",
		answerEntryId: answerEntryId as EntryId,
		answer: answerMessage(),
	});
}

/** An unanswered settle (an aborted run). */
function unanswered(id: ConversationId): RunSettledEvent {
	return settled(id, { status: "unanswered", reason: "aborted" });
}

/** A completed review result (no changes). */
const COMPLETED: CurationRunResult = {
	status: "completed",
	text: "nothing to save",
	changes: [],
};

/** A failed review result (the provider-failure path). */
const FAILED: CurationRunResult = {
	status: "failed",
	text: "",
	changes: [],
	error: "upstream 502",
};

/** A cancelled review result (the parent moved mid-review). */
const CANCELLED: CurationRunResult = {
	status: "cancelled",
	text: "",
	changes: [],
};

/** One pending-review hint. */
function hint(n: number): CurationHint {
	return {
		id: `hint-${n}`,
		tool: "memory_write",
		args: { file: "memory" },
		at: "2026-11-01T12:00:00.000Z",
	};
}

/** The loop-1 harness: fake host, one owned conversation, real queue/backoff. */
async function setup(opts: { now?: () => Date } = {}) {
	const host = await createFakeHost({ users: [{ user: ALICE }] });
	declareSettings(host);
	const id = await host.conversations.create({ owner: ALICE });
	const queue = new ReviewQueue();
	const backoff = new Backoff();
	const loop = createLoop1({
		host,
		queue,
		backoff,
		...(opts.now === undefined ? {} : { now: opts.now }),
	});
	return { host, id, queue, backoff, loop };
}

/** Fire one settle through the handler. */
async function fire(
	loop: { readonly onRunSettled: ExtensionRunSettledHandler },
	host: { readonly context: HandlerContext },
	event: RunSettledEvent,
): Promise<void> {
	await loop.onRunSettled(event, API, host.context);
}

/** Whether the host logged a call to the named curation member. */
function curationCalls(
	calls: readonly { method: string }[],
	method: string,
): number {
	return calls.filter((call) => call.method === `curation.${method}`).length;
}

/** Read a per-user state file as JSON. */
async function readState(
	host: { stores: { user(user: string): { paths: { state: string } } } },
	file: string,
): Promise<unknown> {
	return JSON.parse(
		await readFile(join(host.stores.user(ALICE).paths.state, file), "utf8"),
	);
}

describe("loop 1: the fork-review decision", () => {
	test("no review below threshold", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				modelCallsSince: async () => 9,
				takeHints: async () => [],
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			// No cursor is written when nothing was reviewed.
			await expect(readState(host, "cursors.json")).rejects.toMatchObject({
				code: "ENOENT",
			});
		} finally {
			await host.close();
		}
	});

	test("review at threshold 10, with the brief's bounds and a fresh cursor", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let opts: CurationRunOpts | undefined;
			host.setCuration({
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: true,
					unattributed: 0,
					newestEntry: 5 as EntryId,
				}),
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async (_id, reviewOpts) => {
					opts = reviewOpts;
					return COMPLETED;
				},
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(1);
			expect(opts?.maxToolCalls).toBe(8);
			expect(opts?.maxOutputTokens).toBe(2048);
			expect(opts?.deadlineMs).toBe(120000);
			expect(opts?.reviewId).toMatch(/^review-/);
			expect(opts?.instruction).toBeTypeOf("string");
			// The cursor anchors at the eligibility snapshot's newest entry.
			expect(await readState(host, "cursors.json")).toEqual({
				lastReviewedEntry: { [String(id)]: 5 },
			});
		} finally {
			await host.close();
		}
	});

	test("an owner-only answered run below the threshold is reviewed when wantsReview is true", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				modelCallsSince: async () => 3,
				takeHints: async () => [],
				wantsReview: async () => true,
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(1);
			expect(curationCalls(host.calls, "wantsReview")).toBe(1);
		} finally {
			await host.close();
		}
	});

	test("below the threshold and wantsReview false: no review", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				modelCallsSince: async () => 3,
				takeHints: async () => [],
				wantsReview: async () => false,
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			expect(curationCalls(host.calls, "wantsReview")).toBe(1);
		} finally {
			await host.close();
		}
	});

	test("an unanswered run is not reviewed by wantsReview alone", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				takeHints: async () => [],
				wantsReview: async () => true,
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, unanswered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			// Answered-only: the flag persists until the next answered
			// settle — the loop never even asks on an unanswered run.
			expect(curationCalls(host.calls, "wantsReview")).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("an owner-only answered run at the threshold never asks wantsReview", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				wantsReview: async () => {
					throw new Error("must not be asked at/over the threshold");
				},
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(1);
			expect(curationCalls(host.calls, "wantsReview")).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("a mixed-authorship conversation ignores wantsReview", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: false,
					unattributed: 2,
				}),
				modelCallsSince: async () => 3,
				takeHints: async () => [],
				wantsReview: async () => {
					throw new Error("the digest path never asks wantsReview");
				},
				forkReview: async () => {
					throw new Error("a mixed conversation must never be forked");
				},
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "wantsReview")).toBe(0);
			expect(curationCalls(host.calls, "forkReview")).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("the review allow-list contains each served target's readTools", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let allow: readonly string[] | undefined;
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				targets: async () => [
					{
						id: "memory",
						tools: ["memory_write"],
						readTools: ["memory_search", "memory_read"],
						guidance: [],
						maintain: false,
					},
					{
						id: "notes",
						tools: ["notes_write"],
						guidance: [],
						maintain: false,
					},
				],
				tools: async () => ["memory_write", "notes_write"],
				forkReview: async (_id, opts) => {
					allow = opts.allow;
					return COMPLETED;
				},
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			// readTools ?? [] merge in; a target without readTools adds
			// nothing.
			expect(allow).toEqual([
				"skill_manage",
				"memory_write",
				"memory_search",
				"memory_read",
				"notes_write",
			]);
		} finally {
			await host.close();
		}
	});

	test("hints trigger immediately, even after an unanswered run", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				takeHints: async () => [hint(1)],
				modelCallsSince: async () => 0,
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, unanswered(id));
			await queue.idle();

			// Trigger (b): hints alone, an aborted run's hints included.
			expect(curationCalls(host.calls, "forkReview")).toBe(1);
			expect(curationCalls(host.calls, "takeHints")).toBe(1);
		} finally {
			await host.close();
		}
	});

	test("onRunSettled returns before the review completes", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started!: () => void;
			const startedGate = new Promise<void>((resolve) => {
				started = resolve;
			});
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async () => {
					started();
					await gate;
					return COMPLETED;
				},
			});

			// The handler resolves while forkReview is still parked on the
			// gate — a runSettled handler never awaits a review.
			const pending = fire(loop, host, answered(id));
			await startedGate;
			await pending;

			release();
			await queue.idle();
			expect(curationCalls(host.calls, "forkReview")).toBe(1);
		} finally {
			await host.close();
		}
	});

	test("mixed shared conversation is queued for a digest, not forked", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let pending: readonly CurationHint[] = [];
			host.setCuration({
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: false,
					unattributed: 3,
				}),
				modelCallsSince: async () => 9, // below threshold both times
				takeHints: async () => pending,
				forkReview: async () => {
					throw new Error("a mixed conversation must never be forked");
				},
			});

			// Below threshold with no hints: not even queued.
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			await expect(readState(host, "digest-queue.json")).rejects.toMatchObject({
					code: "ENOENT",
				});

			// Hints trigger the digest path too, and ride in the queued
			// entry (taken read-and-clear — the digest run folds them in).
			pending = [hint(1)];
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			expect(await readState(host, "digest-queue.json")).toEqual({
				conversations: [{ id, hints: [hint(1)] }],
			});

			// A second settle dedups by conversation id (nothing new merges
			// in, nothing forks).
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			expect(await readState(host, "digest-queue.json")).toEqual({
				conversations: [{ id, hints: [hint(1)] }],
			});
		} finally {
			await host.close();
		}
	});

	test("paused user gets no review (and a disabled one neither)", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			await host.stores.user(ALICE).settings.set({ paused: true });
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [hint(1)],
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			// The hints are not consumed while the loop is off.
			expect(curationCalls(host.calls, "takeHints")).toBe(0);

			await host.stores.user(ALICE).settings.set({
				paused: false,
				enabled: false,
			});
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(curationCalls(host.calls, "takeHints")).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("an ownerless settle is ignored", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [hint(1)],
			});
			// `settled()`'s owner default can't express "absent" — build the
			// ownerless event inline.
			const event: RunSettledEvent = {
				conversationId: id,
				inputs: [1 as SubmissionId],
				inputTexts: ["acme deploy notes"],
				outcome: { status: "unanswered", reason: "aborted" },
			};
			await fire(loop, host, event);
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			expect(curationCalls(host.calls, "takeHints")).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("an internal conversation is ignored (the belt under the bus's withholding)", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				eligibility: async () => ({
					owner: ALICE,
					internal: true,
					ownerOnly: true,
					unattributed: 0,
				}),
				modelCallsSince: async () => 10,
				takeHints: async () => [hint(1)],
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(0);
			expect(curationCalls(host.calls, "takeHints")).toBe(0);
		} finally {
			await host.close();
		}
	});

	test("provider failure backs off 15 then 30 then 60 minutes, and a success resets", async () => {
		const base = new Date("2026-11-01T12:00:00.000Z");
		const at = (minutes: number): Date =>
			new Date(base.getTime() + minutes * 60_000);
		let clock = base;
		const { host, id, queue, loop } = await setup({ now: () => clock });
		try {
			let calls = 0;
			host.setCuration({
				takeHints: async () => [hint(calls + 1)],
				forkReview: async () => {
					calls += 1;
					return calls <= 3 ? FAILED : COMPLETED;
				},
			});

			// First failure: blocked for 15 minutes.
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(1);

			clock = at(14);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(1); // still blocked

			clock = at(16);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(2); // second failure: blocked for 30 minutes

			clock = at(45);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(2); // 16 + 29: still blocked

			clock = at(47);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(3); // third failure: blocked for 60 minutes

			clock = at(106);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(3); // 47 + 59: still blocked

			clock = at(108);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(4); // success: the ladder resets

			clock = at(109);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(calls).toBe(5); // no block after a reset
		} finally {
			await host.close();
		}
	});

	test("a failed review refunds its hints; the next settle re-fires from the refund and completion clears it", async () => {
		const base = new Date("2026-11-01T12:00:00.000Z");
		const at = (minutes: number): Date =>
			new Date(base.getTime() + minutes * 60_000);
		let clock = base;
		const { host, id, queue, loop } = await setup({ now: () => clock });
		try {
			const instructions: string[] = [];
			host.setCuration({
				// The host holds the hint once: the first take clears it and
				// every later take finds an empty host — only the refund can
				// bring the hint back.
				takeHints: async () => (instructions.length === 0 ? [hint(1)] : []),
				forkReview: async (_id, opts) => {
					instructions.push(opts.instruction);
					return instructions.length === 1 ? FAILED : COMPLETED;
				},
			});

			// Hints fire the review; the provider fails it.
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(curationCalls(host.calls, "forkReview")).toBe(1);
			// The failed review refunded its consumed hint.
			expect(await readState(host, "pending-hints.json")).toEqual([
				{ conversationId: id, hints: [hint(1)] },
			]);

			// After the backoff window the next settle re-fires from the
			// refund alone: the host is empty and modelCallsSince sits at
			// 0, below threshold — without the merge nothing would run.
			clock = at(16);
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(curationCalls(host.calls, "forkReview")).toBe(2);
			expect(instructions[1]).toContain('memory_write {"file":"memory"}');
			// The completed review consumed the hint for good.
			expect(await readState(host, "pending-hints.json")).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("a cancelled review (the parent moved) refunds its hints too", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				takeHints: async () => [hint(2)],
				forkReview: async () => CANCELLED,
			});
			await fire(loop, host, unanswered(id));
			await queue.idle();

			expect(curationCalls(host.calls, "forkReview")).toBe(1);
			expect(await readState(host, "pending-hints.json")).toEqual([
				{ conversationId: id, hints: [hint(2)] },
			]);
		} finally {
			await host.close();
		}
	});

	test("a completing review consumes only its own hints — a concurrent review's refund survives", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			// Two settles enqueue two reviews back-to-back (the queue is
			// FIFO per user; both decisions ran before either review). Each
			// settle carries its own fresh hint. R1's provider call is
			// deferred so both decisions run before R1's failure lands its
			// refund — the ordering this test pins (the settings checked
			// read is async now, so an immediate R1 would otherwise settle
			// before the second decision and its backoff would block it).
			const batches = [[hint(1)], [hint(2)]];
			let releaseR1: (result: CurationRunResult) => void = () => {};
			const r1 = new Promise<CurationRunResult>((resolve) => {
				releaseR1 = resolve;
			});
			host.setCuration({
				takeHints: async () => batches.shift() ?? [],
				forkReview: async () => {
					if (batches.length === 1) return r1; // the first call
					return COMPLETED;
				},
			});

			await fire(loop, host, answered(id));
			await fire(loop, host, answered(id));
			releaseR1(FAILED);
			await queue.idle();

			// R1 failed and refunded hint-1; R2 completed with hint-2 — its
			// completion must not swallow the other review's refund.
			expect(curationCalls(host.calls, "forkReview")).toBe(2);
			expect(await readState(host, "pending-hints.json")).toEqual([
				{ conversationId: id, hints: [hint(1)] },
			]);
		} finally {
			await host.close();
		}
	});

	test("allow-list omits a target outside the parent's selection and omits read when the parent lacks it", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let allow: readonly string[] | undefined;
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				targets: async () => [
					{
						id: "memory",
						tools: ["memory_write"],
						guidance: ["route personal facts here"],
						maintain: false,
					},
				],
				tools: async () => ["memory_write", "skill_manage"],
				forkReview: async (_id, opts) => {
					allow = opts.allow;
					return COMPLETED;
				},
			});
			await fire(loop, host, answered(id));
			await queue.idle();
			// skill_manage + the selected target's tools; no read (the
			// parent's selection lacks it).
			expect(allow).toEqual(["skill_manage", "memory_write"]);

			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				tools: async () => ["memory_write", "skill_manage", "read"],
				forkReview: async (_id, opts) => {
					allow = opts.allow;
					return COMPLETED;
				},
			});
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(allow).toEqual(["skill_manage", "memory_write", "read"]);
		} finally {
			await host.close();
		}
	});

	test("the cursor anchors the next modelCallsSince read", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			host.setCuration({
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: true,
					unattributed: 0,
					newestEntry: 5 as EntryId,
				}),
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, answered(id));
			await queue.idle();

			let anchor: unknown = "unset";
			host.setCuration({
				modelCallsSince: async (_id, entryId) => {
					anchor = entryId;
					return 10;
				},
				takeHints: async () => [],
				forkReview: async () => COMPLETED,
			});
			await fire(loop, host, answered(id));
			await queue.idle();
			expect(anchor).toBe(5);
		} finally {
			await host.close();
		}
	});

	test("parent activity while the review runs aborts it via the signal", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let signal: AbortSignal | undefined;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started!: () => void;
			const startedGate = new Promise<void>((resolve) => {
				started = resolve;
			});
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async (_id, opts) => {
					signal = opts.signal;
					started();
					await gate;
					return COMPLETED;
				},
			});

			const pending = fire(loop, host, answered(id));
			await startedGate;
			expect(signal).toBeDefined();
			expect(signal?.aborted).toBe(false);

			// A new run on the parent: the watch snapshot establishes the
			// baseline; a frame with MORE entries is genuine churn and fires
			// the abort signal.
			host.pushView(id, viewWith(1));
			expect(signal?.aborted).toBe(false); // the snapshot is not churn
			host.pushView(id, viewWith(2));
			expect(signal?.aborted).toBe(true);

			release();
			await pending;
			await queue.idle();
		} finally {
			await host.close();
		}
	});

	test("a re-rendered view (no new entries) is not churn and never aborts", async () => {
		const { host, id, queue, loop } = await setup();
		try {
			let signal: AbortSignal | undefined;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started!: () => void;
			const startedGate = new Promise<void>((resolve) => {
				started = resolve;
			});
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async (_id, opts) => {
					signal = opts.signal;
					started();
					await gate;
					return COMPLETED;
				},
			});

			const pending = fire(loop, host, answered(id));
			await startedGate;
			expect(signal?.aborted).toBe(false);

			// Snapshot, then repeated re-renders at the same entry count
			// (a status refresh, a re-served frame): none of it is churn.
			host.pushView(id, viewWith(3));
			host.pushView(id, viewWith(3));
			host.pushView(id, viewWith(3));
			expect(signal?.aborted).toBe(false);

			release();
			await pending;
			await queue.idle();
			expect(signal?.aborted).toBe(false);
		} finally {
			await host.close();
		}
	});
	test("loop1 churn survives long conversations", async () => {
		// pi-durable 1.5.0 keeps full raw history in the view (D1-A): a
		// 150-entry conversation's watch frames still carry every entry,
		// so the baseline/churn comparison must hold at real lengths.
		const { host, id, queue, loop } = await setup();
		try {
			let signal: AbortSignal | undefined;
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let started!: () => void;
			const startedGate = new Promise<void>((resolve) => {
				started = resolve;
			});
			host.setCuration({
				modelCallsSince: async () => 10,
				takeHints: async () => [],
				forkReview: async (_id, opts) => {
					signal = opts.signal;
					started();
					await gate;
					return COMPLETED;
				},
			});

			const pending = fire(loop, host, answered(id));
			await startedGate;
			expect(signal).toBeDefined();
			expect(signal?.aborted).toBe(false);

			// Baseline frame of 150 entries is the snapshot, never churn;
			// the 151st entry is genuine churn and fires the abort.
			host.pushView(id, viewWith(150));
			expect(signal?.aborted).toBe(false);
			host.pushView(id, viewWith(151));
			expect(signal?.aborted).toBe(true);

			release();
			await pending;
			await queue.idle();
		} finally {
			await host.close();
		}
	});
});

/** One minimal watch frame carrying `count` model entries. */
type PushedView = Parameters<FakeHost["pushView"]>[1];
function viewWith(count: number): PushedView {
	return {
		entries: Array.from({ length: count }, (_, index) => ({
			id: index + 1,
			kind: "pi.assistant",
		})),
	} as unknown as PushedView;
}
