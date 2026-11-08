/**
 * The curator view tests (`src/view.ts`): the per-user surface is a
 * change feed whose rows open a review page. Undo lives only in that
 * page's confirming callout; change rows navigate to core Skills.
 *
 * The contract under test:
 *
 * - `render` reads the CALLING principal's stores (`ctx.principal`),
 *   and access follows `accessOf` over an owner-shaped resource: the
 *   owner and the superuser see their data ("write"); any other user
 *   gets `none` (bob sees nothing — not alice's feed).
 * - A `review` param renders that review's non-undo changes, oldest
 *   first, and retains a deep link even beyond the bounded feed walk.
 * - Feed entries group by their commit SHA (the feed `id`), not by
 *   review id: a review whose commits interleave another's must not
 *   merge into it.
 * - An outside-actor entry renders as "outside sigrun" (catch-up
 *   commits the store did not author).
 * - The surface's `actions` reach the extension: `openReview` only
 *   navigates, `openChangeSkill` resolves the commit SHA to its skill,
 *   `undoReview` reverts the param's review and clears its notice, and
 *   `setPaused` writes the settings.
 * - The tree validates against the server's own `validateTree`
 *   (placement `view`, handlers = the declared action keys) — the
 *   same check `SurfaceService.render` runs before serving.
 */

import { describe, expect, test } from "vitest";
import type {
	CurationFeedEntry,
	CurationSkillInfo,
	Principal,
	SurfaceContext,
} from "@sigrun/sigrun/extension";
import { validateTree } from "@sigrun/sigrun/blocks";
import { createFakeHost } from "./fake-host.js";
import type { FakeHost } from "./fake-host.js";
import { createCuratorView } from "../src/view.js";
import { notify } from "../src/notices.js";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PageBlock } from "@sigrun/shared/blocks";

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
			list: async () => (feeds[user] ?? feed).map((entry) =>
				skillInfo(entry.skill, entry.action === "archive"),
			),
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

/** Render and validate with the same server gate the surface route uses. */
async function renderView(
	view: ReturnType<typeof createCuratorView>,
	ctx: SurfaceContext,
) {
	const rendered = await view.render(ctx);
	expect(
		validateTree(rendered.tree, {
			placement: "view",
			handlers: new Set(Object.keys(view.actions ?? {})),
		}),
	).toMatchObject({ ok: true });
	return rendered;
}

/** Recursively find blocks of one type. */
function blocksOfType(tree: unknown, type: string): Record<string, any>[] {
	const found: Record<string, any>[] = [];
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
		} else if (typeof value === "object" && value !== null) {
			const record = value as Record<string, unknown>;
			if (record.type === type) found.push(record);
			for (const entry of Object.values(record)) visit(entry);
		}
	};
	visit(tree);
	return found;
}

