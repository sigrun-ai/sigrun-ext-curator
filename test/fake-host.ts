/**
 * The in-memory FakeHost (curator-repo tests): implements the
 * `SigrunHost` the curator factory programs against, in memory — the
 * sigrun-ext-gateway `test/fake-host.ts` pattern (this repo's tests
 * never boot sigrun core; `@sigrun/sigrun` is a types-only contract).
 *
 * - `fake.calls`: the ordered call log (every member method appends
 *   `{ method, args }`), so tests assert WHAT the curator did.
 * - `fake.curation`: the scriptable curation member. The default
 *   implementation is inert (empty lists, failed runs reporting
 *   "not scripted"); tests override per-test fields via
 *   `fake.setCuration({...})`, and every call is recorded in
 *   `fake.calls` like every other host member.
 * - The stores ride a REAL temp dir (settings/secrets get/set are plain
 *   file I/O in the real host; keeping that fidelity costs nothing and
 *   makes the per-user settings reads exact).
 *
 * Runtime type imports come from `@sigrun/shared/*` and
 * `@earendil-works/pi-durable` (devDependencies — the same leaves the
 * contract re-exports); `@sigrun/sigrun/extension` stays type-only.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessOf } from "@sigrun/shared/access";
import type { Access, Sharing } from "@sigrun/shared/access";
import type {
	InteractionAnswer,
	InteractionRecord,
} from "@sigrun/shared/interactions";
import type {
	ConversationSummary,
	ConversationViewWire,
	ModelEntry,
	SessionMeta,
	SlashCommand,
	SubmissionRecordWire,
	UserWire as DirectoryUserWire,
} from "@sigrun/shared/views";
import type { DeclaredSettings, SettingsDeclaration } from "@sigrun/sigrun/extension";
// @ts-expect-error — core internal, resolved through the file: dev link.
import { checkStoredSettings } from "../node_modules/@sigrun/sigrun/dist/settings/schema/defaults.js";
import type {
	AccountLinkWire,
	CurationFeedEntry,
	CurationHint,
	CurationOverlay,
	CurationOverlayKey,
	CurationOverlayMeta,
	CurationRunOpts,
	CurationRunResult,
	CurationSkillChange,
	CurationSkillInfo,
	HandlerContext,
	MaintenanceBudget,
	MaintenanceReport,
	Principal,
	SigrunCurationHost,
	SigrunHost,
	SubmissionInputPart,
	UserNotice,
	UserNoticeActionHandler,
	UserNoticeActionResult,
	UserNoticeInput,
	WhenBusyMode,
} from "@sigrun/sigrun/extension";
import type { ConversationId, EntryId } from "@earendil-works/pi-durable";
import type { SubmissionId } from "@earendil-works/pi-durable";
import type { JsonObject } from "@sigrun/shared/blocks";

/** One recorded host call (the ordered log `fake.calls` carries). */
export interface FakeCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

/** What a watch listener registration keeps per conversation. */
interface Watcher {
	readonly id: ConversationId;
	readonly listener: (view: ConversationViewWire) => void;
}

/** FakeHost options: seeded users and the stores root. */
export interface FakeHostOptions {
	/** Directory the stores (settings/secrets/paths) root at; a temp dir when absent. */
	readonly storesDir?: string;
	/** Seed users (the directory the curator's loops walk). */
	readonly users?: readonly { user: string; admin?: boolean }[];
}

/** The scriptable curation surface tests override per-test. */
export type ScriptableCuration = SigrunCurationHost & {
	/** The inert defaults (what a field restores when deleted). */
	readonly defaults: Readonly<SigrunCurationHost>;
};

