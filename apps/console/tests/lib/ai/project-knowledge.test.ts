// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Claude-Projects context blocks: a project's derived knowledge (live state, rendered onto
// every turn's system prompt) and the pinned instructions/notes for a scope. Both formatters are
// pure, so the prompt stays deterministic (and therefore prompt-cacheable).

import { describe, expect, it } from "vitest";
import {
	formatContextBlock,
	formatProjectKnowledge,
	type ProjectFacts,
} from "@/lib/ai/project-knowledge";
import type { AgentContext } from "@/lib/db/schema";

const facts: ProjectFacts = {
	name: "checkout",
	slug: "checkout",
	region: "eu-central-1",
	iacVersion: "1.9.0",
	monthlyCost: 412,
	environments: [
		{ name: "prod", stage: "production", status: "ACTIVE", region: "eu-central-1" },
		{ name: "staging", stage: "staging", status: "DRAFT", region: null },
	],
	recentJobs: [
		{ type: "DEPLOY", status: "SUCCESS", error: null },
		{ type: "PLAN", status: "FAILED", error: "quota exceeded" },
	],
};

/** A saved context row for a scope. */
function ctx(instructions: string, notes: string): AgentContext {
	return {
		id: "c1",
		user_id: "u1",
		org_id: "u1",
		project_id: null,
		instructions,
		notes,
		created_at: new Date(),
		updated_at: new Date(),
	};
}

describe("formatProjectKnowledge", () => {
	it("renders identity, environments and recent jobs so the first answer is grounded", () => {
		const out = formatProjectKnowledge(facts);
		expect(out).toContain("checkout");
		expect(out).toContain("eu-central-1");
		expect(out).toContain("prod (production, eu-central-1) — ACTIVE");
		expect(out).toContain("staging (staging) — DRAFT");
		expect(out).toContain("DEPLOY: SUCCESS");
		expect(out).toContain("PLAN: FAILED — quota exceeded");
		expect(out).toContain("$412");
	});

	it("is deterministic (same facts → same string, so the prompt stays cacheable)", () => {
		expect(formatProjectKnowledge(facts)).toBe(formatProjectKnowledge(facts));
	});

	it("states the empty cases rather than omitting them", () => {
		const out = formatProjectKnowledge({
			...facts,
			monthlyCost: null,
			environments: [],
			recentJobs: [],
		});
		expect(out).toContain("Environments: none yet");
		expect(out).toContain("Recent jobs: none");
		expect(out).not.toContain("$");
	});

	it("caps the block so a huge project can't blow up every turn's system prompt", () => {
		const out = formatProjectKnowledge({
			...facts,
			recentJobs: Array.from({ length: 200 }, () => ({
				type: "DEPLOY",
				status: "FAILED",
				error: "x".repeat(300),
			})),
		});
		expect(out.length).toBeLessThanOrEqual(2100);
		expect(out).toContain("… (truncated)");
	});
});

describe("formatContextBlock", () => {
	it("labels the scope and includes instructions + notes", () => {
		const out = formatContextBlock("Project", ctx("Never destroy.", "Owned by payments."));
		expect(out).toContain("Project custom instructions");
		expect(out).toContain("Never destroy.");
		expect(out).toContain("Project knowledge");
		expect(out).toContain("Owned by payments.");
	});

	it("drops out of the prompt entirely when the row is missing or blank", () => {
		expect(formatContextBlock("Organization", null)).toBe("");
		expect(formatContextBlock("Organization", ctx("  ", "\n"))).toBe("");
	});

	it("emits only the half that is filled in", () => {
		const out = formatContextBlock("Organization", ctx("Be terse.", ""));
		expect(out).toContain("Organization custom instructions");
		expect(out).not.toContain("Organization knowledge");
	});
});
