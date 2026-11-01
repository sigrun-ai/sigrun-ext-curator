/**
 * Task B5 tests: the curator view (`src/view.ts`) — the per-user
 * surface with learned skills (pin toggle, archive/restore), overlays
 * (orphaned flag), the change feed grouped by review with an UNDO
 * REVIEW action, and a pause switch.
 *
 * The contract under test:
 *
 * - `render` reads the CALLING principal's stores (`ctx.principal`),
 *   and access follows `accessOf` over an owner-shaped resource: the
 *   owner and the superuser see their data ("write"); any other user
 *   gets `none` (bob sees nothing — not alice's skills, not the feed).
 * - The surface's `actions` reach the extension (unlike ambient
 *   bodies): `undoReview` reverts through `host.curation.undoReview`
 *   and then clears the notice conversation's ambient record; `pin`,
 *   `archive`/`restore` and `pause` write the stores.
 * - The tree validates against the server's own `validateTree`
 *   (placement `view`, handlers = the declared action keys) — the
 *   same check `SurfaceService.render` runs before serving.
 */

import { describe, expect, test } from "vitest";
import type {
	CurationFeedEntry,
	CurationOverlay,
	CurationSkillInfo,
	Principal,
	SurfaceContext,
} from "@sigrun/sigrun/extension";
import { validateTree } from "@sigrun/sigrun/blocks";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";
import { createCuratorView } from "../src/view.js";
import { notify } from "../src/notices.js";
import type { NoticeRecord } from "../src/notices.js";
import { CURATOR_NOTICE_KIND } from "../src/index.js";
import type { ConversationId } from "@earendil-works/pi-durable";

/** The users these fixtures walk (tests own their literals). */
const ALICE = "alice";
const BOB = "bob";

/** One signed-in principal fixture. */
function principal(user: string | undefined, superuser = false): Principal {
	return {
		user,
		admin: superuser,
		service: false,
		method: "token",
	};
}

/** The surface context one render/action receives. */
function ctxOf(
	user: string | undefined,
	params: Record<string, unknown> = {},
): SurfaceContext {
	return {
		principal: principal(user),
		params: params as SurfaceContext["params"],
		key: "test",
		signal: new AbortController().signal,
	};
}

/** Script alice's curation reads: two skills, one orphaned overlay, a feed. */
function scriptStores(host: FakeHost, feed: readonly CurationFeedEntry[]): void {
	const skills: readonly CurationSkillInfo[] = [
		{
			name: "deploy-staging",
			description: "how to deploy acme sites",
			archived: false,
			pinned: false,
			bytes: 900,
			createdAt: "2026-10-01T00:00:00.000Z",
		},
		{
			name: "release-flow",
			description: "the acme release procedure",
			archived: true,
			pinned: true,
			bytes: 400,
			createdAt: "2026-10-02T00:00:00.000Z",
		},
	];
	const overlays: readonly CurationOverlay[] = [
		{
			key: { root: "package", skill: "vendor-tool" },
			text: "the vendor tool's flag quirk",
			upstreamHash: "h-1",
		},
		{
			key: { root: "package", skill: "gone-tool" },
			text: "notes for a removed skill",
			upstreamHash: "h-2",
			orphanedSince: "2026-10-30T00:00:00.000Z",
		},
	];
	host.setCuration({
		skills: (userArg) => ({
			list: async () => (userArg === ALICE ? skills : []),
			feed: async (limit) => feed.slice(0, limit),
			pin: async () => undefined,
			view: async () => "",
			undo: async () => [],
			apply: async (name, change) => ({
				id: `feed-${name}-${change.kind}`,
				at: "2026-11-01T00:00:00.000Z",
				actor: "curator",
				action: change.kind,
				skill: name,
			}),
		}),
		overlays: (user) => ({
			...((host.curation as unknown as {
				defaults: FakeHost["curation"];
			}).defaults.overlays(user)),
			list: async () => (user === ALICE ? overlays : []),
		}),
		usage: async (user) =>
			user === ALICE ? { "deploy-staging": "2026-10-28T00:00:00.000Z" } : {},
		undoReview: async () => 0,
	});
}

/** One feed entry fixture (newest first). */
function feedEntry(
	n: number,
	opts: { reviewId?: string; conversationId?: number; skill?: string } = {},
): CurationFeedEntry {
	return {
		id: `feed-${n}`,
		at: new Date(Date.parse("2026-11-01T12:00:00.000Z") - n * 60_000).toISOString(),
		actor: "curator",
		action: n % 2 === 0 ? "patch" : "create",
		skill: opts.skill ?? `skill-${n}`,
		...(opts.reviewId === undefined ? {} : { reviewId: opts.reviewId }),
		...(opts.conversationId === undefined
			? {}
			: { conversationId: opts.conversationId }),
	};
}

