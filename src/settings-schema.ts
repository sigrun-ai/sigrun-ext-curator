/**
 * The curator's per-user settings schema (settings rework, Task 10):
 * userSchema ONLY — every key is read per user through the declared
 * checked-read handle, which applies the defaults and repairs malformed
 * stored values to them (the old parser's fallback-to-default, now the
 * schema's). No shared schema: nothing here is server-wide.
 */

import { Type, type Static } from "typebox";

const positiveInteger = (defaultValue: number, description: string) =>
	Type.Integer({
		minimum: 1,
		default: defaultValue,
		description,
		"x-sigrun-apply": "live",
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

export const CURATOR_USER_SCHEMA = asJsonSchema(Type.Object({
	enabled: Type.Boolean({
		default: true,
		"x-sigrun-apply": "live",
		description: "Whether the curator runs for you at all.",
	}),
	paused: Type.Boolean({
		default: false,
		"x-sigrun-apply": "live",
		description: "Pause the loops without disabling the view or /learn (a vacation switch).",
	}),
	idleModel: Type.Optional(
		Type.String({
			minLength: 1,
			"x-sigrun-apply": "live",
			description: "The model idle-pass digest runs use (absent: the server default).",
		}),
	),
	threshold: positiveInteger(10, "Model calls between reviews."),
	dailyRuns: positiveInteger(12, "Idle-pass digest runs per day."),
}));

export type CuratorUserSettings = Static<typeof CURATOR_USER_SCHEMA>;
