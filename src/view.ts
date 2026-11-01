/**
 * The curator view (`src/view.ts`, Task B5): the per-user surface the
 * notice navigates to — learned skills (name, description, last used,
 * pin toggle, archive/restore), overlays (orphaned flag), the change
 * feed (newest 50) grouped by review with an **Undo review** action,
 * and a pause switch.
 *
 * Access follows `accessOf` (spec P8: "the user, plus the superuser as
 * with conversations"): the resource is the caller's OWN curation data,
 * so a signed-in user is its owner ("write") and an anonymous caller
 * has no instance at all ("none" — accessOf's ownerless rule would
 * otherwise widen to household write, so the anonymous case is gated by
 * hand). Every render and action resolves the CALLING principal's own
 * stores — bob's instance reads bob's data, never alice's — and the
 * per-principal `instanceKey` keeps two users' views apart as surface
 * instances.
 *
 * The actions (what an ambient record can never carry — a view's action
 * routes DO reach the extension). Per-item actions ride the block
 * set's item-scoped dispatches, which carry `{itemId}` (a card action
 * button's submit dispatches a `null` payload — it cannot name an
 * item, `onCheck`/`onActivate` can):
 *
 * - `pin` — the skills collection's `checkable`/`onCheck`:
 *   `{itemId: skill, value}` → the skill store's `pin`;
 * - `toggleArchive` — the skills collection's `onActivate`
 *   (`{itemId: skill}`): reads the store's current state and archives
 *   or restores through `apply` (feed-recorded, undoable);
 * - `undoReview` — the feed collection's `onActivate`
 *   (`{itemId: reviewId}`): `host.curation.undoReview`, then
 *   `host.clearAmbient` on the notice conversation's `curator.notice`
 *   slot (the notice ledger in `src/notices.ts` remembers it);
 * - `setPaused` — the page header's pause button (a submit dispatching
 *   `{}`): toggles the user's `paused` setting, read live by both
 *   loops — pausing takes effect on the next event, restart-free.
 *
 * The tree is data-driven where the block set binds (item templates
 * over literal rows); the whole tree passes the server's own
 * `validateTree` (pinned in the tests) because the server runs that
 * exact walk before serving.
 */

import type {
	ActionResult,
	CurationFeedEntry,
	Principal,
	SigrunHost,
	SurfaceContext,
	SurfaceDef,
	SurfaceRenderResult,
} from "@sigrun/sigrun/extension";
import { accessOf } from "@sigrun/shared/access";
import type { Access } from "@sigrun/shared/access";
import { readNotices } from "./notices.js";
import { CURATOR_NOTICE_KIND } from "./notices.js";
import { parseCuratorSettings } from "./settings.js";

/** How many feed entries the view lists (the brief: newest 50). */
export const VIEW_FEED_LIMIT = 50;

/** The zero-signal context the ambient clear runs under. */
const CONTEXT = { abortSignal: undefined };

/** One grouped review block in the feed (newest first). */
export interface ReviewGroup {
	readonly id: string;
	readonly at: string;
	readonly entries: readonly {
		readonly id: string;
		readonly skill: string;
		readonly action: string;
		readonly at: string;
		readonly reason?: string;
	}[];
}

/** The view's data document (everything the tree binds against). */
export interface CuratorViewData {
	readonly user: string;
	readonly paused: boolean;
	readonly skills: readonly {
		readonly id: string;
		readonly name: string;
		readonly description: string;
		readonly archived: boolean;
		readonly pinned: boolean;
		readonly lastUsedLabel: string;
	}[];
	readonly overlays: readonly {
		readonly id: string;
		readonly skill: string;
		readonly root: string;
		readonly orphaned: boolean;
	}[];
	readonly reviews: readonly ReviewGroup[];
}

