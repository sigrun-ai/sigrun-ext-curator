/**
 * The curator's per-user settings (settings rework, Task 10): declared
 * as a userSchema (`src/settings-schema.ts`) at the top of the factory,
 * read LIVE through the declared checked-read handle — defaults applied
 * and malformed stored values repaired by core, per user, per event
 * (the old parser's fallback-to-default is now the schema's). Unknown
 * keys still ride along untouched in the stored file.
 *
 * The handle is cached per host: core permits `settings.declare` only
 * during the factory, so `readSettings(host, user)` resolves the handle
 * the factory declared rather than re-declaring.
 */

import type { SigrunHost } from "@sigrun/sigrun/extension";
import { CURATOR_USER_SCHEMA } from "./settings-schema.js";
import type { CuratorUserSettings } from "./settings-schema.js";

/** The per-user curator settings (spec §6.2). */
export type CuratorSettings = CuratorUserSettings;

type Declared = ReturnType<SigrunHost["settings"]["declare"]>;

const declaredByHost = new WeakMap<SigrunHost, Declared>();

/**
 * Declare the curator's userSchema (call ONCE at the top of the
 * factory); the returned handle serves every later read on this host.
 */
export function declareSettings(host: SigrunHost): Declared {
	const declared = host.settings.declare({
		// No shared settings (every key is per-user); core's checkSchema
		// still requires the shared root to be an object.
		schema: { type: "object", properties: {} },
		userSchema: CURATOR_USER_SCHEMA,
	});
	declaredByHost.set(host, declared);
	return declared;
}

/** Read one user's settings LIVE through the factory's declared handle. */
export async function readSettings(
	host: SigrunHost,
	user: string,
): Promise<CuratorSettings> {
	const declared = declaredByHost.get(host) ?? declareSettings(host);
	return (await declared.user(user).get()) as CuratorSettings;
}
