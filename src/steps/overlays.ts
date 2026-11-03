/**
 * Overlay drift detection (`src/steps/overlays.ts`, Task B3 — the
 * DETECTION half; the re-check model step is Task B4's).
 *
 * `detectOverlayDrift` walks every stored overlay and compares the
 * hash it was written against (`upstreamHash`) with the upstream as it
 * stands (`upstream(user, key)?.hash`):
 *
 * - ABSENT upstream → `overlays(user).markOrphans(present, now)`: the
 *   host-side pass stamps `orphanedSince` (or clears it when the
 *   upstream is back). The present-predicate answers from this pass's
 *   upstream reads, so the mark and the drift walk agree on the same
 *   observation.
 *
 * - CHANGED hash → the overlay is QUEUED for a re-check in
 *   `overlay-recheck-queue.json` under the user's state dir (the file
 *   name this repo chose for the seam; the `overlay-recheck` step
 *   takes it from there). Queueing is all B3 does — deciding
 *   keep/drop/rewrite takes a model and is the next step's business.
 *   Keys dedup by their canonical JSON, so a pass that re-observes
 *   the same drift twice queues it once.
 *
 * Deterministic by design: reads + one `markOrphans` + one state-file
 * write; no model, no interaction.
 *
 * Task B4 adds the RE-CHECK half: `recheckOverlays` (the loop-2 model
 * step) drains the queue, one `digestRun` per drifted key, and applies
 * the run's verdict — keep (re-anchor the same text on the new hash),
 * drop (remove), rewrite (put the verdict's new text), or unsure (ONE
 * `curator.overlay-question` interaction per skill in ONE new
 * user-owned conversation per pass, applied by `overlayQuestionHandler`
 * from `interactionSettled`). An unparseable verdict changes nothing.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ConversationId } from "@earendil-works/pi-durable";
import type {
	CurationOverlayKey,
	ExtensionLifecycleHandler,
	HandlerContext,
	InteractionRecord,
	MemoryEventApi,
	SigrunHost,
	SigrunLifecycleHandlers,
} from "@sigrun/sigrun/extension";
import { readStateJson, writeStateJson } from "../queue.js";
import { CURATOR_OVERLAY_QUESTION_KIND } from "../index.js";
import {
	digestRunWithBudget,
	parseVerdict,
	stepLog,
	type ModelStepDeps,
} from "./run.js";

/**
 * The overlay-recheck queue's file name under the user's state dir —
 * the seam B3 writes and Task B4's `overlay-recheck` step consumes.
 */
export const RECHECK_QUEUE_FILE = "overlay-recheck-queue.json";

/** The queued re-check file: `{ keys: CurationOverlayKey[] }`. */
interface RecheckQueueFile {
	readonly keys: readonly CurationOverlayKey[];
}

/** A stable identity for one overlay key (dedup and diffs). */
export function keyId(key: CurationOverlayKey): string {
	return JSON.stringify([key.root, key.skill, key.workspace ?? null]);
}

/** Read the queued re-check keys; absent/malformed → []. */
export async function readRecheckQueue(
	host: SigrunHost,
	user: string,
): Promise<readonly CurationOverlayKey[]> {
	const parsed = await readStateJson<Partial<RecheckQueueFile>>(
		join(host.stores.user(user).paths.state, RECHECK_QUEUE_FILE),
		{},
	);
	if (!Array.isArray(parsed.keys)) return [];
	return parsed.keys.filter(
		(key): key is CurationOverlayKey =>
			typeof key === "object" &&
			key !== null &&
			typeof (key as CurationOverlayKey).root === "string" &&
			typeof (key as CurationOverlayKey).skill === "string",
	);
}

/**
 * The queue B4 consumes: `take()` drains (read-and-clear — a taken
 * re-check is the re-check step's to finish), `enqueue` appends deduped.
 */
export class OverlayRecheckQueue {
	constructor(
		private readonly host: SigrunHost,
		private readonly user: string,
	) {}

	/** Append keys, deduped against what is queued (by identity). */
	async enqueue(keys: readonly CurationOverlayKey[]): Promise<void> {
		if (keys.length === 0) return;
		const queued = [...(await readRecheckQueue(this.host, this.user))];
		const seen = new Set(queued.map(keyId));
		for (const key of keys) {
			if (seen.has(keyId(key))) continue;
			queued.push(key);
			seen.add(keyId(key));
		}
		await writeStateJson(
			this.host.stores.user(this.user).paths.state,
			RECHECK_QUEUE_FILE,
			{ keys: queued },
		);
	}