/** The fake host surface: the `SigrunHost` plus the test controls. */
export interface FakeHost extends SigrunHost {
	/** The declaration the factory made through `settings.declare`, with
	 *  checked reads backed by core's own stored-settings check. */
	readonly declaredSettings: DeclaredSettings<Record<string, unknown>, Record<string, unknown>> | undefined;
	/** Every host-member call, in order. */
	readonly calls: readonly FakeCall[];
	/** The shared invocation context handlers receive (never aborts). */
	readonly context: HandlerContext;
	/** Override curation members per-test (partial over the defaults). */
	setCuration(overrides: Partial<SigrunCurationHost>): void;
	/** Set one conversation's `lastActivityAt` (loop 2's idle clock). */
	setLastActivity(id: ConversationId, iso: string | undefined): void;
	/** Push one view to every `watch` listener of `id`. */
	pushView(id: ConversationId, view: ConversationViewWire): void;
	/** Script `settleInteraction`'s outcome (default: the real in-memory
	 *  transition — true when a pending record settles). */
	setSettleBehavior(
		behavior:
			| "transition"
			| "true"
			| "false"
			| { readonly reject: unknown },
	): void;
	/** Script `notify`'s outcome (default: ok — the notice is recorded). */
	setNotifyBehavior(behavior: "ok" | { readonly reject: unknown }): void;
	/** The stored interaction records, keyed `${conversationId}:${callId}`. */
	readonly interactions: ReadonlyMap<string, InteractionRecord>;
	/** The stored conversation metas, keyed id. */
	readonly metas: ReadonlyMap<ConversationId, SessionMeta>;
	/** The stored notices, keyed user (what `notices.list` serves). */
	readonly storedNotices: ReadonlyMap<string, readonly UserNotice[]>;
	/** Register this extension's declared notice action handlers (the
	 *  loader's `noticeActions` plumbing: dispatch looks a handler up by
	 *  name and runs it). */
	registerNoticeActions(
		handlers: Readonly<Record<string, UserNoticeActionHandler>>,
	): void;
	/** Dispatch one notice action through the registered handlers. */
	invokeNoticeAction(
		name: string,
		ctx: {
			readonly principal: Principal;
			readonly notice: UserNotice;
			readonly signal: AbortSignal;
		},
		payload: JsonObject,
	): Promise<UserNoticeActionResult>;
	/** Seed an interaction record directly (no status transitions). */
	seed(conversationId: ConversationId, record: InteractionRecord): void;
	/** Tear down the stores dir (call from an afterAll). */
	readonly close: () => Promise<void>;
}

/** The zero abort signal handlers observe (tests never cancel it). */
const NEVER_ABORTS: AbortSignal = new AbortController().signal;

const HANDLER_CONTEXT: HandlerContext = { abortSignal: NEVER_ABORTS };

/** The inert skill store every user starts with (a real in-memory map). */
function inertSkills(): {
	list: () => Promise<readonly CurationSkillInfo[]>;
	view: (name: string, file?: string) => Promise<string>;
	feed: (limit: number, before?: string) => Promise<readonly CurationFeedEntry[]>;
	pin: (name: string, pinned: boolean) => Promise<void>;
	undo: (entryIds: readonly string[]) => Promise<readonly CurationFeedEntry[]>;
	apply: (
		name: string,
		change: CurationSkillChange,
		meta: { readonly reviewId?: string; readonly reason?: string },
	) => Promise<CurationFeedEntry>;
} {
	const skills = new Map<string, CurationSkillInfo>();
	return {
		list: async () => [...skills.values()],
		view: async () => "",
		feed: async () => [],
		pin: async () => undefined,
		undo: async () => [],
		apply: async (name, change) => {
			const entry: CurationFeedEntry = {
				// The id/before/after are commit SHAs (tabs+skills Task 9):
				// deterministic stand-ins keep the fixtures stable.
				id: `aaaa${change.kind.length}${name.length}`.padEnd(40, "0"),
				at: new Date(0).toISOString(),
				actor: "curator",
				action: change.kind,
				skill: name,
				before: "bbbb".padEnd(40, "0"),
				after: `aaaa${change.kind.length}${name.length}`.padEnd(40, "0"),
			};
			return entry;
		},
	};
}

