/**
 * Task B3 tests: the deterministic steps — `archiveUnused`
 * (`src/steps/archive.ts`) and the detection half of overlay drift
 * (`src/steps/overlays.ts`).
 *
 * `archiveUnused`: learned skills unused ≥ 30 days (per `usage`) AND
 * created ≥ 30 days ago archive through `skills(user).apply(name,
 * {kind: "archive"}, …)` — never a pinned skill, never a skill a job
 * prompt references (`jobSkillRefs`, paused jobs included). Overlays
 * orphaned ≥ 30 days (their `orphanedSince`) are REMOVED.
 *
 * `detectOverlayDrift`: each overlay's `upstreamHash` vs
 * `upstream(user, key)?.hash` — absent upstream → `markOrphans`, a
 * changed hash → one queued re-check in the overlay-recheck queue
 * (`overlay-recheck-queue.json`, the file name this repo chose).
 *
 * Hermetic pattern (test/fake-host.ts): the in-memory host with the
 * scriptable curation member; the asserts read `host.calls` and the
 * per-user state dir. The clock is passed in.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type {
	CurationOverlay,
	CurationSkillInfo,
	CurationOverlayKey,
} from "@sigrun/sigrun/extension";
import { createFakeHost } from "./fake-host.js";
import type { ScriptableCuration } from "./fake-host.js";
import {
	archiveUnused,
	ARCHIVE_UNUSED_DAYS,
} from "../src/steps/archive.js";
import {
	detectOverlayDrift,
	OverlayRecheckQueue,
	RECHECK_QUEUE_FILE,
} from "../src/steps/overlays.js";

/** The acting user these fixtures run as (tests own their literals). */
const ALICE = "alice";

/** One fixed clock instant the 30-day arithmetic hangs off. */
const NOW = new Date("2026-11-01T12:00:00.000Z");

/** `ms` before NOW, as an ISO string. */
const daysAgo = (days: number): string =>
	new Date(NOW.getTime() - days * 86_400_000).toISOString();

/** One learned-skill row with the given age/usage stamps. */
function skill(
	name: string,
	opts: { createdDaysAgo: number; archived?: boolean; pinned?: boolean },
): CurationSkillInfo {
	return {
		name,
		description: `the ${name} procedure`,
		archived: opts.archived ?? false,
		pinned: opts.pinned ?? false,
		bytes: 512,
		createdAt: daysAgo(opts.createdDaysAgo),
	};
}

/** One overlay-key fixture (a package skill; tests own their literals). */
function key(skill: string): CurationOverlayKey {
	return { root: "package", skill };
}

/** One stored overlay with the given upstream hash / orphan stamp. */
function overlay(
	of: string,
	opts: { hash: string; orphanedDaysAgo?: number },
): CurationOverlay {
	return {
		key: key(of),
		text: `${of} notes`,
		upstreamHash: opts.hash,
		...(opts.orphanedDaysAgo === undefined
			? {}
			: { orphanedSince: daysAgo(opts.orphanedDaysAgo) }),
	};
}

/** The fake's scriptable curation member (its `defaults` field). */
function scriptable(host: {
	readonly curation: object;
}): ScriptableCuration {
	return host.curation as ScriptableCuration;
}

/** Read alice's state file as JSON. */
async function readStateFile(name: string, host: {
	stores: { user(user: string): { paths: { state: string } } };
}): Promise<unknown> {
	return JSON.parse(
		await readFile(join(host.stores.user(ALICE).paths.state, name), "utf8"),
	);
}

describe("archiveUnused", () => {
	test("archive spares pinned and job-referenced skills", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// Five learned skills, all unused 40 days and created 40 days
			// ago — only the two with no protection may archive.
			const rows = [
				skill("acme-plain", { createdDaysAgo: 40 }),
				skill("acme-pinned", { createdDaysAgo: 40, pinned: true }),
				skill("acme-job-ref", { createdDaysAgo: 40 }),
				skill("acme-used-recently", { createdDaysAgo: 40 }),
				skill("acme-young", { createdDaysAgo: 5 }),
			];
			const applied: (readonly [string, string])[] = [];
			host.setCuration({
				skills: (user) => {
					expect(user).toBe(ALICE);
					return {
						...scriptable(host).defaults.skills(user),
						list: async () => rows,
						apply: async (name, change) => {
							applied.push([name, change.kind]);
							return scriptable(host).defaults.skills(user).apply(name, change, {});
						},
					};
				},
				usage: async () => ({
					"acme-plain": daysAgo(40),
					"acme-pinned": daysAgo(40),
					"acme-job-ref": daysAgo(40),
					"acme-used-recently": daysAgo(3),
					// acme-young: never used — creation age is its only clock.
				}),
				jobSkillRefs: async () => new Set(["acme-job-ref"]),
			});

			await archiveUnused(host, ALICE, () => NOW);

			expect(applied).toEqual([["acme-plain", "archive"]]);
		} finally {
			await host.close();
		}
	});

	test("orphaned overlay removed after 30 days", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [
				overlay("acme-gone", { hash: "h1", orphanedDaysAgo: 40 }),
				overlay("acme-recent-orphan", { hash: "h2", orphanedDaysAgo: 10 }),
				overlay("acme-healthy", { hash: "h3" }),
			];
			const removed: string[] = [];
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					list: async () => rows,
					remove: async (k) => {
						removed.push(k.skill);
						return scriptable(host).defaults.overlays(user).remove(k, {
							actor: "curator",
						});
					},
				}),
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => [],
				}),
			});

			await archiveUnused(host, ALICE, () => NOW);

			expect(removed).toEqual(["acme-gone"]);
		} finally {
			await host.close();
		}
	});

	test("a skill unused but younger than 30 days is spared (usage absent → never)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [
				skill("acme-young-used", { createdDaysAgo: 40 }),
				skill("acme-never-used-young", { createdDaysAgo: 3 }),
				skill("acme-never-used-old", { createdDaysAgo: 40 }),
			];
			const applied: string[] = [];
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => rows,
					apply: async (name, change) => {
						applied.push(name);
						expect(change.kind).toBe("archive");
						return scriptable(host).defaults.skills(user).apply(name, change, {});
					},
				}),
				usage: async () => ({ "acme-young-used": daysAgo(3) }),
				jobSkillRefs: async () => new Set<string>(),
			});

			await archiveUnused(host, ALICE, () => NOW);

			// acme-never-used-old has NO usage row: never used, and created
			// 40 days ago → it archives. The other two are spared (used 3
			// days ago; created 3 days ago).
			expect(applied).toEqual(["acme-never-used-old"]);
		} finally {
			await host.close();
		}
	});

	test("archived skills are skipped (no restore, no re-archive)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [skill("acme-already", { createdDaysAgo: 40, archived: true })];
			const applied: string[] = [];
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => rows,
					apply: async (name, change) => {
						applied.push(name);
						return scriptable(host).defaults.skills(user).apply(name, change, {});
					},
				}),
			});

			await archiveUnused(host, ALICE, () => NOW);

			expect(applied).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("exactly 30 days counts as unused (>=, not >)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [skill("acme-exactly", { createdDaysAgo: 30 })];
			const applied: string[] = [];
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => rows,
					apply: async (name, change) => {
						applied.push(name);
						return scriptable(host).defaults.skills(user).apply(name, change, {});
					},
				}),
				usage: async () => ({ "acme-exactly": daysAgo(30) }),
			});

			await archiveUnused(host, ALICE, () => NOW);

			expect(applied).toEqual(["acme-exactly"]);
		} finally {
			await host.close();
		}
	});

	test("ARCHIVE_UNUSED_DAYS is 30", () => {
		expect(ARCHIVE_UNUSED_DAYS).toBe(30);
	});
});

