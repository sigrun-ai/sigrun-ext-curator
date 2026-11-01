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
 * `curator.overlay-question` interaction in the user's most recent
 * owned conversation, applied by `overlayQuestionHandler` from
 * `interactionSettled`). An unparseable verdict changes nothing.
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readStateJson, writeStateJson } from "../queue.js";
import { CURATOR_OVERLAY_QUESTION_KIND } from "../index.js";
import { digestRunWithBudget, parseVerdict, stepLog, } from "./run.js";
/**
 * The overlay-recheck queue's file name under the user's state dir —
 * the seam B3 writes and Task B4's `overlay-recheck` step consumes.
 */
export const RECHECK_QUEUE_FILE = "overlay-recheck-queue.json";
/** A stable identity for one overlay key (dedup and diffs). */
export function keyId(key) {
    return JSON.stringify([key.root, key.skill, key.workspace ?? null]);
}
/** Read the queued re-check keys; absent/malformed → []. */
export async function readRecheckQueue(host, user) {
    const parsed = await readStateJson(join(host.stores.user(user).paths.state, RECHECK_QUEUE_FILE), {});
    if (!Array.isArray(parsed.keys))
        return [];
    return parsed.keys.filter((key) => typeof key === "object" &&
        key !== null &&
        typeof key.root === "string" &&
        typeof key.skill === "string");
}
/**
 * The queue B4 consumes: `take()` drains (read-and-clear — a taken
 * re-check is the re-check step's to finish), `enqueue` appends deduped.
 */
export class OverlayRecheckQueue {
    host;
    user;
    constructor(host, user) {
        this.host = host;
        this.user = user;
    }
    /** Append keys, deduped against what is queued (by identity). */
    async enqueue(keys) {
        if (keys.length === 0)
            return;
        const queued = [...(await readRecheckQueue(this.host, this.user))];
        const seen = new Set(queued.map(keyId));
        for (const key of keys) {
            if (seen.has(keyId(key)))
                continue;
            queued.push(key);
            seen.add(keyId(key));
        }
        await writeStateJson(this.host.stores.user(this.user).paths.state, RECHECK_QUEUE_FILE, { keys: queued });
    }
    /** Read and clear the queue (B4's `overlay-recheck` step start). */
    async take() {
        const keys = await readRecheckQueue(this.host, this.user);
        if (keys.length === 0)
            return [];
        await writeStateJson(this.host.stores.user(this.user).paths.state, RECHECK_QUEUE_FILE, { keys: [] });
        return keys;
    }
}
/**
 * The overlay-detect step: mark orphans with the host and queue every
 * drifted overlay for a re-check (loop 2 step `overlay-detect`).
 */
