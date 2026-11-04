/**
 * The post-review notice (`src/notices.ts`, notices Task 9): what the
 * user sees when a review changed something — ONE core per-user notice
 * posted through `host.notices.post`, keyed `review:<reviewId>` (a
 * re-run of one review replaces its notice), aimed at the review's
 * owner and carrying the originating conversation id.
 *
 * The title joins the change lines (`Learned: <summary>` per change);
 * the body tells the user where the review lives. Two actions ride the
 * notice: **Undo** — an extension action running the declared
 * `undoReview` notice-action handler with payload `{reviewId}` (behind
 * a confirm prompt), and **Review** — a navigate action to the curator
 * view anchored at the review.
 *
 * This replaced the pre-core-notices shape (an ambient record on the
 * conversation, with the undo only reachable through the view): the
 * ambient seam is display-only, so Undo could never ride it. Core
 * notices carry extension actions natively. `CURATOR_NOTICE_KIND`
 * stays exported (and the factory keeps declaring it in
 * `ambientKinds`) for ONE reason: the one-time migration sweep in the
 * tick clears the pre-move ambient notices, and the host's write gate
 * throws on clearing an undeclared key. The per-user notices ledger
 * file is gone — core's notice store owns durability.
 *
 * A post is best-effort at the seam: the caller (the loops) isolates a
 * rejection so a notices failure degrades to a missing notice, never
 * a failed review.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CurationRunResult, SigrunHost } from "@sigrun/sigrun/extension";
import { CURATOR_NOTICE_KIND } from "./index.js";
export { CURATOR_NOTICE_KIND };
/** The replace key one review's notice carries (`review:<reviewId>`). */
export declare function reviewNoticeKey(reviewId: string): string;
/**
 * Announce one completed review: when the result carries changes, post
 * the keyed core notice for the review's owner. No changes (or no
 * review id) → nothing. Answers true when a notice was posted.
 */
export declare function notify(host: SigrunHost, conversationId: ConversationId, user: string, result: CurationRunResult & {
    readonly reviewId?: string;
}): Promise<boolean>;
