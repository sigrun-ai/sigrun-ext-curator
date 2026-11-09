/**
 * Task B4 tests: loop 2's five MODEL steps — the overlay re-check
 * (`src/steps/overlays.ts`, re-check half), mixed-conversation digests
 * (`src/steps/digests.ts`), the skill diet (`src/steps/diet.ts`), the
 * merge (`src/steps/merge.ts`) and per-target maintenance
 * (`src/steps/targets.ts`), all under the per-user daily model-run
 * budget (`RunBudget`, `src/steps/run.ts`).
 *
 * The contract under test: every model step is ONE `digestRun` on
 * `CuratorSettings.idleModel` (each run decrements the budget); steps
 * that need a verdict ask for it as the run's final text in a fixed
 * JSON shape and parse `result.text`; an unparseable verdict is "no
 * change". At the daily cap the pass stops for the day — the cursor
 * does not advance past a model step it could not run.
 *
 * Digest attribution: the owner's turns are identified per-entry by
 * `curation.authors` (the per-entry author map), falling back to "the
 * whole conversation is owner-only" (`eligibility.ownerOnly` with zero
 * unattributed entries) when the map is empty. Without either, NO user
 * turn is attributed — bob's words can never enter alice's digest
 * (fail closed, P1's rule).
 *
 * Hermetic pattern (test/fake-host.ts): the in-memory host with the
 * scriptable curation member — every test scripts each run's
 * `text`/`changes` and asserts the recorded `host.calls` plus the
 * per-user state files.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type {
	CurationOverlay,
	CurationOverlayKey,
	CurationRunResult,
	CurationSkillChange,
	CurationSkillInfo,
	HandlerContext,
	MemoryEventApi,
} from "@sigrun/sigrun/extension";
import type { ConversationViewWire, ViewEntry } from "@sigrun/shared/views";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost, ScriptableCuration } from "./fake-host.js";
import { queueDigest, refundHints } from "../src/queue.js";
import {
	FIRST_TICK_FILE,
	LOOP2_TICK_DEADLINE_MS,
	PASS_FILE,
	PASS_STEPS,
	tick,
} from "../src/loop2.js";
import type { ModelStepDeps, RunBudget } from "../src/steps/run.js";
import { OverlayRecheckQueue, recheckOverlays, overlayQuestionHandler, keyId } from "../src/steps/overlays.js";
import { digestsStep } from "../src/steps/digests.js";
import { dietStep } from "../src/steps/diet.js";
import { mergeStep } from "../src/steps/merge.js";
import { maintainTargets } from "../src/steps/targets.js";
import { CURATOR_OVERLAY_QUESTION_KIND } from "../src/index.js";

/** The users these fixtures walk (tests own their literals). */
const ALICE = "alice";
const BOB = "bob";

/** The fixed clock instant every fixture hangs off. */
const NOW = new Date("2026-11-01T12:00:00.000Z");
const now = (): Date => NOW;

/** The handler-invocation stand-ins (the steps never touch the api). */
const API = {} as MemoryEventApi;
const CONTEXT: HandlerContext = { abortSignal: undefined };

/** One overlay-key fixture (a package skill; tests own their literals). */
function key(skill: string): CurationOverlayKey {
	return { root: "package", skill };
}

/** One stored overlay. */
function overlayOf(name: string, opts: { hash: string; text?: string }): CurationOverlay {
	return {
		key: key(name),
		text: opts.text ?? `${name} notes`,
		upstreamHash: opts.hash,
	};
}

/** One learned-skill row. */
function skill(
	name: string,
	opts: { bytes?: number; createdDaysAgo?: number; archived?: boolean } = {},
): CurationSkillInfo {
	return {
		name,
		description: `the ${name} procedure`,
		archived: opts.archived ?? false,
		pinned: false,
		bytes: opts.bytes ?? 512,
		createdAt: new Date(
			NOW.getTime() - (opts.createdDaysAgo ?? 5) * 86_400_000,
		).toISOString(),
	};
}

/** A completed run result with the given final text. */
function completed(
	text: string,
	changes: CurationRunResult["changes"] = [],
): CurationRunResult {
	return { status: "completed", text, changes };
}

/** The fake's scriptable curation member (its `defaults` field). */
function scriptable(host: { readonly curation: object }): ScriptableCuration {
	return host.curation as ScriptableCuration;
}

/** A mutable test budget: spends decrement, `spent` reports the count. */
function budget(runs: number): RunBudget & { spent: () => number } {
	const state = { left: runs, used: 0 };
	return {
		left: () => state.left,
		spend: async () => {
			if (state.left < 1) return false;
			state.left -= 1;
			state.used += 1;
			return true;
		},
		spent: () => state.used,
	};
}

/** One model-step context for alice: fresh budget, the tick deadline. */
function stepDeps(host: FakeHost, runs: number): ModelStepDeps & { budget: RunBudget & { spent: () => number } } {
	const b = budget(runs);
	return {
		host,
		user: ALICE,
		now,
		deadlineAt: NOW.getTime() + LOOP2_TICK_DEADLINE_MS,
		budget: b,
		log: () => undefined,
	};
}

/** The digestRun calls the host recorded: `(user, opts)` pairs. */
function digestRuns(
	calls: readonly { method: string; args: readonly unknown[] }[],
): [string, { input: string; model?: string }][] {
	return calls
		.filter((call) => call.method === "curation.digestRun")
		.map(
			(call) =>
				call.args as [string, { input: string; model?: string }],
		);
}

/** Read one of alice's state files as JSON (throws when absent). */
async function readState(host: FakeHost, name: string): Promise<unknown> {
	return JSON.parse(
		await readFile(join(host.stores.user(ALICE).paths.state, name), "utf8"),
	);
}

/** Script `digestRun` to answer each call with the next scripted result. */
function scriptDigestRuns(
	host: FakeHost,
	results: CurationRunResult[],
): { reviewIds: string[] } {
	const queue = [...results];
	const reviewIds: string[] = [];
	host.setCuration({
		digestRun: async (_user, opts) => {
			reviewIds.push(opts.reviewId);
			const next = queue.shift();
			if (next === undefined) throw new Error("fake host: digestRun not scripted");
			return next;
		},
	});
	return { reviewIds };
}

