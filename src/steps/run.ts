/**
 * The model-step plumbing (`src/steps/run.ts`, Task B4): the shared
 * dependencies every loop-2 MODEL step runs under, and the one
 * `digestRun` helper they all spend their budget through.
 *
 * The budget rule (the brief): every model step is ONE `digestRun` on
 * `CuratorSettings.idleModel` and decrements the per-user daily budget
 * (`dailyRuns`); at the cap the pass stops for the day. {@link RunBudget}
 * is the cursor-backed handle: `left()` answers what remains, `spend()`
 * takes one (persisting the increment through the caller's callback) or
 * answers false when the day is spent.
 *
 * The verdict rule (the brief): steps that need a verdict ask for it as
 * the run's final text in a fixed JSON shape and parse `result.text`;
 * {@link parseVerdict} accepts the whole trimmed text, or the outermost
 * `{…}` span inside it (models are told to answer with the JSON alone —
 * the span fallback tolerates a stray lead-in line). An unparseable
 * verdict is the caller's "no change".
 */

import { randomUUID } from "node:crypto";
import type {
	CurationRunOpts,
	CurationRunResult,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import { readSettings } from "../settings.js";

/** The tool-call budget one model step's digest run runs under. */
export const MODEL_STEP_MAX_TOOL_CALLS = 16;

/** The output-token budget one model step's digest run runs under. */
export const MODEL_STEP_MAX_OUTPUT_TOKENS = 4096;

/**
 * The per-user daily model-run budget. `spend` persists its increment
 * (the cursor's `dailyRunsUsed`) before the run starts — a crash after
 * a spend may waste a run, it never overspends the day.
 */
export interface RunBudget {
	/** How many daily runs remain (0 = the day is spent). */
	left(): number;
	/** Take one run; false when none remain (nothing was taken). */
	spend(): Promise<boolean>;
}

/** What every loop-2 model step receives. */
export interface ModelStepDeps {
	/** The host the step reads and writes through. */
	readonly host: SigrunHost;
	/** The curated user. */
	readonly user: string;
	/** The clock (tests fake it). */
	readonly now: () => Date;
	/** The tick's deadline (epoch ms); runs and loops respect it. */
	readonly deadlineAt: number;
	/** The daily model-run budget. */
	readonly budget: RunBudget;
	/** One line per unexpected condition; defaults to `console.error`. */
	readonly log?: (message: string) => void;
}

/** The default step logger. */
export function stepLog(deps: ModelStepDeps): (message: string) => void {
	return (
		deps.log ?? ((message) => console.error(`curator: ${message}`))
	);
}

/** What {@link digestRunWithBudget} submits. */
export interface DigestRunInput {
	/** The run's only input (the material plus its instruction). */
	readonly input: string;
	/** The run's allow list (non-empty — the gate names it). */
	readonly allow: readonly string[];
}

/** One spent digest run: its result and the review id its changes carry. */
export interface DigestRun {
	readonly result: CurationRunResult;
	/** The run's identity — what `undoReview(user, id)` reverts. */
	readonly reviewId: string;
}

/**
 * ONE digest run under the budget: spend first (false → `undefined`,
 * the caller stops for the day), then run on the user's idle model with
 * the step bounds and the tick's remaining wall clock.
 */
export async function digestRunWithBudget(
	deps: ModelStepDeps,
	input: DigestRunInput,
): Promise<DigestRun | undefined> {
	if (!(await deps.budget.spend())) return undefined;
	const settings = await readSettings(deps.host, deps.user);
	const reviewId = `digest-${randomUUID()}`;
	const opts: CurationRunOpts & {
		readonly input: string;
		readonly model?: string;
	} = {
		instruction: input.input,
		allow: [...input.allow],
		maxToolCalls: MODEL_STEP_MAX_TOOL_CALLS,
		maxOutputTokens: MODEL_STEP_MAX_OUTPUT_TOKENS,
		deadlineMs: Math.max(1, deps.deadlineAt - deps.now().getTime()),
		reviewId,
		input: input.input,
		...(settings.idleModel === undefined ? {} : { model: settings.idleModel }),
	};
	const result = await deps.host.curation.digestRun(deps.user, opts);
	return { result, reviewId };
}

/**
 * Parse a run's final text as one fixed-shape verdict object. The whole
 * trimmed text first, then its outermost `{…}` span; anything else —
 * prose, an empty answer, a JSON scalar — is `undefined` ("no change").
 */
export function parseVerdict<T extends object>(text: string): T | undefined {
	const trimmed = text.trim();
	const candidates = [trimmed];
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
	for (const candidate of candidates) {
		try {
			const value: unknown = JSON.parse(candidate);
			if (typeof value === "object" && value !== null) return value as T;
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}
