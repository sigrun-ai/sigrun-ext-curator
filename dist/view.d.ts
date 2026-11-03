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
/** The view's data document (everything the tree binds against). */
export interface CuratorViewData {
    readonly user: string;
    readonly paused: boolean;
    readonly reviews: readonly ReviewGroup[];
    /** True when a `review` deep-link missed after the bounded walk
     *  (the empty state is then "older than the recent changes", never
     *  the false "Nothing learned yet"). */
    readonly reviewMissed: boolean;
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
/** The view surface (`SurfaceDef<"view">`), built over the host. */
export declare function createCuratorView(host: SigrunHost): SurfaceDef<"view">;
