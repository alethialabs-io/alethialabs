// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	evaluateGates,
	type GateContext,
	type PromotionRules,
} from "@/lib/promotions/gates";

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
