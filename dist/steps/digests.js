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
import { clearPendingHints, mergeHints, pendingHintsFor, readDigestQueue, removeDigestEntry, } from "../queue.js";
import { notify } from "../notices.js";
import { reviewInstruction } from "../prompts.js";
import { digestRunWithBudget, stepLog } from "./run.js";
/** The digest step's own view-acquisition grace: how long to wait for
 *  the watched conversation's first frame (the real host delivers the
 *  snapshot before `watch` resolves; the grace only bounds an anomaly). */
export const DIGEST_VIEW_GRACE_MS = 10_000;
/** The entry kinds that carry a user turn (attribution.ts's set). */
const USER_KINDS = new Set([
    "pi.user",
    "sigrun.user.expanded",
    "sigrun.blocks.answer",
]);
/** The loop-2 digest step: review every queued mixed conversation.
 *  Answers FALSE when the daily budget ran out (the pass stops). */
export async function digestsStep(deps) {
    const { host, user } = deps;
    const log = stepLog(deps);
    if (deps.budget.left() < 1)
        return false; // the day is spent: stop the pass
    const entries = await readDigestQueue(host, user);
    for (const entry of entries) {
        if (deps.now().getTime() >= deps.deadlineAt)
            return false;
        const done = await reviewDigest(deps, entry.id).catch((error) => {
            log(`loop 2: ${user} digest of conversation ${String(entry.id)} failed: ${error instanceof Error ? error.message : String(error)}`);
            return true;
        });
        if (!done)
            return false; // out of daily budget: stop for the day
    }
    return true;
}
/**
 * Review ONE conversation (exported for the step loop): watch its view,
 * build the owner's digest, run the review, and consume the queue
 * entry on completion. False = out of budget (the caller stops).
 */
export async function reviewDigest(deps, conversationId) {
    const { host, user } = deps;
    const log = stepLog(deps);
    const view = await watchFirstFrame(deps, conversationId);
    if (view === undefined) {
        log(`loop 2: ${user} digest of conversation ${String(conversationId)} saw no view`);
        return true; // unreadable: leave it queued, move on
    }
    const digest = await ownerDigest(deps, conversationId, view);
    if (digest === undefined) {
        log(`loop 2: ${user} digest of conversation ${String(conversationId)} has no attributable turns`);
        return true; // fail closed: leave it queued for a per-entry source
    }
    // The B2 carry: the entry owns its hints; the refund file may hold
    // the same ids (a crash between queueDigest and the clear) — merge
    // by hint id so a stranded hint is consumed exactly once.
    const hints = mergeHints(await pendingHintsFor(host, user, conversationId), (await readDigestQueue(host, user)).find((entry) => entry.id === conversationId)?.hints ?? []);
    const targets = await host.curation.targets(user, conversationId);
    const selection = await host.curation.tools(conversationId);
    const allow = [
        ...new Set([
            "skill_manage",
            ...targets.flatMap((target) => [...target.tools]),
            ...(selection.includes("read") ? ["read"] : []),
        ]),
    ];
    const instruction = reviewInstruction({
        hints,
        targets: targets.map((target) => ({
            id: target.id,
            guidance: [...target.guidance],
        })),
        allow,
    });
    const run = await digestRunWithBudget(deps, {
        input: `${digest}\n\n${instruction}`,
        allow,
    });
    if (run === undefined)
        return false; // no budget left today
    if (run.result.status !== "completed")
        return true; // leave it queued
    // The review consumed these hints for good: the queue entry goes and
    // the refund file drains of the same ids.
    await removeDigestEntry(deps.host, user, conversationId);
    await clearPendingHints(host, user, conversationId, hints);
    // Task B5: a digest review that CHANGED something announces itself
    // on the originating (mixed) conversation — the same notice shape a
    // fork review sets, undoable from the view. The notice is isolated:
    // a failing setAmbient or ledger write degrades to a missing notice,
    // never a failed step (the catch above would strand a COMPLETED
    // review's entry back in the queue as if the run had failed).
    await notify(host, conversationId, user, {
        ...run.result,
        reviewId: run.reviewId,
    }).catch((error) => {
        log(`loop 2: ${user} notice after the digest of conversation ${String(conversationId)} could not be set: ${error instanceof Error ? error.message : String(error)}`);
    });
    return true;
}
/**
 * Watch the conversation and resolve its FIRST frame (the snapshot the
 * real host pushes before `watch` resolves), bounded by the grace.
 */
