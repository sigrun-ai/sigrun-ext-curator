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
 *   name this repo chose for the seam; Task B4's `overlay-recheck`
 *   step takes it from there). Queueing is all B3 does — deciding
 *   keep/drop/rewrite takes a model and is the next step's business.
 *   Keys dedup by their canonical JSON, so a pass that re-observes
 *   the same drift twice queues it once.
 *
 * Deterministic by design: reads + one `markOrphans` + one state-file
 * write; no model, no interaction.
 */
import { join } from "node:path";
import { readStateJson, writeStateJson } from "../queue.js";
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
