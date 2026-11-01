/**
 * The archive step (`src/steps/archive.ts`, Task B3): loop 2's first
 * deterministic step — no model, pure store reads plus applies.
 *
 * Two 30-day rules (spec §6.2), both `>=` on milliseconds:
 *
 * - A LEARNED skill archives when it is unused for 30 days (per
 *   `usage(user)`; a skill with no usage row counts as used on its
 *   `createdAt` — never used is the oldest it can be) AND created at
 *   least 30 days ago, AND it is neither pinned nor referenced by one
 *   of the user's job prompts (`jobSkillRefs`, paused jobs included —
 *   archiving under a paused job would break its prompt on resume).
 *   Already-archived rows are left alone. The archive goes through
 *   `skills(user).apply(name, {kind:"archive"}, {reason})` — the feed
 *   records it as a curator change, so the view's undo covers it.
 *
 * - An OVERLAY whose upstream vanished (`orphanedSince`, stamped by
 *   `markOrphans` during the overlay-detect step) is REMOVED after
 *   30 days orphaned: the detection pass before this one marked it,
 *   this pass (a later one) reaps it — a returning upstream in between
 *   clears the mark and spares it.
 *
 * The step is idempotent by construction (archived rows are skipped,
 * removed overlays are gone), so a tick that crashes mid-step and
 * resumes re-runs it safely.
 */
/** The archive threshold (spec §5: 30 days), as days for the export. */
export const ARCHIVE_UNUSED_DAYS = 30;
/** The archive threshold in milliseconds. */
export const ARCHIVE_UNUSED_MS = ARCHIVE_UNUSED_DAYS * 86_400_000;
/** The feed reason stamped on a skill archive. */
export const ARCHIVE_REASON = "unused for 30 days";
/** The feed reason stamped on an orphaned-overlay removal. */
export const ORPHAN_REMOVAL_REASON = "orphaned for 30 days";
/**
 * Whether `iso` is at least `thresholdMs` before `now`. An unparseable
 * stamp answers FALSE — bad data spares the skill/overlay, it never
 * destroys.
 */
function atLeast(thresholdMs, now, iso) {
    if (iso === undefined)
        return false;
    const at = Date.parse(iso);
    return Number.isFinite(at) && now.getTime() - at >= thresholdMs;
}
/**
 * Archive the user's unused learned skills and reap their long-orphaned
 * overlays (loop 2 step `archive`).
 */
export async function archiveUnused(host, user, now) {
    const at = now();
    await archiveSkills(host, user, at);
    await reapOrphanedOverlays(host, user, at);
}
/** The learned-skill half of the archive step. */
async function archiveSkills(host, user, now) {
    const store = host.curation.skills(user);
    const skills = await store.list();
    const usage = await host.curation.usage(user);
    const jobRefs = await host.curation.jobSkillRefs(user);
    for (const skill of skills) {
        if (skill.archived)
            continue;
        if (skill.pinned)
            continue;
        if (jobRefs.has(skill.name))
            continue;
        // Unused ≥ 30 days: never-used counts from creation.
        const lastUsed = usage[skill.name] ?? skill.createdAt;
        if (!atLeast(ARCHIVE_UNUSED_MS, now, lastUsed))
            continue;
        if (!atLeast(ARCHIVE_UNUSED_MS, now, skill.createdAt))
            continue;
        await store.apply(skill.name, { kind: "archive" }, { reason: ARCHIVE_REASON });
    }
}
/** The orphaned-overlay half of the archive step. */
async function reapOrphanedOverlays(host, user, now) {
    const store = host.curation.overlays(user);
    for (const overlay of await store.list()) {
        if (!atLeast(ARCHIVE_UNUSED_MS, now, overlay.orphanedSince))
            continue;
        await store.remove(overlay.key, {
            actor: "curator",
            reason: ORPHAN_REMOVAL_REASON,
        });
    }
}
