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
import type { CurationFeedEntry, Principal, SigrunHost, SurfaceDef } from "@sigrun/sigrun/extension";
import type { Access } from "@sigrun/shared/access";
/** How many feed entries the view lists (the brief: newest 50). */
export declare const VIEW_FEED_LIMIT = 50;
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
export declare function viewAccess(principal: Principal, user: string): Access;
/** Group a feed by review: entries sharing a reviewId form one group
 *  (the feed's newest-first order preserved, outside and inside). An
 *  entry with no reviewId (user pins, direct edits) groups alone. */
export declare function groupFeed(feed: readonly CurationFeedEntry[]): readonly ReviewGroup[];
/** The view surface (`SurfaceDef<"view">`), built over the host. */
export declare function createCuratorView(host: SigrunHost): SurfaceDef<"view">;
