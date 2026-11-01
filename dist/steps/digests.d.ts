/**
 * The mixed-conversation digest step (`src/steps/digests.ts`, Task B4 —
 * loop 2 step `digests`): the conversations loop 1 refused to fork
 * (mixed authorship, unattributed entries) are reviewed here, NEVER
 * forked — a fresh internal digest run over a text digest of the
 * OWNER'S attributed turns plus the assistant replies to them.
 *
 * Attribution (fail closed, P1's rule — another user's words can never
 * enter the owner's digest): the step watches the conversation through
 * `host.conversations.watch` and attributes turns per-entry from the
 * `sigrun.authors` doc when the watched view carries one
 * (`docs["sigrun.authors"].byEntry`, entry id → author). Without the
 * doc, the step falls back to `curation.eligibility`: an owner-only
 * conversation with zero unattributed entries attributes EVERY user
 * turn to the owner (that is what `ownerOnly` means). A mixed
 * conversation with no per-entry source is SKIPPED — no user turn is
 * attributable, so none is included, and skipping all of them is the
 * only safe digest; the queue entry stays and self-heals the day the
 * host serves per-entry attribution.
 *
 * ⚠ HOST GAP (2026-11-01): core's watched view mounts only the five
 * pi-durable built-in docs — `sigrun.authors` is NOT among them, so
 * against today's core only the eligibility fallback digests anything.
 * Mounting the authors doc (projected to `byEntry`) is a CORE change
 * (src/harness — not this repo); until it lands, mixed conversations
 * wait in the queue. Recorded in the task report.
 *
 * Assistant replies: an assistant entry is included only when it
 * belongs to the run an OWNER turn started — the entries after an
 * owner-attributed user entry, up to the next user entry (a reply that
 * follows another user's turn answers that turn, and is excluded with
 * it).
 *
 * Durability: the queue file is read WITHOUT clearing; an entry is
 * removed only after its review COMPLETED (a failed run leaves it for
 * the next pass). The B2 carry: consumption dedups hints by id — the
 * entry's own hints merge with the conversation's refunded batch
 * (`pending-hints.json`), and completing the review drains both.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import { type ModelStepDeps } from "./run.js";
/** The digest step's own view-acquisition grace: how long to wait for
 *  the watched conversation's first frame (the real host delivers the
 *  snapshot before `watch` resolves; the grace only bounds an anomaly). */
export declare const DIGEST_VIEW_GRACE_MS = 10000;
/** The loop-2 digest step: review every queued mixed conversation.
 *  Answers FALSE when the daily budget ran out (the pass stops). */
export declare function digestsStep(deps: ModelStepDeps): Promise<boolean>;
/**
 * Review ONE conversation (exported for the step loop): watch its view,
 * build the owner's digest, run the review, and consume the queue
 * entry on completion. False = out of budget (the caller stops).
 */
export declare function reviewDigest(deps: ModelStepDeps, conversationId: ConversationId): Promise<boolean>;