describe("the curator view", () => {
	test("view lists skills, overlays and feed for the owner; bob sees nothing", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			scriptStores(host, [
				feedEntry(1, { reviewId: "review-a", conversationId: 7 }),
				feedEntry(2, { reviewId: "review-a", conversationId: 7 }),
				feedEntry(3, { reviewId: "review-b" }),
			]);
			const view = createCuratorView(host);

			const rendered = await view.render(ctxOf(ALICE));
			expect(rendered.access).toBe("write");
			const text = JSON.stringify(rendered.tree);
			// The owner's skills with their descriptions and pin state.
			expect(text).toContain("deploy-staging");
			expect(text).toContain("how to deploy acme sites");
			expect(text).toContain("release-flow");
			// The orphaned overlay carries its flag.
			expect(text).toContain("vendor-tool");
			expect(text).toContain("gone-tool");
			expect(text).toContain("orphaned");
			// The feed entries, grouped per review (one group per id, the
			// entries' skills inside).
			expect(text).toContain("review-a");
			expect(text).toContain("review-b");
			expect(text).toContain("skill-1");
			expect(text).toContain("skill-3");
			expect(text).toContain("patch skill-2");
			// The tree validates against the server's own walk (placement
			// view; handler names must resolve to the declared actions).
			const verdict = validateTree(rendered.tree, {
				placement: "view",
				handlers: new Set(Object.keys(view.actions ?? {})),
			});
			expect(verdict.ok).toBe(true);

			// bob: his OWN instance — write access to his own (empty)
			// data, and NONE of alice's content leaks into it. Every read
			// the render made ran for bob, never alice.
			const seen: string[] = [];
			host.setCuration({
				skills: (user2) => ({
					list: async () => {
						seen.push(`skills:${user2}`);
						return [];
					},
					feed: async () => {
						seen.push(`feed:${user2}`);
						return [];
					},
					view: async () => "",
					pin: async () => undefined,
					undo: async () => [],
					apply: async (name, change) => ({
						id: `feed-${name}-${change.kind}`,
						at: "2026-11-01T00:00:00.000Z",
						actor: "curator",
						action: change.kind,
						skill: name,
					}),
				}),
				overlays: (user2) => ({
					...((host.curation as unknown as {
						defaults: FakeHost["curation"];
					}).defaults.overlays(user2)),
					list: async () => {
						seen.push(`overlays:${user2}`);
						return [];
					},
				}),
				usage: async (user2) => {
					seen.push(`usage:${user2}`);
					return {};
				},
				undoReview: async () => 0,
			});
			const bobs = await view.render(ctxOf(BOB));
			expect(bobs.access).toBe("write");
			const bobText = JSON.stringify(bobs.tree);
			expect(bobText).not.toContain("deploy-staging");
			expect(bobText).not.toContain("release-flow");
			expect(bobText).not.toContain("vendor-tool");
			expect(bobText).not.toContain("review-a");
			// The reads ran for bob only (usage, skills list, overlays,
			// feed — four reads, all for bob, none for alice).
			expect(seen.length).toBeGreaterThanOrEqual(4);
			expect(seen.every((entry) => entry.endsWith(`:${BOB}`))).toBe(true);
		} finally {
			await host.close();
		}
	});

	test("the view's Undo review reverts the review and clears the notice", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const conversation = (await host.conversations.create({
				owner: ALICE,
			})) as ConversationId;
			const undone: string[] = [];
			let undoCount = 0;
			host.setCuration({
				undoReview: async (user, reviewId) => {
					undone.push(`${user}:${reviewId}`);
					return ++undoCount;
				},
			});

			// A completed review set the notice on the conversation.
			const notice: NoticeRecord | undefined = await notify(host, conversation, ALICE, {
				status: "completed",
				text: "saved",
				changes: [
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				],
				reviewId: "review-acme",
			});
			expect(notice).toBeDefined();

			const view = createCuratorView(host);
			const action = view.actions?.["undoReview"];
			expect(action).toBeDefined();

			// The feed's onActivate dispatch: {itemId: the review id}.
			const result = await action!(
				ctxOf(ALICE),
				{ itemId: "review-acme" },
			);
			expect(result).toMatchObject({ ok: true });

			// The review reverted through the curation host, for the caller.
			expect(undone).toEqual([`${ALICE}:review-acme`]);
			// And the notice conversation's ambient record was cleared.
			const cleared = host.calls.filter((call) => call.method === "clearAmbient");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]?.args[0]).toBe(conversation);
			expect(cleared[0]?.args[1]).toBe(CURATOR_NOTICE_KIND);
		} finally {
			await host.close();
		}
	});

	test("undo for a review without a recorded notice still reverts (nothing to clear)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const undone: string[] = [];
			host.setCuration({
				undoReview: async (user, reviewId) => {
					undone.push(`${user}:${reviewId}`);
					return 3;
				},
			});
			const view = createCuratorView(host);
			await view.actions!["undoReview"](ctxOf(ALICE), {
				itemId: "digest-old",
			});
			expect(undone).toEqual([`${ALICE}:digest-old`]);
			expect(
				host.calls.filter((call) => call.method === "clearAmbient"),
			).toHaveLength(0);
		} finally {
			await host.close();
		}
	});

	test("the pause switch writes the user's settings; pin and archive/restore write the stores", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const pins: [string, boolean][] = [];
			const applies: [string, string][] = [];
			host.setCuration({
				skills: (_user) => ({
					list: async () => [
						{
							name: "deploy-staging",
							description: "how to deploy acme sites",
							archived: false,
							pinned: false,
							bytes: 900,
							createdAt: "2026-10-01T00:00:00.000Z",
						},
						{
							name: "release-flow",
							description: "the acme release procedure",
							archived: true,
							pinned: false,
							bytes: 400,
							createdAt: "2026-10-02T00:00:00.000Z",
						},
					],
					feed: async () => [],
					pin: async (name, pinned) => {
						pins.push([name, pinned]);
					},
					view: async () => "",
					undo: async () => [],
					apply: async (name, change) => {
						applies.push([name, change.kind]);
						return {
							id: `feed-${name}-${change.kind}`,
							at: "2026-11-01T00:00:00.000Z",
							actor: "curator",
							action: change.kind,
							skill: name,
						};
					},
				}),
				overlays: (user) =>
					((host.curation as unknown as {
						defaults: FakeHost["curation"];
					}).defaults.overlays(user)),
				usage: async () => ({}),
				undoReview: async () => 0,
			});

			const view = createCuratorView(host);

			// Pause on: the header button's submit action toggles to true.
			await view.actions!["setPaused"](ctxOf(ALICE), {});
			expect(await readSettings(host, ALICE)).toMatchObject({ paused: true });
			// Pause off again (an explicit form-shaped payload also works).
			await view.actions!["setPaused"](ctxOf(ALICE), {
				values: { paused: false },
			});
			expect(await readSettings(host, ALICE)).toMatchObject({ paused: false });

			// Pin toggle: the collection's onCheck dispatch {itemId, value}.
			await view.actions!["pin"](ctxOf(ALICE), {
				itemId: "deploy-staging",
				value: true,
			});
			expect(pins).toEqual([["deploy-staging", true]]);

			// Archive/restore ride ONE onActivate action, direction read
			// from the store: an ACTIVE skill archives, an ARCHIVED one
			// restores (the list has release-flow archived).
			await view.actions!["toggleArchive"](ctxOf(ALICE), {
				itemId: "deploy-staging",
			});
			await view.actions!["toggleArchive"](ctxOf(ALICE), {
				itemId: "release-flow",
			});
			expect(applies).toEqual([
				["deploy-staging", "archive"],
				["release-flow", "restore"],
			]);
		} finally {
			await host.close();
		}
	});

	test("an anonymous principal sees nothing; another user's action never touches the owner's stores", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			scriptStores(host, []);
			const view = createCuratorView(host);
			const anonymous = await view.render(ctxOf(undefined));
			expect(anonymous.access).toBe("none");

			// The per-user surface: bob's action runs against BOB's stores
			// (nothing there), never alice's — the isolation is in WHO the
			// action writes for, not in a reject.
			const undone: string[] = [];
			host.setCuration({
				undoReview: async (user, reviewId) => {
					undone.push(`${user}:${reviewId}`);
					return 0;
				},
			});
			const bobs = await view.actions!["undoReview"](ctxOf(BOB), {
				itemId: "review-acme",
			});
			expect(bobs).toMatchObject({ ok: true });
			expect(undone).toEqual([`${BOB}:review-acme`]);
		} finally {
			await host.close();
		}
	});
});

/** Read one user's curator settings through the scoped store. */
async function readSettings(
	host: FakeHost,
	user: string,
): Promise<Record<string, unknown>> {
	return await host.stores.user(user).settings.get();
}
