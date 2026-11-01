/**
 * Task B3 tests: loop 2 — the tick's eligibility gate and the
 * resumable pass cursor (`src/loop2.ts`).
 *
 * The contract under test: a tick picks the users who are quiet (the
 * newest `lastActivityAt` older than the idle threshold), past the
 * install's first-run grace (first tick + 24 h, extension-scope
 * state), and without a full pass in the last 24 h — then walks each
 * user's pass cursor step by step under a 5-minute self-deadline,
 * persisting `done` after every step so the next tick resumes
 * mid-pass instead of restarting.
 *
 * "No live run" rides the idle clock: a live run stamped
 * `lastActivityAt` at admission (and stamps again at settle), so a
 * user with a live run is never past the idle threshold.
 *
 * Hermetic pattern (test/fake-host.ts): the in-memory host with
 * `setLastActivity` controlling each conversation's `lastActivityAt`;
 * the clock is a mutable holder tests advance mid-step.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";
import {
	eligibleUsers,
	tick,
	FIRST_TICK_FILE,
	IDLE_THRESHOLD_MS,
	LOOP2_TICK_DEADLINE_MS,
	PASS_FILE,
	PASS_STEPS,
} from "../src/loop2.js";

/** The users these fixtures walk (tests own their literals). */
const ALICE = "alice";
const BOB = "bob";

/** The epoch every fixture clock starts at. */
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** A mutable fake clock: `now` reads it, `advance` moves it. */
function clock(atMs: number): {
	readonly now: () => Date;
	readonly advance: (ms: number) => void;
} {
	let at = atMs;
	return {
		now: () => new Date(at),
		advance: (ms) => {
			at += ms;
		},
	};
}

/** The loop-2 harness: a fake host over both users. */
async function setup(
	users: readonly string[] = [ALICE, BOB],
): Promise<FakeHost> {
	return createFakeHost({ users: users.map((user) => ({ user })) });
}

/** One owned conversation with the given newest activity. */
async function seedConversation(
	host: FakeHost,
	owner: string,
	lastActivityAt?: string,
): Promise<ConversationId> {
	const id = await host.conversations.create({ owner });
	if (lastActivityAt !== undefined) host.setLastActivity(id, lastActivityAt);
	return id;
}

/** Put the extension's first-tick state 25 h in the past (past the grace). */
async function pastGrace(host: FakeHost): Promise<void> {
	await mkdir(host.stores.paths.state, { recursive: true });
	await writeFile(
		join(host.stores.paths.state, FIRST_TICK_FILE),
		`${JSON.stringify({ firstTickAt: new Date(T0 - 25 * HOUR).toISOString() })}\n`,
		"utf8",
	);
}

/** One user's pass cursor, parsed. */
async function readPass(host: FakeHost, user: string): Promise<unknown> {
	return JSON.parse(
		await readFile(join(host.stores.user(user).paths.state, PASS_FILE), "utf8"),
	);
}

/** Whether the user's pass file exists yet. */
async function hasPass(host: FakeHost, user: string): Promise<boolean> {
	try {
		await readFile(join(host.stores.user(user).paths.state, PASS_FILE), "utf8");
		return true;
	} catch {
		return false;
	}
}