/** The inert overlay store every user starts with. */
function inertOverlays(): {
	list: () => Promise<readonly CurationOverlay[]>;
	get: (key: CurationOverlayKey) => Promise<CurationOverlay | undefined>;
	put: (
		key: CurationOverlayKey,
		text: string,
		upstreamHash: string,
		meta: CurationOverlayMeta,
	) => Promise<CurationFeedEntry>;
	remove: (key: CurationOverlayKey, meta: CurationOverlayMeta) => Promise<CurationFeedEntry>;
	markOrphans: (
		present: (key: CurationOverlayKey) => boolean,
		now: string,
	) => Promise<void>;
} {
	return {
		list: async () => [],
		get: async () => undefined,
		put: async (key, _text, _hash, meta) => ({
			id: `cccc${key.skill.length}`.padEnd(40, "0"),
			at: new Date(0).toISOString(),
			actor: meta.actor,
			action: "overlay",
			skill: key.skill,
			before: "bbbb".padEnd(40, "0"),
			after: `cccc${key.skill.length}`.padEnd(40, "0"),
		}),
		remove: async (key, meta) => ({
			id: `dddd${key.skill.length}`.padEnd(40, "0"),
			at: new Date(0).toISOString(),
			actor: meta.actor,
			action: "overlay",
			skill: key.skill,
			before: `cccc${key.skill.length}`.padEnd(40, "0"),
			after: `dddd${key.skill.length}`.padEnd(40, "0"),
		}),
		markOrphans: async () => undefined,
	};
}

/**
 * Build the fake host (ASYNC: the stores dir is created before the host
 * is usable — the synchronous `paths` getters read the resolved dir).
 * Disposal: `close()` removes the stores dir when the host owned it (a
 * temp dir); a caller-supplied `storesDir` is left in place.
 */
