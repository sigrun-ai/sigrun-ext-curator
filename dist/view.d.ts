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
import type { CurationFeedEntry, Principal, SigrunHost, SurfaceDef } from "@sigrun/sigrun/extension";
import type { Access } from "@sigrun/shared/access";
/** How many feed entries the view lists (the brief: newest 50). */
export declare const VIEW_FEED_LIMIT = 50;
/** How many pages a `review` deep-link walks before giving up (the
 *  link arrives from the core skills history at ANY depth; core's
 *  own `feedOf` walks until the entries run out — this view bounds
 *  the walk and says so when the bound elapses). */
export declare const VIEW_FEED_MAX_PAGES = 3;
/** One grouped review block in the feed (newest first). */
export interface ReviewGroup {
    readonly id: string;
    readonly at: string;
    readonly entries: readonly {
        readonly id: string;
        readonly skill: string;
        readonly action: string;
        readonly at: string;
        readonly actor: string;
        readonly reason?: string;
    }[];
}
/** One non-undo change on a review page (the id is its commit SHA). */
export interface ReviewChange {
    readonly id: string;
    readonly skill: string;
    readonly action: string;
    readonly actor: string;
    readonly at: string;
    readonly archived: boolean;
}
/** The selected review, including a deep link the bounded walk missed. */
export interface ReviewDetail {
    readonly id: string;
    readonly at: string | undefined;
    readonly undoneAt?: string;
    readonly changes: readonly ReviewChange[];
    readonly missed: boolean;
}
/** The view's data document (everything the tree binds against). */
export interface CuratorViewData {
    readonly user: string;
    readonly paused: boolean;
    readonly reviews: readonly ReviewGroup[];
    /** True when a `review` deep-link missed after the bounded walk
     *  (the empty state is then "older than the recent changes", never
     *  the false "Nothing learned yet"). */
    readonly reviewMissed: boolean;
    readonly review?: ReviewDetail;
}
/**
 * Resolve one principal's access to their per-user view instance (spec
 * P8: "the user, plus the superuser as with conversations"): the
 * resource is the principal's OWN curation data, so a signed-in user is
 * its owner (write) and the service principal the superuser (write);
 * an anonymous caller has no instance at all — accessOf's ownerless
 * rule would widen to household write, so anonymous is none BY HAND.
 */
export declare function viewAccess(principal: Principal, user: string): Access;
/** One actor's display name (the git trailer's name: outside
 *  catch-up commits render as "outside sigrun"). */
export declare function actorLabel(entry: CurationFeedEntry): string;
/** Group a feed for undo: entries SHARING A REVIEW ID AND ADJACENT in
 *  the newest-first feed form one group — the group's id is its newest
 *  commit sha (`review-<sha>`). Keying on the sha (never the review
 *  id) keeps two interleaved reviews apart: undoing one must revert
 *  exactly the commits it authored. An entry with no reviewId groups
 *  alone (a lone commit is never undoable as a review). */
export declare function groupFeed(feed: readonly CurationFeedEntry[]): readonly ReviewGroup[];
/** Resolve a feed group's `review-<sha>` coordinate to its review id. */
export declare function resolveReviewId(host: SigrunHost, user: string, groupId: string): Promise<string | undefined>;
/** The view surface (`SurfaceDef<"view">`), built over the host. */
export declare function createCuratorView(host: SigrunHost): SurfaceDef<"view">;
