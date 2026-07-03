// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from "vitest";
import {
	COMMUNITY_ENTITLEMENTS,
	isBillingActive,
	planEntitlements,
	resolvePlanEntitlements,
} from "@/lib/billing/plan";

describe("planEntitlements", () => {
	it("community is single-tenant with every paid feature off", () => {
		const e = planEntitlements("community");
		expect(e.organizations).toBe(false);
		expect(e.teams).toBe(false);
		expect(e.sso).toBe(false);
		expect(e.quotas.maxConcurrentJobs).toBe(2);
		expect(e.quotas.includedRunnerMinutes).toBe(200);
		expect(e.ai.weeklyCredits).toBe(100);
	});

	it("team unlocks organizations + raises quotas", () => {
		const e = planEntitlements("team");
		expect(e.organizations).toBe(true);
		expect(e.teams).toBe(false); // teams is enterprise-only
		expect(e.quotas.maxConcurrentJobs).toBe(8);
		expect(e.quotas.includedRunnerMinutes).toBe(500);
		expect(e.ai.weeklyCredits).toBe(3_000);
	});

	it("enterprise unlocks governance features + unlimited concurrency", () => {
		const e = planEntitlements("enterprise");
		expect(e.organizations).toBe(true);
		expect(e.teams).toBe(true);
		expect(e.customRoles).toBe(true);
		expect(e.activityExport).toBe(true);
		expect(e.sso).toBe(true);
		expect(e.quotas.maxConcurrentJobs).toBeNull(); // unlimited
		expect(e.quotas.includedRunnerMinutes).toBe(20_000);
		expect(e.ai.weeklyCredits).toBe(60_000);
	});

	it("entitlements grow monotonically up the ladder", () => {
		const c = planEntitlements("community");
		const t = planEntitlements("team");
		expect(t.quotas.includedRunnerMinutes).toBeGreaterThan(
			c.quotas.includedRunnerMinutes,
		);
		expect(t.ai.weeklyCredits).toBeGreaterThan(c.ai.weeklyCredits);
	});
});

describe("isBillingActive", () => {
	it("is true only while the subscription is live", () => {
		expect(isBillingActive("active")).toBe(true);
		expect(isBillingActive("trialing")).toBe(true);
	});

	it("is false for every non-live status", () => {
		for (const s of ["none", "past_due", "canceled"] as const) {
			expect(isBillingActive(s)).toBe(false);
		}
	});
});

describe("resolvePlanEntitlements", () => {
	it("grants the plan's entitlements while the subscription is live", () => {
		expect(resolvePlanEntitlements("team", "active")).toEqual(
			planEntitlements("team"),
		);
		expect(resolvePlanEntitlements("enterprise", "trialing")).toEqual(
			planEntitlements("enterprise"),
		);
	});

	it("falls back to the community baseline when not live", () => {
		expect(resolvePlanEntitlements("team", "canceled")).toEqual(
			COMMUNITY_ENTITLEMENTS,
		);
		expect(resolvePlanEntitlements("enterprise", "past_due")).toEqual(
			COMMUNITY_ENTITLEMENTS,
		);
		expect(resolvePlanEntitlements("team", "none")).toEqual(
			COMMUNITY_ENTITLEMENTS,
		);
	});
});
