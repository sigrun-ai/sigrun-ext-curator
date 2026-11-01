/**
 * The merge step (`src/steps/merge.ts`, Task B4 — loop 2 step `merge`):
 * ONE pair of learned skills a run judges same-class merges — the run
 * patches the survivor and the step archives the other with
 * `absorbed_into` naming the survivor (the spec's merge shape).
 *
 * The verdict (`{"merge": ["a","b"], "survivor": "a"}`) is the run's
 * final text in the fixed JSON shape. It must name exactly two KNOWN,
 * unarchived, learned skills with a known survivor among them —
 * anything else (unparseable text, unknown names, a mismatched
 * survivor) changes nothing, and a run that already wrote through its
 * tools is reverted with `undoReview` (an unverified merge never
 * stands, mirroring the diet's compare rule).
 */

import type { CurationSkillInfo } from "@sigrun/sigrun/extension";
import { digestRunWithBudget, parseVerdict, stepLog, type ModelStepDeps } from "./run.js";

/** The merge's allow list: the run patches through skill_manage. */
const MERGE_ALLOW: readonly string[] = ["skill_manage"];

/** The merge verdict shape (the run's final text, fixed JSON). */
interface MergeVerdict {
	readonly merge?: unknown;
	readonly survivor?: unknown;
}

/** The loop-2 merge step: at most one judged merge per pass. */
export async function mergeStep(deps: ModelStepDeps): Promise<boolean> {
	const { host, user } = deps;
	const log = stepLog(deps);
	if (deps.budget.left() < 1) return false; // the day is spent: stop the pass
	const skills = await host.curation.skills(user).list();
	const active = skills.filter((row) => !row.archived);
	if (active.length < 2) return true; // nothing mergeable

	const result = await digestRunWithBudget(deps, {
		input: mergeInput(active),
		allow: MERGE_ALLOW,
	});
	if (result === undefined) return false; // no budget left today
	if (result.result.status !== "completed") return true;

	const verdict = parseVerdict<MergeVerdict>(result.result.text);
	const plan = verdict === undefined ? undefined : mergePlan(verdict, active);
	if (plan !== undefined) {
		// The run patched the survivor; the step archives the absorbed
		// skill naming it (absorbed_into) — undoable through the feed.
		await host.curation.skills(user).apply(
			plan.absorbed,
			{ kind: "archive", absorbedInto: plan.survivor },
			{ reason: `merged into ${plan.survivor}` },
		);
		return true;
	}

	// Unparseable or unusable verdict: a run that wrote anyway is undone
	// — an unverified merge never stands (net: no change).
	if (result.result.changes.length > 0) {
		await host.curation.undoReview(user, result.reviewId).catch((error: unknown) => {
			log(
					`loop 2: ${user} merge undo of review failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
			);
		});
	}
	return true;
}

/** Validate a verdict into a merge plan; undefined when it names
 *  anything but exactly two known active skills and a survivor of them. */
function mergePlan(
	verdict: MergeVerdict,
	active: readonly CurationSkillInfo[],
): { readonly survivor: string; readonly absorbed: string } | undefined {
	if (!Array.isArray(verdict.merge) || verdict.merge.length !== 2) return undefined;
	const [first, second] = verdict.merge as unknown[];
	if (typeof first !== "string" || typeof second !== "string") return undefined;
	if (typeof verdict.survivor !== "string") return undefined;
	const names = new Set(active.map((row) => row.name));
	if (!names.has(first) || !names.has(second)) return undefined;
	if (verdict.survivor !== first && verdict.survivor !== second) return undefined;
	const absorbed = verdict.survivor === first ? second : first;
	return { survivor: verdict.survivor, absorbed };
}

/** The merge run's input: the candidate list and the fixed verdict. */
function mergeInput(active: readonly CurationSkillInfo[]): string {
	const rows = active.map(
		(row) => `- ${row.name} (${row.bytes} bytes): ${row.description}`,
	);
	return [
		"You are the curator. These are the user's learned skills. Decide whether exactly ONE pair covers the same class of task and should merge (the survivor absorbs the other's rules; use your skill_manage tool to patch the survivor so it covers both). Most passes find no pair — that is fine.",
		"",
		...rows,
		"",
		'When you merged a pair, answer with ONLY this JSON: {"merge": ["<survivor>", "<absorbed>"], "survivor": "<survivor>"}. Otherwise answer with {}.',
	].join("\n");
}
