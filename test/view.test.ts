/**
 * The curator view tests (`src/view.ts`, tabs+skills Task 13): the
 * per-user surface is the FEED — the change history grouped by review
 * with an Undo review action, each entry carrying its actor (curator /
 * agent / user / outside sigrun) — plus a pause switch and a page
 * action navigating to the core Skills view (skill CRUD moved there
 * with Task 12's core/skills; this view lists no learned skills and
 * no overlays any more).
 *
 * The contract under test:
 *
 * - `render` reads the CALLING principal's stores (`ctx.principal`),
 *   and access follows `accessOf` over an owner-shaped resource: the
 *   owner and the superuser see their data ("write"); any other user
 *   gets `none` (bob sees nothing — not alice's feed).
 * - A `review` param filters the feed to that one review (the core
 *   skills view's curator-commit link navigates here with it; the
 *   notice does too).
 * - Feed entries group by their commit SHA (the feed `id`), not by
 *   review id: an undo needs every commit of one review, and a review
 *   whose commits interleave another's must not merge into it.
 * - An outside-actor entry renders as "outside sigrun" (catch-up
 *   commits the store did not author, Task 9's actor widening).
 * - The surface's `actions` reach the extension: `undoReview` reverts
 *   through `host.curation.undoReview` and then clears the notice
 *   conversation's ambient record; `setPaused` writes the settings.
 * - The tree validates against the server's own `validateTree`
 *   (placement `view`, handlers = the declared action keys) — the
 *   same check `SurfaceService.render` runs before serving.
 */

