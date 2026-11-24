// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The agent policy write's input and its Activity wording (AGT-L2, G7).

import { describe, expect, it } from "vitest";
import { agentPolicyPatchSchema, APPROVAL_TTL_PRESETS, describePolicyPatch } from "@/lib/agents/policy";

describe("agentPolicyPatchSchema", () => {
	it("accepts a change to one core toggle", () => {
		expect(agentPolicyPatchSchema.safeParse({ agentAccessEnabled: false }).success).toBe(true);
		expect(agentPolicyPatchSchema.safeParse({ agentsMayNotApplyToProduction: true }).success).toBe(true);
	});

	it.each(APPROVAL_TTL_PRESETS)("accepts the %i-minute preset", (minutes) => {
		expect(agentPolicyPatchSchema.safeParse({ approvalTtlMinutes: minutes }).success).toBe(true);
	});

	it("refuses a duration that is not a preset", () => {
		expect(agentPolicyPatchSchema.safeParse({ approvalTtlMinutes: 45 }).success).toBe(false);
		expect(agentPolicyPatchSchema.safeParse({ approvalTtlMinutes: 5000 }).success).toBe(false);
	});

	it("refuses an empty change", () => {
		expect(agentPolicyPatchSchema.safeParse({}).success).toBe(false);
	});

	it("drops the Enterprise toggles: they are not written from here", () => {
		const parsed = agentPolicyPatchSchema.safeParse({ agentAccessEnabled: true, requireDifferentApprover: true, allowedOauthClientIds: [] });
		expect(parsed.success && parsed.data).toEqual({ agentAccessEnabled: true });
	});
});

describe("describePolicyPatch", () => {
	it("says what changed in plain words", () => {
		expect(describePolicyPatch({ agentAccessEnabled: false, approvalTtlMinutes: 15 })).toBe(
			"agent access off; requests stay open 15 min",
		);
		expect(describePolicyPatch({ agentsMayNotApplyToProduction: true })).toBe("agents kept off production");
	});
});