async function watchFirstFrame(deps, conversationId) {
    let frame;
    let releaseFrame;
    const first = new Promise((resolve) => {
        releaseFrame = resolve;
    });
    const stop = await deps.host.conversations.watch(conversationId, (view) => {
        frame = view;
        releaseFrame();
    });
    try {
        if (frame === undefined) {
            const grace = Math.min(DIGEST_VIEW_GRACE_MS, Math.max(0, deps.deadlineAt - deps.now().getTime()));
            await Promise.race([
                first,
                new Promise((resolve) => setTimeout(resolve, grace)),
            ]);
        }
    }
    finally {
        await stop();
    }
    return frame;
}
/** The owner's digest of one view, or undefined when no user turn is
 *  attributable (the fail-closed skip). */
async function ownerDigest(deps, conversationId, view) {
    const { host, user } = deps;
    // Per-entry attribution, when the view carries the authors doc.
    const byEntry = readByEntry(view);
    let everyTurnIsOwners = byEntry !== undefined;
    if (byEntry === undefined) {
        // The fallback: an owner-only conversation with zero unattributed
        // entries attributes every user turn to the owner.
        const eligibility = await host.curation.eligibility(conversationId);
        everyTurnIsOwners =
            eligibility.owner === user && eligibility.ownerOnly && eligibility.unattributed === 0;
    }
    const lines = [];
    let inOwnerRun = false;
    let sawOwnerTurn = false;
    for (const entry of view.entries ?? []) {
        if (USER_KINDS.has(entry.kind)) {
            const author = byEntry?.[String(entry.id)];
            inOwnerRun = byEntry !== undefined ? author === user : everyTurnIsOwners;
            if (!inOwnerRun)
                continue;
            const text = entryText(entry, "user");
            if (text === "")
                continue;
            lines.push(`User (${user}): ${text}`);
            sawOwnerTurn = true;
            continue;
        }
        if (entry.kind === "pi.assistant") {
            if (!inOwnerRun)
                continue; // replies to another user's turn
            const text = entryText(entry, "assistant");
            if (text === "")
                continue;
            lines.push(`Assistant: ${text}`);
        }
    }
    if (!sawOwnerTurn)
        return undefined;
    return [`Conversation digest (only ${user}'s turns and the replies to them):`, "", ...lines]
        .join("\n");
}
/** The `byEntry` projection of the authors doc, when the view has one. */
function readByEntry(view) {
    const doc = (view.docs ?? {})["sigrun.authors"];
    if (typeof doc !== "object" || doc === null)
        return undefined;
    const byEntry = doc.byEntry;
    if (typeof byEntry !== "object" || byEntry === null)
        return undefined;
    const result = {};
    for (const [id, author] of Object.entries(byEntry)) {
        if (typeof author === "string")
            result[id] = author;
    }
    return result;
}
/** One entry's text for `role` (string content, or the text blocks). */
function entryText(entry, role) {
    const parts = [];
    for (const message of entry.model ?? []) {
        if (message.role !== role)
            continue;
        const content = message.content;
        if (typeof content === "string") {
            parts.push(content);
        }
        else if (Array.isArray(content)) {
            for (const block of content) {
                if (typeof block === "object" &&
                    block !== null &&
                    typeof block.text === "string") {
                    parts.push(block.text);
                }
            }
        }
    }
    return parts.join("\n").trim();
}