/** One view entry fixture. */
function entry(id: number, kind: string, role: string, text: string): ViewEntry {
	return { id, kind, model: [{ role, content: text }] };
}

// ─── Scenario 1: overlay keep / drop / rewrite ─────────────────────────────

describe("overlay re-check", () => {
	/** Three drifted overlays, one of each verdict shape. */
	async function setupThree() {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		const puts: (readonly [string, string, string])[] = [];
		const removes: string[] = [];
		const rows = new Map<string, CurationOverlay>([
			["acme-keep", overlayOf("acme-keep", { hash: "old-keep" })],
			["acme-drop", overlayOf("acme-drop", { hash: "old-drop" })],
			["acme-rewrite", overlayOf("acme-rewrite", { hash: "old-rewrite" })],
		]);
		host.setCuration({
			overlays: (user) => ({
				...scriptable(host).defaults.overlays(user),
				get: async (k) => rows.get(k.skill),
				put: async (k, text, hash) => {
					puts.push([k.skill, text, hash]);
					return scriptable(host).defaults.overlays(user).put(k, text, hash, {
						actor: "curator",
					});
				},
				remove: async (k, meta) => {
					removes.push(k.skill);
					return scriptable(host).defaults.overlays(user).remove(k, meta);
				},
			}),
			upstream: async (_user, k) =>
				rows.has(k.skill)
					? { body: `new ${k.skill} body`, hash: `new-${k.skill}` }
					: undefined,
		});
		await new OverlayRecheckQueue(host, ALICE).enqueue([
			key("acme-keep"),
			key("acme-drop"),
			key("acme-rewrite"),
		]);
		return { host, puts, removes };
	}

	test("keep / drop / rewrite verdicts apply the right store change", async () => {
		const { host, puts, removes } = await setupThree();
		try {
			await host.stores.user(ALICE).settings.set({ idleModel: "acme/idle" });
			scriptDigestRuns(host, [
				completed('{"verdict":"keep"}'),
				completed('{"verdict":"drop"}'),
				completed('{"verdict":"rewrite","text":"fresh acme notes"}'),
			]);

			const deps = stepDeps(host, 12);
			await recheckOverlays(deps);

			// keep re-anchors the SAME overlay text on the NEW hash; drop
			// removes; rewrite puts the verdict's new text on the new hash.
			expect(puts).toEqual([
				["acme-keep", "acme-keep notes", "new-acme-keep"],
				["acme-rewrite", "fresh acme notes", "new-acme-rewrite"],
			]);
			expect(removes).toEqual(["acme-drop"]);
			// Every verdict was ONE digestRun on the idle model, and the
			// re-check queue drained (three runs spent).
			const runs = digestRuns(host.calls);
			expect(runs).toHaveLength(3);
			expect(runs.every(([, opts]) => opts.model === "acme/idle")).toBe(true);
			expect(deps.budget.spent()).toBe(3);
			// Each input carries the overlay text, the hash it was written
			// against (the old version) and the NEW upstream body.
			expect(runs[0][1].input).toContain("acme-keep notes");
			expect(runs[0][1].input).toContain("old-keep");
			expect(runs[0][1].input).toContain("new acme-keep body");
			expect(runs[2][1].input).toContain("old-rewrite");
			expect(runs[2][1].input).toContain("new acme-rewrite body");
			await expect(new OverlayRecheckQueue(host, ALICE).take()).resolves.toEqual(
				[],
			);
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 2: unsure raises one interaction, the answer applies ─────────

describe("overlay unsure", () => {
	/** One drifted overlay the run cannot decide on. */
	async function setupUnsure() {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		const recent = await host.conversations.create({ owner: ALICE });
		const older = await host.conversations.create({ owner: ALICE });
		host.setLastActivity(recent, new Date(NOW.getTime() - 60_000).toISOString());
		host.setLastActivity(older, new Date(NOW.getTime() - 3_600_000).toISOString());
		const puts: (readonly [string, string, string])[] = [];
		const removes: string[] = [];
		host.setCuration({
			overlays: (user) => ({
				...scriptable(host).defaults.overlays(user),
				get: async (k) =>
					k.skill === "acme-unsure"
						? overlayOf("acme-unsure", { hash: "old", text: "unsure notes" })
						: undefined,
				put: async (k, text, hash) => {
					puts.push([k.skill, text, hash]);
					return scriptable(host).defaults.overlays(user).put(k, text, hash, {
						actor: "curator",
					});
				},
				remove: async (k, meta) => {
					removes.push(k.skill);
					return scriptable(host).defaults.overlays(user).remove(k, meta);
				},
			}),
			upstream: async () => ({ body: "new body", hash: "new-hash" }),
		});
		await new OverlayRecheckQueue(host, ALICE).enqueue([key("acme-unsure")]);
		return { host, recent, older, puts, removes };
	}

	test("unsure seeds one question in a NEW conversation owned by the user; a keep answer applies", async () => {
		const { host, recent, older, puts } = await setupUnsure();
		try {
			scriptDigestRuns(host, [completed('{"verdict":"unsure"}')]);

			await recheckOverlays(stepDeps(host, 12));

			// Exactly ONE interaction, in a conversation created for it
			// (owned by the user) — never an existing one from the list.
			const seeds = host.calls.filter((call) => call.method === "seedInteraction");
			expect(seeds).toHaveLength(1);
			const askedIn = seeds[0].args[0] as number;
			expect(askedIn).not.toBe(recent);
			expect(askedIn).not.toBe(older);
			const creates = host.calls.filter(
				(call) => call.method === "conversations.create",
			);
			expect(creates).toHaveLength(3); // the two fixtures + the question conversation
			expect(creates[2].args[0]).toMatchObject({ owner: ALICE });
			const callId = seeds[0].args[1] as string;
			const record = host.interactions.get(`${askedIn}:${callId}`)!;
			expect(record.kind).toBe(CURATOR_OVERLAY_QUESTION_KIND);
			expect(record.status).toBe("pending");
			// `details` carries what the settled handler needs: whose overlay,
			// which key, the remembered text/hash, and the call id.
			expect(record.details).toEqual({
				user: ALICE,
				key: key("acme-unsure"),
				upstreamHash: "new-hash",
				overlayText: "unsure notes",
				callId: record.details?.callId,
			});
			expect(typeof record.details?.callId).toBe("string");
			// The body asks exactly keep / drop (the choice sits in a
			// section — a form's children are fields and sections).
			const form = record.body as unknown as {
				root: {
					children: {
						type: string;
						children: { type: string; options: { id: string }[] }[];
					}[];
				};
			};
			expect(form.root.children[0].type).toBe("section");
			const fields = form.root.children[0].children;
			const choice = fields.find((field) => field.type === "choice")!;
			expect(choice.options.map((option) => option.id)).toEqual(["keep", "drop"]);
			// Nothing was decided yet.
			expect(puts).toEqual([]);

			// The user answers KEEP; the settled handler applies it.
			await host.answerInteraction(askedIn as ConversationId, callId, { values: { verdict: "keep" } }, CONTEXT);
			// The lifecycle event carries the STORED answer values directly.
			const answers = overlayQuestionHandler(host);
			const onSettled = answers.interactionSettled!;
			await onSettled(
				{
					conversationId: askedIn as ConversationId,
					callId,
					kind: CURATOR_OVERLAY_QUESTION_KIND,
					status: "answered",
					answer: { verdict: "keep" },
					owner: ALICE,
				},
				API,
				CONTEXT,
			);

			// keep → the overlay text re-anchored on the new hash.
			expect(puts).toEqual([["acme-unsure", "unsure notes", "new-hash"]]);
		} finally {
			await host.close();
		}
	});

	test("a drop answer removes the overlay; a non-answered settle drops the question and changes nothing", async () => {
		const { host, removes, puts } = await setupUnsure();
		try {
			scriptDigestRuns(host, [completed('{"verdict":"unsure"}')]);
			await recheckOverlays(stepDeps(host, 12));
			const seeds = host.calls.filter((call) => call.method === "seedInteraction");
			expect(seeds).toHaveLength(1);
			const askedIn = seeds[0].args[0] as number;
			const callId = seeds[0].args[1] as string;

			// Cancelled (a terminal non-answer): the question leaves the
			// file, the overlay changes nothing.
			const handler = overlayQuestionHandler(host).interactionSettled!;
			await handler(
				{
					conversationId: askedIn as ConversationId,
					callId,
					kind: CURATOR_OVERLAY_QUESTION_KIND,
					status: "cancelled",
					owner: ALICE,
				},
				API,
				CONTEXT,
			);
			expect(removes).toEqual([]);
			expect(puts).toEqual([]);
			const file = (await readState(host, "overlay-questions.json")) as {
				questions: Record<string, unknown>;
			};
			expect(Object.keys(file.questions)).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("a drop answer removes the overlay and the question leaves the file", async () => {
		const { host, removes, puts } = await setupUnsure();
		try {
			scriptDigestRuns(host, [completed('{"verdict":"unsure"}')]);
			await recheckOverlays(stepDeps(host, 12));
			const seeds = host.calls.filter((call) => call.method === "seedInteraction");
			const askedIn = seeds[0].args[0] as number;
			const callId = seeds[0].args[1] as string;

			// Answer DROP, then settle: removed, and the entry is gone.
			await host.answerInteraction(askedIn as ConversationId, callId, { values: { verdict: "drop" } }, CONTEXT);
			const handler = overlayQuestionHandler(host).interactionSettled!;
			await handler(
				{
					conversationId: askedIn as ConversationId,
					callId,
					kind: CURATOR_OVERLAY_QUESTION_KIND,
					status: "answered",
					answer: { verdict: "drop" },
					owner: ALICE,
				},
				API,
				CONTEXT,
			);
			expect(removes).toEqual(["acme-unsure"]);
			expect(puts).toEqual([]);
			const file = (await readState(host, "overlay-questions.json")) as {
				questions: Record<string, unknown>;
			};
			expect(Object.keys(file.questions)).toEqual([]);
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 2b: overlay questions — the bounded v2 file and the new conversation ───

describe("overlay questions (v2)", () => {
	/** Script drifted overlays + unsure runs for the named skills. */
	async function setupUnsureSkills(host: FakeHost, skills: readonly string[]) {
		host.setCuration({
			overlays: (user) => ({
				...scriptable(host).defaults.overlays(user),
				get: async (k) =>
					skills.includes(k.skill)
						? overlayOf(k.skill, { hash: "old" })
						: undefined,
			}),
			upstream: async (_user, k) =>
				skills.includes(k.skill)
					? { body: `new ${k.skill} body`, hash: `new-${k.skill}` }
					: undefined,
		});
		await new OverlayRecheckQueue(host, ALICE).enqueue(skills.map(key));
		scriptDigestRuns(
			host,
			skills.map(() => completed('{"verdict":"unsure"}')),
		);
	}

	/** Write alice's pending-questions file verbatim (a v1 array or a v2 object). */
	async function writeQuestions(host: FakeHost, value: unknown): Promise<void> {
		const state = host.stores.user(ALICE).paths.state;
		await mkdir(state, { recursive: true });
		await writeFile(
			join(state, "overlay-questions.json"),
			`${JSON.stringify(value)}\n`,
			"utf8",
		);
	}

	/** Read alice's pending-questions file in its v2 shape. */
	async function readQuestions(
		host: FakeHost,
	): Promise<{
		v: number;
		questions: Record<string, { callId: string; conversationId: number }>;
		legacy: { callId: string }[];
	}> {
		return (await readState(host, "overlay-questions.json")) as never;
	}

	/** One pending-question fixture (the shape both file versions share). */
	function question(
		skill: string,
		callId: string,
		conversationId?: number,
	): Record<string, unknown> {
		return {
			user: ALICE,
			key: key(skill),
			upstreamHash: `${skill}-hash`,
			overlayText: `${skill} notes`,
			callId,
			...(conversationId === undefined ? {} : { conversationId }),
		};
	}

	test("an unsure verdict asks in a new conversation owned by the user", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// Pre-existing owned conversations the question must NOT land in.
			const existing = await host.conversations.create({ owner: ALICE });
			host.setLastActivity(existing, NOW.toISOString());
			await setupUnsureSkills(host, ["acme-solo"]);

			await recheckOverlays(stepDeps(host, 12));

			const seeds = host.calls.filter((call) => call.method === "seedInteraction");
			expect(seeds).toHaveLength(1);
			const askedIn = seeds[0].args[0] as number;
			expect(askedIn).not.toBe(existing);
			// The new conversation is the user's, titled for what it holds.
			const meta = await host.conversations.meta(askedIn as ConversationId);
			expect(meta.owner).toBe(ALICE);
			expect(meta.name).toBe('Your notes on "acme-solo"');
			// The pending file carries the question under its key, with the
			// conversation it was asked in.
			const file = await readQuestions(host);
			expect(file.v).toBe(2);
			expect(Object.keys(file.questions)).toEqual([keyId(key("acme-solo"))]);
			expect(Object.values(file.questions)[0].conversationId).toBe(askedIn);
			expect(file.legacy).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("unsure verdicts in one recheck share one new conversation", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await setupUnsureSkills(host, ["acme-one", "acme-two"]);

			await recheckOverlays(stepDeps(host, 12));

			const creates = host.calls.filter(
				(call) => call.method === "conversations.create",
			);
			expect(creates).toHaveLength(1);
			const seeds = host.calls.filter((call) => call.method === "seedInteraction");
			expect(seeds).toHaveLength(2);
			expect(seeds[0].args[0]).toBe(seeds[1].args[0]);
			const askedIn = seeds[0].args[0] as number;
			// One notice, targeting the new conversation.
			const notices = host.calls.filter((call) => call.method === "notify");
			expect(notices).toHaveLength(1);
			const notice = notices[0].args[0] as {
				kind: string;
				title: string;
				body: string;
				target?: { conversation: number };
			};
			expect(notice.kind).toBe("curator.overlay-question");
			expect(notice.title).toBe("Notes to review");
			expect(notice.target).toEqual({ conversation: askedIn });
			// The second question renamed the conversation for what it holds.
			const patches = host.calls.filter(
				(call) => call.method === "conversations.patchMeta",
			);
			expect(patches).toHaveLength(1);
			expect(patches[0].args[0]).toBe(askedIn);
			expect(patches[0].args[1]).toEqual({ name: "Your notes on 2 skills" });
		} finally {
			await host.close();
		}
	});

	test("re-asking a skill cancels the open question", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await writeQuestions(host, {
				v: 2,
				questions: {
					[keyId(key("acme-reask"))]: question("acme-reask", "old-open", 42),
				},
				legacy: [],
			});
			await setupUnsureSkills(host, ["acme-reask"]);

			await recheckOverlays(stepDeps(host, 12));

			const settles = host.calls.filter(
				(call) => call.method === "settleInteraction",
			);
			expect(settles).toHaveLength(1);
			expect(settles[0].args.slice(0, 3)).toEqual([42, "old-open", "cancelled"]);
			const file = await readQuestions(host);
			expect(Object.values(file.questions)).toHaveLength(1);
			expect(Object.values(file.questions)[0].callId).not.toBe("old-open");
		} finally {
			await host.close();
		}
	});

	test("re-ask still asks when the old conversation is gone", async () => {
		for (const behavior of ["false", { reject: new Error("gone") }] as const) {
			const host = await createFakeHost({ users: [{ user: ALICE }] });
			try {
				host.setSettleBehavior(behavior);
				await writeQuestions(host, {
					v: 2,
					questions: {
						[keyId(key("acme-gone"))]: question("acme-gone", "old-gone", 42),
					},
					legacy: [],
				});
				await setupUnsureSkills(host, ["acme-gone"]);

				await recheckOverlays(stepDeps(host, 12));

				const seeds = host.calls.filter(
					(call) => call.method === "seedInteraction",
				);
				expect(seeds).toHaveLength(1);
				const file = await readQuestions(host);
				expect(Object.values(file.questions)).toHaveLength(1);
				expect(Object.values(file.questions)[0].callId).not.toBe("old-gone");
			} finally {
				await host.close();
			}
		}
	});

	test("a skipped, cancelled or expired question leaves the file and the overlay unchanged", async () => {
		for (const status of ["skipped", "cancelled", "expired"] as const) {
			const host = await createFakeHost({ users: [{ user: ALICE }] });
			try {
				const convId = await host.conversations.create({ owner: ALICE });
				const callId = `acme-q-${status}`;
				await writeQuestions(host, {
					v: 2,
					questions: {
						[keyId(key("acme-settled"))]: question("acme-settled", callId, convId),
					},
					legacy: [],
				});
				const writes: string[] = [];
				host.setCuration({
					overlays: (user) => ({
						...scriptable(host).defaults.overlays(user),
						put: async (k) => {
							writes.push(`put:${k.skill}`);
							return scriptable(host)
								.defaults.overlays(user)
								.put(k, "", "", { actor: "curator" });
						},
						remove: async (k, meta) => {
							writes.push(`remove:${k.skill}`);
							return scriptable(host).defaults.overlays(user).remove(k, meta);
						},
					}),
				});

				const handler = overlayQuestionHandler(host).interactionSettled!;
				await handler(
					{
						conversationId: convId,
						callId,
						kind: CURATOR_OVERLAY_QUESTION_KIND,
						status,
						owner: ALICE,
					},
					API,
					CONTEXT,
				);

				expect(writes).toEqual([]);
				const file = await readQuestions(host);
				expect(Object.keys(file.questions)).toEqual([]);
				expect(file.legacy).toEqual([]);
			} finally {
				await host.close();
			}
		}
	});

	test("answered keep re-anchors and drop removes; the entry leaves the file", async () => {
		for (const verdict of ["keep", "drop"] as const) {
			const host = await createFakeHost({ users: [{ user: ALICE }] });
			try {
				const convId = await host.conversations.create({ owner: ALICE });
				const callId = `acme-answered-${verdict}`;
				await writeQuestions(host, {
					v: 2,
					questions: {
						[keyId(key("acme-verdict"))]: question("acme-verdict", callId, convId),
					},
					legacy: [],
				});
				const puts: string[] = [];
				const removes: string[] = [];
				host.setCuration({
					overlays: (user) => ({
						...scriptable(host).defaults.overlays(user),
						put: async (k, text, hash) => {
							puts.push(`${k.skill}|${text}|${hash}`);
							return scriptable(host)
								.defaults.overlays(user)
								.put(k, text, hash, { actor: "curator" });
						},
						remove: async (k, meta) => {
							removes.push(k.skill);
							return scriptable(host).defaults.overlays(user).remove(k, meta);
						},
					}),
				});

				const handler = overlayQuestionHandler(host).interactionSettled!;
				await handler(
					{
						conversationId: convId,
						callId,
						kind: CURATOR_OVERLAY_QUESTION_KIND,
						status: "answered",
						answer: { verdict },
						owner: ALICE,
					},
					API,
					CONTEXT,
				);

				if (verdict === "keep") {
					expect(puts).toEqual(["acme-verdict|acme-verdict notes|acme-verdict-hash"]);
					expect(removes).toEqual([]);
				} else {
					expect(removes).toEqual(["acme-verdict"]);
					expect(puts).toEqual([]);
				}
				const file = await readQuestions(host);
				expect(Object.keys(file.questions)).toEqual([]);
			} finally {
				await host.close();
			}
		}
	});

	test("a legacy array file is migrated without losing questions", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// A v1 file: THREE entries, two for one skill.
			await writeQuestions(host, [
				question("acme-dupe", "legacy-dupe-1"),
				question("acme-dupe", "legacy-dupe-2"),
				question("acme-other", "legacy-other"),
			]);
			await setupUnsureSkills(host, ["acme-new"]);

			await recheckOverlays(stepDeps(host, 12));

			const file = await readQuestions(host);
			expect(file.v).toBe(2);
			// The v1 entries moved to `legacy` unchanged (no conversationId,
			// no cancellation); the new question went to `questions`.
			expect(file.legacy.map((entry) => entry.callId)).toEqual([
				"legacy-dupe-1",
				"legacy-dupe-2",
				"legacy-other",
			]);
			expect(Object.keys(file.questions)).toEqual([keyId(key("acme-new"))]);
		} finally {
			await host.close();
		}
	});

	test("a legacy question is still applied when answered", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await writeQuestions(host, [question("acme-legacy", "legacy-keep")]);
			const puts: string[] = [];
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					put: async (k, text, hash) => {
						puts.push(`${k.skill}|${text}|${hash}`);
						return scriptable(host)
							.defaults.overlays(user)
							.put(k, text, hash, { actor: "curator" });
					},
				}),
			});

			const handler = overlayQuestionHandler(host).interactionSettled!;
			await handler(
				{
					conversationId: 7 as ConversationId,
					callId: "legacy-keep",
					kind: CURATOR_OVERLAY_QUESTION_KIND,
					status: "answered",
					answer: { verdict: "keep" },
					owner: ALICE,
				},
				API,
				CONTEXT,
			);

			// keep re-anchored the remembered text on the remembered hash,
			// and the legacy entry left the file (migrated to the v2 shape).
			expect(puts).toEqual(["acme-legacy|acme-legacy notes|acme-legacy-hash"]);
			const file = await readQuestions(host);
			expect(file.v).toBe(2);
			expect(file.legacy).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("re-asking a skill that has only a legacy entry still asks", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await writeQuestions(host, [question("acme-reask", "legacy-reask")]);
			await setupUnsureSkills(host, ["acme-reask"]);

			await recheckOverlays(stepDeps(host, 12));

			// The legacy entry has no conversation to cancel: no settle call,
			// legacy untouched, and the NEW question asked under the key.
			expect(
				host.calls.some((call) => call.method === "settleInteraction"),
			).toBe(false);
			const file = await readQuestions(host);
			expect(file.legacy.map((entry) => entry.callId)).toEqual(["legacy-reask"]);
			expect(Object.keys(file.questions)).toEqual([keyId(key("acme-reask"))]);
			expect(
				Object.values(file.questions)[0].callId,
			).not.toBe("legacy-reask");
		} finally {
			await host.close();
		}
	});

	test("a failed notice does not lose the question", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			host.setNotifyBehavior({ reject: new Error("notifier down") });
			await setupUnsureSkills(host, ["acme-notify"]);

			// The step does not throw on the failed notice...
			await recheckOverlays(stepDeps(host, 12));

			// ...the notice WAS attempted...
			expect(host.calls.some((call) => call.method === "notify")).toBe(true);
			// ...and the question is seeded and on file regardless.
			expect(
				host.calls.filter((call) => call.method === "seedInteraction"),
			).toHaveLength(1);
			const file = await readQuestions(host);
			expect(Object.keys(file.questions)).toEqual([keyId(key("acme-notify"))]);
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 3: the digest never includes bob's turns ─────────────────────

describe("reviewDigest (the digests step)", () => {
	/** Script the curation reads the digest step makes. */
	function scriptDigestReads(host: FakeHost, inputs: string[]) {
		host.setCuration({
			targets: async () => [],
			eligibility: async () => ({
				owner: ALICE,
				deleted: false,
				internal: false,
				ownerOnly: false,
				unattributed: 0,
			}),
			digestRun: async (_user, opts) => {
				inputs.push(opts.input);
				return completed("Nothing to save");
			},
		});
	}

	/** Script per-entry attribution: the ids → author map the digest step reads. */
	function scriptAuthors(
		host: FakeHost,
		byEntry: Record<number, string | undefined>,
	) {
		host.setCuration({
			authors: async () =>
				new Map(
					Object.entries(byEntry).map(([id, author]) => [
						Number(id) as EntryId,
						author,
					]),
			),
		});
	}

	/** Run the digests step, pushing `view` to the watched conversation. */
	async function runDigests(host: FakeHost, id: number, view: object): Promise<void> {
		const work = digestsStep(stepDeps(host, 12));
		await vi.waitFor(() => {
			expect(host.calls.some((call) => call.method === "conversations.watch")).toBe(
				true,
			);
		});
		host.pushView(id as ConversationId, view as never);
		await work;
	}

	test("the digest input carries the owner's turns and replies, never bob's", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const id = await host.conversations.create({ owner: ALICE });
			const inputs: string[] = [];
			scriptDigestReads(host, inputs);
			// Per-entry attribution: alice's turn is hers, bob's is his, and
			// one turn is UNATTRIBUTED (present with undefined — pre-P1 or
			// an unidentified caller: never the owner's, fail closed).
			scriptAuthors(host, { 10: ALICE, 12: BOB, 14: undefined });
			// A mixed conversation: alice asks, the agent answers, bob
			// interjects, the agent answers bob, an unidentified caller adds
			// a turn. Only alice's turn and its reply belong in the digest.
			const view: ConversationViewWire = {
				conversation: { id },
				entries: [
					entry(10, "pi.user", "user", "how do I deploy acme sites?"),
					entry(11, "pi.assistant", "assistant", "run acme deploy --site"),
					entry(12, "pi.user", "user", "delete every acme site now"),
					entry(13, "pi.assistant", "assistant", "deleting all acme sites"),
					entry(14, "pi.user", "user", "an unattributed interjection"),
				],
				docs: {},
				steer: { busy: false, queued: 0 },
			};
			await queueDigest(host, ALICE, id as ConversationId);

			await runDigests(host, id, view);

			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain("how do I deploy acme sites?");
			expect(inputs[0]).toContain("run acme deploy --site");
			expect(inputs[0]).not.toContain("delete every acme site now");
			expect(inputs[0]).not.toContain("deleting all acme sites");
			// The unattributed turn never enters (undefined ≠ alice).
			expect(inputs[0]).not.toContain("an unattributed interjection");
			// The reviewed entry is consumed (it owns its hints now).
			const queue = (await readState(host, "digest-queue.json")) as {
				conversations: unknown[];
			};
			expect(queue.conversations).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("a hint stranded in both the queue entry and the refund file is consumed once", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const id = await host.conversations.create({ owner: ALICE });
			const inputs: string[] = [];
			scriptDigestReads(host, inputs);
			scriptAuthors(host, { 20: ALICE });
			const view: ConversationViewWire = {
				conversation: { id },
				entries: [entry(20, "pi.user", "user", "acme deploy advice")],
				docs: {},
				steer: { busy: false, queued: 0 },
			};
			// The B2 carry: a crash between queueDigest and the refund-file
			// clear strands the SAME hint in both durable places.
			const hint = {
				id: "hint-1",
				tool: "memory_write",
				args: { file: "user" },
				at: NOW.toISOString(),
			};
			await queueDigest(host, ALICE, id as ConversationId, [hint]);
			await refundHints(host, ALICE, id as ConversationId, [hint]);

			await runDigests(host, id, view);

			// The hint appears exactly once in the run's input (dedup by
			// hint id at consumption — the instruction prints each hint
			// once, so its tool name appears once)...
			expect(inputs).toHaveLength(1);
			expect(inputs[0].split("memory_write").length - 1).toBe(1);
			// ...and both durable places are drained after the review.
			const queue = (await readState(host, "digest-queue.json")) as {
				conversations: unknown[];
			};
			expect(queue.conversations).toEqual([]);
			expect(await readState(host, "pending-hints.json")).toEqual([]);
		} finally {
			await host.close();
		}
	});

	test("an owner-only conversation without the authors doc digests every turn", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const id = await host.conversations.create({ owner: ALICE });
			const inputs: string[] = [];
			host.setCuration({
				targets: async () => [],
				eligibility: async () => ({
					owner: ALICE,
					deleted: false,
					internal: false,
					ownerOnly: true,
					unattributed: 0,
				}),
				digestRun: async (_user, opts) => {
					inputs.push(opts.input);
					return completed("Nothing to save");
				},
			});
			const view: ConversationViewWire = {
				conversation: { id },
				entries: [entry(30, "pi.user", "user", "acme release checklist")],
				docs: {},
				steer: { busy: false, queued: 0 },
			};
			await queueDigest(host, ALICE, id as ConversationId);

			await runDigests(host, id, view);

			expect(inputs).toHaveLength(1);
			expect(inputs[0]).toContain("acme release checklist");
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 4: a reported loss is undone ─────────────────────────────────

describe("dietOne (the diet step)", () => {
	test("a compare run reporting loss undoes the rewrite via skills.undo", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			let fedRewrite = false;
			const undone: (readonly string[])[] = [];
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => [skill("acme-big", { bytes: 40_000, createdDaysAgo: 3 })],
					view: async (name) =>
						name === "acme-big" && fedRewrite
							? "# acme big\ncore only"
							: "# acme big\n## Section One\nlong body",
					undo: async (entryIds) => {
						undone.push([...entryIds]);
						return [];
					},
				}),
			});
			// The scripted run: the FIRST digestRun is the rewrite (it
			// reports its moved sections), the SECOND is the compare (a
			// reported loss) — and the view flips once the rewrite fired.
			// The fake records the call BEFORE the script runs, so "already
			// recorded" counts include THIS call.
			host.setCuration({
				digestRun: async () => {
					const recorded = host.calls.filter(
						(call) => call.method === "curation.digestRun",
					).length;
					const isFirst = recorded <= 1;
					if (!isFirst) fedRewrite = true;
					return isFirst
						? completed("moved 2 sections", [
								{ changeId: "c1", summary: "moved sections", target: "skill" },
							])
						: completed('{"loss": true}');
				},
			});

			await dietStep(stepDeps(host, 12));

			// The compare reported loss → the rewrite's changes were undone
			// through skills.undo, by the change ids the run reported.
			expect(undone).toEqual([["c1"]]);
			expect(digestRuns(host.calls)).toHaveLength(2);
		} finally {
			await host.close();
		}
	});

	test("a compare run reporting no loss keeps the rewrite; small or fresh skills are untouched", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			let fedRewrite = false;
			const undone: (readonly string[])[] = [];
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => [
						skill("acme-big", { bytes: 40_000, createdDaysAgo: 3 }),
						skill("acme-small", { bytes: 2_000, createdDaysAgo: 30 }),
						skill("acme-fresh", { bytes: 40_000, createdDaysAgo: 3 }),
					],
					view: async (name) =>
						name === "acme-big" && fedRewrite ? "# acme big\ncore only" : "# acme big\n## Section One\nlong body",
					undo: async (entryIds) => {
						undone.push([...entryIds]);
						return [];
					},
					feed: async () => [
						{
							id: "feed-fresh",
							at: new Date(NOW.getTime() - 3_600_000).toISOString(),
							actor: "curator",
							action: "patch",
							skill: "acme-fresh",
						},
					],
				}),
				digestRun: async () => {
					const recorded = host.calls.filter(
						(call) => call.method === "curation.digestRun",
					).length;
					fedRewrite = recorded > 1;
					return recorded <= 1
						? completed("moved 2 sections", [
								{ changeId: "c1", summary: "moved sections", target: "skill" },
							])
						: completed('{"loss": false}');
				},
			});

			await dietStep(stepDeps(host, 12));

			// No loss → the rewrite stands (no undo), and only the eligible
			// oversized-unchanged skill was dieted (two runs total).
			expect(undone).toEqual([]);
			expect(digestRuns(host.calls)).toHaveLength(2);
			const name = digestRuns(host.calls)[0][1].input;
			expect(name).toContain("acme-big");
			expect(name).not.toContain("acme-small");
			expect(name).not.toContain("acme-fresh");
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 5: merge archives the absorbed skill with absorbed_into ──────

describe("mergeOne (the merge step)", () => {
	function scriptMerge(
		host: FakeHost,
		rows: readonly CurationSkillInfo[],
		run: () => CurationRunResult,
	): (readonly [string, CurationSkillChange])[] {
		const applied: (readonly [string, CurationSkillChange])[] = [];
		host.setCuration({
			skills: (user) => ({
				...scriptable(host).defaults.skills(user),
				list: async () => rows,
				apply: async (name, change) => {
					applied.push([name, change]);
					return scriptable(host).defaults.skills(user).apply(name, change, {});
				},
			}),
			undoReview: async () => 0,
			digestRun: async () => run(),
		});
		return applied;
	}

	test("a same-class pair merges: the step archives the other skill with absorbed_into", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [skill("acme-deploy"), skill("acme-deploys")];
			const applied = scriptMerge(host, rows, () =>
				completed(
					'{"merge": ["acme-deploy", "acme-deploys"], "survivor": "acme-deploy"}',
					[
						{
							changeId: "m1",
							summary: "merged acme-deploys into acme-deploy",
							target: "skill",
						},
					],
				),
			);

			const deps = stepDeps(host, 12);
			await mergeStep(deps);

			// The run patched the survivor; the step archived the other
			// skill naming its survivor.
			expect(applied).toEqual([
				["acme-deploys", { kind: "archive", absorbedInto: "acme-deploy" }],
			]);
			// A valid verdict keeps the run's changes (no undo).
			expect(
				host.calls.some((call) => call.method === "curation.undoReview"),
			).toBe(false);
		} finally {
			await host.close();
		}
	});

	test("a verdict naming unknown skills changes nothing", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const rows = [skill("acme-deploy"), skill("acme-deploys")];
			const applied = scriptMerge(host, rows, () =>
				completed('{"merge": ["acme-deploy", "acme-hallucinated"], "survivor": "acme-deploy"}', [
					{ changeId: "m1", summary: "patched", target: "skill" },
				]),
			);

			await mergeStep(stepDeps(host, 12));

			expect(applied).toEqual([]);
			// The run DID change something (patched the survivor for a merge
			// that cannot complete) — the review is undone (net: no change).
			expect(
				host.calls.some((call) => call.method === "curation.undoReview"),
			).toBe(true);
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 6: targets get the remaining budget; the cap stops the pass ──

describe("maintainTargets and the daily cap", () => {
	/** Write the extension's first-tick state 25 h in the past. */
	async function pastGrace(host: FakeHost): Promise<void> {
		await mkdir(host.stores.paths.state, { recursive: true });
		await writeFile(
			join(host.stores.paths.state, FIRST_TICK_FILE),
			`${JSON.stringify({ firstTickAt: new Date(NOW.getTime() - 25 * 3_600_000).toISOString() })}\n`,
			"utf8",
		);
	}

	/** Seed alice's pass cursor mid-pass. */
	async function seedPass(
		host: FakeHost,
		cursor: { done: number; dailyRunsUsed: number },
	): Promise<void> {
		const state = host.stores.user(ALICE).paths.state;
		await mkdir(state, { recursive: true });
		await writeFile(
			join(state, PASS_FILE),
			`${JSON.stringify({
				startedAt: NOW.toISOString(),
				steps: [...PASS_STEPS],
				done: cursor.done,
				dailyRunsUsed: cursor.dailyRunsUsed,
				day: NOW.toISOString().slice(0, 10),
			})}\n`,
			"utf8",
		);
	}

	test("targets get the tick deadline and the remaining runs; the pass completes", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await pastGrace(host);
			// No conversations at all: quiet. steps[6] = "targets".
			await seedPass(host, { done: 6, dailyRunsUsed: 3 });
			const budgets: (readonly [string, object])[] = [];
			host.setCuration({
				targets: async () => [
					{
						id: "memory:files",
						tools: ["memory_write"],
						guidance: ["keep entries under budget"],
						maintain: true,
					},
					{
						id: "memory:none",
						tools: [],
						guidance: [],
						maintain: false,
					},
				],
				maintain: async (_user, targetId, b) => {
					budgets.push([targetId, { ...b }]);
					return { changes: [] };
				},
			});

			await tick(host, now);

			// Only the maintain-capable target ran, with the tick deadline
			// and the remaining daily runs (12 - 3).
			expect(budgets).toEqual([
				[
					"memory:files",
					{ deadline: NOW.getTime() + LOOP2_TICK_DEADLINE_MS, runs: 9 },
				],
			]);
			// The pass completed (maintain spends nothing the cursor counts).
			const pass = (await readState(host, PASS_FILE)) as {
				done: number;
				dailyRunsUsed: number;
			};
			expect(pass.done).toBe(PASS_STEPS.length);
			expect(pass.dailyRunsUsed).toBe(3);
		} finally {
			await host.close();
		}
	});

	test("the daily cap stops the pass for the day (cursor does not advance)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			await pastGrace(host);
			// steps[2] = "overlay-recheck" (the first model step).
			await seedPass(host, { done: 2, dailyRunsUsed: 12 });
			const maintained: string[] = [];
			host.setCuration({
				maintain: async (_user, targetId) => {
					maintained.push(targetId);
					return { changes: [] };
				},
			});

			await tick(host, now);

			// No model run happened and no target was maintained...
			expect(digestRuns(host.calls)).toHaveLength(0);
			expect(maintained).toEqual([]);
			// ...and the cursor still points at the step it could not run —
			// the next tick (or a new day) resumes exactly there.
			const pass = (await readState(host, PASS_FILE)) as {
				done: number;
				dailyRunsUsed: number;
			};
			expect(pass.done).toBe(2);
			expect(pass.dailyRunsUsed).toBe(12);
		} finally {
			await host.close();
		}
	});

	test("maintainTargets hands each capable target the deadline and remaining runs", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const budgets: (readonly [string, object])[] = [];
			host.setCuration({
					targets: async () => [
						{
							id: "memory:files",
							tools: ["memory_write"],
							guidance: [],
							maintain: true,
						},
						{
							id: "memory:inactive",
							tools: [],
							guidance: [],
							maintain: false,
						},
					],
					maintain: async (_user, targetId, b) => {
						budgets.push([targetId, { ...b }]);
						return { changes: [], more: true };
					},
				});

			const deps = stepDeps(host, 5);
			const proceed = await maintainTargets(deps);

			// Only the capable target ran, with the tick deadline and the
			// remaining runs; a target reporting `more` still lets the pass
			// finish (the next pass continues it).
			expect(proceed).toBe(true);
			expect(budgets).toEqual([
					[
						"memory:files",
						{ deadline: NOW.getTime() + LOOP2_TICK_DEADLINE_MS, runs: 5 },
					],
			]);
		} finally {
			await host.close();
		}
	});
});

