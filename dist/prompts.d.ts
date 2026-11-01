/**
 * The review prompt (`src/prompts.ts`, Task B2): what a fork review or
 * digest review submits as its only input. The fork carries the
 * parent's transcript, so the instruction is the reviewer's brief, not
 * the material.
 *
 * The CONTENT is spec §6.2's review-prompt requirements (the wording is
 * ours; the snapshot test pins it once written):
 *
 * - what a skill is — a procedure for a repeatable class of task, for
 *   this user; pitfalls as a rule plus one clause of why; no incident
 *   narration, dates, PR numbers or quoted chatter;
 * - the do-not-capture list — environment failures, negative claims
 *   about tools, transient errors, unresolved failures presented as
 *   workflows, one-off tasks, codebase facts (the repo's AGENTS.md),
 *   secrets, and personal facts (a memory target when one is offered);
 * - the routing rule — each lesson goes in exactly one place: one
 *   skill, one overlay, or one target;
 * - update the skill in play before creating one; class-level names;
 * - "Nothing to save" is a valid outcome;
 * - never store another participant's words;
 * - the hint arguments and exactly the allowed tools.
 *
 * Loop 2's digest reviews reuse this instruction verbatim (Task B4).
 */
import type { CurationHint } from "@sigrun/sigrun/extension";
/** What `reviewInstruction` needs (the brief's exact shape). */
export interface ReviewInstructionOpts {
    /** Owner write attempts the review folds in (empty: none pending). */
    readonly hints: readonly CurationHint[];
    /** Curation targets offered to this run, with their guidance. */
    readonly targets: readonly {
        readonly id: string;
        readonly guidance: readonly string[];
    }[];
    /** The run's allow list — the instruction names these and no others. */
    readonly allow: readonly string[];
    /** `/learn`'s optional focus, riding along when given. */
    readonly focus?: string;
}
/**
 * Build the review instruction (the run's only input). Deterministic:
 * fixed inputs produce the fixed text the snapshot pins.
 */
export declare function reviewInstruction(opts: ReviewInstructionOpts): string;
