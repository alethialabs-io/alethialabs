// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The precedence ladder is the whole contract of the status system: a node has several truths at
// once (its design is invalid AND it's live AND it drifted), and the order they resolve in decides
// what the user sees. These tests pin that order, because this is exactly where such systems rot —
// someone adds a state, slots it in "somewhere reasonable", and the canvas starts lying.

import { describe, expect, it } from "vitest";
import {
	NODE_STATUS_META,
	resolveNodeStatus,
	type NodeReadiness,
	type NodeStatusState,
} from "@/lib/canvas/node-status";
import type {
	ComponentServerStatus,
	EnvironmentStatus,
} from "@/lib/canvas/component-status";
import type { ComponentStatus } from "@/lib/db/schema/enums";
import type { DriftDetail } from "@/types/jsonb.types";

const READY: NodeReadiness = { state: "ready", complete: true, gated: false };
const NEEDS_SETUP: NodeReadiness = {
	state: "needs-setup",
	issue: "Partition key is required",
	complete: false,
	gated: false,
};
const GATED: NodeReadiness = { state: "gated", complete: true, gated: true };

const CALM: Pick<EnvironmentStatus, "activeJob" | "updatePending" | "probe"> = {
	activeJob: null,
	updatePending: false,
	probe: null,
};

function server(
	lifecycle: ComponentStatus,
	overrides: Partial<ComponentServerStatus> = {},
): ComponentServerStatus {
	return { lifecycle, message: null, drift: [], ...overrides };
}

const DRIFT: DriftDetail[] = [
	{ address: "aws_db_instance.orders", type: "aws_db_instance", kind: "modified" },
];

describe("no component row — the design layer is the whole truth", () => {
	it("a node that was never provisioned reports its design readiness", () => {
		expect(resolveNodeStatus(READY, undefined, CALM).state).toBe("ready");
		expect(resolveNodeStatus(NEEDS_SETUP, undefined, CALM).state).toBe("needs-setup");
		expect(resolveNodeStatus(GATED, undefined, CALM).state).toBe("gated");
	});

	it("and is not marked deployed", () => {
		expect(resolveNodeStatus(READY, undefined, CALM).deployed).toBe(false);
	});
});

describe("the precedence ladder", () => {
	it("1 — a failed apply outranks everything, including a broken design", () => {
		const s = resolveNodeStatus(
			NEEDS_SETUP,
			server("FAILED", { message: "InvalidParameterValue: bad engine version" }),
			CALM,
		);
		expect(s.state).toBe("failed");
		// …and it carries the server's own message, not the config issue.
		expect(s.message).toBe("InvalidParameterValue: bad engine version");
	});

	it("2 — mid-change outranks a broken design (what's HAPPENING beats what's wrong)", () => {
		expect(resolveNodeStatus(NEEDS_SETUP, server("CREATING"), CALM).state).toBe("applying");
		expect(resolveNodeStatus(NEEDS_SETUP, server("UPDATING"), CALM).state).toBe("updating");
		expect(resolveNodeStatus(NEEDS_SETUP, server("DESTROYING"), CALM).state).toBe("destroying");
	});

	it("3 — a broken design outranks a LIVE resource (the next deploy will not work)", () => {
		const s = resolveNodeStatus(NEEDS_SETUP, server("ACTIVE"), CALM);
		expect(s.state).toBe("needs-setup");
		expect(s.message).toBe("Partition key is required");
	});

	it("4 — gated outranks live, but not a broken design", () => {
		expect(resolveNodeStatus(GATED, server("ACTIVE"), CALM).state).toBe("gated");
	});

	it("7 — an unreachable cluster outranks update-pending", () => {
		const s = resolveNodeStatus(
			READY,
			server("ACTIVE"),
			{ ...CALM, updatePending: true, probe: { reachable: false, message: "i/o timeout" } },
			{ isCluster: true },
		);
		expect(s.state).toBe("unreachable");
		expect(s.message).toBe("i/o timeout");
	});

	it("only the cluster can be unreachable — a database ignores the probe", () => {
		const s = resolveNodeStatus(READY, server("ACTIVE"), {
			...CALM,
			probe: { reachable: false, message: "i/o timeout" },
		});
		expect(s.state).toBe("live");
	});

	it("8 — a live resource whose design moved ahead is update-pending", () => {
		const s = resolveNodeStatus(READY, server("ACTIVE"), { ...CALM, updatePending: true });
		expect(s.state).toBe("update-pending");
	});

	it("9 — the calm nominal state", () => {
		expect(resolveNodeStatus(READY, server("ACTIVE"), CALM).state).toBe("live");
	});
});

