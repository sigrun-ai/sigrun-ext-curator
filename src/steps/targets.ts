/**
 * The targets step (`src/steps/targets.ts`, Task B4 — loop 2 step
 * `targets`, the pass's LAST step): run each maintain-capable curation
 * target's maintenance hook through `host.curation.maintain`, handing
 * it the tick's deadline and the REMAINING daily digest runs (the
 * budget the five model steps did not spend — the brief: "within the
 * remaining budget").
 *
 * The step itself spends nothing — the target's own `run` calls are
 * budgeted by the `runs` count it receives (one digest run each, per
 * the P6 contract), and a target that reports `more` keeps the rest for
 * the next pass. A failing target is logged and never blocks the others.
 */

import type { MaintenanceReport } from "@sigrun/sigrun/extension";
import { stepLog, type ModelStepDeps } from "./run.js";

/** The loop-2 targets step: maintain every maintain-capable target. */
export async function maintainTargets(deps: ModelStepDeps): Promise<boolean> {
	const { host, user } = deps;
	const log = stepLog(deps);
	if (deps.budget.left() < 1) return false; // nothing to hand a target: stop
	const targets = await host.curation.targets(user);
	for (const target of targets) {
		if (!target.maintain) continue;
		if (deps.now().getTime() >= deps.deadlineAt) return false;
		await host.curation
			.maintain(user, target.id, {
				deadline: deps.deadlineAt,
				runs: deps.budget.left(),
			})
			.then((report: MaintenanceReport) => {
				if (report.more) {
					log(
						`loop 2: target ${target.id} stopped early — the next pass continues it`,
					);
				}
			})
			.catch((error: unknown) => {
				log(
					`loop 2: ${user} maintain of target ${target.id} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
	}
	return true;
}
