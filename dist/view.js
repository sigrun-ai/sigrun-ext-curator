/**
 * The curator view (`src/view.ts`, tabs+skills Task 13): the per-user
 * surface the notice and the core Skills history link navigate to —
 * the change FEED (newest 50) with an **Undo review** action per
 * review, and a pause switch. Skill management (list, pin,
 * archive/restore, overlays) moved to the core Skills view when it
 * landed (core-views/skills.ts): this view lists no learned skills and
 * no overlays any more, and its **Skills** page action navigates
 * `{target:{view:{extension:"core", id:"skills"}}}`.
 *
 * A `review` param filters the feed to that review's commits (the core
 * skills history's curator-commit link and the notice both navigate
 * here with it). Feed entry ids are commit SHAs in the user's curation
 * history repo (tabs+skills Task 9), so the undo groups key on the
 * SHA, never on the review id: a review reverted through
 * `host.curation.undoReview` needs every commit the review authored,
 * and grouping by review id would merge two interleaved reviews into
 * one undo. Actors render as their names — `curator`, `agent`, the
 * user, and `outside sigrun` for catch-up commits the store itself
 * did not author (the git trailer's actor name).
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
 * set's item-scoped dispatches, which carry `{itemId}`:
 *
 * - `undoReview` — the feed collection's `onActivate`
 *   (`{itemId: groupId}` where the group id is `review-<newest sha>`):
 *   resolves the sha back to the entry's review id through the feed
 *   (core's `undoReview` matches `entry.reviewId`, never the group
 *   key), then `host.curation.undoReview`, then `host.clearAmbient` on
 *   the notice conversation's `curator.notice` slot (the notice ledger
 *   in `src/notices.ts` remembers it); a commit with no review id
 *   answers "Nothing to undo" without calling the host;
 * - `setPaused` — the page header's pause button (a submit dispatching
 *   `{}`): toggles the user's `paused` setting, read live by both
 *   loops — pausing takes effect on the next event, restart-free.
 *
 * The tree is data-driven where the block set binds (item templates
 * over literal rows); the whole tree passes the server's own
 * `validateTree` (pinned in the tests) because the server runs that
 * exact walk before serving.
 */
import { accessOf } from "@sigrun/shared/access";
import { readNotices } from "./notices.js";
import { CURATOR_NOTICE_KIND } from "./notices.js";
import { parseCuratorSettings } from "./settings.js";
/** How many feed entries the view lists (the brief: newest 50). */
export const VIEW_FEED_LIMIT = 50;
/** How many pages a `review` deep-link walks before giving up (the
 *  link arrives from the core skills history at ANY depth; core's
 *  own `feedOf` walks until the entries run out — this view bounds
 *  the walk and says so when the bound elapses). */
export const VIEW_FEED_MAX_PAGES = 3;
/** The zero-signal context the ambient clear runs under. */
const CONTEXT = { abortSignal: undefined };
/**
 * Resolve one principal's access to their per-user view instance (spec
 * P8: "the user, plus the superuser as with conversations"): the
 * resource is the principal's OWN curation data, so a signed-in user is
 * its owner (write) and the service principal the superuser (write);
 * an anonymous caller has no instance at all — accessOf's ownerless
 * rule would widen to household write, so anonymous is none BY HAND.
 */
export function viewAccess(principal, user) {
    if (principal.user === undefined)
        return "none";
    return accessOf({ user: principal.user, superuser: principal.service }, { owner: user });
}
/** One actor's display name (the git trailer's name: outside
 *  catch-up commits render as "outside sigrun"). */
export function actorLabel(entry) {
    return entry.actor === "outside" ? "outside sigrun" : entry.actor;
}
/** Group a feed for undo: entries SHARING A REVIEW ID AND ADJACENT in
 *  the newest-first feed form one group — the group's id is its newest
 *  commit sha (`review-<sha>`). Keying on the sha (never the review
 *  id) keeps two interleaved reviews apart: undoing one must revert
 *  exactly the commits it authored. An entry with no reviewId groups
 *  alone (a lone commit is never undoable as a review). */
export function groupFeed(feed) {
    const groups = [];
    let current;
    let currentReview;
    for (const entry of feed) {
        const row = {
            id: entry.id,
            skill: entry.skill,
            action: entry.action,
            at: entry.at,
            actor: actorLabel(entry),
            ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        };
        if (entry.reviewId !== undefined &&
            current !== undefined &&
            currentReview === entry.reviewId) {
            current = { ...current, entries: [...current.entries, row] };
            groups[groups.length - 1] = current;
        }
        else {
            current = {
                id: `review-${entry.id}`,
                at: entry.at,
                entries: [row],
            };
            groups.push(current);
        }
        currentReview = entry.reviewId;
    }
    return groups;
}
/** The `review` param a render was anchored at (the core skills
 *  history link and the notice navigate with it), or undefined. */
