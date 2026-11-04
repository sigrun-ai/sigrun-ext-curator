/**
 * The one-time ambient-notice migration sweep tests (notices Task 9):
 * pre-core-notices versions announced a review on the originating
 * conversation's `curator.notice` AMBIENT record; now that the notice
 * is a core per-user notice, a tick first sweeps each user's
 * conversations with `host.clearAmbient(id, "curator.notice")` — ONCE
 * per user, pinned by a `notices-migrated` marker in the user's state
 * dir. The sweep runs BEFORE the eligibility/pass logic so even an
 * ineligible user's stale notices go; a user with no conversations is
 * still marked (never re-swept); a clearAmbient failure is logged and
 * the marker is NOT written (the next tick retries).
 *
 * The sweep is why `ambientKinds: ["curator.notice"]` stays declared
 * in the factory: the host's write gate throws on clearing an
 * undeclared key.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";
import {
	tick,
	FIRST_TICK_FILE,
	NOTICES_MIGRATED_FILE,
} from "../src/loop2.js";

/** The users these fixtures walk (tests own their literals). */
const ALICE = "alice";
const BOB = "bob";

/** The epoch every fixture clock starts at. */
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const HOUR = 3_600_000;

/** A fixed clock (the sweep is clock-independent; the tick needs one). */
function fixedClock(): () => Date {
	return () => new Date(T0);
}

/** Put the extension's first-tick state 25 h in the past (past the grace). */
async function pastGrace(host: FakeHost): Promise<void> {
	await mkdir(host.stores.paths.state, { recursive: true });
	await writeFile(
		join(host.stores.paths.state, FIRST_TICK_FILE),
		`${JSON.stringify({ firstTickAt: new Date(Date.parse("2026-10-31T00:00:00.000Z")).toISOString() })}\n`,
		"utf8",
	);
}

/** Whether the user's notices-migrated marker file exists. */
async function hasMarker(host: FakeHost, user: string): Promise<boolean> {
	try {
		await readFile(
			join(host.stores.user(user).paths.state, NOTICES_MIGRATED_FILE),
			"utf8",
		);
		return true;
	} catch {
		return false;
	}
}

/** The clearAmbient calls the host recorded, as (conversationId, key). */
function ambientClears(
	host: FakeHost,
): readonly (readonly [ConversationId, string])[] {
	return host.calls
		.filter((call) => call.method === "clearAmbient")
		.map((call) => [call.args[0] as ConversationId, call.args[1] as string] as const);
}

describe("the one-time ambient-notice migration sweep", () => {
	test("the sweep clears old ambient notices once (marker)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const first = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			const second = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			await pastGrace(host);

			await tick(host, fixedClock());

			// Every one of alice's conversations got its curator.notice
			// ambient record cleared, and the marker landed.
			expect(ambientClears(host)).toEqual([
				[first, "curator.notice"],
				[second, "curator.notice"],
			]);
			expect(await hasMarker(host, ALICE)).toBe(true);

			// A second tick NEVER re-sweeps: the marker pins the one-time pass.
			await tick(host, fixedClock());
			expect(ambientClears(host)).toHaveLength(2);
		} finally {
			await host.close();
		}
	});

	test("the sweep is harmless when absent (no conversations → marker only)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await pastGrace(host);
			await tick(host, fixedClock());
			expect(ambientClears(host)).toEqual([]);
			expect(await hasMarker(host, ALICE)).toBe(true);
			// And never re-runs.
			await tick(host, fixedClock());
			expect(ambientClears(host)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("a clearAmbient failure is logged and the marker is not written (the next tick retries)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await host.conversations.create({ owner: ALICE });
			await pastGrace(host);
			const logs: string[] = [];
			const log = (line: string) => logs.push(line);

			host.clearAmbient = async () => {
				throw new Error("ambient seam unavailable");
			};
			await tick(host, fixedClock(), { log });
			expect(await hasMarker(host, ALICE)).toBe(false);
			expect(logs.some((line) => line.includes("ambient seam unavailable"))).toBe(
				true,
			);

			// The next tick retries the sweep (and now it lands).
			const clears: unknown[] = [];
			host.clearAmbient = async (id, key) => {
				clears.push([id, key]);
			};
			await tick(host, fixedClock(), { log });
			expect(clears).toHaveLength(1);
			expect(await hasMarker(host, ALICE)).toBe(true);
		} finally {
			await host.close();
		}
	});

	test("the sweep is per-user (bob's conversations are alice's never)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const alices = (await host.conversations.create({ owner: ALICE })) as ConversationId;
			const bobs = (await host.conversations.create({ owner: BOB })) as ConversationId;
			await pastGrace(host);
			await tick(host, fixedClock());
			expect(ambientClears(host)).toEqual([
				[alices, "curator.notice"],
				[bobs, "curator.notice"],
			]);
			expect(await hasMarker(host, ALICE)).toBe(true);
			expect(await hasMarker(host, BOB)).toBe(true);
		} finally {
			await host.close();
		}
	});
});