/**
 * Resolve one principal's access to their per-user view instance (spec
 * P8: "the user, plus the superuser as with conversations"): the
 * resource is the principal's OWN curation data, so a signed-in user is
 * its owner (write) and the service principal the superuser (write);
 * an anonymous caller has no instance at all — accessOf's ownerless
 * rule would widen to household write, so anonymous is none BY HAND.
 */
export function viewAccess(principal: Principal, user: string): Access {
	if (principal.user === undefined) return "none";
	return accessOf(
		{ user: principal.user, superuser: principal.service },
		{ owner: user },
	);
}

/** Group a feed by review: entries sharing a reviewId form one group
 *  (the feed's newest-first order preserved, outside and inside). An
 *  entry with no reviewId (user pins, direct edits) groups alone. */
export function groupFeed(
	feed: readonly CurationFeedEntry[],
): readonly ReviewGroup[] {
	const groups = new Map<string, ReviewGroup>();
	for (const entry of feed) {
		const key = entry.reviewId ?? entry.id;
		const row = {
			id: entry.id,
			skill: entry.skill,
			action: entry.action,
			at: entry.at,
			...(entry.reason === undefined ? {} : { reason: entry.reason }),
		};
		const existing = groups.get(key);
		if (existing === undefined) {
			groups.set(key, { id: key, at: entry.at, entries: [row] });
		} else {
			groups.set(key, { ...existing, entries: [...existing.entries, row] });
		}
	}
	return [...groups.values()];
}

/** A human label for one skill's last-used stamp ("never" or the date). */
function lastUsedLabel(at: string | undefined): string {
	if (at === undefined) return "never";
	const date = new Date(at);
	return Number.isNaN(date.getTime()) ? "never" : date.toISOString().slice(0, 10);
}

/** Build the view's data document for one user (the render's model). */
async function readData(
	host: SigrunHost,
	user: string,
): Promise<CuratorViewData> {
	const settings = parseCuratorSettings(await host.stores.user(user).settings.get());
	const usage = await host.curation.usage(user);
	const skills = await host.curation.skills(user).list();
	const overlays = await host.curation.overlays(user).list();
	const feed = await host.curation.skills(user).feed(VIEW_FEED_LIMIT);
	return {
		user,
		paused: settings.paused,
		skills: [...skills]
			.sort((a, b) => a.name.localeCompare(b.name))
			.map((row) => ({
				id: row.name,
				name: row.name,
				description: row.description,
				archived: row.archived,
				pinned: row.pinned,
				lastUsedLabel: lastUsedLabel(usage[row.name]),
			})),
		overlays: [...overlays]
			.map((row) => ({
				id: row.key.skill,
				skill: row.key.skill,
				root: row.key.root,
				orphaned: row.orphanedSince !== undefined,
			}))
			.sort((a, b) => a.skill.localeCompare(b.skill)),
		reviews: groupFeed(feed),
	};
}

/** Whether `payload` (an action's JSON argument) is a plain object. */
function isObject(
	payload: unknown,
): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

/** The `{itemId, value}` dispatch an `onCheck` toggle carries. */
function itemToggle(
	payload: unknown,
): { itemId: string; value: boolean } | undefined {
	if (!isObject(payload)) return undefined;
	const itemId = payload.itemId;
	const value = payload.value;
	if (typeof itemId !== "string" || itemId === "") return undefined;
	if (typeof value !== "boolean") return undefined;
	return { itemId, value };
}

/** The `{itemId}` dispatch an `onActivate` click carries. */
function itemIdOf(payload: unknown): string | undefined {
	if (!isObject(payload)) return undefined;
	const itemId = payload.itemId;
	return typeof itemId === "string" && itemId !== "" ? itemId : undefined;
}

