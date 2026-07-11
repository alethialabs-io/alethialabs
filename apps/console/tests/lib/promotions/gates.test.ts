// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	applyClassificationEnforcement,
	type EnforcingValue,
	evaluateGates,
	type GateContext,
	type PromotionRules,
} from "@/lib/promotions/gates";
import type { ApproverSpec } from "@/types/jsonb.types";

const OFF: PromotionRules = {
	require_predecessor: false,
	require_verify_pass: false,
	require_approval: false,
	soak_minutes: null,
	cost_delta_threshold: null,
};

const NOW = 1_800_000_000_000;

function ctx(overrides: Partial<GateContext> = {}): GateContext {
	return {
		rules: OFF,
		candidateHash: "abc",
		predecessor: null,
		verifyUnwaivedHardFailures: null,
		costDelta: null,
		approvals: { approved: 0, required: 0 },
		nowMs: NOW,
		...overrides,
	};
}

describe("evaluateGates — all off", () => {
	it("passes with every rule skipped", () => {
		const e = evaluateGates(ctx());
		expect(e.overall).toBe("pass");
		expect(e.results.every((r) => r.status === "skipped")).toBe(true);
	});
});

describe("predecessor_healthy", () => {
	it("fails when the predecessor hasn't deployed this design", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, require_predecessor: true },
				candidateHash: "want",
				predecessor: { exists: true, deployedHash: "other", inSync: true, lastDeployedAt: new Date(NOW) },
			}),
		);
		expect(e.overall).toBe("blocked");
	});
	it("fails when the predecessor has drifted", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, require_predecessor: true },
				candidateHash: "want",
				predecessor: { exists: true, deployedHash: "want", inSync: false, lastDeployedAt: new Date(NOW) },
			}),
		);
		expect(e.overall).toBe("blocked");
	});
	it("passes when the predecessor deployed this design and is in sync", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, require_predecessor: true },
				candidateHash: "want",
				predecessor: { exists: true, deployedHash: "want", inSync: true, lastDeployedAt: new Date(NOW) },
			}),
		);
		expect(e.overall).toBe("pass");
	});
});

describe("verify_pass", () => {
	it("is pending until a report is available", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, require_verify_pass: true }, verifyUnwaivedHardFailures: null }));
		expect(e.overall).toBe("pending_approval");
	});
	it("blocks on unwaived hard failures", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, require_verify_pass: true }, verifyUnwaivedHardFailures: 2 }));
		expect(e.overall).toBe("blocked");
	});
	it("passes with zero unwaived hard failures", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, require_verify_pass: true }, verifyUnwaivedHardFailures: 0 }));
		expect(e.overall).toBe("pass");
	});
});

describe("soak_timer", () => {
	it("is pending before the soak elapses", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, soak_minutes: 30 },
				predecessor: { exists: true, deployedHash: "x", inSync: true, lastDeployedAt: new Date(NOW - 10 * 60_000) },
			}),
		);
		expect(e.overall).toBe("pending_approval");
	});
	it("passes after the soak elapses", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, soak_minutes: 30 },
				predecessor: { exists: true, deployedHash: "x", inSync: true, lastDeployedAt: new Date(NOW - 45 * 60_000) },
			}),
		);
		expect(e.overall).toBe("pass");
	});
});

describe("cost_delta", () => {
	it("requires approval when the delta exceeds the threshold", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, cost_delta_threshold: 100 }, costDelta: 250 }));
		expect(e.overall).toBe("pending_approval");
	});
	it("passes within the threshold", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, cost_delta_threshold: 100 }, costDelta: 40 }));
		expect(e.overall).toBe("pass");
	});
	it("skips when no prior cost is known", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, cost_delta_threshold: 100 }, costDelta: null }));
		const cost = e.results.find((r) => r.type === "cost_delta");
		expect(cost?.status).toBe("skipped");
		expect(e.overall).toBe("pass");
	});
});

describe("manual_approval", () => {
	it("is pending until approvals are met", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, require_approval: true }, approvals: { approved: 0, required: 2 } }));
		expect(e.overall).toBe("pending_approval");
	});
	it("passes once approvals are met", () => {
		const e = evaluateGates(ctx({ rules: { ...OFF, require_approval: true }, approvals: { approved: 2, required: 2 } }));
		expect(e.overall).toBe("pass");
	});
});

