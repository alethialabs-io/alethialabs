// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What the changeset bar and the review view SAY (#6833), pinned state by state.
//
// Two properties matter more than the wording. `deployBlock` returns null — Deploy may be pressed —
// only when the store's gate allows it, whatever else is true. And `serverCurrentFor` is false
// unless the server calls current the very plan the board recorded, so neither side's belief is
// enough on its own.

import { describe, expect, it } from "vitest";
import {
	barState,
	deployBlock,
	fieldLabel,
	formatValue,
	planBlock,
	planCountsSentence,
	planPhase,
	serverCurrentFor,
	summarizeChanges,
	type BarFacts,
	type DeployFacts,
	type PlanPhase,
} from "@/components/design-project/canvas/review/changeset-status";
import type { ReviewPlan } from "@/lib/canvas/component-status";
import type { DeployGate } from "@/lib/canvas/store/derive";
import type { PendingChange } from "@/lib/canvas/store/types";

const PLAN_ID = "11111111-1111-4111-8111-111111111111";

/** A server answer for a successful, current plan, with overrides. */
function serverPlan(over: Partial<ReviewPlan> = {}): ReviewPlan {
	return {
		environmentId: "env-1",
		planJobId: PLAN_ID,
		status: "SUCCESS",
		createdAt: "2026-11-20T10:00:00.000Z",
		summary: { create: 3, update: 1, delete: 0, replace: 0 },
		cost: { totalMonthly: 212.4, currency: "EUR" },
		designRevision: "7",
		savedRevision: "7",
		digest: null,
		current: true,
		staleReason: null,
		...over,
	};
}

const ALLOWED: DeployGate = { allowed: true, reason: "ok", planJobId: PLAN_ID };
const NO_PLAN: DeployGate = { allowed: false, reason: "no-plan", planJobId: null };

const change = (op: PendingChange["op"], id: string): PendingChange => ({
	id,
	op,
	kind: "database",
	name: id,
});

/** Bar facts for a clean, never-deployed board, with overrides. */
function bar(over: Partial<BarFacts> = {}): BarFacts {
	return {
		changes: [],
		operations: [],
		deployState: "never",
		activeJob: null,
		recentJobs: [],
		...over,
	};
}

/** Deploy facts for a board that may deploy, with overrides. */
function deploy(over: Partial<DeployFacts> = {}): DeployFacts {
	return {
		gate: ALLOWED,
		refusal: null,
		activeJob: null,
		pendingDesign: 0,
		pendingOperations: 0,
		issues: 0,
		phase: "current",
		planJobId: PLAN_ID,
		...over,
	};
}

describe("barState: the bar's states", () => {
	it("edits pending: says how many kinds of change, and review is the primary action", () => {
		const state = barState(
			bar({ changes: [change("new", "a"), change("modified", "b"), change("modified", "c")] }),
		);
		expect(state).toMatchObject({
			kind: "pending",
			label: "Pending changes",
			detail: "1 added · 2 edited",
			reviewIsPrimary: true,
		});
	});

	it("clean and never deployed", () => {
		expect(barState(bar({ deployState: "never" }))).toMatchObject({
			kind: "never",
			label: "Not deployed yet",
			reviewIsPrimary: true,
		});
	});

	it("clean, saved ahead of what is deployed", () => {
		expect(barState(bar({ deployState: "ahead" }))).toMatchObject({
			kind: "ahead",
			label: "Saved, not deployed",
			reviewIsPrimary: true,
		});
	});

	it("clean and in sync: review is offered quietly", () => {
		expect(barState(bar({ deployState: "in-sync" }))).toMatchObject({
			kind: "in-sync",
			label: "Up to date",
			reviewIsPrimary: false,
		});
	});

	it("a job running: names what it is doing and carries the job for View log", () => {
		expect(
			barState(bar({ activeJob: { id: "job-1", type: "DEPLOY", status: "PROCESSING" } })),
		).toMatchObject({ kind: "running", label: "Deploying", tier: "live", jobId: "job-1" });
	});

	it("a job queued and not started reads as waiting, not as running", () => {
		const state = barState(bar({ activeJob: { id: "job-1", type: "DEPLOY", status: "QUEUED" } }));
		expect(state.label).toBe("Deploy queued, waiting to start");
		expect(state.tier).toBe("pending");
	});

	it("the last deploy failed", () => {
		expect(
			barState(
				bar({
					deployState: "ahead",
					recentJobs: [
						{ id: "job-9", type: "DEPLOY", status: "FAILED", createdAt: "2026-11-20T09:00:00.000Z" },
					],
				}),
			),
		).toMatchObject({ kind: "failed", label: "Deploy failed", jobId: "job-9", reviewIsPrimary: true });
	});

	it("a failed plan is not a failed deploy: the bar falls back to where the design stands", () => {
		expect(
			barState(
				bar({
					deployState: "in-sync",
					recentJobs: [
						{ id: "job-9", type: "PLAN", status: "FAILED", createdAt: "2026-11-20T09:00:00.000Z" },
					],
				}),
			).kind,
		).toBe("in-sync");
	});

	it("pending edits outrank a running job, so Discard stays reachable", () => {
		expect(
			barState(
				bar({
					changes: [change("new", "a")],
					activeJob: { id: "job-1", type: "DEPLOY", status: "PROCESSING" },
				}),
			).kind,
		).toBe("pending");
	});
});