import { describe, expect, test } from "vitest";
import type {
	CurationFeedEntry,
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

/** Script the curation feed read per user (the view's only curation read). */
function scriptFeed(
	host: FakeHost,
	feed: readonly CurationFeedEntry[],
	feeds: Readonly<Record<string, readonly CurationFeedEntry[]>> = {},
): void {
	host.setCuration({
		skills: (user) => ({
			list: async () => [],
			feed: async (limit) => (feeds[user] ?? feed).slice(0, limit),
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
	});
}

/** One feed entry fixture (newest first; the id is the commit SHA). */
function feedEntry(
	sha: string,
	opts: {
		reviewId?: string;
		actor?: CurationFeedEntry["actor"];
		skill?: string;
		action?: string;
	} = {},
): CurationFeedEntry {
	const n = Number.parseInt(sha.replace(/^0+/, "") || "0", 16);
	return {
		id: sha,
		at: new Date(Date.parse("2026-11-01T12:00:00.000Z") - n * 60_000).toISOString(),
		actor: opts.actor ?? "curator",
		action: opts.action ?? "patch",
		skill: opts.skill ?? `skill-${sha}`,
		...(opts.reviewId === undefined ? {} : { reviewId: opts.reviewId }),
	};
}

/** The undo group ids the rendered feed carries (item ids). */
function reviewIds(tree: unknown): string[] {
	const text = JSON.stringify(tree);
	const ids: string[] = [];
	for (const match of text.matchAll(/"id":"(review-[^"]+)"/g)) {
		ids.push(match[1]!);
	}
	return ids;
}

describe("the curator view", () => {
	test("the view links to core skills and lists no learned skills", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, []);
			const view = createCuratorView(host);
			const rendered = await view.render(ctxOf(ALICE));
			expect(rendered.access).toBe("write");
			const text = JSON.stringify(rendered.tree);
			// The page action navigates to the core skills view (skill
			// management lives there since core/skills landed).
			expect(text).toContain('"extension":"core"');
			expect(text).toContain('"id":"skills"');
			expect(text).toContain('"type":"navigate"');
			// No learned-skills or overlays sections remain on this view.
			expect(text).not.toContain("Learned skills");
			expect(text).not.toContain("Overlays");
			expect(text).not.toContain("skills-section");
			expect(text).not.toContain("overlays-section");
			// And the data document carries no skill/overlay rows either.
			const data = JSON.stringify(rendered.data);
			expect(data).not.toContain('"skills"');
			expect(data).not.toContain('"overlays"');
			// The tree validates against the server's own walk (placement
			// view; handler names must resolve to the declared actions).
			const verdict = validateTree(rendered.tree, {
				placement: "view",
				handlers: new Set(Object.keys(view.actions ?? {})),
			});
			expect(verdict.ok).toBe(true);
		} finally {
			await host.close();
		}
	});

	test("an outside-actor feed entry renders as 'outside sigrun'", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-a" }),
				feedEntry("aa0002", { actor: "outside", skill: "deploy-staging" }),
			]);
			const view = createCuratorView(host);
			const rendered = await view.render(ctxOf(ALICE));
			// The ROW carries the outside label (the git trailer's actor
			// name), not just the section blurb.
			expect(JSON.stringify(rendered.tree)).toContain(
				"patch deploy-staging (outside sigrun)",
			);
			// And the data document's actor field is the label.
			const data = rendered.data as unknown as {
				reviews: readonly { entries: readonly { actor: string }[] }[];
			};
			const actors = data.reviews.flatMap((group) =>
				group.entries.map((entry) => entry.actor),
			);
			expect(actors).toEqual(["curator", "outside sigrun"]);
		} finally {
			await host.close();
		}
	});

	test("interleaved reviews stay apart (A, B, A groups as A-run, B, A-run)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-a", skill: "one" }),
				feedEntry("aa0002", { reviewId: "review-b", skill: "two" }),
				feedEntry("aa0003", { reviewId: "review-a", skill: "three" }),
			]);
			const view = createCuratorView(host);
			const rendered = await view.render(ctxOf(ALICE));
			// Three groups, one per same-review RUN — the two review-a
			// commits never merge into one undo.
			expect(reviewIds(rendered.tree)).toEqual([
				"review-aa0001",
				"review-aa0002",
				"review-aa0003",
			]);
		} finally {
			await host.close();
		}
	});

	test("a review param filters the feed to that review", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-a", skill: "deploy-staging" }),
				feedEntry("aa0002", { reviewId: "review-b", skill: "release-flow" }),
			]);
			const view = createCuratorView(host);

			// Unfiltered: both reviews render.
			const all = await view.render(ctxOf(ALICE));
			const allText = JSON.stringify(all.tree);
			expect(allText).toContain("deploy-staging");
			expect(allText).toContain("release-flow");

			// Anchored at review-a (the core skills link's target): only
			// its commits render.
			const one = await view.render(ctxOf(ALICE, { review: "review-a" }));
			const oneText = JSON.stringify(one.tree);
			expect(oneText).toContain("deploy-staging");
			expect(oneText).not.toContain("release-flow");
		} finally {
			await host.close();
		}
	});

	test("a review deep-link pages the feed to find an older review", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// The target review's commit sits on feed page 2 (beyond the
			// first VIEW_FEED_LIMIT entries).
			const page1 = Array.from({ length: 50 }, (_, i) =>
				feedEntry(`aa00${String(i + 10).padStart(2, "0")}`, { skill: `recent-${i}` }),
			);
			const page2 = [
				feedEntry("aa0001", { reviewId: "review-old", skill: "deploy-staging" }),
			];
			const seenBefore: (string | undefined)[] = [];
			host.setCuration({
				skills: (_user) => ({
					list: async () => [],
					feed: async (limit, before) => {
						seenBefore.push(before);
						return before === undefined ? page1.slice(0, limit) : page2;
					},
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
			});
			const view = createCuratorView(host);
			const rendered = await view.render(ctxOf(ALICE, { review: "review-old" }));
			const text = JSON.stringify(rendered.tree);
			// The older review's commit renders — the deep-link found it
			// on page 2 (the walk paged with the last sha of page 1).
			expect(text).toContain("deploy-staging");
			expect(text).not.toContain("Nothing learned yet");
			expect(text).not.toContain("older than the recent changes");
			expect(seenBefore).toEqual([undefined, "aa0059"]);
		} finally {
			await host.close();
		}
	});

	test("a review deep-link past the bounded walk renders a distinct empty state", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// Every page is full and never carries the review: the walk
			// gives up after its bound.
			host.setCuration({
				skills: (_user) => ({
					list: async () => [],
					feed: async (limit, _before) =>
						Array.from({ length: limit }, (_, i) =>
							feedEntry(`bb${String(i).padStart(4, "0")}`, { skill: `filler-${i}` }),
						),
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
			});
			const view = createCuratorView(host);
			const rendered = await view.render(ctxOf(ALICE, { review: "review-ancient" }));
			const text = JSON.stringify(rendered.tree);
			// The distinct message — never the false "Nothing learned yet".
			expect(text).toContain("This review is older than the recent changes");
			expect(text).not.toContain("Nothing learned yet");
		} finally {
			await host.close();
		}
	});

	test("feed entries group by commit sha, keeping reviews apart; bob sees nothing of alice's", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-a", skill: "deploy-staging" }),
				feedEntry("aa0002", { reviewId: "review-a", skill: "release-flow" }),
				feedEntry("aa0003", { skill: "vendor-notes" }),
			],
			// bob's own instance reads BOB's feed — alice's entries never
			// leak across the per-principal boundary.
			{
				bob: [feedEntry("bb0001", { skill: "bob-notes" })],
			},
		);
			const view = createCuratorView(host);

			const rendered = await view.render(ctxOf(ALICE));
			expect(rendered.access).toBe("write");
			const text = JSON.stringify(rendered.tree);
			// Every feed row renders (skill, action, sha) and the two
			// review-a commits are ONE undo group; the unreviewed commit
			// stands alone (one group per commit run, keyed on the sha).
			expect(text).toContain("deploy-staging");
			expect(text).toContain("release-flow");
			expect(text).toContain("vendor-notes");
			expect(text).toContain("aa0001");
			expect(reviewIds(rendered.tree)).toEqual([
				"review-aa0001",
				"review-aa0003",
			]);

			// bob: his OWN instance — write access to his own feed
			// (bob-notes), and NONE of alice's content leaks into it.
			const bobs = await view.render(ctxOf(BOB));
			expect(bobs.access).toBe("write");
			const bobText = JSON.stringify(bobs.tree);
			expect(bobText).toContain("bob-notes");
			expect(bobText).not.toContain("deploy-staging");
			expect(bobText).not.toContain("aa0001");
			// The feed read ran for bob only.
			const feeds = host.calls.filter(
				(call) => call.method === "curation.skills",
			);
			expect(feeds.map((call) => call.args[0])).toEqual([ALICE, BOB]);
		} finally {
			await host.close();
		}
	});

	test("undo resolves the group sha back to the review id before dispatch", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const conversation = (await host.conversations.create({
				owner: ALICE,
			})) as ConversationId;
			// The feed's group key is review-<sha>; the review id lives on
			// the feed entry (core matches review ids, never group keys).
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-3", skill: "deploy-staging" }),
			]);
			// A completed review set its notice (the ledger keys on the
			// review id too).
			await notify(host, conversation, ALICE, {
				status: "completed",
				text: "saved",
				changes: [
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				],
				reviewId: "review-3",
			});
			host.setCuration({ undoReview: async () => 1 });

			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](ctxOf(ALICE), {
				itemId: "review-aa0001",
			});
			expect(result).toMatchObject({ ok: true });

			// The host received the RESOLVED review id — never the sha
			// group key verbatim.
			const undos = host.calls.filter(
				(call) => call.method === "curation.undoReview",
			);
			expect(undos).toHaveLength(1);
			expect(undos[0]?.args).toEqual([ALICE, "review-3"]);
			// And the notice lookup used the same resolved id: the
			// ambient record on the notice conversation cleared.
			const cleared = host.calls.filter((call) => call.method === "clearAmbient");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]?.args[0]).toBe(conversation);
			expect(cleared[0]?.args[1]).toBe(CURATOR_NOTICE_KIND);
		} finally {
			await host.close();
		}
	});

	test("a bare review id still undoes (the pre-upgrade coordinate)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-3", skill: "deploy-staging" }),
			]);
			const view = createCuratorView(host);
			// No `review-` prefix, and no entry whose id is "review-3":
			// the sha lookup misses, the reviewId fallback resolves.
			const result = await view.actions!["undoReview"](ctxOf(ALICE), {
				itemId: "review-3",
			});
			expect(result).toMatchObject({ ok: true });
			const undos = host.calls.filter(
				(call) => call.method === "curation.undoReview",
			);
			expect(undos).toHaveLength(1);
			expect(undos[0]?.args).toEqual([ALICE, "review-3"]);
		} finally {
			await host.close();
		}
	});

	test("an undo group for a commit without a review undoes nothing", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("aa0009", { skill: "vendor-notes" })]);
			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](ctxOf(ALICE), {
				itemId: "review-aa0009",
			});
			// A lone commit has no review to revert — and the host is
			// never asked.
			expect(result).toEqual({ ok: true, toast: "Nothing to undo" });
			expect(
				host.calls.filter((call) => call.method === "curation.undoReview"),
			).toHaveLength(0);
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
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-acme", skill: "deploy-staging" }),
			]);
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

			// The feed's onActivate dispatch: {itemId: the group key
			// (review-<sha>)} — the handler resolves the review id.
			const result = await action!(
				ctxOf(ALICE),
				{ itemId: "review-aa0001" },
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
			scriptFeed(host, [feedEntry("dd0001", { reviewId: "digest-old" })]);
			const undone: string[] = [];
			host.setCuration({
				undoReview: async (user, reviewId) => {
					undone.push(`${user}:${reviewId}`);
					return 3;
				},
			});
			const view = createCuratorView(host);
			await view.actions!["undoReview"](ctxOf(ALICE), {
				itemId: "review-dd0001",
			});
			expect(undone).toEqual([`${ALICE}:digest-old`]);
			expect(
				host.calls.filter((call) => call.method === "clearAmbient"),
			).toHaveLength(0);
		} finally {
			await host.close();
		}
	});

	test("a clearAmbient rejection after a successful undo still lands the undo toast", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const conversation = (await host.conversations.create({
				owner: ALICE,
			})) as ConversationId;
			host.setCuration({
				undoReview: async () => 2,
			});
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-acme", skill: "deploy-staging" }),
			]);
			// The review set its notice (the ledger remembers the
			// conversation); the ambient CLEAR then hiccups.
			await notify(host, conversation, ALICE, {
				status: "completed",
				text: "saved",
				changes: [
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				],
				reviewId: "review-acme",
			});
			host.clearAmbient = async () => {
				throw new Error("ambient seam unavailable");
			};

			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](ctxOf(ALICE), {
				itemId: "review-aa0001",
			});

			// The revert succeeded, so the reply is the undo toast — the
			// stale notice is cosmetic, never a failed action.
			expect(result).toEqual({
				ok: true,
				toast: "Undid 2 change(s)",
			});
		} finally {
			await host.close();
		}
	});

	test("the pause switch writes the user's settings", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			const view = createCuratorView(host);

			// Pause on: the header button's submit action toggles to true.
			await view.actions!["setPaused"](ctxOf(ALICE), {});
			expect(await readSettings(host, ALICE)).toMatchObject({ paused: true });
			// Pause off again (an explicit form-shaped payload also works).
			await view.actions!["setPaused"](ctxOf(ALICE), {
				values: { paused: false },
			});
			expect(await readSettings(host, ALICE)).toMatchObject({ paused: false });
		} finally {
			await host.close();
		}
	});

	test("an anonymous principal sees nothing; another user's action never touches the owner's stores", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }, { user: BOB }] });
		try {
			scriptFeed(host, []);
			const view = createCuratorView(host);
			const anonymous = await view.render(ctxOf(undefined));
			expect(anonymous.access).toBe("none");

			// The per-user surface: bob's action runs against BOB's stores
			// (his own feed), never alice's — the isolation is in WHO the
			// action writes for, not in a reject.
			const undone: string[] = [];
			scriptFeed(host, [], {
				bob: [feedEntry("aa0001", { reviewId: "review-acme" })],
			});
			host.setCuration({
				undoReview: async (user, reviewId) => {
					undone.push(`${user}:${reviewId}`);
					return 0;
				},
			});
			const bobs = await view.actions!["undoReview"](ctxOf(BOB), {
				itemId: "review-aa0001",
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