export async function createFakeHost(
	opts: FakeHostOptions = {},
): Promise<FakeHost> {
	const calls: FakeCall[] = [];
	const record = (method: string, ...args: readonly unknown[]): void => {
		calls.push({ method, args });
	};

	const storesDir =
		opts.storesDir ?? (await mkdtemp(join(tmpdir(), "sigrun-curator-fake-host-")));

	// The scoped-stores surfaces: per-user settings/secrets JSON objects
	// in memory + REAL per-user paths under the stores dir (the fake never
	// creates them; the code under test owns its directories).
	const settingsByUser = new Map<string, Record<string, unknown>>();
	const secretsByUser = new Map<string, Record<string, string>>();
	let settingsValue: Record<string, unknown> = {};
	const secretsValue: Record<string, string> = {};

	const directory = new Map<string, DirectoryUserWire>(
		(opts.users ?? []).map((entry) => [
			entry.user,
			{
				user: entry.user,
				admin: entry.admin ?? false,
				createdAt: 0,
				source: "cli" as const,
			},
		]),
	);

	// Conversations: create/submit/watch/meta/... over plain maps.
	const nextConversationId = { value: 1 };
	const nextSubmissionId = { value: 1 };
	const conversationOwners = new Map<ConversationId, string>();
	const conversationNames = new Map<ConversationId, string>();
	const conversationArchived = new Map<ConversationId, boolean>();
	const conversationActivity = new Map<ConversationId, string>();
	const submissionsByConversation = new Map<
		ConversationId,
		SubmissionRecordWire[]
	>();
	const watchList: Watcher[] = [];
	const interactions = new Map<string, InteractionRecord>();
	const metas = new Map<ConversationId, SessionMeta>();
	const accountLinks = new Map<string, AccountLinkWire>();
	// `settleInteraction`'s scripted outcome: "transition" runs the real
	// in-memory transition; "true"/"false" return verbatim; {reject}
	// throws. Tests set it via `setSettleBehavior`.
	let settleBehavior: "transition" | "true" | "false" | { readonly reject: unknown } =
		"transition";
	let notifyBehavior: "ok" | { readonly reject: unknown } = "ok";

	// The per-user notices pile (owner-scoped like the real service:
	// this fake hosts one extension — "curator") and the declared
	// notice action handlers (the loader's noticeActions plumbing).
	const noticesByUser = new Map<string, UserNotice[]>();
	const noticeActionHandlers = new Map<string, UserNoticeActionHandler>();
	let noticeSeq = 0;

	const models: ModelEntry[] = [
		{
			id: "faux/m",
			provider: "faux",
			modelId: "m",
			name: "Faux M",
			contextWindow: 128_000,
			maxTokens: 8_192,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
	];

	const commands: SlashCommand[] = [];

	const emptyMeta = (): SessionMeta => ({
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "gateway",
	});

	// The curation member: defaults are inert (empty reads, failed runs
	// reporting "not scripted"); `setCuration` overrides fields per test.
	const curationDefaults: SigrunCurationHost = {
		eligibility: async (id) => {
			record("curation.eligibility", id);
			return {
				owner: conversationOwners.get(id),
				internal: false,
				ownerOnly: true,
				unattributed: 0,
			};
		},
		modelCallsSince: async (id, entryId) => {
			record("curation.modelCallsSince", id, entryId);
			return 0;
		},
		authors: async (id) => {
			record("curation.authors", id);
			// The inert default: no attributed entries — the digest step's
			// eligibility fallback (an empty map means "no per-entry source").
			return new Map<EntryId, string | undefined>();
		},
		takeHints: async (id) => {
			record("curation.takeHints", id);
			return [];
		},
		targets: async (user, id) => {
			record("curation.targets", user, id);
			return [];
		},
		tools: async (id) => {
			record("curation.tools", id);
			return [];
		},
		wantsReview: async (user, id) => {
			record("curation.wantsReview", user, id);
			return false;
		},
		forkReview: async (id, opts) => {
			record("curation.forkReview", id, opts);
			return notScripted("forkReview");
		},
		digestRun: async (user, opts) => {
			record("curation.digestRun", user, opts);
			return notScripted("digestRun");
		},
		maintain: async (user, targetId, budget) => {
			record("curation.maintain", user, targetId, budget);
			return { changes: [] };
		},
		skills: (user) => {
			record("curation.skills", user);
			return inertSkills();
		},
		overlays: (user) => {
			record("curation.overlays", user);
			return inertOverlays();
		},
		upstream: async (user, key) => {
			record("curation.upstream", user, key);
			return undefined;
		},
		jobSkillRefs: async (user) => {
			record("curation.jobSkillRefs", user);
			return new Set<string>();
		},
		undoReview: async (user, reviewId) => {
			record("curation.undoReview", user, reviewId);
			return 0;
		},
		usage: async (user) => {
			record("curation.usage", user);
			return {};
		},
	};
	const curation: ScriptableCuration = Object.assign(
		{} as ScriptableCuration,
		curationDefaults,
		{ defaults: curationDefaults },
	);

	let declaredSettings: FakeHost["declaredSettings"];

	const host: SigrunHost = {
		settings: {
			declare: <S, U>(decl: SettingsDeclaration) => {
				record("settings.declare");
				const read = async (
					schema: SettingsDeclaration["schema"],
					stored: Record<string, unknown>,
				): Promise<Record<string, unknown>> =>
					checkStoredSettings(schema, stored).value;
				const handle = {
					get: async () =>
						(await read(decl.schema, { ...settingsValue })) as S,
					user: (user: string) => ({
						get: async () => {
							if (decl.userSchema === undefined) {
								throw new Error("settings.userSchema is not declared");
							}
							return (await read(
								decl.userSchema,
								{ ...(settingsByUser.get(user) ?? {}) },
							)) as U;
						},
					}),
				};
				declaredSettings = handle as unknown as FakeHost["declaredSettings"];
				return handle;
			},
		},
		stores: {
			user: (user: string) => ({
				secrets: {
					get: async (key: string) => {
						record("stores.user.secrets.get", user, key);
						return secretsByUser.get(user)?.[key];
					},
					set: async (key: string, value: string) => {
						record("stores.user.secrets.set", user, key, value);
						const scoped = secretsByUser.get(user) ?? {};
						scoped[key] = value;
						secretsByUser.set(user, scoped);
					},
					delete: async (key: string) => {
						record("stores.user.secrets.delete", user, key);
						const scoped = secretsByUser.get(user);
						if (scoped !== undefined) delete scoped[key];
					},
				},
				settings: {
					get: async () => {
						record("stores.user.settings.get", user);
						return { ...(settingsByUser.get(user) ?? {}) };
					},
					set: async (value: Record<string, unknown>) => {
						record("stores.user.settings.set", user, value);
						settingsByUser.set(user, { ...value });
					},
				},
				paths: {
					data: join(storesDir, "data", "users", user),
					state: join(storesDir, "state", "users", user),
					cache: join(storesDir, "cache", "users", user),
				},
			}),
			secrets: {
				get: async (key: string) => {
					record("stores.secrets.get", key);
					return secretsValue[key];
				},
				set: async (key: string, value: string) => {
					record("stores.secrets.set", key, value);
					secretsValue[key] = value;
				},
				delete: async (key: string) => {
					record("stores.secrets.delete", key);
					delete secretsValue[key];
				},
			},
			settings: {
				get: async () => {
					record("stores.settings.get");
					return settingsValue;
				},
				set: async (value: Record<string, unknown>) => {
					record("stores.settings.set", value);
					settingsValue = value;
				},
			},
			paths: {
				get data() {
					return join(storesDir, "data");
				},
				get cache() {
					return join(storesDir, "cache");
				},
				get state() {
					return join(storesDir, "state");
				},
			},
		},

		tools: {
			setUserTools: (user, tools) => {
				record("tools.setUserTools", user, tools.map((tool) => tool.name));
			},
		},
		services: {
			connect: async (name, user) => {
				record("services.connect", name, user);
				throw new Error(`fake host: no service ${name}`);
			},
		},

		seedInteraction: async (conversationId, rec, _context) => {
			record("seedInteraction", conversationId, rec.callId);
			const key = `${conversationId}:${rec.callId}`;
			const existing = interactions.get(key);
			if (existing !== undefined && existing.status !== "pending") return;
			interactions.set(key, rec);
		},
		answerInteraction: async (
			conversationId,
			callId,
			answer,
			_context,
			opts,
		) => {
			record("answerInteraction", conversationId, callId, answer, opts?.user);
			const key = `${conversationId}:${callId}`;
			const rec = interactions.get(key);
			if (rec === undefined || rec.status !== "pending") return false;
			interactions.set(key, {
				...rec,
				status: "answered",
				answer,
				answeredBy: "human",
				...(opts?.user === undefined ? {} : { answeredByUser: opts.user }),
			});
			return true;
		},
		settleInteraction: async (conversationId, callId, status, _context) => {
			record("settleInteraction", conversationId, callId, status);
			if (typeof settleBehavior === "object") throw settleBehavior.reject;
			if (settleBehavior !== "transition") return settleBehavior === "true";
			const key = `${conversationId}:${callId}`;
			const rec = interactions.get(key);
			if (rec === undefined || rec.status !== "pending") return false;
			interactions.set(key, { ...rec, status });
			return true;
		},
		snapshotInteraction: async (conversationId, callId) => {
			record("snapshotInteraction", conversationId, callId);
			return interactions.get(`${conversationId}:${callId}`);
		},
		peekInteraction: async (conversationId, callId) => {
			record("peekInteraction", conversationId, callId);
			return interactions.get(`${conversationId}:${callId}`);
		},
		setAmbient: async (conversationId, spec) => {
			record("setAmbient", conversationId, spec);
		},
		clearAmbient: async (conversationId, key) => {
			record("clearAmbient", conversationId, key);
		},

		conversations: {
			create: async (opts) => {
				record("conversations.create", opts);
				const id = nextConversationId.value++ as ConversationId;
				conversationOwners.set(id, opts.owner ?? "tester");
				conversationNames.set(id, opts.name ?? "");
				conversationArchived.set(id, false);
				submissionsByConversation.set(id, []);
				return id;
			},
			submit: async (id, input, opts) => {
				record("conversations.submit", id, input, opts);
				const submission: SubmissionRecordWire = {
					id: nextSubmissionId.value++ as SubmissionId,
					conversationId: id,
					...(opts?.requestId === undefined ? {} : { requestId: opts.requestId }),
					type: "pi.user",
					status: "queued",
				};
				submissionsByConversation.get(id)?.push(submission);
				return submission;
			},
			watch: async (id, listener) => {
				record("conversations.watch", id);
				watchList.push({ id, listener });
				return async () => {
					const index = watchList.findIndex(
						(entry) => entry.id === id && entry.listener === listener,
					);
					if (index !== -1) watchList.splice(index, 1);
				};
			},
			list: async (opts) => {
				record("conversations.list", opts);
				const summaries: ConversationSummary[] = [];
				for (const id of conversationOwners.keys()) {
					if (opts?.owner !== undefined && conversationOwners.get(id) !== opts.owner)
						continue;
				const archived = conversationArchived.get(id) ?? false;
				if (opts?.archived !== undefined && archived !== opts.archived) continue;
				const lastActivityAt = conversationActivity.get(id);
				summaries.push({
					id,
					root: false,
					owner: conversationOwners.get(id),
					name: conversationNames.get(id),
					source: "gateway",
					archived,
						pinned: false,
						access: "write",
						...(lastActivityAt === undefined ? {} : { lastActivityAt }),
					});
				}
				return summaries;
			},
			meta: async (id) => {
				record("conversations.meta", id);
				return (
					metas.get(id) ?? {
						...emptyMeta(),
						owner: conversationOwners.get(id),
						name: conversationNames.get(id),
						archived: conversationArchived.get(id) ?? false,
					}
				);
			},
			entries: async (id, query, limit, cursor) => {
				record("conversations.entries", id, query, limit, cursor);
				// Recording stub: tests that need entries pass their own host.
				return { items: [] };
			},
			entry: async (id, entryId) => {
				record("conversations.entry", id, entryId);
				return undefined;
			},
			abort: async (id) => {
				record("conversations.abort", id);
			},
			configure: async (id, opts) => {
				record("conversations.configure", id, opts);
			},
			compact: async (id) => {
				record("conversations.compact", id);
			},
			fork: async (id, opts) => {
				record("conversations.fork", id, opts);
				const child = nextConversationId.value++ as ConversationId;
				conversationOwners.set(child, opts?.owner ?? conversationOwners.get(id) ?? "tester");
				conversationNames.set(child, conversationNames.get(id) ?? "");
				conversationArchived.set(child, false);
				submissionsByConversation.set(child, []);
				return child;
			},
			patchMeta: async (id, patch) => {
				record("conversations.patchMeta", id, patch);
				const current =
					metas.get(id) ??
					({
						...emptyMeta(),
						owner: conversationOwners.get(id),
						name: conversationNames.get(id),
					} as SessionMeta);
				const next: SessionMeta = {
					...current,
					...(patch.name === undefined ? {} : { name: patch.name ?? undefined }),
					...(patch.archived === undefined ? {} : { archived: patch.archived }),
					...(patch.sharing === undefined
						? {}
						: patch.sharing === null
							? { sharing: undefined }
							: { sharing: patch.sharing }),
				};
				metas.set(id, next);
				conversationArchived.set(id, next.archived);
				return next;
			},
			upload: async (id, file) => {
				record("conversations.upload", id, file.name);
				return { path: `uploads/${id}/${file.name}` };
			},
			readFile: async (id, path) => {
				record("conversations.readFile", id, path);
				throw new Error(`fake host: no file at ${path}`);
			},
		},

		jobs: {
			get: async (id) => {
				record("jobs.get", id);
				return undefined;
			},
			activeRun: async () => undefined,
			isJobRun: async () => false,
		},

		notify: async (input) => {
			record("notify", input);
			if (typeof notifyBehavior === "object") throw notifyBehavior.reject;
		},

		notices: {
			post: async (input) => {
				record("notices.post", input);
				noticeSeq += 1;
				const notice: UserNotice = {
					...input,
					id: `notice-${noticeSeq}`,
					owner: "curator",
					at: new Date(0).toISOString(),
				};
				const pile = noticesByUser.get(input.user) ?? [];
				// A keyed post REPLACES the same extension's same-key notice.
				noticesByUser.set(input.user, [
					notice,
					...pile.filter(
						(entry) => input.key === undefined || entry.key !== input.key,
					),
				]);
				return { id: notice.id };
			},
			clear: async (selector) => {
				record("notices.clear", selector);
				const pile = noticesByUser.get(selector.user) ?? [];
				noticesByUser.set(
					selector.user,
					pile.filter((entry) =>
						"key" in selector
							? entry.key !== selector.key
							: entry.id !== selector.id,
					),
				);
			},
			list: async (user) => {
				record("notices.list", user);
				return noticesByUser.get(user) ?? [];
			},
		},

		users: {
			list: async () => {
				record("users.list");
				return [...directory.values()];
			},
			get: async (user) => {
				record("users.get", user);
				return directory.get(user);
			},
		},

		accounts: {
			lookup: async (provider, subject) => {
				record("accounts.lookup", provider, subject);
				return accountLinks.get(`${provider}:${subject}`);
			},
			link: async (provider, subject, user, via) => {
				record("accounts.link", provider, subject, user, via);
				if (!directory.has(user)) throw new Error(`unknown user "${user}"`);
				const row: AccountLinkWire = {
					provider,
					subject,
					user,
					linkedAt: 0,
					via,
				};
				accountLinks.set(`${provider}:${subject}`, row);
				return row;
			},
			unlink: async (provider, subject) => {
				record("accounts.unlink", provider, subject);
				return accountLinks.delete(`${provider}:${subject}`);
			},
			listForUser: async (user) => {
				record("accounts.listForUser", user);
				return [...accountLinks.values()].filter((row) => row.user === user);
			},
		},

		access: {
			accessOf: async (
				principal: Principal | { readonly user: string },
				resource: { owner?: string; sharing?: Sharing },
			): Promise<Access> => {
				record("access.accessOf", principal, resource);
				return accessOf(
					{
						user: "user" in principal ? principal.user : undefined,
						superuser: false,
					},
					resource,
				);
			},
		},

		identity: {
			actingUser: async (id) => {
				record("identity.actingUser", id);
				return conversationOwners.get(id);
			},
		},

		surfaces: {
			changed: (id, key) => {
				record("surfaces.changed", id, key);
			},
		},

		models: {
			list: async () => {
				record("models.list");
				return models;
			},
			complete: async () => {
				throw new Error("fake host: models.complete is not implemented");
			},
		},

		commands: {
			list: async () => {
				record("commands.list");
				return commands;
			},
			run: async (id, name, args, opts) => {
				record("commands.run", id, name, args, opts);
				return {};
			},
		},

		curation,

		publishedHooks: {
			get: (name) => {
				record("publishedHooks.get", name);
				return undefined;
			},
			call: async (name, payload, opts) => {
				record("publishedHooks.call", name, payload, opts);
				return { status: "absent" };
			},
		},

		declineInteraction: async () => {
			throw new Error("fake host: declineInteraction is not implemented");
		},

		decisions: {
			evaluate: async () => {
				throw new Error("fake host: decisions.evaluate is not implemented");
			},
			list: async () => [],
		},
	};

	const fake: FakeHost = {
		...host,
		get declaredSettings() {
			return declaredSettings;
		},
		calls,
		context: HANDLER_CONTEXT,
		setLastActivity: (id, iso) => {
			if (iso === undefined) conversationActivity.delete(id);
			else conversationActivity.set(id, iso);
		},
		setSettleBehavior: (behavior) => {
			settleBehavior = behavior;
		},
		setNotifyBehavior: (behavior) => {
			notifyBehavior = behavior;
		},
		setCuration: (overrides) => {
			for (const [key, value] of Object.entries(overrides)) {
				// Scripted members record like the defaults — `fake.calls` is
				// the ordered log of EVERY curation call, scripted or not.
				const scripted =
					typeof value === "function"
						? (...args: readonly unknown[]) => {
								record(`curation.${key}`, ...args);
								return (value as (...a: readonly unknown[]) => unknown)(...args);
						}
						: value;
				// @ts-expect-error — scriptable-by-design: tests override members.
				curation[key] = scripted;
			}
		},
		pushView: (id, view) => {
			for (const watcher of watchList) {
				if (watcher.id === id) watcher.listener(view);
			}
		},
		interactions,
		metas,
		storedNotices: noticesByUser,
		registerNoticeActions: (handlers) => {
			noticeActionHandlers.clear();
			for (const [name, handler] of Object.entries(handlers)) {
				noticeActionHandlers.set(name, handler);
			}
		},
		invokeNoticeAction: async (name, ctx, payload) => {
			record("noticeActions.invoke", name, ctx.notice.id, payload);
			const handler = noticeActionHandlers.get(name);
			if (handler === undefined) {
				throw new Error(`fake host: no notice action "${name}" registered`);
			}
			return handler(ctx, payload);
		},
		seed: (conversationId, rec) => {
			const key = `${conversationId}:${rec.callId}`;
			const existing = interactions.get(key);
			if (existing !== undefined && existing.status !== "pending") return;
			interactions.set(key, rec);
		},
		close: async () => {
			// Only the dir the host OWNED (a temp dir) is removed; a
			// caller-supplied storesDir is the caller's to manage.
			if (opts.storesDir !== undefined) return;
			await rm(storesDir, { recursive: true, force: true });
		},
	};
	return fake;
}

/** The failed-run default for an unscripted run producer. */
function notScripted(kind: string): CurationRunResult {
	return {
		status: "failed",
		text: "",
		changes: [],
		error: `fake host: curation.${kind} not scripted`,
	};
}

// Re-export the option/answer shapes the tests construct (one import site).
export type { CurationRunOpts, MaintenanceBudget, MaintenanceReport };
