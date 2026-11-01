/**
 * The curator's per-user settings (`src/settings.ts`, Task B1): read
 * LIVE through the per-user scoped store, with defaults for every
 * absent or malformed field — the read never throws (a bad edit disables
 * nothing; the loop reads per event, like the gateway's live config).
 *
 * The stored object is the user's scoped settings for THIS extension
 * (`settings/curator.json` in the real host); the fields sit at its top
 * level. Unknown keys ride along untouched — they may belong to a later
 * task of this extension and are none of the reader's business.
 */
/** The defaults every absent or malformed field falls back to. */
export const DEFAULT_CURATOR_SETTINGS = {
    enabled: true,
    paused: false,
    threshold: 10,
    dailyRuns: 12,
};
/** A positive integer (thresholds and run budgets are counts). */
function positiveInteger(value) {
    return (typeof value === "number" &&
        Number.isInteger(value) &&
        value > 0);
}
/**
 * Parse a raw settings object into {@link CuratorSettings}: every field
 * validated by TYPE and range, falling back to its default — the read
 * is total, never a throw.
 */
export function parseCuratorSettings(raw) {
    return {
        enabled: typeof raw.enabled === "boolean"
            ? raw.enabled
            : DEFAULT_CURATOR_SETTINGS.enabled,
        paused: typeof raw.paused === "boolean"
            ? raw.paused
            : DEFAULT_CURATOR_SETTINGS.paused,
        ...(typeof raw.idleModel === "string" && raw.idleModel.length > 0
            ? { idleModel: raw.idleModel }
            : {}),
        threshold: positiveInteger(raw.threshold)
            ? raw.threshold
            : DEFAULT_CURATOR_SETTINGS.threshold,
        dailyRuns: positiveInteger(raw.dailyRuns)
            ? raw.dailyRuns
            : DEFAULT_CURATOR_SETTINGS.dailyRuns,
    };
}
/**
 * Read one user's settings LIVE through the per-user scoped store,
 * merged over the defaults.
 */
export async function readSettings(host, user) {
    const raw = await host.stores.user(user).settings.get();
    return parseCuratorSettings(raw);
}