/** The view surface (`SurfaceDef<"view">`), built over the host. */
export function createCuratorView(host: SigrunHost): SurfaceDef<"view"> {
	/** Reject for a caller with no instance of their own. */
	const noAccess = (): ActionResult => ({
		ok: false,
		error: { message: "sign in to use the curator view" },
	});

	/** The caller's user, or a reject when they have no instance. */
	function callerOf(ctx: SurfaceContext): { user: string } | { reject: ActionResult } {
		const user = ctx.principal.user;
		if (user === undefined) return { reject: noAccess() };
		if (viewAccess(ctx.principal, user) === "none") return { reject: noAccess() };
		return { user };
	}

	return {
		id: "curator",
		title: "Curator",
		icon: "book",
		placement: "view",
		// A principal-owned surface (§7.3): the principal folds into the
		// instance identity so two users' views are two instances.
		instanceKey: (params, principal) =>
			JSON.stringify([principal.user ?? "", params]),
		render: async (ctx: SurfaceContext) => {
			const who = callerOf(ctx);
			if ("reject" in who) {
				return { tree: emptyTree(), data: {}, access: "none" };
			}
			const data = await readData(host, who.user);
			return {
				tree: viewTree(data),
				// SAFETY: the data document is a JSON mirror (every field a
				// literal); the interface lacks the index signature JsonObject
				// requires, so the cast only restores that erased identity.
				data: data as unknown as SurfaceRenderResult["data"],
				access: "write",
			};
		},
		data: async (ctx: SurfaceContext) => {
			const who = callerOf(ctx);
			if ("reject" in who) return { data: {}, access: "none" };
			return {
				// SAFETY: same JSON-mirror cast as `render`'s (the comment there).
				data: (await readData(host, who.user)) as unknown as SurfaceRenderResult["data"],
				access: "write",
			};
		},
		actions: {
			undoReview: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const who = callerOf(ctx);
				if ("reject" in who) return who.reject;
				const reviewId = itemIdOf(payload);
				if (reviewId === undefined) {
					return { ok: false, error: { message: "undoReview expects {itemId}" } };
				}
				const reverted = await host.curation.undoReview(who.user, reviewId);
				// Clear the notice this review set, when the ledger remembers
				// one (a digest review with no notice clears nothing).
				const notice = (await readNotices(host, who.user)).find(
					(entry) => entry.reviewId === reviewId,
				);
				if (notice !== undefined) {
					await host.clearAmbient(
						notice.conversationId,
						CURATOR_NOTICE_KIND,
						CONTEXT,
					);
				}
				return {
					ok: true,
					toast: reverted > 0 ? `Undid ${reverted} change(s)` : "Nothing to undo",
				};
			},
			pin: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const who = callerOf(ctx);
				if ("reject" in who) return who.reject;
				const toggle = itemToggle(payload);
				if (toggle === undefined) {
					return { ok: false, error: { message: "pin expects {itemId, value}" } };
				}
				await host.curation.skills(who.user).pin(toggle.itemId, toggle.value);
				return {
					ok: true,
					toast: toggle.value ? `Pinned ${toggle.itemId}` : `Unpinned ${toggle.itemId}`,
				};
			},
			toggleArchive: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const who = callerOf(ctx);
				if ("reject" in who) return who.reject;
				const name = itemIdOf(payload);
				if (name === undefined) {
					return { ok: false, error: { message: "toggleArchive expects {itemId}" } };
				}
				// The current store state decides the direction: click an
				// active skill → archive; click an archived one → restore.
				const row = (await host.curation.skills(who.user).list()).find(
					(skill) => skill.name === name,
				);
				if (row === undefined) {
					return { ok: false, error: { message: `unknown skill: ${name}` } };
				}
				const change = row.archived
					? ({ kind: "restore" } as const)
					: ({ kind: "archive" } as const);
				await host.curation
					.skills(who.user)
					.apply(name, change, { reason: `${change.kind === "archive" ? "archived" : "restored"} from the curator view` });
				return {
					ok: true,
					toast: change.kind === "archive" ? `Archived ${name}` : `Restored ${name}`,
				};
			},
			setPaused: async (
				ctx: SurfaceContext,
				payload: unknown,
			): Promise<ActionResult> => {
				const who = callerOf(ctx);
				if ("reject" in who) return who.reject;
				// The header button dispatches `{}` (toggle); a form-shaped
				// `{values: {paused}}` or bare `{paused}` sets explicitly.
				const explicit =
					(isObject(payload) && isObject(payload.values)
						? payload.values.paused
						: undefined) ??
					(isObject(payload) ? payload.paused : undefined);
				const raw = await host.stores.user(who.user).settings.get();
				const current = parseCuratorSettings(raw).paused;
				const paused =
					typeof explicit === "boolean" ? explicit : !current;
				if (paused === current) {
					return { ok: true, toast: paused ? "Curation paused" : "Curation resumed" };
				}
				await host.stores.user(who.user).settings.set({ ...raw, paused });
				return {
					ok: true,
					toast: paused ? "Curation paused" : "Curation resumed",
				};
			},
		},
	};
}

