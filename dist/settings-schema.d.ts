/**
 * The curator's settings schema (settings finish, Task 12): a SYSTEM
 * schema — every key is server-wide, marked `x-sigrun-overridable` so
 * core derives the per-user override form (the user wins where an
 * override is set and valid; the system value stands otherwise).
 * Existing per-user files keep working as overrides: same file, same
 * keys, and the declared handle's `effective(user)` resolves them.
 */
import { Type, type Static } from "typebox";
export declare const CURATOR_SCHEMA: Type.TObject<{
    enabled: Type.TBoolean;
    paused: Type.TBoolean;
    idleModel: Type.TOptional<Type.TString>;
    threshold: Type.TInteger;
    dailyRuns: Type.TInteger;
}> & Readonly<Record<string, unknown>>;
export type CuratorUserSettings = Static<typeof CURATOR_SCHEMA>;
