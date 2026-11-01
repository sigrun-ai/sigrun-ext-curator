/**
 * The mixed-conversation digest step (`src/steps/digests.ts`, Task B4 —
 * loop 2 step `digests`): the conversations loop 1 refused to fork
 * (mixed authorship, unattributed entries) are reviewed here, NEVER
 * forked — a fresh internal digest run over a text digest of the
 * OWNER'S attributed turns plus the assistant replies to them.
 *
 * Attribution (fail closed, P1's rule — another user's words can never
 * enter the owner's digest): the PRIMARY per-entry source is
 * `curation.authors(conversationId)` — core's map of every user-input
 * entry in the active context to its author (an entry ABSENT from the
 * map or mapped to `undefined` is unattributed and never the owner's).
 * When the map is EMPTY (no attributed entry at all — a pre-P1-shaped
 * or fresh conversation), the step falls back to `curation.eligibility`:
 * an owner-only conversation with zero unattributed entries attributes
 * EVERY user turn to the owner (that is what `ownerOnly` means). A
 * mixed conversation whose map has no entry for the digesting user has
 * no attributable turn — none is included, the fail-closed skip below
 * leaves it queued.
 *
 * ✅ HOST GAP RESOLVED (2026-11-01): this step originally read per-entry
 * authors from a `sigrun.authors` doc projected onto the watched view
 * (`docs["sigrun.authors"].byEntry`) — but pi-durable's structural view
 * mounts only its five built-in docs, so that projection never existed
 * and mixed conversations digested NOTHING. Core now serves the map
 * directly (`host.curation.authors`, core commit "feat(curation):
 * per-entry author map on host.curation"); the view-doc path is gone.
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