/** The signed-out/none-access tree (an empty page; the route 404s it). */
function emptyTree() {
	return {
		v: 1 as const,
		root: {
			type: "page" as const,
			title: "Curator",
			main: [
				{ type: "markdown" as const, text: "Sign in to see your curator activity." },
			],
		},
	};
}

/** The view tree: header with the pause switch, skills, overlays, feed. */
function viewTree(data: CuratorViewData) {
	return {
		v: 1 as const,
		root: {
			type: "page" as const,
			id: "curator-root",
			title: "Curator",
			subtitle: `Learned activity for ${data.user}${data.paused ? " (paused)" : ""}`,
			actions: [
				{
					id: "pause-switch",
					label: data.paused ? "Resume curation" : "Pause curation",
					icon: data.paused ? ("sun" as const) : ("moon" as const),
					action: { type: "submit" as const, name: "setPaused" },
				},
			],
			main: [
				{
					type: "section" as const,
					id: "skills-section",
					title: "Learned skills",
					children: [
						{
							type: "markdown" as const,
							text: "Toggle the checkbox to pin or unpin. Click a skill to archive it; click an archived one to restore.",
						},
						{
							type: "collection" as const,
							id: "skills",
							display: "list" as const,
							items: data.skills as never,
							checkable: "pinned",
							onCheck: "pin",
							onActivate: { type: "edit" as const, name: "toggleArchive" },
							item: {
								title: { $: "./name" },
								subtitle: { $: "./description" },
								body: { $: "./lastUsedLabel" },
								badges: [
									{ text: "pinned", tone: "good" as const },
									{ text: "archived", tone: "neutral" as const },
								],
							},
						},
					],
				},
				{
					type: "section" as const,
					id: "overlays-section",
					title: "Overlays",
					children: [
						data.overlays.length === 0
							? {
									type: "markdown" as const,
									text: "No overlays on upstream skills.",
								}
							: {
									type: "collection" as const,
									id: "overlays",
									display: "list" as const,
									items: data.overlays as never,
									item: {
										title: { $: "./skill" },
										subtitle: { $: "./root" },
										badges: [{ text: "orphaned", tone: "warn" as const }],
									},
								},
					],
				},
				{
					type: "section" as const,
					id: "feed-section",
					title: "Change feed (newest 50, grouped by review)",
					children: [
						{
							type: "markdown" as const,
							text: "Click a review to undo every change it made.",
						},
						data.reviews.length === 0
							? {
									type: "markdown" as const,
									text: "Nothing learned yet. Use /learn to ask for a review now.",
								}
							: {
									type: "collection" as const,
									id: "reviews",
									display: "list" as const,
									items: data.reviews.map((group) => ({
										id: group.id,
										at: group.at,
										summary: group.entries
											.map((entry) => `${entry.action} ${entry.skill}`)
											.join(", "),
									})) as never,
									onActivate: { type: "edit" as const, name: "undoReview" },
									item: {
										title: { $: "./id" },
										subtitle: { $: "./summary" },
										meta: [{ time: { $: "./at" }, format: "relative" as const }],
									},
								},
					],
				},
			],
		},
	};
}