describe("overall precedence", () => {
	it("blocks even if another gate is only pending", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, require_verify_pass: true, require_approval: true },
				verifyUnwaivedHardFailures: 1, // fail
				approvals: { approved: 0, required: 1 }, // pending
			}),
		);
		expect(e.overall).toBe("blocked");
	});
});

// ── Classification-driven enforcement (label drives policy) ──────────────────────────

/** A classification value carrying an enforcement policy. */
function enforcing(
	label: string,
	e: Partial<EnforcingValue["enforcement"]> = {},
): EnforcingValue {
	return {
		value_label: label,
		dimension_label: "Environment",
		enforcement: {
			require_approval: false,
			require_verify_pass: false,
			min_approvals: 1,
			...e,
		},
	};
}

describe("applyClassificationEnforcement", () => {
	it("is a no-op with no enforcing values", () => {
		const { rules, minApprovals, reasons } = applyClassificationEnforcement(OFF, null, []);
		expect(rules).toEqual(OFF);
		expect(minApprovals).toBe(0);
		expect(reasons).toEqual({});
	});

	it("turns approval on and records the driving label", () => {
		const { rules, minApprovals, reasons } = applyClassificationEnforcement(
			OFF,
			null,
			[enforcing("production", { require_approval: true, min_approvals: 2 })],
		);
		expect(rules.require_approval).toBe(true);
		expect(rules.require_verify_pass).toBe(false);
		expect(minApprovals).toBe(2);
		expect(reasons.manual_approval).toEqual(["production"]);
	});

	it("turns verify on and records the driving label", () => {
		const { rules, reasons } = applyClassificationEnforcement(OFF, null, [
			enforcing("restricted", { require_verify_pass: true }),
		]);
		expect(rules.require_verify_pass).toBe(true);
		expect(reasons.verify_pass).toEqual(["restricted"]);
	});

	it("takes the strictest approval count across the spec and every value", () => {
		const spec: ApproverSpec = { user_ids: [], role: null, min_count: 3 };
		const { minApprovals } = applyClassificationEnforcement(
			{ ...OFF, require_approval: true },
			spec,
			[
				enforcing("production", { require_approval: true, min_approvals: 2 }),
				enforcing("regulated", { require_approval: true, min_approvals: 5 }),
			],
		);
		expect(minApprovals).toBe(5);
	});

	it("keeps an already-on gate on and never lowers the count", () => {
		const { rules, minApprovals } = applyClassificationEnforcement(
			{ ...OFF, require_verify_pass: true },
			null,
			[enforcing("production", { require_approval: true, min_approvals: 1 })],
		);
		expect(rules.require_verify_pass).toBe(true);
		expect(rules.require_approval).toBe(true);
		expect(minApprovals).toBe(1);
	});
});

describe("evaluateGates — classification annotations", () => {
	it("parks for approval solely because a classification forced it, with the why in the detail", () => {
		const { rules, minApprovals, reasons } = applyClassificationEnforcement(
			OFF,
			null,
			[enforcing("production", { require_approval: true, min_approvals: 2 })],
		);
		const e = evaluateGates(
			ctx({
				rules,
				approvals: { approved: 0, required: minApprovals },
				enforcedReasons: reasons,
			}),
		);
		expect(e.overall).toBe("pending_approval");
		const approval = e.results.find((r) => r.type === "manual_approval");
		expect(approval?.status).toBe("pending");
		expect(approval?.detail).toContain("classified production");
	});

	it("annotates the verify detail when classification forced it", () => {
		const { rules, reasons } = applyClassificationEnforcement(OFF, null, [
			enforcing("production", { require_verify_pass: true }),
		]);
		const e = evaluateGates(
			ctx({ rules, verifyUnwaivedHardFailures: 0, enforcedReasons: reasons }),
		);
		const verify = e.results.find((r) => r.type === "verify_pass");
		expect(verify?.status).toBe("pass");
		expect(verify?.detail).toContain("classified production");
	});

	it("leaves details unannotated when nothing forced the gate", () => {
		const e = evaluateGates(
			ctx({
				rules: { ...OFF, require_approval: true },
				approvals: { approved: 0, required: 1 },
			}),
		);
		const approval = e.results.find((r) => r.type === "manual_approval");
		expect(approval?.detail).not.toContain("classified");
	});
});
