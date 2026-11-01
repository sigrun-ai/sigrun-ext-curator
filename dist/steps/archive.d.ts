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
import type { SigrunHost } from "@sigrun/sigrun/extension";
/** The archive threshold (spec §5: 30 days), as days for the export. */
export declare const ARCHIVE_UNUSED_DAYS = 30;
/** The archive threshold in milliseconds. */
export declare const ARCHIVE_UNUSED_MS: number;
/** The feed reason stamped on a skill archive. */
export declare const ARCHIVE_REASON = "unused for 30 days";
/** The feed reason stamped on an orphaned-overlay removal. */
export declare const ORPHAN_REMOVAL_REASON = "orphaned for 30 days";
/**
 * Archive the user's unused learned skills and reap their long-orphaned
 * overlays (loop 2 step `archive`).
 */
export declare function archiveUnused(host: SigrunHost, user: string, now: () => Date): Promise<void>;
