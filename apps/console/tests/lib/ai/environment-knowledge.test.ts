// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environment knowledge block (lib/ai/environment-knowledge.ts): the project block's
// sibling, scoped to the ONE environment the conversation is about. The formatter is pure, so
// the prompt stays deterministic; every empty case is stated rather than omitted, because the
// model must not read silence as "nothing to report".

import { describe, expect, it } from "vitest";
import {
	type EnvironmentFacts,
	formatEnvironmentKnowledge,
} from "@/lib/ai/environment-knowledge";

const ENV_ID = "3f7c1a2e-8b4d-4c6e-9a1b-2d3e4f5a6b7c";

const facts: EnvironmentFacts = {
	id: ENV_ID,
	name: "prod-eu",
	stage: "production",
	status: "ACTIVE",
	region: "eu-central-1",
	isDefault: false,
	cost: { monthly: 412.5, capturedAt: "2026-09-01T10:00:00Z" },
	drift: { inSync: false, drifted: 2, scannedAt: "2026-09-06T08:30:00Z" },
	deployed: true,
	updatePending: true,
	recentJobs: [
		{ type: "DEPLOY", status: "SUCCESS", error: null },
		{ type: "PLAN", status: "FAILED", error: "quota exceeded" },
	],
	stagedChanges: [
		{ op: "UPDATE", componentType: "cluster" },
		{ op: "UPDATE", componentType: "cache" },
		{ op: "CREATE", componentType: "database" },
	],
};

describe("formatEnvironmentKnowledge", () => {
	it("names the environment BY ID so the model can copy it onto a proposal", () => {
		const out = formatEnvironmentKnowledge(facts);
		expect(out).toContain("## Environment knowledge");
		expect(out).toContain(`- Name: prod-eu · id: ${ENV_ID}`);
		expect(out).toContain("Stage: production · Status: ACTIVE · Region: eu-central-1");
	});

	it("marks the project default, so the model knows when the scoped env IS the default", () => {
		expect(formatEnvironmentKnowledge({ ...facts, isDefault: true })).toContain(
			"prod-eu (project default)",
		);
		expect(formatEnvironmentKnowledge(facts)).not.toContain("(project default)");
	});

	it("renders cost through the shared formatter with the plan's capture date", () => {
		const out = formatEnvironmentKnowledge(facts);
		expect(out).toContain("$412.50/mo");
		expect(out).toContain("from the plan of 1 Sept 2026");
	});

	it("renders drift as a count when out of sync and as 'in sync' otherwise", () => {
		expect(formatEnvironmentKnowledge(facts)).toContain("Drift: 2 resources drifted");
		expect(
			formatEnvironmentKnowledge({
				...facts,
				drift: { inSync: false, drifted: 1, scannedAt: "2026-09-06T08:30:00Z" },
			}),
		).toContain("Drift: 1 resource drifted");
		expect(
			formatEnvironmentKnowledge({
				...facts,
				drift: { inSync: true, drifted: 0, scannedAt: "2026-09-06T08:30:00Z" },
			}),
		).toContain("Drift: in sync");
	});

	it("distinguishes never deployed / update pending / matches / unmeasurable", () => {
		expect(formatEnvironmentKnowledge(facts)).toContain("update pending");
		expect(
			formatEnvironmentKnowledge({ ...facts, updatePending: false }),
		).toContain("matches the saved design");
		expect(
			formatEnvironmentKnowledge({ ...facts, deployed: false, updatePending: null }),
		).toContain("Deployed: never");
		// A design read that threw is an UNKNOWN, never reported as "matches".
		const unknown = formatEnvironmentKnowledge({ ...facts, updatePending: null });
		expect(unknown).toContain("could not be measured");
		expect(unknown).not.toContain("matches the saved design");
	});

	it("lists the jobs that ran on THIS environment, newest first, with the error", () => {
		const out = formatEnvironmentKnowledge(facts);
		expect(out).toContain("Recent jobs on this environment (newest first):");
		expect(out).toContain("  - DEPLOY: SUCCESS");
		expect(out).toContain("  - PLAN: FAILED — quota exceeded");
	});

	it("calls out an in-flight job so the model does not stack a second operation on it", () => {
		const out = formatEnvironmentKnowledge({
			...facts,
			recentJobs: [{ type: "DEPLOY", status: "PROCESSING", error: null }, ...facts.recentJobs],
		});
		expect(out).toContain("In flight: DEPLOY is PROCESSING");
		expect(formatEnvironmentKnowledge(facts)).not.toContain("In flight");
	});

	it("groups the staged changes by operation with the kinds they touch", () => {
		expect(formatEnvironmentKnowledge(facts)).toContain(
			"Staged changes (on the canvas, not yet applied): 2 UPDATE (cluster, cache) · 1 CREATE (database)",
		);
	});

	it("states every empty case rather than omitting it", () => {
		const out = formatEnvironmentKnowledge({
			...facts,
			cost: null,
			drift: null,
			deployed: false,
			updatePending: null,
			recentJobs: [],
			stagedChanges: [],
		});
		expect(out).toContain("Estimated monthly cost: never priced");
		expect(out).toContain("Drift: never scanned");
		expect(out).toContain("Deployed: never");
		expect(out).toContain("Recent jobs on this environment: none");
		expect(out).toContain("Staged changes: none");
		expect(out).not.toContain("$");
	});

	it("is deterministic (same facts → same string, so the prompt stays cacheable)", () => {
		expect(formatEnvironmentKnowledge(facts)).toBe(formatEnvironmentKnowledge(facts));
	});

	it("drops out entirely for an environment that is not visible in scope", () => {
		expect(formatEnvironmentKnowledge(null)).toBe("");
	});

	it("caps the block so a noisy environment cannot blow up every turn's prompt", () => {
		const out = formatEnvironmentKnowledge({
			...facts,
			stagedChanges: Array.from({ length: 400 }, (_, i) => ({
				op: "UPDATE",
				componentType: `service-${i}`,
			})),
		});
		expect(out.length).toBeLessThanOrEqual(1600);
		expect(out).toContain("… (truncated)");
	});
});