function reviewParam(ctx) {
    const review = ctx.params.review;
    return typeof review === "string" && review !== "" ? review : undefined;
}
/** Read the feed: the plain view is the newest VIEW_FEED_LIMIT only
 *  (the section's "newest 50" contract — every rendered group's sha
 *  resolves for undo from that same page). A `review` deep-link pages
 *  on (last sha as the cursor, core's feedOf shape, bounded) until
 *  the review's entries appear or the walk elapses; a miss on ANY
 *  exit path — short page or bound — is reported, never rendered as
 *  the false "Nothing learned yet". */
async function feedFor(host, user, review) {
    const store = host.curation.skills(user);
    const collected = [];
    let before;
    do {
        const rows = await store.feed(VIEW_FEED_LIMIT, before);
        collected.push(...rows);
        if (rows.length < VIEW_FEED_LIMIT)
            break; // the last page
        if (review !== undefined &&
            rows.some((entry) => entry.reviewId === review))
            break; // the deep-link found its review
        before = rows[rows.length - 1]?.id;
    } while (review !== undefined && collected.length < VIEW_FEED_LIMIT * VIEW_FEED_MAX_PAGES);
    return {
        feed: collected,
        reviewMissed: review !== undefined &&
            !collected.some((entry) => entry.reviewId === review),
    };
}
/** Build the view's data document for one user (the render's model). */
async function readData(host, user, review) {
    const settings = parseCuratorSettings(await host.stores.user(user).settings.get());
    const { feed, reviewMissed } = await feedFor(host, user, review);
    return {
        user,
        paused: settings.paused,
        reviews: groupFeed(review === undefined
            ? feed
            : feed.filter((entry) => entry.reviewId === review)),
        reviewMissed,
    };
}
/** Whether `payload` (an action's JSON argument) is a plain object. */
function isObject(payload) {
    return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}
