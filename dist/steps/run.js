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
import { readSettings } from "../settings.js";
/** The tool-call budget one model step's digest run runs under. */
export const MODEL_STEP_MAX_TOOL_CALLS = 16;
/** The output-token budget one model step's digest run runs under. */
export const MODEL_STEP_MAX_OUTPUT_TOKENS = 4096;
/** The default step logger. */
export function stepLog(deps) {
    return (deps.log ?? ((message) => console.error(`curator: ${message}`)));
}
/**
 * ONE digest run under the budget: spend first (false → `undefined`,
 * the caller stops for the day), then run on the user's idle model with
 * the step bounds and the tick's remaining wall clock.
 */
export async function digestRunWithBudget(deps, input) {
    if (!(await deps.budget.spend()))
        return undefined;
    const settings = await readSettings(deps.host, deps.user);
    const reviewId = `digest-${randomUUID()}`;
    const opts = {
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
export function parseVerdict(text) {
    const trimmed = text.trim();
    const candidates = [trimmed];
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first)
        candidates.push(trimmed.slice(first, last + 1));
    for (const candidate of candidates) {
        try {
            const value = JSON.parse(candidate);
            if (typeof value === "object" && value !== null)
                return value;
        }
        catch {
            // try the next candidate
        }
    }
    return undefined;
}
