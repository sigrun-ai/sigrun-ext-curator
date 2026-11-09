/**
 * Task B1 scaffold tests: the factory's DECLARED surface — the extension
 * (name `curator`, the `curator.tick` task), the `curator-tick` job over
 * it, the `runSettled` handler, the `/learn` command, the declared
 * ambient/interaction kinds, and the curator view — plus the per-user
 * settings read with defaults (`src/settings.ts`).
 *
 * Hermetic pattern (test/fake-host.ts): the in-memory SigrunHost; the
 * factory is called directly, never through a boot. The loop behaviors
 * are B2–B5's; here only the declared wiring is pinned.
 */

import { describe, expect, test } from "vitest";
import type {
	ExtensionCommandContribution,
	UserNotice,
} from "@sigrun/sigrun/extension";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";
import createCurator, { CURATOR_TICK_TASK, readSettings } from "../src/index.js";
import { notify } from "../src/notices.js";

/** The acting user these fixtures run as (tests own their literals). */
const ALICE = "alice";

describe("createCurator (the loader contract)", () => {
	test("factory returns the job, runSettled, command, kinds and view", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		await host.close();
		const result = createCurator(host);

		// The extension: named `curator`, carrying the tick task.
		expect(result.extension?.name).toBe("curator");
		expect(
			result.extension?.tasks?.map((task) => task.definition.name),
		).toEqual([CURATOR_TICK_TASK]);

		// The job: the only time-based scheduler, every 15 minutes, over
		// the task the extension registers.
		expect(result.jobs).toEqual([
			{
				name: "curator-tick",
				schedule: { every: "15m" },
				action: { kind: "task", task: CURATOR_TICK_TASK },
				description:
					"The curator's idle pass: every 15 minutes it reviews learned skills and memory for each user.",
			},
		]);

		// runSettled: declared (loop 1's decision lands in B2).
		expect(typeof result.runSettled).toBe("function");

		// The command: `/learn`.
		const commands: readonly ExtensionCommandContribution[] = result.commands ?? [];
		expect(commands.map((command) => command.name)).toEqual(["learn"]);

		// The declared kinds.
		expect(result.ambientKinds).toEqual(["curator.notice"]);
		expect(result.interactionKinds).toEqual(["curator.overlay-question"]);

		// The declared notice actions (notices Task 9): the Undo on the
		// posted notice runs the extension's undoReview handler.
		expect(Object.keys(result.noticeActions ?? {})).toEqual(["undoReview"]);

		// The view: one view surface, placement `view`.
		expect(result.surfaces?.views?.map((view) => view.id)).toEqual(["curator"]);
		expect(result.surfaces?.views?.[0]?.placement).toBe("view");
	});
});

// The per-user settings reads (defaults, stored overrides, malformed
// repairs) moved to test/settings-schema.test.ts with the schema
// declaration (settings rework, Task 10).

describe("the noticeActions.undoReview handler (the notice's Undo)", () => {
	const BOB = "bob";

	/** Post one review notice and answer the stored record it became. */
	async function postedNotice(host: FakeHost, user: string): Promise<UserNotice> {
		const id = await host.conversations.create({ owner: user });
		await notify(host, id, user, {
			status: "completed",
			text: "saved",
			changes: [
				{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
			],
			reviewId: "review-acme",
		});
		const [notice] = await host.notices.list(user);
		expect(notice).toBeDefined();
		return notice;
	}

	test("undoReview handler undoes and returns the count", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const result = createCurator(host);
			host.registerNoticeActions(result.noticeActions ?? {});
			host.setCuration({ undoReview: async () => 2 });
			const notice = await postedNotice(host, ALICE);

			const outcome = await host.invokeNoticeAction(
				"undoReview",
				{
					principal: { user: ALICE, admin: false, service: false, method: "token" },
					notice,
					signal: new AbortController().signal,
				},
				{ reviewId: "review-acme" },
			);
			expect(outcome).toEqual({ ok: true, message: "Undid 2 change(s)" });
			const undos = host.calls.filter(
				(call) => call.method === "curation.undoReview",
			);
			expect(undos).toHaveLength(1);
			expect(undos[0]?.args).toEqual([ALICE, "review-acme"]);
		} finally {
			await host.close();
		}
	});

	test("undoReview refuses a principal other than the notice's user", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const result = createCurator(host);
			host.registerNoticeActions(result.noticeActions ?? {});
			host.setCuration({ undoReview: async () => 1 });
			const notice = await postedNotice(host, ALICE);

			const outcome = await host.invokeNoticeAction(
				"undoReview",
				{
					principal: { user: BOB, admin: false, service: false, method: "token" },
					notice,
					signal: new AbortController().signal,
				},
				{ reviewId: "review-acme" },
			);
			expect(outcome).toEqual({
				ok: false,
				error: { message: "this notice is not yours" },
			});
			// The curation host was never touched for the wrong user.
			expect(
				host.calls.filter((call) => call.method === "curation.undoReview"),
			).toHaveLength(0);
		} finally {
			await host.close();
		}
	});
});