/** The `{itemId}` dispatch an `onActivate` click carries. */
function itemIdOf(payload) {
    if (!isObject(payload))
        return undefined;
    const itemId = payload.itemId;
    return typeof itemId === "string" && itemId !== "" ? itemId : undefined;
}
/** The view surface (`SurfaceDef<"view">`), built over the host. */
export function createCuratorView(host) {
    /** Reject for a caller with no instance of their own. */
    const noAccess = () => ({
        ok: false,
        error: { message: "sign in to use the curator view" },
    });
    /** The caller's user, or a reject when they have no instance. */
    function callerOf(ctx) {
        const user = ctx.principal.user;
        if (user === undefined)
            return { reject: noAccess() };
        if (viewAccess(ctx.principal, user) === "none")
            return { reject: noAccess() };
        return { user };
    }
    return {
        id: "curator",
        title: "Curator",
        icon: "book",
        placement: "view",
        // A principal-owned surface (§7.3): the principal folds into the
        // instance identity so two users' views are two instances.
        instanceKey: (params, principal) => JSON.stringify([principal.user ?? "", params]),
        render: async (ctx) => {
            const who = callerOf(ctx);
            if ("reject" in who) {
                return { tree: emptyTree(), data: {}, access: "none" };
            }
            const data = await readData(host, who.user, reviewParam(ctx));
            return {
                tree: viewTree(data),
                // SAFETY: the data document is a JSON mirror (every field a
                // literal); the interface lacks the index signature JsonObject
                // requires, so the cast only restores that erased identity.
                data: data,
                access: "write",
            };
        },
        data: async (ctx) => {
            const who = callerOf(ctx);
            if ("reject" in who)
                return { data: {}, access: "none" };
            return {
                // SAFETY: same JSON-mirror cast as `render`'s (the comment there).
                data: (await readData(host, who.user, reviewParam(ctx))),
                access: "write",
            };
        },
        actions: {
            undoReview: async (ctx, payload) => {
                const who = callerOf(ctx);
                if ("reject" in who)
                    return who.reject;
                const itemId = itemIdOf(payload);
                if (itemId === undefined) {
                    return { ok: false, error: { message: "undoReview expects {itemId}" } };
                }
                // On a deep-link the param already names the review — and
                // the group's sha may sit past page 1 of the feed, where
                // the single-page lookup below cannot see it. Dispatch the
                // param's review id directly.
                const anchored = reviewParam(ctx);
                if (anchored !== undefined) {
                    const reverted = await host.curation.undoReview(who.user, anchored);
                    const anchoredNotice = (await readNotices(host, who.user)).find((entry) => entry.reviewId === anchored);
                    if (anchoredNotice !== undefined) {
                        await host.clearAmbient(anchoredNotice.conversationId, CURATOR_NOTICE_KIND, CONTEXT).catch(() => undefined);
                    }
                    return {
                        ok: true,
                        toast: reverted > 0 ? `Undid ${reverted} change(s)` : "Nothing to undo",
                    };
                }
                // The dispatch carries the GROUP key (`review-<sha>`, minted
                // by groupFeed); core's undoReview matches entry.reviewId.
                // Resolve the sha back to the review id through the feed — a
                // verbatim dispatch would match nothing and silently revert 0.
                // A bare review id (the pre-upgrade coordinate, and digest
                // ids like "digest-<date>" that already carry the prefix) is
                // the fallback when no entry's sha matches.
                const sha = itemId.startsWith("review-")
                    ? itemId.slice("review-".length)
                    : itemId;
                const feed = await host.curation.skills(who.user).feed(VIEW_FEED_LIMIT);
                const reviewId = feed.find((entry) => entry.id === sha)?.reviewId ??
                    (feed.some((entry) => entry.reviewId === itemId)
                        ? itemId
                        : undefined);
                if (reviewId === undefined) {
                    return { ok: true, toast: "Nothing to undo" };
                }
                const reverted = await host.curation.undoReview(who.user, reviewId);
                // Clear the notice this review set, when the ledger remembers
                // one (a digest review with no notice clears nothing).
                const notice = (await readNotices(host, who.user)).find((entry) => entry.reviewId === reviewId);
                if (notice !== undefined) {
                    // The revert already succeeded — a failing clear only leaves a
                    // stale notice (replaced by the next review's), so it must
                    // never turn the undo into a failed action with no toast.
                    await host.clearAmbient(notice.conversationId, CURATOR_NOTICE_KIND, CONTEXT).catch(() => undefined);
                }
                return {
                    ok: true,
                    toast: reverted > 0 ? `Undid ${reverted} change(s)` : "Nothing to undo",
                };
            },
            setPaused: async (ctx, payload) => {
                const who = callerOf(ctx);
                if ("reject" in who)
                    return who.reject;
                // The header button dispatches `{}` (toggle); a form-shaped
                // `{values: {paused}}` or bare `{paused}` sets explicitly.
                const explicit = (isObject(payload) && isObject(payload.values)
                    ? payload.values.paused
                    : undefined) ??
                    (isObject(payload) ? payload.paused : undefined);
                const raw = await host.stores.user(who.user).settings.get();
                const current = parseCuratorSettings(raw).paused;
                const paused = typeof explicit === "boolean" ? explicit : !current;
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
        v: 1,
        root: {
            type: "page",
            title: "Curator",
            main: [
                { type: "markdown", text: "Sign in to see your curator activity." },
            ],
        },
    };
}
/** The view tree: header actions (pause switch + the Skills
 *  link to the core view), then the feed grouped for undo. */
function viewTree(data) {
    return {
        v: 1,
        root: {
            type: "page",
            id: "curator-root",
            title: "Curator",
            subtitle: `Learned activity for ${data.user}${data.paused ? " (paused)" : ""}`,
            actions: [
                {
                    id: "pause-switch",
                    label: data.paused ? "Resume curation" : "Pause curation",
                    icon: data.paused ? "sun" : "moon",
                    action: { type: "submit", name: "setPaused" },
                },
                {
                    id: "open-skills",
                    label: "Skills",
                    icon: "book",
                    action: {
                        type: "navigate",
                        target: {
                            view: { extension: "core", id: "skills" },
                        },
                    },
                },
            ],
            main: [
                {
                    type: "section",
                    id: "feed-section",
                    title: "Change feed (newest 50, grouped by review)",
                    children: [
                        {
                            type: "markdown",
                            text: "Click a review to undo every change it made. Outside sigrun marks catch-up commits made outside sigrun.",
                        },
                        data.reviews.length === 0
                            ? {
                                type: "markdown",
                                text: data.reviewMissed
                                    ? "This review is older than the recent changes."
                                    : "Nothing learned yet. Use /learn to ask for a review now.",
                            }
                            : {
                                type: "collection",
                                id: "reviews",
                                display: "list",
                                items: data.reviews.map((group) => ({
                                    id: group.id,
                                    at: group.at,
                                    summary: group.entries
                                        .map((entry) => `${entry.action} ${entry.skill} (${entry.actor})`)
                                        .join(", "),
                                })),
                                onActivate: { type: "edit", name: "undoReview" },
                                item: {
                                    title: { $: "./id" },
                                    subtitle: { $: "./summary" },
                                    meta: [{ time: { $: "./at" }, format: "relative" }],
                                },
                            },
                    ],
                },
            ],
        },
    };
}