// ─── Scenario 7: an unparseable verdict changes nothing ────────────────────

describe("an unparseable verdict", () => {
	test("an unparseable overlay verdict applies nothing (the run still spends budget)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const puts: string[] = [];
			const removes: string[] = [];
			host.setCuration({
				overlays: (user) => ({
					...scriptable(host).defaults.overlays(user),
					get: async (k) => overlayOf(k.skill, { hash: "old" }),
					put: async (k, text, hash) => {
						puts.push(k.skill);
						return scriptable(host).defaults.overlays(user).put(k, text, hash, {
							actor: "curator",
						});
					},
					remove: async (k, meta) => {
						removes.push(k.skill);
						return scriptable(host).defaults.overlays(user).remove(k, meta);
					},
				}),
				upstream: async () => ({ body: "new body", hash: "new" }),
			});
			await new OverlayRecheckQueue(host, ALICE).enqueue([key("acme-garbage")]);
			scriptDigestRuns(host, [completed("The overlay looks fine to me, honestly.")]);

			const deps = stepDeps(host, 12);
			await recheckOverlays(deps);

			expect(puts).toEqual([]);
			expect(removes).toEqual([]);
			// The run happened (and spent one daily run) — only the verdict
			// was unparseable, not the step.
			expect(deps.budget.spent()).toBe(1);
			await expect(new OverlayRecheckQueue(host, ALICE).take()).resolves.toEqual(
				[],
			);
		} finally {
			await host.close();
		}
	});

	test("an unparseable merge verdict with changes reverts them via undoReview", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const undone: (readonly [string, string])[] = [];
			let reviewId = "";
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => [skill("acme-a"), skill("acme-b")],
					apply: async (name, change) =>
						scriptable(host).defaults.skills(user).apply(name, change, {}),
				}),
				undoReview: async (user, id) => {
					undone.push([user, id]);
					return 1;
				},
				digestRun: async (_user, opts) => {
					reviewId = opts.reviewId;
					return completed("merged the two skills, they cover the same thing", [
							{ changeId: "m1", summary: "merged", target: "skill" },
						]);
				},
			});

			await mergeStep(stepDeps(host, 12));

			// Unparseable verdict + a run that wrote → the review is undone
			// (net: no change).
			expect(undone).toEqual([[ALICE, reviewId]]);
		} finally {
			await host.close();
		}
	});

	test("an unparseable diet compare undoes the rewrite (no unverified diet stands)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			let fedRewrite = false;
			const undone: (readonly string[])[] = [];
			host.setCuration({
				skills: (user) => ({
					...scriptable(host).defaults.skills(user),
					list: async () => [skill("acme-big", { bytes: 40_000, createdDaysAgo: 3 })],
					view: async () => (fedRewrite ? "# acme big\ncore only" : "# acme big\n## Section One\nlong body"),
					undo: async (entryIds) => {
						undone.push([...entryIds]);
						return [];
					},
				}),
				digestRun: async () => {
					const recorded = host.calls.filter(
						(call) => call.method === "curation.digestRun",
					).length;
					const isFirst = recorded <= 1;
					if (!isFirst) fedRewrite = true;
					return isFirst
						? completed("moved sections", [
								{ changeId: "c1", summary: "moved", target: "skill" },
							])
						: completed("looks fine I guess");
				},
			});

			await dietStep(stepDeps(host, 12));

			expect(undone).toEqual([["c1"]]);
		} finally {
			await host.close();
		}
	});
});