describe("loop 2: the tick", () => {
	test("a busy user is skipped; a quiet user gets a pass; a second pass waits 24h", async () => {
		const host = await setup();
		try {
			await pastGrace(host);
			// Alice submitted a minute ago (busy); bob has been quiet for hours.
			const aliceConversation = await seedConversation(
				host,
				ALICE,
				new Date(T0 - 1 * MINUTE).toISOString(),
			);
			await seedConversation(
				host,
				BOB,
				new Date(T0 - IDLE_THRESHOLD_MS - HOUR).toISOString(),
			);
			const c = clock(T0);

			expect(await eligibleUsers(host, c.now)).toEqual([BOB]);
			await tick(host, c.now);

			// Bob: one FULL pass — every step walked, cursor persisted.
			const pass = (await readPass(host, BOB)) as { startedAt: string; done: number; steps: string[] };
			expect(pass.done).toBe(PASS_STEPS.length);
			expect(pass.steps).toEqual([...PASS_STEPS]);
			// Alice: no pass at all.
			expect(await hasPass(host, ALICE)).toBe(false);

			// An hour later bob is still within 24 h of the full pass: no
			// second pass, and the recorded pass is untouched. (Alice stays
			// busy — her activity re-stamped — so only bob's window is under
			// test here.)
			c.advance(1 * HOUR);
			host.setLastActivity(aliceConversation, c.now().toISOString());
			expect(await eligibleUsers(host, c.now)).toEqual([]);
			await tick(host, c.now);
			const unchanged = (await readPass(host, BOB)) as { startedAt: string };
			expect(unchanged.startedAt).toBe(pass.startedAt);

			// Past 24 h since that pass started: bob is due again, and the
			// new pass is a NEW cursor (fresh startedAt).
			c.advance(24 * HOUR);
			host.setLastActivity(aliceConversation, c.now().toISOString());
			expect(await eligibleUsers(host, c.now)).toEqual([BOB]);
			await tick(host, c.now);
			const next = (await readPass(host, BOB)) as { startedAt: string };
			expect(next.startedAt).not.toBe(pass.startedAt);
		} finally {
			await host.close();
		}
	});

	test("first-run grace: no pass in the first 24h", async () => {
		const host = await setup([BOB]);
		try {
			await seedConversation(
				host,
				BOB,
				new Date(T0 - IDLE_THRESHOLD_MS - HOUR).toISOString(),
			);
			const c = clock(T0);

			// The very first tick records the install instant; nobody is
			// eligible (the grace window starts NOW).
			await tick(host, c.now);
			const firstTick = JSON.parse(
				await readFile(join(host.stores.paths.state, FIRST_TICK_FILE), "utf8"),
			) as { firstTickAt: string };
			expect(firstTick.firstTickAt).toBe(new Date(T0).toISOString());
			expect(await eligibleUsers(host, c.now)).toEqual([]);
			expect(await hasPass(host, BOB)).toBe(false);

			// Inside the grace: still nothing.
			c.advance(23 * HOUR);
			await tick(host, c.now);
			expect(await hasPass(host, BOB)).toBe(false);

			// Past 24 h since the first tick: the quiet user is due.
			c.advance(1 * HOUR + MINUTE);
			expect(await eligibleUsers(host, c.now)).toEqual([BOB]);
			await tick(host, c.now);
			const pass = (await readPass(host, BOB)) as { done: number };
			expect(pass.done).toBe(PASS_STEPS.length);
		} finally {
			await host.close();
		}
	});

	test("cursor resumes after the per-tick deadline", async () => {
		const host = await setup([BOB]);
		try {
			await pastGrace(host);
			await seedConversation(
				host,
				BOB,
				new Date(T0 - IDLE_THRESHOLD_MS - HOUR).toISOString(),
			);
			const c = clock(T0);

			// The archive step's usage read burns the (fake) clock past the
			// tick's 5-minute self-deadline mid-step: the step that was
			// already running completes; the pass stops before the next.
			host.setCuration({
				usage: async () => {
					c.advance(LOOP2_TICK_DEADLINE_MS + MINUTE);
					return {};
				},
			});

			await tick(host, c.now);

			const first = (await readPass(host, BOB)) as { done: number; steps: string[] };
			expect(first.done).toBe(1);
			expect(first.steps[0]).toBe("archive");
			// The deadline stopped the pass BEFORE overlay-detect: no
			// upstream reads happened (only that step makes them).
			expect(
				host.calls.filter((call) => call.method === "curation.upstream"),
			).toHaveLength(0);

			// The next tick has a fresh 5-minute budget: it resumes at
			// overlay-detect and walks the pass to the end.
			await tick(host, c.now);
			const done = (await readPass(host, BOB)) as { done: number };
			expect(done.done).toBe(PASS_STEPS.length);
		} finally {
			await host.close();
		}
	});
});
