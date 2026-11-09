/**
 * The curator view: a per-user change feed (newest 50) whose reviews
 * open a detail page. Clicking a feed row only navigates; Undo review
 * is a confirmed callout action on the detail page, never a feed
 * activation. The feed page also carries the pause switch and a link
 * to core Skills, where skill management now lives.
 *
 * A `review` param selects the detail page (the core Skills history
 * and the notice navigate with it). Its change rows key on commit SHA
 * and open the changed skill in core Skills; overlay rows explain that
 * they open from Skills instead. Reviews beyond the bounded feed walk
 * retain their deep link and Undo action.
 *
 * Access follows `accessOf`: a signed-in principal owns their curation
 * data, the service principal is the superuser, and an anonymous caller
 * has no instance. Every render and action reads the calling
 * principal's own stores, with a per-principal `instanceKey`.
 *
 * Actions: `openReview` resolves a feed group SHA to its review id;
 * `openChangeSkill` resolves a review's commit SHA to its skill;
 * `undoReview` requires the page's review param, reverts it, then
 * clears `review:<reviewId>`; `setPaused` toggles the user's setting.
 * Every tree passes core's `validateTree` in the tests.
 */
import { accessOf } from "@sigrun/shared/access";
import { reviewNoticeKey } from "./notices.js";
import { readSettings } from "./settings.js";
/** How many feed entries the view lists (the brief: newest 50). */
export const VIEW_FEED_LIMIT = 50;
/** How many pages a `review` deep-link walks before giving up (the
 *  link arrives from the core skills history at ANY depth; core's
 *  own `feedOf` walks until the entries run out — this view bounds
 *  the walk and says so when the bound elapses). */
