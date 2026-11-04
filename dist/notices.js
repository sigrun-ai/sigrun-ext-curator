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
import { NOTICE_LIMITS } from "@sigrun/shared/notices";
import { CURATOR_NOTICE_KIND } from "./index.js";
export { CURATOR_NOTICE_KIND };
/**
 * Join the change lines into the one-line notice title, bounded by the
 * core title cap (`NOTICE_LIMITS.title` = 200): a review with many
 * changes would otherwise throw on post (the caller's catch would then
 * swallow the notice ENTIRELY — a changed review announcing nothing).
 * The joined lines fit → verbatim; otherwise the title is cut at the
 * cap minus one and ends with "…" (the body still names the view,
 * where every change lists in full).
 */
function fitTitle(lines) {
    const joined = lines.join(" · ");
    if (joined.length <= NOTICE_LIMITS.title)
        return joined;
    return `${joined.slice(0, NOTICE_LIMITS.title - 1)}…`;
}
/** The replace key one review's notice carries (`review:<reviewId>`). */
export function reviewNoticeKey(reviewId) {
    return `review:${reviewId}`;
}
/**
 * Announce one completed review: when the result carries changes, post
 * the keyed core notice for the review's owner. No changes (or no
 * review id) → nothing. Answers true when a notice was posted.
 */
export async function notify(host, conversationId, user, result) {
    if (result.status !== "completed")
        return false;
    if (result.changes.length === 0)
        return false;
    const reviewId = result.reviewId;
    if (reviewId === undefined || reviewId === "")
        return false;
    const title = fitTitle(result.changes.map((change) => `Learned: ${change.summary}`));
    await host.notices.post({
        user,
        conversationId,
        key: reviewNoticeKey(reviewId),
        title,
        body: "Open the curator view to review or undo.",
        actions: [
            {
                id: "undo",
                label: "Undo",
                kind: "extension",
                name: "undoReview",
                payload: { reviewId },
                confirm: "Undo every change this review made?",
            },
            {
                id: "review",
                label: "Review",
                kind: "navigate",
                target: {
                    view: {
                        extension: "curator",
                        id: "curator",
                        params: { review: reviewId },
                    },
                },
            },
        ],
    });
    return true;
}