describe("summarizeChanges", () => {
	it("names each kind that is present, and staged operations", () => {
		expect(
			summarizeChanges(
				[change("new", "a"), change("removed", "b")],
				[
					{
						id: "addon:grafana",
						target: "addon",
						verb: "install",
						targetId: "grafana",
						summary: "Install Grafana",
						input: {},
					},
				],
			),
		).toBe("1 added · 1 removed · 1 add-on change");
	});

	it("is empty when nothing is pending", () => {
		expect(summarizeChanges([], [])).toBe("");
	});
});

describe("planPhase", () => {
	it("is loading until the read answers, and unknown when it failed", () => {
		expect(planPhase(undefined, "loading")).toBe("loading");
		expect(planPhase(undefined, "error")).toBe("unknown");
	});

	it.each<[Partial<ReviewPlan>, PlanPhase]>([
		[{ planJobId: null, status: null, current: false, staleReason: "no-plan" }, "none"],
		[{ status: "QUEUED", current: false, staleReason: "plan-not-succeeded" }, "waiting"],
		[{ status: "CLAIMED", current: false, staleReason: "plan-not-succeeded" }, "running"],
		[{ status: "PROCESSING", current: false, staleReason: "plan-not-succeeded" }, "running"],
		[{ status: "FAILED", current: false, staleReason: "plan-not-succeeded" }, "failed"],
		[{ status: "CANCELLED", current: false, staleReason: "plan-not-succeeded" }, "cancelled"],
		[{ current: false, staleReason: "design-changed" }, "design-changed"],
		[{ current: false, staleReason: "run-since-plan" }, "run-since"],
		[{}, "current"],
	])("reads %j as %s", (over, phase) => {
		expect(planPhase(serverPlan(over), "ready")).toBe(phase);
	});
});

describe("serverCurrentFor", () => {
	const reviewed = { planJobId: PLAN_ID, designRevision: "abc" };

	it("is true only when the server calls current the plan the board recorded", () => {
		expect(serverCurrentFor(serverPlan(), reviewed)).toBe(true);
	});

	it("is false with no server answer, however sure the board is", () => {
		expect(serverCurrentFor(undefined, reviewed)).toBe(false);
	});

	it("is false when nothing was recorded, however current the server's plan is", () => {
		expect(serverCurrentFor(serverPlan(), null)).toBe(false);
	});

	it("is false when the server's latest plan is another plan", () => {
		expect(
			serverCurrentFor(serverPlan({ planJobId: "22222222-2222-4222-8222-222222222222" }), reviewed),
		).toBe(false);
	});

	it("is false while the recorded plan is still running", () => {
		expect(
			serverCurrentFor(
				serverPlan({ status: "PROCESSING", current: false, staleReason: "plan-not-succeeded" }),
				reviewed,
			),
		).toBe(false);
	});
});

