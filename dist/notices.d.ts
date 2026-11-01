/**
 * The post-review notice (`src/notices.ts`, Task B5): what the user
 * sees when a review changed something — ONE ambient record on the
 * originating conversation (`curator.notice`, place `status`), one
 * line per change (`Learned: <summary>`), with a `navigate` action to
 * the curator view anchored at the review.
 *
 * The ambient seam is the ONLY carrier (the brief): a notice is never
 * a transcript entry (a fork would replay it) and never a notifier or
 * channel delivery (gateway channels get no notice by default, spec
 * P8). Ambient records are display-only — no action route reaches
 * them — so Undo lives on the curator VIEW; the notice's button just
 * navigates there.
 *
 * The body must pass the server's own ambient validation (a `status`
 * slot allows ONE line-level block, literal content only — ambient
 * bodies carry no data document, so bindings are rejected): a single
 * `callout` whose title joins the change lines and whose actions
 * carry the navigate button. One line-level block per seam rule.
 *
 * DURABILITY: each notice is remembered in `notices.json` under the
 * user's state dir (`readNotices` is the view's lookup) — an Undo
 * after a restart still knows which conversation's ambient record to
 * clear. The file is bounded: recording a notice replaces the entry
 * of the SAME review id (a re-run of one review id is one notice) and
 * the file keeps the newest 50 (matching the feed window the view
 * shows — older notices have nothing left to undo once the feed rolls
 * past them).
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { CurationRunResult, SigrunHost } from "@sigrun/sigrun/extension";
import { CURATOR_NOTICE_KIND } from "./index.js";
export { CURATOR_NOTICE_KIND };
/** What one recorded notice remembers (the view's undo lookup). */
export interface NoticeRecord {
    /** The review the notice announced (the undo key). */
    readonly reviewId: string;
    /** The conversation whose ambient slot carries the notice. */
    readonly conversationId: ConversationId;
    /** When the notice was set (ISO). */
    readonly at: string;
}
/**
 * Announce one completed review: when the result carries changes, set
 * the `curator.notice` ambient record on the conversation and record
 * the notice durably. No changes → nothing (an unchanged conversation
 * stays untouched). Answers the notice record (undefined when no
 * notice was set).
 */
export declare function notify(host: SigrunHost, conversationId: ConversationId, user: string, result: CurationRunResult & {
    readonly reviewId?: string;
}): Promise<NoticeRecord | undefined>;
/** Read the user's recorded notices (newest first); absent/malformed → []. */
export declare function readNotices(host: SigrunHost, user: string): Promise<readonly NoticeRecord[]>;
