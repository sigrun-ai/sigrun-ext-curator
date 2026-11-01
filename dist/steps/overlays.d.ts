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
import type { CurationOverlayKey, SigrunHost, SigrunLifecycleHandlers } from "@sigrun/sigrun/extension";
import { type ModelStepDeps } from "./run.js";
/**
 * The overlay-recheck queue's file name under the user's state dir —
 * the seam B3 writes and Task B4's `overlay-recheck` step consumes.
 */
export declare const RECHECK_QUEUE_FILE = "overlay-recheck-queue.json";
/** A stable identity for one overlay key (dedup and diffs). */
export declare function keyId(key: CurationOverlayKey): string;
/** Read the queued re-check keys; absent/malformed → []. */
export declare function readRecheckQueue(host: SigrunHost, user: string): Promise<readonly CurationOverlayKey[]>;
/**
 * The queue B4 consumes: `take()` drains (read-and-clear — a taken
 * re-check is the re-check step's to finish), `enqueue` appends deduped.
 */
export declare class OverlayRecheckQueue {
    private readonly host;
    private readonly user;
    constructor(host: SigrunHost, user: string);
    /** Append keys, deduped against what is queued (by identity). */
    enqueue(keys: readonly CurationOverlayKey[]): Promise<void>;
    /** Read and clear the queue (B4's `overlay-recheck` step start). */
    take(): Promise<readonly CurationOverlayKey[]>;
}
/**
 * The overlay-detect step: mark orphans with the host and queue every
 * drifted overlay for a re-check (loop 2 step `overlay-detect`).
 */
export declare function detectOverlayDrift(host: SigrunHost, user: string): Promise<void>;
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
export declare function recheckOverlays(deps: ModelStepDeps): Promise<boolean>;
/**
 * The `interactionSettled` half: apply a settled overlay question's
 * answer. Only ANSWERED records with a `verdict` of keep/drop apply;
 * every other terminal status (skipped, expired, cancelled) changes
 * nothing. `keep` re-anchors the remembered overlay text on the
 * remembered hash; `drop` removes the overlay. Idempotent per callId
 * (an applied question leaves the pending file).
 */
export declare function overlayQuestionHandler(host: SigrunHost): Pick<SigrunLifecycleHandlers, "interactionSettled">;
