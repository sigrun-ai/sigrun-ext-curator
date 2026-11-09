/**
 * The curator's per-user settings schema (settings rework, Task 10):
 * userSchema ONLY — every key is read per user through the declared
 * checked-read handle, which applies the defaults and repairs malformed
 * stored values to them (the old parser's fallback-to-default, now the
 * schema's). No shared schema: nothing here is server-wide.
 */
import { Type, type Static } from "typebox";
export declare const CURATOR_USER_SCHEMA: Type.TObject<{
    enabled: Type.TBoolean;
    paused: Type.TBoolean;
    idleModel: Type.TOptional<Type.TString>;
    threshold: Type.TInteger;
    dailyRuns: Type.TInteger;
}> & Readonly<Record<string, unknown>>;
export type CuratorUserSettings = Static<typeof CURATOR_USER_SCHEMA>;