describe("deployBlock: why Deploy is disabled", () => {
	it("is null — Deploy may be pressed — when the gate allows and nothing else refuses", () => {
		expect(deployBlock(deploy())).toBeNull();
	});

	it("never returns null while the gate refuses, whatever the server says", () => {
		const phases: PlanPhase[] = [
			"loading",
			"unknown",
			"none",
			"waiting",
			"running",
			"failed",
			"cancelled",
			"current",
			"design-changed",
			"run-since",
		];
		const open = phases.filter((phase) => deployBlock(deploy({ gate: NO_PLAN, phase })) === null);
		expect(open).toEqual([]);
	});

	it.each<[string, Partial<DeployFacts>, string, string | null]>([
		["no plan yet", { gate: NO_PLAN, phase: "none" }, "no-plan", "run-plan"],
		["the plan failed", { gate: NO_PLAN, phase: "failed" }, "plan-failed", "run-plan"],
		["the plan was cancelled", { gate: NO_PLAN, phase: "cancelled" }, "plan-cancelled", "run-plan"],
		["the plan is queued", { gate: NO_PLAN, phase: "waiting" }, "plan-waiting", "view-job"],
		["the plan is running", { gate: NO_PLAN, phase: "running" }, "plan-running", "view-job"],
		[
			"the design changed since the plan (saved)",
			{ gate: NO_PLAN, phase: "design-changed" },
			"design-changed",
			"run-plan",
		],
		[
			"the design changed since the plan (unsaved)",
			{ gate: { allowed: false, reason: "unsaved-edits", planJobId: null }, pendingDesign: 2 },
			"unsaved-edits",
			"run-plan",
		],
		["something ran since", { gate: NO_PLAN, phase: "run-since" }, "run-since-plan", "run-plan"],
		[
			"the cloud is not available",
			{ refusal: { reason: "cloud-not-offered", message: "Alibaba Cloud is not available here." } },
			"cloud-not-offered",
			null,
		],
		[
			"another job is in flight",
			{ activeJob: { id: "job-1", type: "DESTROY", status: "PROCESSING" } },
			"job-running",
			"view-job",
		],
		["the design has issues", { issues: 2 }, "issues", "show-issues"],
		["an add-on change is staged", { pendingOperations: 1 }, "staged-operations", "show-changes"],
		["the plan read failed", { gate: NO_PLAN, phase: "unknown" }, "plan-unknown", "retry-read"],
		[
			"a current plan nobody confirmed here",
			{ gate: NO_PLAN, phase: "current" },
			"not-reviewed",
			"use-plan",
		],
	])("%s", (_name, over, code, fix) => {
		const block = deployBlock(deploy(over));
		expect(block?.code).toBe(code);
		expect(block?.fix).toBe(fix);
		expect(block?.reason.length).toBeGreaterThan(20);
	});

	it("says the two 'design changed' cases in the words the person will look for", () => {
		expect(deployBlock(deploy({ gate: NO_PLAN, phase: "design-changed" }))?.reason).toMatch(
			/design changed since the plan/i,
		);
		expect(deployBlock(deploy({ gate: NO_PLAN, pendingDesign: 1 }))?.reason).toMatch(
			/design changed since the plan/i,
		);
	});

	it("carries the server's own sentence when the cloud is not offered", () => {
		const block = deployBlock(
			deploy({ refusal: { reason: "cloud-not-offered", message: "Alibaba Cloud is not available here." } }),
		);
		expect(block?.reason).toContain("Alibaba Cloud is not available here.");
	});

	it("a plan in flight is not 'another job': it is reported as the plan running", () => {
		const block = deployBlock(
			deploy({
				gate: NO_PLAN,
				phase: "running",
				activeJob: { id: PLAN_ID, type: "PLAN", status: "PROCESSING" },
			}),
		);
		expect(block?.code).toBe("plan-running");
		expect(block?.jobId).toBe(PLAN_ID);
	});
});

describe("planBlock: why Run plan is disabled", () => {
	it("is null on a design with no issues, an offered cloud and nothing in flight", () => {
		expect(planBlock({ refusal: null, activeJob: null, issues: 0 })).toBeNull();
	});

	it("refuses while a job is in flight, and names it", () => {
		const block = planBlock({
			refusal: null,
			activeJob: { id: "job-1", type: "DEPLOY", status: "PROCESSING" },
			issues: 0,
		});
		expect(block?.reason).toMatch(/deploy is running/i);
		expect(block?.jobId).toBe("job-1");
	});

	it("refuses a design with issues: it would not be saved", () => {
		expect(planBlock({ refusal: null, activeJob: null, issues: 1 })?.reason).toMatch(/1 issue/);
	});
});

describe("the small formatters", () => {
	it("says a plan's counts in one sentence, with replace only when there is one", () => {
		expect(planCountsSentence({ create: 3, update: 1, delete: 0, replace: 0 })).toBe(
			"3 to add · 1 to change · 0 to destroy",
		);
		expect(planCountsSentence({ create: 0, update: 0, delete: 1, replace: 2 })).toBe(
			"0 to add · 0 to change · 1 to destroy · 2 to replace",
		);
	});

	it("shows an absent value as words and a structured one as one clipped line", () => {
		expect(formatValue(undefined)).toBe("not set");
		expect(formatValue("")).toBe("not set");
		expect(formatValue("db.t3.micro")).toBe("db.t3.micro");
		expect(formatValue(20)).toBe("20");
		expect(formatValue(false)).toBe("false");
		expect(formatValue([])).toBe("none");
		expect(formatValue({ a: 1 })).toBe('{"a":1}');
		expect(formatValue("x".repeat(200)).length).toBe(80);
	});

	it("turns a config key into a label", () => {
		expect(fieldLabel("instance_class")).toBe("Instance class");
		expect(fieldLabel("cloud_identity_id")).toBe("Cloud account");
	});
});