export async function detectOverlayDrift(host, user) {
    const store = host.curation.overlays(user);
    const overlays = await store.list();
    // One upstream read per overlay — the single observation both the
    // orphan mark and the drift comparison answer from.
    const upstreamByKey = new Map();
    for (const overlay of overlays) {
        upstreamByKey.set(keyId(overlay.key), await host.curation.upstream(user, overlay.key));
    }
    await store.markOrphans((key) => upstreamByKey.get(keyId(key)) !== undefined, new Date().toISOString());
    const drifted = overlays
        .filter((overlay) => {
        const upstream = upstreamByKey.get(keyId(overlay.key));
        return upstream !== undefined && upstream.hash !== overlay.upstreamHash;
    })
        .map((overlay) => overlay.key);
    await new OverlayRecheckQueue(host, user).enqueue(drifted);
}
/** The overlay re-check's allow list: it writes nothing itself. */
const RECHECK_ALLOW = ["skill_manage"];
/** The pending questions file under the user's state dir. */
const PENDING_QUESTIONS_FILE = "overlay-questions.json";
/** Read the user's pending overlay questions; absent/malformed → []. */
async function readPendingQuestions(host, user) {
    const parsed = await readStateJson(join(host.stores.user(user).paths.state, PENDING_QUESTIONS_FILE), []);
    if (!Array.isArray(parsed))
        return [];
    return parsed.filter((entry) => typeof entry === "object" &&
        entry !== null &&
        typeof entry.user === "string" &&
        typeof entry.key?.root === "string" &&
        typeof entry.key?.skill === "string" &&
        typeof entry.upstreamHash === "string" &&
        typeof entry.overlayText === "string" &&
        typeof entry.callId === "string");
}
/** Write the user's pending overlay questions. */
async function writePendingQuestions(host, user, questions) {
    await writeStateJson(host.stores.user(user).paths.state, PENDING_QUESTIONS_FILE, questions);
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
export async function recheckOverlays(deps) {
    const { host, user } = deps;
    const log = stepLog(deps);
    if (deps.budget.left() < 1)
        return false; // the day is spent: stop the pass
    const keys = [...(await new OverlayRecheckQueue(host, user).take())];
    for (const key of keys) {
        if (deps.now().getTime() >= deps.deadlineAt)
            return false;
        const applied = await recheckOne(deps, key).catch((error) => {
            log(`loop 2: ${user} overlay re-check of ${key.skill} failed: ${error instanceof Error ? error.message : String(error)}`);
            return true;
        });
        if (!applied)
            return false; // out of daily budget: stop for the day
    }
    return true;
}
/** Re-check one key: run, parse the verdict, apply it. */
async function recheckOne(deps, key) {
    const { host, user } = deps;
    const store = host.curation.overlays(user);
    const overlay = await store.get(key);
    const upstream = await host.curation.upstream(user, key);
    if (overlay === undefined || upstream === undefined)
        return true;
    const run = await digestRunWithBudget(deps, {
        input: recheckInput(overlay.text, overlay.upstreamHash, upstream.body, upstream.hash),
        allow: RECHECK_ALLOW,
    });
    if (run === undefined)
        return false;
    if (run.result.status !== "completed")
        return true;
    const verdict = parseVerdict(run.result.text);
    if (verdict === undefined)
        return true; // unparseable: no change
    const meta = {
        actor: "curator",
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
            if (typeof verdict.text !== "string" || verdict.text === "")
                return true;
            await store.put(key, verdict.text, upstream.hash, meta);
            return true;
        case "unsure":
            await askOverlayQuestion(deps, key, overlay.text, upstream.hash);
            return true;
        default:
            return true; // unknown verdict word: no change
    }
}
/** The re-check run's input: the overlay, the version it was written
 *  against, and the NEW upstream — the three things the brief names. */
function recheckInput(overlayText, oldHash, newBody, newHash) {
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
const SEED_CONTEXT = { abortSignal: undefined };
/**
 * Seed ONE `curator.overlay-question` in the user's MOST RECENT owned
 * conversation and remember it durably (the settled handler needs the
 * overlay text and hash — the interaction's `details` carry them, and
 * the pending-questions file is the crash-safe copy: an answered
 * question whose apply crashed re-applies on the next handler fire).
 */
async function askOverlayQuestion(deps, key, overlayText, upstreamHash) {
    const { host, user } = deps;
    const owned = await host.conversations.list({ owner: user });
    const withActivity = owned
        .filter((row) => row.lastActivityAt !== undefined)
        .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt));
    const target = withActivity[0] ?? owned[owned.length - 1];
    if (target === undefined)
        return; // no owned conversation to ask in
    const callId = `overlay-question-${randomUUID()}`;
    const details = {
        user,
        key,
        upstreamHash,
        overlayText,
        callId,
    };
    const record = {
        kind: CURATOR_OVERLAY_QUESTION_KIND,
        callId,
        status: "pending",
        createdAt: deps.now().getTime(),
        body: questionBody(key, overlayText),
        // SAFETY: cast — `details` is opaque extension-owned JSON by
        // contract; the structural QuestionDetails shape is JSON-safe.
        details: details,
    };
    await host.seedInteraction(target.id, record, SEED_CONTEXT);
    await writePendingQuestions(host, user, [...(await readPendingQuestions(host, user)).filter((q) => q.callId !== callId), details]);
}
/** The question's form body: exactly keep / drop. The overlay text
 *  rides a section (a form's children are fields and sections only;
 *  free blocks live inside a section — the interactions validator's
 *  rule). */
function questionBody(key, overlayText) {
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
    };
}
/**
 * The `interactionSettled` half: apply a settled overlay question's
 * answer. Only ANSWERED records with a `verdict` of keep/drop apply;
 * every other terminal status (skipped, expired, cancelled) changes
 * nothing. `keep` re-anchors the remembered overlay text on the
 * remembered hash; `drop` removes the overlay. Idempotent per callId
 * (an applied question leaves the pending file).
 */
export function overlayQuestionHandler(host) {
    return {
        interactionSettled: async (event, _api, _context) => {
            if (event.kind !== CURATOR_OVERLAY_QUESTION_KIND)
                return;
            if (event.status !== "answered")
                return;
            const verdict = event.answer?.["verdict"];
            if (verdict !== "keep" && verdict !== "drop")
                return;
            const questions = await readQuestionsFor(host, event.callId);
            for (const question of questions) {
                const store = host.curation.overlays(question.user);
                const meta = {
                    actor: "curator",
                    reason: `user chose to ${verdict} the overlay`,
                };
                if (verdict === "keep") {
                    await store.put(question.key, question.overlayText, question.upstreamHash, meta);
                }
                else {
                    await store.remove(question.key, meta);
                }
                await dropQuestion(host, question.user, question.callId);
            }
        },
    };
}
/** Read one user's pending questions — the handler scans every user's
 *  file (the event names the callId, not the user). */
async function readQuestionsFor(host, callId) {
    const found = [];
    for (const row of await host.users.list()) {
        for (const question of await readPendingQuestions(host, row.user)) {
            if (question.callId === callId)
                found.push(question);
        }
    }
    return found;
}
/** Remove an applied question from its user's pending file. */
async function dropQuestion(host, user, callId) {
    const remaining = (await readPendingQuestions(host, user)).filter((question) => question.callId !== callId);
    await writePendingQuestions(host, user, remaining);
}
