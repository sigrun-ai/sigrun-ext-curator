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
import type { ExtensionCommandContribution } from "@sigrun/sigrun/extension";
import { createFakeHost } from "./fake-host.js";
import createCurator, { CURATOR_TICK_TASK, readSettings } from "../src/index.js";

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

		// The view: one view surface, placement `view`.
		expect(result.surfaces?.views?.map((view) => view.id)).toEqual(["curator"]);
		expect(result.surfaces?.views?.[0]?.placement).toBe("view");
	});
});

describe("readSettings (per user, with defaults)", () => {
	test("an absent settings object reads as the defaults", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await expect(readSettings(host, ALICE)).resolves.toEqual({
				enabled: true,
				paused: false,
				idleModel: undefined,
				threshold: 10,
				dailyRuns: 12,
			});
			// Read through the per-user scoped store.
			expect(
				host.calls.some(
					(call) =>
						call.method === "stores.user.settings.get" &&
						call.args[0] === ALICE,
				),
			).toBe(true);
		} finally {
			await host.close();
		}
	});

	test("stored values override the defaults; unknown keys are ignored", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await host.stores.user(ALICE).settings.set({
				enabled: false,
				paused: true,
				idleModel: "faux/m",
				threshold: 4,
				dailyRuns: 2,
				unrelated: "kept-but-ignored",
			});
			await expect(readSettings(host, ALICE)).resolves.toEqual({
				enabled: false,
				paused: true,
				idleModel: "faux/m",
				threshold: 4,
				dailyRuns: 2,
			});
		} finally {
			await host.close();
		}
	});

	test("malformed values fall back to their defaults, never throw", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await host.stores.user(ALICE).settings.set({
				enabled: "yes",
				threshold: -3,
				dailyRuns: "many",
				paused: 0,
			});
			await expect(readSettings(host, ALICE)).resolves.toEqual({
				enabled: true,
				paused: false,
				idleModel: undefined,
				threshold: 10,
				dailyRuns: 12,
			});
		} finally {
			await host.close();
		}
	});
});