describe("detectOverlayDrift", () => {
	test("changed upstream queues an overlay re-check", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [
				overlay("acme-changed", { hash: "old-hash" }),
				overlay("acme-same", { hash: "same-hash" }),
				overlay("acme-absent", { hash: "h4" }),
			];
			const upstream: ReadonlyMap<string, { body: string; hash: string }> = new Map([
				["acme-changed", { body: "b", hash: "new-hash" }],
				["acme-same", { body: "b", hash: "same-hash" }],
			]);
			let markedWith: readonly CurationOverlayKey[] = [];
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					list: async () => rows,
					markOrphans: async (present) => {
						markedWith = rows.map((row) => row.key).filter((k) => !present(k));
					},
				}),
				upstream: async (_user, k) => upstream.get(k.skill),
			});

			await detectOverlayDrift(host, ALICE);

			// The absent upstream is marked orphaned via the host's own
			// pass (present() answers from the upstream reads).
			expect(markedWith.map((k) => k.skill)).toEqual(["acme-absent"]);
			// The changed hash — and only it — is queued for a re-check.
			const queued = (await readStateFile(RECHECK_QUEUE_FILE, host)) as {
				keys: readonly { skill: string }[];
			};
			expect(queued.keys).toEqual([key("acme-changed")]);
		} finally {
			await host.close();
		}
	});

	test("an unchanged, healthy set queues and marks nothing", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [overlay("acme-same", { hash: "h" })];
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					list: async () => rows,
				}),
				upstream: async (_user, k) =>
					k.skill === "acme-same" ? { body: "b", hash: "h" } : undefined,
			});

			await detectOverlayDrift(host, ALICE);

			await expect(readStateFile(RECHECK_QUEUE_FILE, host)).rejects.toThrow();
		} finally {
			await host.close();
		}
	});

	test("a returning upstream clears the orphan mark (markOrphans' contract)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// Orphaned 5 days ago, but the upstream is BACK — the host's
			// markOrphans clears the stamp; nothing is queued or removed.
			const rows = [
				overlay("acme-back", { hash: "h", orphanedDaysAgo: 5 }),
			];
			let presentCalls = 0;
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					list: async () => rows,
					markOrphans: async (present) => {
						presentCalls += 1;
						void present(rows[0].key);
					},
				}),
				upstream: async () => ({ body: "b", hash: "h" }),
			});

			await detectOverlayDrift(host, ALICE);

			expect(presentCalls).toBe(1);
			await expect(readStateFile(RECHECK_QUEUE_FILE, host)).rejects.toThrow();
		} finally {
			await host.close();
		}
	});

	test("re-check queue dedups keys across passes", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [overlay("acme-changed", { hash: "old" })];
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					list: async () => rows,
				}),
				upstream: async () => ({ body: "b", hash: "new" }),
			});

			await detectOverlayDrift(host, ALICE);
			await detectOverlayDrift(host, ALICE);

			const queued = (await readStateFile(RECHECK_QUEUE_FILE, host)) as {
				keys: readonly { skill: string }[];
			};
			expect(queued.keys).toEqual([key("acme-changed")]);
		} finally {
			await host.close();
		}
	});
});

describe("OverlayRecheckQueue (the queue's read/take shape B4 consumes)", () => {
	test("take drains the queue and writes it back empty", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					list: async () => [overlay("acme-changed", { hash: "old" })],
				}),
				upstream: async () => ({ body: "b", hash: "new" }),
			});
			await detectOverlayDrift(host, ALICE);

			const queue = new OverlayRecheckQueue(host, ALICE);
			const first = await queue.take();
			expect(first).toEqual([key("acme-changed")]);
			const second = await queue.take();
			expect(second).toEqual([]);
		} finally {
			await host.close();
		}
	});
});
