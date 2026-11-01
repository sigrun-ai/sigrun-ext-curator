/**
 * Task B5 tests: `/learn [focus]` (`src/learn.ts`).
 *
 * The contract under test: `/learn` enqueues a loop-1 review for the
 * conversation — bypassing the THRESHOLD but not ELIGIBILITY — with
 * the given focus folded into the instruction. The answer's `{notice}`
 * names what will happen; in a MIXED conversation (loop 1 would never
 * fork it) the answer says the curator only learns from the owner's
 * messages.
 */

import { describe, expect, test } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	CurationRunOpts,
	CurationRunResult,
	ExtensionCommandContribution,
	HandlerContext,
	Principal,
} from "@sigrun/sigrun/extension";
import { createFakeHost } from "./fake-host.js";
import { Backoff } from "../src/backoff.js";
import { createLoop1, LOOP1_MAX_OUTPUT_TOKENS, LOOP1_MAX_TOOL_CALLS } from "../src/loop1.js";
import { ReviewQueue } from "../src/queue.js";
import { createLearnCommand } from "../src/learn.js";

/** The acting user these fixtures run as (tests own their literals). */
const ALICE = "alice";

/** A signed-in principal fixture. */
const PRINCIPAL: Principal = {
	user: ALICE,
	admin: false,
	service: false,
	method: "token",
};

/** The command context (the fake host's shared, never-aborting one). */
const CONTEXT: HandlerContext = { abortSignal: undefined };

/** A completed review result with one change. */
const REVIEWED: CurationRunResult = {
	status: "completed",
	text: "saved",
	changes: [
		{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
	],
};

/** The learn harness: fake host, one owned conversation, real loop 1. */
async function setup() {
	const host = await createFakeHost({ users: [{ user: ALICE }] });
	const id = (await host.conversations.create({ owner: ALICE })) as ConversationId;
	const queue = new ReviewQueue();
	const loop1 = createLoop1({ host, queue, backoff: new Backoff() });
	const command: ExtensionCommandContribution = createLearnCommand(
		host,
		loop1.learnNow,
	);
	return { host, id, queue, loop1, command };
}

/** Run the command (the route's shape: id, raw args, principal, host). */
async function runLearn(
	command: ExtensionCommandContribution,
	conversationId: ConversationId,
	args: string,
	host: { readonly context: HandlerContext },
): Promise<{ notice?: string } | void> {
	return await command.run({
		conversationId,
		args,
		principal: PRINCIPAL,
		host: host as never,
		// The command runs with the shared invocation context in tests.
		...({} as Record<string, never>),
	}) ?? undefined;
}

describe("/learn", () => {
	test("bypasses the threshold: a review runs with focus folded in", async () => {
		const { host, id, queue, command } = await setup();
		try {
			const instructions: string[] = [];
			let opts: CurationRunOpts | undefined;
			host.setCuration({
				modelCallsSince: async () => 0, // far below any threshold
				takeHints: async () => [],
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: true,
					unattributed: 0,
				}),
				forkReview: async (_id, reviewOpts) => {
					opts = reviewOpts;
					instructions.push(reviewOpts.instruction);
					return REVIEWED;
				},
			});

			const result = await runLearn(command, id, "the deploy steps", host);
			await queue.idle();

			expect(result).toMatchObject({ notice: expect.stringContaining("review") });
			expect(host.calls.some((call) => call.method === "curation.forkReview")).toBe(
				true,
			);
			// The focus rode into the instruction.
			expect(instructions[0]).toContain("the deploy steps");
			// The review still ran under loop 1's bounds.
			expect(opts?.maxToolCalls).toBe(LOOP1_MAX_TOOL_CALLS);
			expect(opts?.maxOutputTokens).toBe(LOOP1_MAX_OUTPUT_TOKENS);
		} finally {
			await host.close();
		}
	});

	test("in a mixed conversation, answers that it only learns from the owner's messages", async () => {
		const { host, id, queue, command } = await setup();
		try {
			host.setCuration({
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: false,
					unattributed: 2,
				}),
				forkReview: async () => {
					throw new Error("a mixed conversation must never be forked");
				},
			});

			const result = await runLearn(command, id, "", host);
			await queue.idle();

			const notice = (result as { notice?: string } | undefined)?.notice;
			expect(typeof notice).toBe("string");
			expect(notice).toContain("only");
			expect(notice).toContain("own messages");
			expect(
				host.calls.some((call) => call.method === "curation.forkReview"),
			).toBe(false);
		} finally {
			await host.close();
		}
	});

	test("a no-focus call in an owner-only conversation still enqueues the review", async () => {
		const { host, id, queue, command } = await setup();
		try {
			host.setCuration({
				modelCallsSince: async () => 0,
				takeHints: async () => [],
				eligibility: async () => ({
					owner: ALICE,
					internal: false,
					ownerOnly: true,
					unattributed: 0,
				}),
				forkReview: async () => REVIEWED,
			});

			const result = await runLearn(command, id, "", host);
			await queue.idle();

			expect(result).toMatchObject({ notice: expect.stringContaining("review") });
			expect(
				host.calls.some((call) => call.method === "curation.forkReview"),
			).toBe(true);
		} finally {
			await host.close();
		}
	});
});
