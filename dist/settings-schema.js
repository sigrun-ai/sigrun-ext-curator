/**
 * The curator's per-user settings schema (settings rework, Task 10):
 * userSchema ONLY — every key is read per user through the declared
 * checked-read handle, which applies the defaults and repairs malformed
 * stored values to them (the old parser's fallback-to-default, now the
 * schema's). No shared schema: nothing here is server-wide.
 */
import { Type } from "typebox";
const positiveInteger = (defaultValue, title, description) => Type.Integer({
    minimum: 1,
    default: defaultValue,
    title,
    description,
    "x-sigrun-apply": "live",
});
/**
 * Widen a TypeBox schema to the host's structural JSON-Schema contract
 * (`SettingsJsonSchema = Readonly<Record<string, unknown>>`): TypeBox's
 * TObject carries no string index signature, but every schema it builds
 * IS a plain JSON object. The `Static` types stay on the original.
 */
function asJsonSchema(schema) {
    return schema;
}
export const CURATOR_USER_SCHEMA = asJsonSchema(Type.Object({
    enabled: Type.Boolean({
        default: true,
        title: "Enabled",
        "x-sigrun-apply": "live",
        description: "Whether the curator runs for you at all.",
    }),
    paused: Type.Boolean({
        default: false,
        title: "Paused",
        "x-sigrun-apply": "live",
        description: "Pause the loops without disabling the view or /learn (a vacation switch).",
    }),
    idleModel: Type.Optional(Type.String({
        minLength: 1,
        title: "Idle model",
        "x-sigrun-apply": "live",
        "x-sigrun-model": "chat",
        description: "The model idle-pass digest runs use (absent: the server default).",
    })),
    threshold: positiveInteger(10, "Review every N model calls", "Model calls between reviews."),
    dailyRuns: positiveInteger(12, "Digest runs per day", "Idle-pass digest runs per day."),
}));
