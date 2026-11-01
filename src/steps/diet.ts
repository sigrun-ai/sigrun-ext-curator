/**
 * The skill-diet step (`src/steps/diet.ts`, Task B4 — loop 2 step
 * `diet`): ONE oversized learned skill per pass is rewritten so its
 * `##` sections move out to `references/` files verbatim (openclaw's
 * diet), and a SECOND model run compares old and new and answers
 * `{"loss": false}` — anything else (a reported loss, or an unparseable
 * answer) undoes the rewrite through `skills.undo`, so no unverified
 * diet ever stands.
 *
 * Eligibility (the brief): a learned skill whose SKILL.md is > 12 KB
 * and unchanged for 24h — "unchanged" reads the skill store's feed: the
 * newest curator/agent-authored entry for the skill must be older than
 * 24h (a skill with no feed entry at all counts as its creation, so a
 * freshly created giant waits a day before its first diet).
 *
 * The runs: the FIRST carries the full SKILL.md and instructs the
 * move-to-references rewrite (the run performs it through its allowed
 * `skill_manage` tool — `write_file` under `references/` plus the
 * trimmed patch); the SECOND carries old and new side by side and asks
 * only the fixed JSON loss answer. Both are ordinary budget-spending
 * digest runs on the idle model.
 */

import type {
	CurationFeedEntry,
	CurationRunResult,
} from "@sigrun/sigrun/extension";
import { digestRunWithBudget, parseVerdict, stepLog, type ModelStepDeps } from "./run.js";

/** The diet threshold (the brief: > 12 KB). */
export const DIET_BYTES = 12 * 1024;

/** How long a skill must be unchanged before a diet (the brief: 24h). */
export const DIET_UNCHANGED_MS = 24 * 60 * 60 * 1000;

/** The diet's allow list: the rewrite runs through skill_manage. */
const DIET_ALLOW: readonly string[] = ["skill_manage"];

/** The loss-compare verdict shape (the second run's final text). */
interface LossVerdict {
	readonly loss?: unknown;
}

/** The loop-2 diet step: diet at most one eligible skill. */
export async function dietStep(deps: ModelStepDeps): Promise<boolean> {
	const { host, user } = deps;
	const log = stepLog(deps);
	if (deps.budget.left() < 1) return false; // the day is spent: stop the pass
	const store = host.curation.skills(user);
	const feed = await store.feed(200);
	for (const row of await store.list()) {
		if (deps.now().getTime() >= deps.deadlineAt) return false;
		if (row.archived) continue;
		if (row.bytes <= DIET_BYTES) continue;
		const last = newestEntry(feed, row.name) ?? row.createdAt;
		if (deps.now().getTime() - Date.parse(last) < DIET_UNCHANGED_MS) continue;
		const done = await dietOne(deps, row.name).catch((error: unknown) => {
			log(
				`loop 2: ${user} diet of skill ${row.name} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return true;
		});
		return done; // ONE skill per pass, whatever happened
	}
	return true;
}

/** Diet one skill: rewrite, compare, undo on loss or unparseable. */
async function dietOne(deps: ModelStepDeps, name: string): Promise<boolean> {
	const { host, user } = deps;
	const store = host.curation.skills(user);
	const oldBody = await store.view(name);
	if (oldBody === "") return true; // unreadable: nothing to diet safely

	// Run 1 — the rewrite (the run moves `##` sections to references/
	// verbatim through its skill_manage tool).
	const rewrite = await digestRunWithBudget(deps, {
		input: rewriteInput(name, oldBody),
		allow: DIET_ALLOW,
	});
	if (rewrite === undefined) return false; // no budget left today
	if (rewrite.result.status !== "completed" || rewrite.result.changes.length === 0) {
		return true;
	}

	// Run 2 — the loss compare over old and NEW bodies.
	const newBody = await store.view(name);
	const compare = await digestRunWithBudget(deps, {
		input: compareInput(name, oldBody, newBody),
		allow: DIET_ALLOW, // the compare may read files through skill_manage
	});
	if (compare === undefined) {
		// Budget ran out mid-diet: an UNVERIFIED rewrite must not stand.
		await undoChanges(store, rewrite.result);
		return false;
	}
	const verdict =
		compare.result.status === "completed"
			? parseVerdict<LossVerdict>(compare.result.text)
			: undefined;
	if (verdict !== undefined && verdict.loss === false) return true; // verified

	// A reported loss, an unparseable answer, or a failed compare run:
	// the rewrite is undone (the brief — or the change is undone).
	await undoChanges(store, rewrite.result);
	return true;
}

/** Undo one run's changes through the skill store. */
async function undoChanges(
	store: {
		undo(entryIds: readonly string[]): Promise<readonly CurationFeedEntry[]>;
	},
	run: CurationRunResult,
): Promise<void> {
	const ids = run.changes
		.map((change) => change.changeId)
		.filter((id) => typeof id === "string" && id !== "");
	if (ids.length > 0) await store.undo(ids);
}

/** The feed's newest entry for one skill (feed is newest-first). */
function newestEntry(
	feed: readonly CurationFeedEntry[],
	skill: string,
): string | undefined {
	return feed.find((entry) => entry.skill === skill)?.at;
}

/** The rewrite run's input (run 1). */
function rewriteInput(name: string, body: string): string {
	return [
		`You are the curator. The learned skill "${name}" is too large. Diet it: keep the skill's SKILL.md to its opening summary and its core procedure, and move every \`##\` section that is reference material (examples, long tables, background) into files under \`references/\` VERBATIM — unchanged text, only relocated. Re-link them from SKILL.md with a one-line pointer each.`,
		"",
		"The current SKILL.md in full:",
		body,
		"",
		"Use your skill_manage tool to write the files (write_file for each references/ file, then patch SKILL.md). Move text verbatim; never summarize, merge, or drop a rule. When you are done, answer with one line naming what you moved.",
	].join("\n");
}

/** The loss-compare run's input (run 2). */
function compareInput(name: string, oldBody: string, newBody: string): string {
	return [
		`You are the curator. The learned skill "${name}" was just dieted: sections moved to references/ files. Compare the OLD body with the NEW body plus the reference files' pointers, and decide whether any rule, pitfall, or instruction present in the old body was dropped or weakened anywhere in the new shape.`,
		"",
		"The OLD SKILL.md:",
		oldBody,
		"",
		"The NEW SKILL.md (references/ files are reachable through its pointers):",
		newBody,
		"",
		'Answer with ONLY this JSON: {"loss": false} when nothing was dropped or weakened, or {"loss": true} when something was.',
	].join("\n");
}
