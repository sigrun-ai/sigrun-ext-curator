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

import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	CurationRunResult,
	SigrunHost,
} from "@sigrun/sigrun/extension";
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

/** The notice ledger's file name under the user's state dir. */
const NOTICES_FILE = "notices.json";

/** How many notices the ledger keeps (the view's feed window). */
const NOTICE_LEDGER_MAX = 50;

/** The zero-signal context the ambient write runs under (the review
 *  body has no caller signal of its own — the run's deadline bound it). */
const CONTEXT = { abortSignal: undefined };

/**
 * Announce one completed review: when the result carries changes, set
 * the `curator.notice` ambient record on the conversation and record
 * the notice durably. No changes → nothing (an unchanged conversation
 * stays untouched). Answers the notice record (undefined when no
 * notice was set).
 */
export async function notify(
	host: SigrunHost,
	conversationId: ConversationId,
	user: string,
	result: CurationRunResult & { readonly reviewId?: string },
): Promise<NoticeRecord | undefined> {
	if (result.status !== "completed") return undefined;
	if (result.changes.length === 0) return undefined;
	const reviewId = result.reviewId;
	if (reviewId === undefined || reviewId === "") return undefined;

	const at = new Date().toISOString();
	await host.setAmbient(
		conversationId,
		{
			key: CURATOR_NOTICE_KIND,
			place: "status",
			body: noticeBody(result.changes.map((change) => change.summary), reviewId),
		},
		CONTEXT,
	);
	const record: NoticeRecord = { reviewId, conversationId, at };
	await recordNotice(host, user, record);
	return record;
}

/**
 * The notice body: ONE line-level `callout` (the `status` slot's
 * one-line rule) whose title joins the change summaries and whose
 * actions navigate to the curator view anchored at the review.
 */
function noticeBody(
	summaries: readonly string[],
	reviewId: string,
): {
	readonly v: 1;
	readonly root: {
		readonly type: "callout";
		readonly id: string;
		readonly tone: "neutral";
		readonly title: string;
		readonly body: string;
		readonly actions: readonly {
			readonly id: string;
			readonly label: string;
			readonly icon: "book";
			readonly action: {
				readonly type: "navigate";
				readonly target: {
					readonly view: {
						readonly extension: "curator";
						readonly id: "curator";
						readonly params: { readonly review: string };
					};
				};
			};
		}[];
	};
} {
	const lines = summaries.map((summary) => `Learned: ${summary}`);
	return {
		v: 1,
		root: {
			type: "callout",
			id: "curator-notice",
			tone: "neutral",
			// The one-line rule makes the title the line the channels show;
			// multiple changes join on the same line (a statusline slot).
			title: lines.join(" · "),
			body: "Open the curator view to review or undo.",
			actions: [
				{
					id: "open",
					label: "Curator",
					icon: "book",
					action: {
						type: "navigate",
						target: {
							view: {
								extension: "curator",
								id: "curator",
								params: { review: reviewId },
							},
						},
					},
				},
			],
		},
	};
}

/** The ledger file path for one user. */
function noticesFile(host: SigrunHost, user: string): string {
	return join(host.stores.user(user).paths.state, NOTICES_FILE);
}

/** Read the user's recorded notices (newest first); absent/malformed → []. */
export async function readNotices(
	host: SigrunHost,
	user: string,
): Promise<readonly NoticeRecord[]> {
	const { readStateJson } = await import("./queue.js");
	const parsed = await readStateJson<Partial<NoticeRecord>[]>(
		noticesFile(host, user),
		[],
	);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(entry): entry is NoticeRecord =>
			typeof entry === "object" &&
			entry !== null &&
			typeof (entry as NoticeRecord).reviewId === "string" &&
			typeof (entry as NoticeRecord).conversationId === "number" &&
			typeof (entry as NoticeRecord).at === "string",
	);
}

/** Record one notice: replace the same review's entry, keep the newest 50. */
async function recordNotice(
	host: SigrunHost,
	user: string,
	record: NoticeRecord,
): Promise<void> {
	const { writeStateJson } = await import("./queue.js");
	const current = await readNotices(host, user);
	const next = [
		record,
		...current.filter((entry) => entry.reviewId !== record.reviewId),
	].slice(0, NOTICE_LEDGER_MAX);
	await writeStateJson(
		host.stores.user(user).paths.state,
		NOTICES_FILE,
		next,
	);
}