describe("PENDING splits on whether a job is in flight", () => {
	it("queued while the environment has a running job", () => {
		const s = resolveNodeStatus(READY, server("PENDING"), {
			...CALM,
			activeJob: { id: "job-1", type: "DEPLOY", status: "PROCESSING" },
		});
		expect(s.state).toBe("queued");
		expect(s.deployed).toBe(false);
	});

	it("not-deployed when nothing is running", () => {
		expect(resolveNodeStatus(READY, server("PENDING"), CALM).state).toBe("not-deployed");
	});
});

describe("cost is an OVERLAY that rides on whatever state the node is in", () => {
	it("passes the monthly total and its per-address breakdown through", () => {
		const s = resolveNodeStatus(
			READY,
			server("ACTIVE", {
				monthlyCost: 42.5,
				costLines: [
					{ address: "aws_db_instance.orders", monthlyCost: 30 },
					{ address: "aws_db_instance.orders_replica", monthlyCost: 12.5 },
				],
			}),
			CALM,
		);
		expect(s.state).toBe("live");
		expect(s.monthlyCost).toBe(42.5);
		expect(s.costLines).toHaveLength(2);
	});

	it("defaults to no cost when the server priced nothing", () => {
		const s = resolveNodeStatus(READY, server("ACTIVE"), CALM);
		expect(s.monthlyCost).toBeNull();
		expect(s.costLines).toEqual([]);
	});

	it("a node with no component row reports no cost", () => {
		const s = resolveNodeStatus(READY, undefined, CALM);
		expect(s.monthlyCost).toBeNull();
		expect(s.costLines).toEqual([]);
	});

	it("cost survives alongside a failure — it isn't lost when the apply broke", () => {
		const s = resolveNodeStatus(
			READY,
			server("FAILED", {
				monthlyCost: 10,
				costLines: [{ address: "aws_db_instance.orders", monthlyCost: 10 }],
			}),
			CALM,
		);
		expect(s.state).toBe("failed");
		expect(s.costLines).toHaveLength(1);
	});
});

describe("drift is an OVERLAY, never a base state", () => {
	it("a drifted resource is still live", () => {
		const s = resolveNodeStatus(READY, server("ACTIVE", { drift: DRIFT }), CALM);
		expect(s.state).toBe("live");
		expect(s.drift).toHaveLength(1);
	});

	it("drift survives alongside a failure — it doesn't replace it, and isn't lost", () => {
		const s = resolveNodeStatus(READY, server("FAILED", { drift: DRIFT }), CALM);
		expect(s.state).toBe("failed");
		expect(s.drift).toHaveLength(1);
	});

	it("and alongside an in-flight apply", () => {
		const s = resolveNodeStatus(READY, server("CREATING", { drift: DRIFT }), CALM);
		expect(s.state).toBe("applying");
		expect(s.drift).toHaveLength(1);
	});
});

describe("every state is visually expressible", () => {
	it("has a design-system token — status reads through dot shape, never hue", () => {
		const states: NodeStatusState[] = [
			"needs-setup", "ready", "gated", "not-deployed", "queued", "applying",
			"updating", "update-pending", "live", "destroying", "destroyed",
			"failed", "unreachable",
		];
		for (const state of states) {
			const meta = NODE_STATUS_META[state];
			expect(meta, `${state} has no visual mapping`).toBeDefined();
			expect(meta.label).toBeTruthy();
			expect(
				["idle", "active", "pending", "failed", "disabled", "live"],
				`${state} maps to an unknown vx-status modifier`,
			).toContain(meta.vx);
		}
	});
});