	/** Read and clear the queue (B4's `overlay-recheck` step start). */
	async take(): Promise<readonly CurationOverlayKey[]> {
		const keys = await readRecheckQueue(this.host, this.user);
		if (keys.length === 0) return [];
		await writeStateJson(
			this.host.stores.user(this.user).paths.state,
			RECHECK_QUEUE_FILE,
			{ keys: [] },
		);
		return keys;
	}
}

/**
 * The overlay-detect step: mark orphans with the host and queue every
 * drifted overlay for a re-check (loop 2 step `overlay-detect`).
 */
export async function detectOverlayDrift(
	host: SigrunHost,
	user: string,
): Promise<void> {
	const store = host.curation.overlays(user);
	const overlays = await store.list();
	// One upstream read per overlay — the single observation both the
	// orphan mark and the drift comparison answer from.
	const upstreamByKey = new Map<string, { hash: string } | undefined>();
	for (const overlay of overlays) {
		upstreamByKey.set(
			keyId(overlay.key),
			await host.curation.upstream(user, overlay.key),
		);
	}
	await store.markOrphans(
		(key) => upstreamByKey.get(keyId(key)) !== undefined,
		new Date().toISOString(),
	);
	const drifted = overlays
		.filter((overlay) => {
			const upstream = upstreamByKey.get(keyId(overlay.key));
			return upstream !== undefined && upstream.hash !== overlay.upstreamHash;
		})
		.map((overlay) => overlay.key);
	await new OverlayRecheckQueue(host, user).enqueue(drifted);
}

// ─── The re-check half (Task B4) ───────────────────────────────────────────

/** The re-check verdict shape (the run's final text, fixed JSON). */
interface OverlayVerdict {
	readonly verdict?: unknown;
	readonly text?: unknown;
}

/** The question record's `details` (what the settled handler applies). */
interface QuestionDetails {
	readonly user: string;
	readonly key: CurationOverlayKey;
	readonly upstreamHash: string;
	readonly overlayText: string;
	readonly callId: string;
}

/** A v2 question: the details plus the conversation it was asked in. */
interface StoredQuestion extends QuestionDetails {
	readonly conversationId: number;
}

/** The pending-questions file's parsed shape (v2; a legacy top-level
 *  array reads as all-`legacy`). `questions` is keyed by `keyId(key)` —
 *  one open question per skill; `legacy` holds pre-v2 questions (no
 *  conversation, so they can't be cancelled) and only ever shrinks. */
interface PendingQuestionsFile {
	readonly questions: Record<string, StoredQuestion>;
	readonly legacy: readonly QuestionDetails[];
}

/** The overlay re-check's allow list: it writes nothing itself. */
const RECHECK_ALLOW: readonly string[] = ["skill_manage"];

/** The pending questions file under the user's state dir. */
const PENDING_QUESTIONS_FILE = "overlay-questions.json";

/** Structural check: one parsed entry is a QuestionDetails. */
function isQuestion(entry: unknown): entry is QuestionDetails {
	return (
		typeof entry === "object" &&
		entry !== null &&
		typeof (entry as QuestionDetails).user === "string" &&
		typeof (entry as QuestionDetails).key?.root === "string" &&
		typeof (entry as QuestionDetails).key?.skill === "string" &&
		typeof (entry as QuestionDetails).upstreamHash === "string" &&
		typeof (entry as QuestionDetails).overlayText === "string" &&
		typeof (entry as QuestionDetails).callId === "string"
	);
}

/** Read the user's pending overlay questions (absent/malformed → empty;
 *  a legacy top-level ARRAY reads as v1: every entry lands in `legacy`
 *  unchanged). The write shape is always v2. */
async function readPendingQuestions(
	host: SigrunHost,
	user: string,
): Promise<PendingQuestionsFile> {
	const parsed = await readStateJson<unknown>(
		join(host.stores.user(user).paths.state, PENDING_QUESTIONS_FILE),
		{ v: 2, questions: {}, legacy: [] },
	);
	if (Array.isArray(parsed)) {
		return { questions: {}, legacy: parsed.filter(isQuestion) };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { questions: {}, legacy: [] };
	}
	const raw = parsed as {
		readonly questions?: unknown;
		readonly legacy?: unknown;
	};
	const questions: Record<string, StoredQuestion> = {};
	if (
		typeof raw.questions === "object" &&
		raw.questions !== null &&
		!Array.isArray(raw.questions)
	) {
		for (const [id, entry] of Object.entries(raw.questions)) {
			if (
				isQuestion(entry) &&
				typeof (entry as StoredQuestion).conversationId === "number"
			) {
				questions[id] = entry as StoredQuestion;
			}
		}
	}
	const legacy = Array.isArray(raw.legacy)
		? raw.legacy.filter(isQuestion)
		: [];
	return { questions, legacy };
}

