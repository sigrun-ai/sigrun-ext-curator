/**
 * Task B2 tests: `reviewInstruction` (`src/prompts.ts`) — the review
 * run's only input. The snapshot pins the wording once written; the
 * targeted assertions keep the required CONTENT honest (spec §6.2):
 * the do-not-capture list, the routing rule, the hint arguments and
 * exactly the allowed tools.
 */

import { describe, expect, test } from "vitest";
import type { CurationHint } from "@sigrun/sigrun/extension";
import { reviewInstruction } from "../src/prompts.js";

describe("reviewInstruction", () => {
	test("the review instruction contains the do-not-capture list, the routing rule, the hint arguments and exactly the allowed tools", () => {
		const hints: readonly CurationHint[] = [
			{
				id: "hint-1",
				tool: "memory_write",
				args: { file: "user", text: "prefers tabs" },
				at: "2026-11-01T12:00:00.000Z",
			},
		];
		const text = reviewInstruction({
			hints,
			targets: [
				{
					id: "memory",
					guidance: ["personal facts go here", "keep it under budget"],
				},
			],
			allow: ["skill_manage", "memory_write"],
			focus: "the deploy checklist",
		});

		// The do-not-capture list (spec §6.2).
		for (const banned of [
			"environment failures",
			"negative claims about tools",
			"transient errors",
			"unresolved failures",
			"one-off tasks",
			"AGENTS.md",
			"secrets",
			"personal facts",
		]) {
			expect(text).toContain(banned);
		}

		// The routing rule: each lesson exactly one place.
		expect(text).toContain("exactly one");

		// The hint arguments (verbatim).
		expect(text).toContain("memory_write");
		expect(text).toContain("prefers tabs");

		// Exactly the allowed tools — the instruction names them and no
		// stray tool.
		expect(text).toContain("skill_manage");
		expect(text).toMatch(/memory_write(?!_)/);
		// A negative probe: a tool NOT in the allow list is absent.
		expect(text).not.toContain("read");

		// The target guidance rides along.
		expect(text).toContain("personal facts go here");

		// The focus rides along.
		expect(text).toContain("the deploy checklist");

		// The wording is pinned once written.
		expect(text).toMatchSnapshot();
	});

	test("without hints, targets or focus the instruction still stands alone", () => {
		const text = reviewInstruction({
			hints: [],
			targets: [],
			allow: ["skill_manage"],
		});
		expect(text).toContain("skill_manage");
		expect(text).not.toContain("hint");
		expect(text).toMatchSnapshot();
	});
});