// ─── Digest allow-list gains served targets' read tools ────────────────────

describe("reviewDigest read tools (knowledge follow-up)", () => {
	test("the digest allow list carries served targets' readTools", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const id = await host.conversations.create({ owner: ALICE });
			const allows: (readonly string[])[] = [];
			host.setCuration({
				targets: async () => [
					{
						id: "knowledge",
						tools: ["knowledge_record"],
						readTools: ["knowledge_find"],
						guidance: ["find before creating"],
						maintain: false,
					},
				],
				eligibility: async () => ({
					owner: ALICE,
					deleted: false,
					internal: false,
					ownerOnly: false,
					unattributed: 0,
				}),
				digestRun: async (_user, opts) => {
					allows.push([...opts.allow]);
					return completed("Nothing to save");
				},
			});
			host.setCuration({
				authors: async () => new Map([[10 as EntryId, ALICE]]),
			});
			const view: ConversationViewWire = {
				conversation: { id },
				entries: [
					entry(10, "pi.user", "user", "research acme clinics"),
					entry(11, "pi.assistant", "assistant", "found three"),
				],
				docs: {},
				steer: { busy: false, queued: 0 },
			};
			await queueDigest(host, ALICE, id as ConversationId);

			const work = digestsStep(stepDeps(host, 12));
			await vi.waitFor(() => {
				expect(
					host.calls.some((call) => call.method === "conversations.watch"),
				).toBe(true);
			});
			host.pushView(id as ConversationId, view as never);
			await work;

			expect(allows).toHaveLength(1);
			expect(allows[0]).toContain("knowledge_record");
			// Read tools join the allow list so a digest review can call
			// knowledge_find (find-before-creating works on this path too).
			expect(allows[0]).toContain("knowledge_find");
		} finally {
			await host.close();
		}
	});
});