/** Write the user's pending overlay questions (the v2 shape — legacy
 *  questions keep their entries but the file is v2 from here on). */
async function writePendingQuestions(
	host: SigrunHost,
	user: string,
	file: PendingQuestionsFile,
): Promise<void> {
	await writeStateJson(
		host.stores.user(user).paths.state,
		PENDING_QUESTIONS_FILE,
		{ v: 2, questions: file.questions, legacy: file.legacy },
	);
}

/**
 * The overlay-recheck step (loop 2 step `overlay-recheck`): drain the
 * re-check queue and re-check every drifted overlay — ONE digest run
 * per key, under the daily budget. Verdicts apply immediately
 * (keep/drop/rewrite); "unsure" asks the user (the design's only
 * prompt) and the answer applies through {@link overlayQuestionHandler}.
 * Answers FALSE when the daily budget ran out mid-queue (the pass
 * stops for the day; the keys still queued re-check next pass — the
 * re-check queue only drains as keys complete).
 *
 * Crash-durability posture (the B3 carry): `take()` is read-then-clear,
 * never at-least-once — DETECTION is the system of record; a lost
 * queue entry self-heals on the next detect pass. A crash after a
 * run but before its verdict applied wastes one model run, nothing
 * more (the verdict is re-derived next pass).
 */
