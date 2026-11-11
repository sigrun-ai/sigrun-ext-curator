/**
 * The curator's schema-declared per-user settings (settings rework,
 * Task 10): drawable proof, the old parser's defaults (copied from
 * src/settings.ts before its retirement), and an old settings file
 * loading through the factory's declared checked read — including the
 * malformed-value repairs the parser used to apply by hand.
 */
import { describe, expect, test } from "vitest";
import { assertDrawable } from "@sigrun/sigrun/settings-schema";
import { CURATOR_USER_SCHEMA } from "../src/settings-schema.js";
import { createFakeHost } from "./fake-host.js";
import createCurator from "../src/index.js";
import { readSettings } from "../src/settings.js";

const ALICE = "alice";

describe("curator user settings schema", () => {
	test("idleModel declares the chat kind", () => {
		expect(CURATOR_USER_SCHEMA.properties.idleModel).toMatchObject({
			"x-sigrun-model": "chat",
		});
	});

	test("every field has a title", () => {
		expect(Object.fromEntries(
			Object.entries(CURATOR_USER_SCHEMA.properties).map(([name, schema]) => [
				name,
				(schema as { title?: unknown }).title,
			]),
		)).toEqual({
			enabled: "Enabled",
			paused: "Paused",
			idleModel: "Idle model",
			threshold: "Review every N model calls",
			dailyRuns: "Digest runs per day",
		});
	});

	test("schema is drawable", () => {
		assertDrawable(CURATOR_USER_SCHEMA);
	});

	test("defaults match the old parser's defaults", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			createCurator(host);
			const declared = host.declaredSettings!;
			// An absent settings object reads as the old parser's defaults,
			// one assertion per key (DEFAULT_CURATOR_SETTINGS).
			const value = await declared.user(ALICE).get();
			expect(value.enabled).toBe(true);
			expect(value.paused).toBe(false);
			expect(value.idleModel).toBeUndefined();
			expect(value.threshold).toBe(10);
			expect(value.dailyRuns).toBe(12);
		} finally {
			await host.close();
		}
	});

	test("an old settings file still loads", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			createCurator(host);
			// The fixture from the old parser tests (factory.test.ts):
			// stored values override the defaults; unknown keys ride along.
			await host.stores.user(ALICE).settings.set({
				enabled: false,
				paused: true,
				idleModel: "faux/m",
				threshold: 4,
				dailyRuns: 2,
				unrelated: "kept-but-ignored",
			});
			const value = await host.declaredSettings!.user(ALICE).get();
			expect(value).toMatchObject({
				enabled: false,
				paused: true,
				idleModel: "faux/m",
				threshold: 4,
				dailyRuns: 2,
			});

			// Malformed values fall back to their defaults, never throw.
			await host.stores.user(ALICE).settings.set({
				enabled: "yes",
				threshold: -3,
				dailyRuns: "many",
				paused: 0,
			});
			const repaired = await host.declaredSettings!.user(ALICE).get();
			expect(repaired).toMatchObject({
				enabled: true,
				paused: false,
				threshold: 10,
				dailyRuns: 12,
			});
			expect(repaired.idleModel).toBeUndefined();
		} finally {
			await host.close();
		}
	});

	test("a read before the factory declared names the lifecycle error", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await expect(readSettings(host, ALICE)).rejects.toThrow(
				"readSettings before the factory declared settings",
			);
		} finally {
			await host.close();
		}
	});

	test("the factory declares a userSchema and no shared-schema reads throw nowhere", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			createCurator(host);
			expect(host.declaredSettings).toBeDefined();
			// The loops read through the declared handle, not the raw store.
			const value = await host.declaredSettings!.user(ALICE).get();
			expect(value.threshold).toBe(10);
		} finally {
			await host.close();
		}
	});
});
