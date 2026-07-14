// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Per-environment infrastructure cost.
//
// The pipeline already ran end to end and stopped one step short of the database: the runner runs
// Infracost on every PLAN and posts the breakdown; `parseCostBreakdown` already parsed it; nobody
// ever wrote it down. These tests pin the parse → persist shape, and the rule that matters most:
// an unknown cost stays UNKNOWN. A fabricated $0 is worse than an admitted "not priced", because
// you'd believe it.

import { describe, expect, it } from "vitest";
import { parseCostBreakdown } from "@/lib/plan/parse-cost";
import { NODE_STATUS_META, resolveNodeStatus } from "@/lib/canvas/node-status";
import type {
	ComponentServerStatus,
	EnvironmentStatus,
} from "@/lib/canvas/component-status";
import { EMPTY_ENVIRONMENT_STATUS } from "@/lib/canvas/component-status";
import type { NodeReadiness } from "@/lib/canvas/node-status";

/** A realistic Infracost payload — the shape the runner actually posts. */
const BREAKDOWN = {
	totalMonthlyCost: "312.47",
	totalHourlyCost: "0.428",
	projects: [
		{
			breakdown: {
				resources: [
					{
						name: "aws_eks_cluster.main",
						resourceType: "aws_eks_cluster",
						monthlyCost: "73.00",
						hourlyCost: "0.1",
						subresources: [],
					},
					{
						name: "aws_db_instance.orders",
						resourceType: "aws_db_instance",
						monthlyCost: "61.32",
						hourlyCost: "0.084",
						subresources: [],
					},
					// Free resources exist in every plan and must not become $0.00 lines on a card.
					{
						name: "aws_s3_bucket.assets",
						resourceType: "aws_s3_bucket",
						monthlyCost: "0",
						hourlyCost: "0",
						subresources: [],
					},
				],
			},
		},
	],
};

const READY: NodeReadiness = { state: "ready", complete: true, gated: false };
const CALM: Pick<EnvironmentStatus, "activeJob" | "updatePending" | "probe"> = {
	activeJob: null,
	updatePending: false,
	probe: null,
};

const server = (o: Partial<ComponentServerStatus> = {}): ComponentServerStatus => ({
	lifecycle: "ACTIVE",
	message: null,
	drift: [],
	...o,
});

describe("parsing what the runner already posts", () => {
	it("reads the environment's monthly total", () => {
		expect(parseCostBreakdown(BREAKDOWN).totalMonthlyCost).toBe(312.47);
	});

	it("keeps the Terraform ADDRESS — the same key drift uses, so cost can find its card", () => {
		const { resources } = parseCostBreakdown(BREAKDOWN);
		expect(resources.map((r) => r.name)).toContain("aws_db_instance.orders");
		expect(resources.map((r) => r.resourceType)).toContain("aws_db_instance");
	});

	it("drops free resources rather than pricing them at $0.00", () => {
		const { resources } = parseCostBreakdown(BREAKDOWN);
		expect(resources.map((r) => r.name)).not.toContain("aws_s3_bucket.assets");
	});

	it("a malformed payload degrades to unknown instead of throwing — cost is an overlay", () => {
		const summary = parseCostBreakdown({ nonsense: true });
		expect(summary.totalMonthlyCost).toBe(0);
		expect(summary.resources).toEqual([]);
	});
});

describe("cost reaches the node, without becoming a state", () => {
	it("a priced component carries its monthly cost", () => {
		const status = resolveNodeStatus(READY, server({ monthlyCost: 61.32 }), CALM);
		expect(status.monthlyCost).toBe(61.32);
		// …and it's still just Live. Cost is an overlay, exactly like drift.
		expect(status.state).toBe("live");
	});

	it("an unpriced component says NOTHING rather than $0 — a fabricated zero is worse", () => {
		expect(resolveNodeStatus(READY, server(), CALM).monthlyCost).toBeNull();
	});

	it("a node that was never provisioned has no cost", () => {
		expect(resolveNodeStatus(READY, undefined, CALM).monthlyCost).toBeNull();
	});

	it("a failed component keeps its cost — it's still costing you money", () => {
		const status = resolveNodeStatus(
			READY,
			server({ lifecycle: "FAILED", monthlyCost: 61.32 }),
			CALM,
		);
		expect(status.state).toBe("failed");
		expect(status.monthlyCost).toBe(61.32);
	});
});

describe("an environment that has never been planned", () => {
	it("reports null, not zero — the difference between 'free' and 'we don't know'", () => {
		expect(EMPTY_ENVIRONMENT_STATUS.monthlyCost).toBeNull();
		expect(EMPTY_ENVIRONMENT_STATUS.costCapturedAt).toBeNull();
	});
});

describe("every status still maps to a design-system token", () => {
	it("adding cost changed no state", () => {
		// Cost is an overlay; it must not have introduced a state (and therefore a new visual).
		expect(Object.keys(NODE_STATUS_META)).toHaveLength(13);
	});
});
