/**
 * The curator's settings schema (settings finish, Task 12): a SYSTEM
 * schema — every key is server-wide, marked `x-sigrun-overridable` so
 * core derives the per-user override form (the user wins where an
 * override is set and valid; the system value stands otherwise).
 * Existing per-user files keep working as overrides: same file, same
 * keys, and the declared handle's `effective(user)` resolves them.
 */

import { Type, type Static } from "typebox";

const positiveInteger = (
	defaultValue: number,
	title: string,
	description: string,
	overridable: boolean,
) =>
	Type.Integer({
		minimum: 1,
		default: defaultValue,
		title,
		description,
		"x-sigrun-apply": "live",
		...(overridable ? { "x-sigrun-overridable": true } : {}),
	});

/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` types stay on the original.
 */
function asJsonSchema<T>(schema: T): T & Readonly<Record<string, unknown>> {
	return schema as T & Readonly<Record<string, unknown>>;
}

export const CURATOR_SCHEMA = asJsonSchema(Type.Object({
	enabled: Type.Boolean({
		default: true,
		title: "Enabled",
		"x-sigrun-apply": "live",
		"x-sigrun-overridable": true,
		description: "Whether the curator runs for you at all.",
	}),
	paused: Type.Boolean({
		default: false,
		title: "Paused",
		"x-sigrun-apply": "live",
		"x-sigrun-overridable": true,
		description: "Pause the loops without disabling the view or /learn (a vacation switch).",
	}),
	idleModel: Type.Optional(
		Type.String({
			minLength: 1,
			title: "Idle model",
			"x-sigrun-apply": "live",
			"x-sigrun-model": "chat",
			"x-sigrun-overridable": true,
			description: "The model idle-pass digest runs use (absent: the server default).",
		}),
	),
	threshold: positiveInteger(10, "Review every N model calls", "Model calls between reviews.", true),
	dailyRuns: positiveInteger(12, "Digest runs per day", "Idle-pass digest runs per day.", true),
}));

export type CuratorUserSettings = Static<typeof CURATOR_SCHEMA>;