export async function recheckOverlays(deps: ModelStepDeps): Promise<boolean> {
	const { host, user } = deps;
	const log = stepLog(deps);
	if (deps.budget.left() < 1) return false; // the day is spent: stop the pass
	const keys = [...(await new OverlayRecheckQueue(host, user).take())];
	// ONE lazily created question conversation for the whole pass (spec
	// §5.6: one conversation per recheck call, not one per question).
	const conversation: QuestionConversation = { promised: undefined, seeded: 0 };
	for (const key of keys) {
		if (deps.now().getTime() >= deps.deadlineAt) return false;
		const applied = await recheckOne(deps, key, conversation).catch((error: unknown) => {
			log(
				`loop 2: ${user} overlay re-check of ${key.skill} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return true;
		});
		if (!applied) return false; // out of daily budget: stop for the day
	}
	return true;
}

/** Re-check one key: run, parse the verdict, apply it. */
async function recheckOne(deps: ModelStepDeps, key: CurationOverlayKey, conversation: QuestionConversation): Promise<boolean> {
	const { host, user } = deps;
	const store = host.curation.overlays(user);
	const overlay = await store.get(key);
	const upstream = await host.curation.upstream(user, key);
	if (overlay === undefined || upstream === undefined) return true;
	const run = await digestRunWithBudget(deps, {
		input: recheckInput(overlay.text, overlay.upstreamHash, upstream.body, upstream.hash),
		allow: RECHECK_ALLOW,
	});
	if (run === undefined) return false;
	if (run.result.status !== "completed") return true;
	const verdict = parseVerdict<OverlayVerdict>(run.result.text);
	if (verdict === undefined) return true; // unparseable: no change
	const meta = {
		actor: "curator" as const,
		reason: "overlay re-check after upstream drift",
		reviewId: run.reviewId,
	};
	switch (verdict.verdict) {
		case "keep":
			await store.put(key, overlay.text, upstream.hash, meta);
			return true;
		case "drop":
			await store.remove(key, meta);
			return true;
		case "rewrite":
			if (typeof verdict.text !== "string" || verdict.text === "") return true;
			await store.put(key, verdict.text, upstream.hash, meta);
			return true;
		case "unsure":
			await askOverlayQuestion(deps, key, overlay.text, upstream.hash, conversation);
			return true;
		default:
			return true; // unknown verdict word: no change
	}
}

/** The re-check run's input: the overlay, the version it was written
 *  against, and the NEW upstream — the three things the brief names. */
function recheckInput(
	overlayText: string,
	oldHash: string,
	newBody: string,
	newHash: string,
): string {
	return [
		"You are the curator. This overlay (the user's notes for a skill they do not own) was written against an upstream skill that has since changed. Decide what happens to it.",
		"",
		"Your notes for the old upstream:",
		overlayText,
		"",
		"The old upstream's version id:",
		oldHash,
		"",
		"The new upstream in full:",
		newBody,
		"",
		`Its new version id is ${newHash}.`,
		"",
		'Decide, and answer with ONLY this JSON: {"verdict":"keep"} when the notes still apply to the new upstream (they will be re-anchored to it); {"verdict":"drop"} when the change makes the notes obsolete; {"verdict":"rewrite","text":"…"} when the notes need a rewrite for the new upstream (the new notes text); or {"verdict":"unsure"} when you cannot decide — the user will be asked.',
	].join("\n");
}

/** The zero-signal context the seed call runs under (a tick has no
 *  caller signal — the job's deadline is the bound that matters). */
const SEED_CONTEXT: HandlerContext = { abortSignal: undefined };

/** The lazily created question conversation one recheck pass shares. */
interface QuestionConversation {
	/** The create in flight or done; absent until the first question. */
	promised: Promise<ConversationId> | undefined;
	/** How many questions the conversation holds so far (for its title). */
	seeded: number;
}

/** The conversation's title: named for what it holds. */
function questionConversationTitle(seeded: number, skill?: string): string {
	return seeded === 1 && skill !== undefined
		? `Your notes on "${skill}"`
		: `Your notes on ${seeded} skills`;
}

/** The id of the pass's question conversation, creating it on the
 *  first question (owned by the user, titled for what it holds). */
async function questionConversation(
	deps: ModelStepDeps,
	conversation: QuestionConversation,
	skill: string,
): Promise<ConversationId> {
	if (conversation.promised === undefined) {
		conversation.seeded = 1;
		conversation.promised = deps.host.conversations.create({
			owner: deps.user,
			name: questionConversationTitle(1, skill),
		});
		return conversation.promised;
	}
	const id = await conversation.promised;
	conversation.seeded += 1;
	// A second question renames the conversation to cover what it now
	// holds; a failed rename never loses the question (logged only).
	try {
		await deps.host.conversations.patchMeta(id, {
			name: questionConversationTitle(conversation.seeded),
		});
	} catch (error: unknown) {
		stepLog(deps)(
			`loop 2: renaming the overlay-question conversation failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return id;
}

/**
 * Ask ONE `curator.overlay-question` for a drifted overlay: the pass's
 * shared NEW conversation (created lazily, owned by the user) gets the
 * question, and the pending file keeps one open question per skill —
 * the bounding rule (spec §5.5, ruling 8: no timers, no auto-expiry;
 * keying and terminal statuses bound the file, never age).
 *
 * Order per question: create the conversation if needed, cancel the
 * skill's old open question (a re-ask replaces it; a GONE old
 * conversation — settle resolves false or rejects — still lets the new
 * question be asked), seed, write the file. Only then, for the first
 * question of the pass, send the owner a notice linking to the
 * conversation; a FAILED notice never loses the question (try/catch-log).
 */
async function askOverlayQuestion(
	deps: ModelStepDeps,
	key: CurationOverlayKey,
	overlayText: string,
	upstreamHash: string,
	conversation: QuestionConversation,
): Promise<void> {
	const { host, user } = deps;
	const log = stepLog(deps);
	const file = await readPendingQuestions(host, user);
	const id = keyId(key);
	const old = file.questions[id];
	const conversationId = await questionConversation(deps, conversation, key.skill);
	if (old !== undefined) {
		try {
			await host.settleInteraction(
				old.conversationId as ConversationId,
				old.callId,
				"cancelled",
				SEED_CONTEXT,
			);
		} catch (error: unknown) {
			log(
				`loop 2: cancelling the previous overlay question for ${key.skill} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	const callId = `overlay-question-${randomUUID()}`;
	const details: QuestionDetails = {
		user,
		key,
		upstreamHash,
		overlayText,
		callId,
	};
	const record: InteractionRecord = {
		kind: CURATOR_OVERLAY_QUESTION_KIND,
		callId,
		status: "pending",
		createdAt: deps.now().getTime(),
		body: questionBody(key, overlayText),
		// SAFETY: cast — `details` is opaque extension-owned JSON by
		// contract; the structural QuestionDetails shape is JSON-safe.
		details: details as unknown as InteractionRecord["details"],
	};
	await host.seedInteraction(conversationId, record, SEED_CONTEXT);
	await writePendingQuestions(host, user, {
		questions: {
			...file.questions,
			[id]: { ...details, conversationId: conversationId as number },
		},
		legacy: file.legacy,
	});
	if (conversation.seeded !== 1) return; // only the first question notifies
	try {
		await host.notify({
			user,
			title: "Notes to review",
			body: `The curator has a question about your notes on "${key.skill}".`,
			kind: CURATOR_OVERLAY_QUESTION_KIND,
			target: { conversation: conversationId as number },
		});
	} catch (error: unknown) {
		log(
			`loop 2: the overlay-question notice for ${user} failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** The question's form body: exactly keep / drop. The overlay text
 *  rides a section (a form's children are fields and sections only;
 *  free blocks live inside a section — the interactions validator's
 *  rule). */
function questionBody(
	key: CurationOverlayKey,
	overlayText: string,
): InteractionRecord["body"] {
	return {
		v: 1,
		root: {
			type: "form",
			mode: "submit",
			bind: "answer",
			submitLabel: "Answer",
			children: [
				{
					type: "section",
					title: `The upstream skill "${key.skill}" changed under your notes`,
					children: [
						{ type: "markdown", text: overlayText },
						{
							type: "choice",
							name: "verdict",
							label: "Keep the notes?",
							options: [
								{ id: "keep", label: "Keep the notes" },
								{ id: "drop", label: "Drop the notes" },
							],
						},
					],
				},
			],
		},
	} as InteractionRecord["body"];
}

/**
 * The `interactionSettled` half: apply a settled overlay question's
 * answer. EVERY terminal status (answered, skipped, cancelled, expired)
 * drops the entry from the pending file — the file is bounded by
 * terminal statuses (one open entry per skill key). Only ANSWERED
 * records with a `verdict` of keep/drop apply; `keep` re-anchors the
 * remembered overlay text on the remembered hash; `drop` removes the
 * overlay. The callId is looked up in BOTH the v2 `questions` map and
 * the migrated `legacy` list, so pre-v2 questions stay answerable
 * where they were asked. Idempotent per callId (an applied question
 * leaves the pending file).
 */
export function overlayQuestionHandler(
	host: SigrunHost,
): Pick<SigrunLifecycleHandlers, "interactionSettled"> {
	return {
		interactionSettled: async (
			event: Parameters<ExtensionLifecycleHandler<"interactionSettled">>[0],
			_api: MemoryEventApi,
			_context: HandlerContext,
		): Promise<void> => {
			if (event.kind !== CURATOR_OVERLAY_QUESTION_KIND) return;
			if (event.status !== "answered" &&
				event.status !== "skipped" &&
				event.status !== "cancelled" &&
				event.status !== "expired") return;
			const found = await findQuestion(host, event.callId);
			if (found === undefined) return;
			const { user, question } = found;
			if (event.status === "answered") {
				const verdict = event.answer?.["verdict"];
				if (verdict === "keep" || verdict === "drop") {
					const store = host.curation.overlays(user);
					const meta = {
						actor: "curator" as const,
						reason: `user chose to ${verdict} the overlay`,
					};
					if (verdict === "keep") {
						await store.put(
							question.key,
							question.overlayText,
							question.upstreamHash,
							meta,
						);
					} else {
						await store.remove(question.key, meta);
					}
				}
			}
			await dropQuestion(host, user, question.callId);
		},
	};
}

/** Find one pending question by callId — the handler scans every user's
 *  file (the event names the callId, not the user), both the v2
 *  `questions` map and the migrated `legacy` list. */
async function findQuestion(
	host: SigrunHost,
	callId: string,
): Promise<{ readonly user: string; readonly question: QuestionDetails } | undefined> {
	for (const row of await host.users.list()) {
		const file = await readPendingQuestions(host, row.user);
		for (const question of Object.values(file.questions)) {
			if (question.callId === callId) return { user: row.user, question };
		}
		for (const question of file.legacy) {
			if (question.callId === callId) return { user: row.user, question };
		}
	}
	return undefined;
}

/** Remove a question from its user's pending file — from BOTH the v2
 *  map (by matching callId, in case the file drifted) and the legacy
 *  list. */
async function dropQuestion(
	host: SigrunHost,
	user: string,
	callId: string,
): Promise<void> {
	const file = await readPendingQuestions(host, user);
	const questions: Record<string, StoredQuestion> = {};
	for (const [id, question] of Object.entries(file.questions)) {
		if (question.callId !== callId) questions[id] = question;
	}
	await writePendingQuestions(host, user, {
		questions,
		legacy: file.legacy.filter((question) => question.callId !== callId),
	});
}