/** One complete learned-skill listing row. */
function skillInfo(
	name: string,
	archived = false,
): CurationSkillInfo {
	return {
		name,
		description: `${name} description`,
		archived,
		pinned: false,
		bytes: 100,
		createdAt: "2026-11-01T00:00:00.000Z",
	};
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
	test("the rail icon is the pencil, distinct from core Skills' book", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const view = createCuratorView(host);
			// Core's Skills view owns "book"; two rail entries with one glyph
			// read as the same destination.
			expect(view.icon).toBe("edit");
		} finally {
			await host.close();
		}
	});

	test("the feed activates openReview, never undoReview", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("0a", { reviewId: "review-acme" })]);
			const view = createCuratorView(host);
			const rendered = await renderView(view, ctxOf(ALICE));
			const feed = blocksOfType(rendered.tree, "collection").find(
				(block) => block.id === "reviews",
			);
			expect(feed?.onActivate).toEqual({ type: "edit", name: "openReview" });
			expect(JSON.stringify(rendered.tree)).not.toContain('"undoReview"');
		} finally {
			await host.close();
		}
	});

	test("clicking a feed item navigates to its review and reverts nothing", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("0a", { reviewId: "review-acme" })]);
			const view = createCuratorView(host);
			const result = await view.actions!["openReview"]?.(
				ctxOf(ALICE),
				{ itemId: "review-0a" },
			);
			expect(result).toEqual({
				ok: true,
				navigate: { type: "navigate", params: { review: "review-acme" } },
			});
			expect(
				host.calls.filter((call) => call.method === "curation.undoReview"),
			).toHaveLength(0);
		} finally {
			await host.close();
		}
	});

	test("the view links to core skills and lists no learned skills", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, []);
			const view = createCuratorView(host);
			const rendered = await renderView(view, ctxOf(ALICE));
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
			const rendered = await renderView(view, ctxOf(ALICE));
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
			const rendered = await renderView(view, ctxOf(ALICE));
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
			const all = await renderView(view, ctxOf(ALICE));
			const allText = JSON.stringify(all.tree);
			expect(allText).toContain("deploy-staging");
			expect(allText).toContain("release-flow");

			// Anchored at review-a (the core skills link's target): only
			// its commits render.
			const one = await renderView(view, ctxOf(ALICE, { review: "review-a" }));
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
			const rendered = await renderView(view, ctxOf(ALICE, { review: "review-old" }));
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
			const rendered = await renderView(view, ctxOf(ALICE, { review: "review-ancient" }));
			const text = JSON.stringify(rendered.tree);
			// The distinct message — never the false "Nothing learned yet".
			expect(text).toContain("This review is older than the recent changes");
			expect(text).not.toContain("Nothing learned yet");
		} finally {
			await host.close();
		}
	});

	test("a deep-link missing on a PARTIAL final page renders the distinct empty state", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// 60 entries: page 1 full (no match), page 2 partial (no
			// match). The walk ends on the short page — and the miss must
			// still render the distinct message, never "Nothing learned
			// yet".
			const page1 = Array.from({ length: 50 }, (_, i) =>
				feedEntry(`aa00${String(i + 10).padStart(2, "0")}`, { skill: `recent-${i}` }),
			);
			const page2 = Array.from({ length: 10 }, (_, i) =>
				feedEntry(`cc00${String(i).padStart(2, "0")}`, { skill: `old-${i}` }),
			);
			host.setCuration({
				skills: (_user) => ({
					list: async () => [],
					feed: async (limit, before) =>
						before === undefined ? page1.slice(0, limit) : page2,
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
			const rendered = await renderView(view, ctxOf(ALICE, { review: "review-ancient" }));
			const text = JSON.stringify(rendered.tree);
			expect(text).toContain("This review is older than the recent changes");
			expect(text).not.toContain("Nothing learned yet");
		} finally {
			await host.close();
		}
	});

	test("the plain view stays newest-50 (no paging without a review param)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// A feed deeper than one page: the plain view reads page 1
			// only, so every rendered group's sha resolves for undo.
			const page1 = Array.from({ length: 50 }, (_, i) =>
				feedEntry(`aa00${String(i + 10).padStart(2, "0")}`, { skill: `recent-${i}` }),
			);
			const page2 = [feedEntry("aa0001", { skill: "deeper" })];
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
			const rendered = await renderView(view, ctxOf(ALICE));
			const text = JSON.stringify(rendered.tree);
			expect(text).toContain("recent-0");
			expect(text).not.toContain("deeper");
			expect(seenBefore).toEqual([undefined]);
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

			const rendered = await renderView(view, ctxOf(ALICE));
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
			const bobs = await renderView(view, ctxOf(BOB));
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

	test("the review page offers Undo review in a callout with a confirm", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("0a", { reviewId: "review-acme" })]);
			const view = createCuratorView(host);
			const rendered = await renderView(
				view,
				ctxOf(ALICE, { review: "review-acme" }),
			);
			expect(
				(rendered.tree.root as PageBlock).actions?.map((action) => action.id),
			).toEqual([
				"back-to-feed",
				"open-skills",
			]);
			const callout = blocksOfType(rendered.tree, "callout").find(
				(block) => block.id === "undo-callout",
			);
			expect(callout?.actions).toEqual([
				{
					id: "undo-review",
					label: "Undo review",
					action: {
						type: "submit",
						name: "undoReview",
						confirm: {
							title: "Undo this review?",
							body: "Reverts every change this review made. Archived skills can be restored from Skills.",
							tone: "warn",
							confirmLabel: "Undo",
						},
					},
				},
			]);
		} finally {
			await host.close();
		}
	});

	test("undoReview without a review param refuses", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("0a", { reviewId: "review-acme" })]);
			const view = createCuratorView(host);
			expect(
				await view.actions!["undoReview"]?.(ctxOf(ALICE), {
					itemId: "review-0a",
				}),
			).toEqual({ ok: false, error: { message: "undoReview needs a review" } });
			expect(
				host.calls.filter((call) => call.method === "curation.undoReview"),
			).toHaveLength(0);
		} finally {
			await host.close();
		}
	});

	test("an undone review shows Undone and no Undo button", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			const undo = feedEntry("0b", {
				reviewId: "review-acme",
				action: "undo",
			});
			scriptFeed(host, [
				undo,
				feedEntry("0a", {
					reviewId: "review-acme",
					action: "create",
					skill: "acme-skill",
				}),
			]);
			const view = createCuratorView(host);
			const rendered = await renderView(
				view,
				ctxOf(ALICE, { review: "review-acme" }),
			);
			expect(JSON.stringify(rendered.tree)).not.toContain('"undo-review"');
			const callout = blocksOfType(rendered.tree, "callout").find(
				(block) => block.id === "undo-callout",
			);
			expect(callout?.title).toMatch(/^Undone/);
			const detail = rendered.data.review as unknown as {
				undoneAt?: string;
				changes: readonly unknown[];
			};
			expect(detail).toMatchObject({ undoneAt: undo.at });
			expect(detail.changes).toMatchObject([
				{ id: "0a", action: "create", skill: "acme-skill" },
			]);
		} finally {
			await host.close();
		}
	});

	test("a group without a review id opens with nothing to review", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("0c", { actor: "outside" })]);
			const view = createCuratorView(host);
			const result = await view.actions!["openReview"]?.(
				ctxOf(ALICE),
				{ itemId: "review-0c" },
			);
			expect(result).toEqual({ ok: true, toast: "Nothing to review" });
			expect(result).not.toHaveProperty("navigate");
		} finally {
			await host.close();
		}
	});

	test("change rows key on the commit sha and open the skill in core Skills", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("0b", { reviewId: "review-acme", action: "patch", skill: "acme-skill" }),
				feedEntry("0a", { reviewId: "review-acme", action: "create", skill: "acme-skill" }),
			]);
			const view = createCuratorView(host);
			const ctx = ctxOf(ALICE, { review: "review-acme" });
			const rendered = await renderView(view, ctx);
			const changes = blocksOfType(rendered.tree, "collection").find(
				(block) => block.id === "changes",
			);
			expect(changes?.items.map((item: { id: string }) => item.id)).toEqual(["0a", "0b"]);
			expect(changes?.onActivate).toEqual({ type: "edit", name: "openChangeSkill" });
			expect(await view.actions!["openChangeSkill"]?.(ctx, { itemId: "0a" })).toEqual({
				ok: true,
				navigate: {
					type: "navigate",
					target: {
						view: {
							extension: "core",
							id: "skills",
							params: { skill: "acme-skill", root: "learned" },
						},
					},
				},
			});
		} finally {
			await host.close();
		}
	});

	test("an overlay change row does not navigate", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("0a", { reviewId: "review-acme", action: "overlay", skill: "acme-skill" }),
			]);
			const view = createCuratorView(host);
			const result = await view.actions!["openChangeSkill"]?.(
				ctxOf(ALICE, { review: "review-acme" }),
				{ itemId: "0a" },
			);
			expect(result).toEqual({ ok: true, toast: "Overlays open from Skills." });
			expect(result).not.toHaveProperty("navigate");
		} finally {
			await host.close();
		}
	});

	test("an older review reached by deep link keeps its Undo", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("0a", { reviewId: "review-other" })]);
			const view = createCuratorView(host);
			const rendered = await renderView(
				view,
				ctxOf(ALICE, { review: "review-acme" }),
			);
			expect(JSON.stringify(rendered.tree)).toContain(
				"This review is older than the recent changes.",
			);
			const callout = blocksOfType(rendered.tree, "callout").find(
				(block) => block.id === "undo-callout",
			);
			expect(callout?.actions?.some((action: { id: string }) => action.id === "undo-review")).toBe(true);
			expect((rendered.data.review as { missed: boolean }).missed).toBe(true);
		} finally {
			await host.close();
		}
	});

	test("an archived change has a literal Archived badge only on that row", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			host.setCuration({
				skills: () => ({
					list: async () => [skillInfo("acme-archived", true), skillInfo("acme-live")],
					feed: async () => [
						feedEntry("0b", { reviewId: "review-acme", skill: "acme-live" }),
						feedEntry("0a", { reviewId: "review-acme", skill: "acme-archived" }),
					],
					pin: async () => undefined,
					view: async () => "",
					undo: async () => [],
					apply: async (name, change) => feedEntry(name, { action: change.kind }),
				}),
			});
			const view = createCuratorView(host);
			const rendered = await renderView(
				view,
				ctxOf(ALICE, { review: "review-acme" }),
			);
			const changes = blocksOfType(rendered.tree, "collection").find(
				(block) => block.id === "changes",
			);
			expect(changes?.items[0].badges).toEqual([{ text: "Archived", tone: "neutral" }]);
			expect(changes?.items[1].badges).toBeUndefined();
		} finally {
			await host.close();
		}
	});

	test("the review page's Undo review reverts the review and clears the notice", async () => {
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
			// A completed review posted its notice (the core notice keys on
			// the review id too).
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
			const result = await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "review-3" }),
				{},
			);
			expect(result).toMatchObject({ ok: true });

			// The host received the RESOLVED review id — never the sha
			// group key verbatim.
			const undos = host.calls.filter(
				(call) => call.method === "curation.undoReview",
			);
			expect(undos).toHaveLength(1);
			expect(undos[0]?.args).toEqual([ALICE, "review-3"]);
			// And the notice cleared by its key (the core store owns the
			// pile now — the clear names the user and the review key).
			const cleared = host.calls.filter((call) => call.method === "notices.clear");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]?.args[0]).toEqual({ user: ALICE, key: "review:review-3" });
		} finally {
			await host.close();
		}
	});

	test("a deep-linked undo dispatches the param's review id (the group sha may sit past page 1)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// The deep-linked review's commit is on feed page 2: the
			// group key review-<sha> cannot resolve from page 1, and the
			// reviewId fallback misses (the itemId is not the review id).
			// The deep-link param already names the review — the undo
			// dispatches it directly.
			const page1 = Array.from({ length: 50 }, (_, i) =>
				feedEntry(`aa00${String(i + 10).padStart(2, "0")}`, { skill: `recent-${i}` }),
			);
			const page2 = [
				feedEntry("aa0001", { reviewId: "review-3", skill: "deploy-staging" }),
			];
			host.setCuration({
				skills: (_user) => ({
					list: async () => [],
					feed: async (limit, before) =>
						before === undefined ? page1.slice(0, limit) : page2,
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
				undoReview: async () => 1,
			});
			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "review-3" }),
				{},
			);
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

	test("a deep-linked undo dispatches the param's review id", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [
				feedEntry("aa0001", { reviewId: "review-3", skill: "deploy-staging" }),
			]);
			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "review-3" }),
				{},
			);
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

	test("an unknown deep-linked review still asks the host to undo it", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			scriptFeed(host, [feedEntry("aa0009", { skill: "vendor-notes" })]);
			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "review-aa0009" }),
				{},
			);
			expect(result).toEqual({ ok: true, toast: "Nothing to undo" });
			expect(
				host.calls.filter((call) => call.method === "curation.undoReview"),
			).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	test("the review page's Undo review reverts the review and clears its posted notice", async () => {
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

			// A completed review posted its notice (the core notice keys
			// on the review id).
			await notify(host, conversation, ALICE, {
				status: "completed",
				text: "saved",
				changes: [
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				],
				reviewId: "review-acme",
			});

			const view = createCuratorView(host);
			const action = view.actions?.["undoReview"];
			expect(action).toBeDefined();

			// The callout button submits an empty payload; the page's
			// review param supplies the id.
			const result = await action!(
				ctxOf(ALICE, { review: "review-acme" }),
				{},
			);
			expect(result).toMatchObject({ ok: true });

			// The review reverted through the curation host, for the caller.
			expect(undone).toEqual([`${ALICE}:review-acme`]);
			// And the notice cleared by its key.
			const cleared = host.calls.filter((call) => call.method === "notices.clear");
			expect(cleared).toHaveLength(1);
			expect(cleared[0]?.args[0]).toEqual({ user: ALICE, key: "review:review-acme" });
		} finally {
			await host.close();
		}
	});

	test("undo for a review without a posted notice still reverts (nothing to clear)", async () => {
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
			await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "digest-old" }),
				{},
			);
			expect(undone).toEqual([`${ALICE}:digest-old`]);
			// The clear-by-key runs unconditionally (a notice-less clear
			// is a no-op in the core store), but no ambient write ever
			// happened.
			expect(
				host.calls.filter((call) => call.method === "clearAmbient"),
			).toHaveLength(0);
			expect(
				host.calls.filter((call) => call.method === "notices.clear"),
			).toHaveLength(1);
		} finally {
			await host.close();
		}
	});

	test("a rejecting undoReview action returns a named error (never a thrown action)", async () => {
		const host = await createFakeHost({ users: [{ user: ALICE }] });
		try {
			// The param names the review directly, so a host failure is
			// returned as a named action error.
			scriptFeed(host, [
				{
					id: "acme",
					at: "2026-11-03T00:00:00Z",
					actor: "curator",
					action: "patch",
					skill: "acme-deploy",
					reviewId: "review-3",
				},
			]);
			host.setCuration({
				undoReview: async () => {
					throw new Error(
						"cannot undo patch acme-deploy: the version snapshot v4 was pruned — the change is no longer revertible",
					);
				},
			});
			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "review-3" }),
				{},
			);
			// The named message reaches the user as the action's error,
			// never the surface layer's generic failure.
			expect(result).toEqual({
				ok: false,
				error: {
					message:
						"cannot undo patch acme-deploy: the version snapshot v4 was pruned — the change is no longer revertible",
				},
			});
		} finally {
			await host.close();
		}
	});

	test("a notices.clear rejection after a successful undo still lands the undo toast", async () => {
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
			// The review posted its notice; the notice CLEAR then hiccups.
			await notify(host, conversation, ALICE, {
				status: "completed",
				text: "saved",
				changes: [
					{ changeId: "chg-1", summary: "updated `deploy-staging`", target: "skills" },
				],
				reviewId: "review-acme",
			});
			host.notices.clear = async () => {
				throw new Error("notices seam unavailable");
			};

			const view = createCuratorView(host);
			const result = await view.actions!["undoReview"](
				ctxOf(ALICE, { review: "review-acme" }),
				{},
			);

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
			const anonymous = await renderView(view, ctxOf(undefined));
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
			const bobs = await view.actions!["undoReview"](
				ctxOf(BOB, { review: "review-acme" }),
				{},
			);
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