export const VIEW_FEED_MAX_PAGES = 3;
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
/** Resolve a feed group's `review-<sha>` coordinate to its review id. */
export async function resolveReviewId(host, user, groupId) {
    const sha = groupId.startsWith("review-")
        ? groupId.slice("review-".length)
        : groupId;
    const feed = await host.curation.skills(user).feed(VIEW_FEED_LIMIT);
    return (feed.find((entry) => entry.id === sha)?.reviewId ??
        (feed.some((entry) => entry.reviewId === groupId) ? groupId : undefined));
}
/** Build the view's data document for one user (the render's model). */
async function readData(host, user, review) {
    const settings = await readSettings(host, user);
    const { feed, reviewMissed } = await feedFor(host, user, review);
    let detail;
    if (review !== undefined) {
        const entries = feed.filter((entry) => entry.reviewId === review);
        const skills = await host.curation.skills(user).list();
        const archived = new Set(skills.filter((skill) => skill.archived).map((skill) => skill.name));
        const undoneAt = entries.find((entry) => entry.action === "undo")?.at;
        detail = {
            id: review,
            at: entries[0]?.at,
            ...(undoneAt === undefined ? {} : { undoneAt }),
            changes: entries
                .filter((entry) => entry.action !== "undo")
                .reverse()
                .map((entry) => ({
                id: entry.id,
                skill: entry.skill,
                action: entry.action,
                actor: actorLabel(entry),
                at: entry.at,
                archived: archived.has(entry.skill),
            })),
            missed: reviewMissed,
        };
    }
    return {
        user,
        paused: settings.paused,
        reviews: groupFeed(feed),
        reviewMissed,
        ...(detail === undefined ? {} : { review: detail }),
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
        icon: "edit",
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
            openReview: async (ctx, payload) => {
                const who = callerOf(ctx);
                if ("reject" in who)
                    return who.reject;
                const itemId = itemIdOf(payload);
                if (itemId === undefined) {
                    return { ok: false, error: { message: "openReview expects {itemId}" } };
                }
                const review = await resolveReviewId(host, who.user, itemId);
                if (review === undefined)
                    return { ok: true, toast: "Nothing to review" };
                return {
                    ok: true,
                    navigate: { type: "navigate", params: { review } },
                };
            },
            openChangeSkill: async (ctx, payload) => {
                const who = callerOf(ctx);
                if ("reject" in who)
                    return who.reject;
                const review = reviewParam(ctx);
                if (review === undefined) {
                    return { ok: false, error: { message: "openChangeSkill needs a review" } };
                }
                const itemId = itemIdOf(payload);
                if (itemId === undefined) {
                    return { ok: false, error: { message: "openChangeSkill expects {itemId}" } };
                }
                const { feed } = await feedFor(host, who.user, review);
                const entry = feed.find((candidate) => candidate.id === itemId && candidate.reviewId === review);
                if (entry === undefined)
                    return { ok: true, toast: "Nothing to open" };
                if (entry.action === "overlay") {
                    return { ok: true, toast: "Overlays open from Skills." };
                }
                return {
                    ok: true,
                    navigate: {
                        type: "navigate",
                        target: {
                            view: {
                                extension: "core",
                                id: "skills",
                                params: { skill: entry.skill, root: "learned" },
                            },
                        },
                    },
                };
            },
            undoReview: async (ctx, _payload) => {
                const who = callerOf(ctx);
                if ("reject" in who)
                    return who.reject;
                const reviewId = reviewParam(ctx);
                if (reviewId === undefined) {
                    return { ok: false, error: { message: "undoReview needs a review" } };
                }
                // A failing undo is a named action error, never a thrown one.
                const fail = (cause) => ({
                    ok: false,
                    error: { message: cause instanceof Error ? cause.message : String(cause) },
                });
                let reverted;
                try {
                    reverted = await host.curation.undoReview(who.user, reviewId);
                }
                catch (cause) {
                    return fail(cause);
                }
                // The revert succeeded: a notice-clear failure must not turn
                // it into a failed action or suppress the undo toast.
                await host.notices
                    .clear({ user: who.user, key: reviewNoticeKey(reviewId) })
                    .catch(() => undefined);
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
                const current = (await readSettings(host, who.user)).paused;
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
/** The view tree: the feed, or the selected review's detail page. */
function viewTree(data) {
    const skillsAction = {
        id: "open-skills",
        label: "Skills",
        icon: "book",
        action: {
            type: "navigate",
            target: {
                view: { extension: "core", id: "skills" },
            },
        },
    };
    if (data.review !== undefined) {
        const review = data.review;
        return {
            v: 1,
            root: {
                type: "page",
                id: "curator-root",
                title: "Curator",
                subtitle: review.at === undefined || review.missed
                    ? "Review"
                    : `Review ${review.at}`,
                actions: [
                    {
                        id: "back-to-feed",
                        label: "Back to feed",
                        icon: "list",
                        action: { type: "navigate", params: {} },
                    },
                    skillsAction,
                ],
                main: [
                    review.undoneAt === undefined
                        ? {
                            type: "callout",
                            id: "undo-callout",
                            tone: "warn",
                            title: "Undo review",
                            body: "Undo also reverts this review's knowledge and memory changes.",
                            actions: [
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
                            ],
                        }
                        : {
                            type: "callout",
                            id: "undo-callout",
                            tone: "neutral",
                            title: `Undone ${review.undoneAt}. Archived skills can be restored from Skills.`,
                        },
                    ...(review.missed
                        ? [
                            {
                                type: "markdown",
                                text: "This review is older than the recent changes.",
                            },
                        ]
                        : []),
                    {
                        type: "section",
                        id: "changes-section",
                        title: "Changes",
                        subtitle: "Newest changes from the feed. Undo reverts every change this review made.",
                        children: [
                            {
                                type: "collection",
                                id: "changes",
                                display: "list",
                                items: review.changes.map((change) => ({
                                    ...change,
                                    title: `${change.action} ${change.skill}`,
                                    ...(change.archived
                                        ? { badges: [{ text: "Archived", tone: "neutral" }] }
                                        : {}),
                                })),
                                onActivate: { type: "edit", name: "openChangeSkill" },
                                item: {
                                    title: { $: "./title" },
                                    subtitle: { $: "./actor" },
                                    meta: [{ time: { $: "./at" }, format: "relative" }],
                                },
                            },
                        ],
                    },
                ],
            },
        };
    }
    return feedTree(data, skillsAction);
}
function feedTree(data, skillsAction) {
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
                skillsAction,
            ],
            main: [
                {
                    type: "section",
                    id: "feed-section",
                    title: "Change feed (newest 50, grouped by review)",
                    children: [
                        {
                            type: "markdown",
                            text: "Click a review to see what it changed. Outside sigrun marks catch-up commits made outside sigrun.",
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
                                onActivate: { type: "edit", name: "openReview" },
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
