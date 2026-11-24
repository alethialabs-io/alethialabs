// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7016 — the team-creation gate reads the entitlements it is handed.
//
// `canOrgCreateTeams(orgId)` answers from the organization's billing record: that is the hosted
// path, and its answer is the same as before the resolver became a parameter.
// `canOrgCreateTeams(orgId, resolve)` answers from `resolve`, which the enterprise module supplies:
// the instance licence when one grants, the billing record otherwise. The four cells below are
// hosted with a plan, hosted without, self-managed under a licence with no billing record, and
// self-managed with no licence.
//
// The resolver here is a stand-in with the enterprise module's shape — a licence answer, else the
// billing read. The module's own resolver, under a real signed licence and mounted in a real auth
// instance, is exercised in ee/src/instance-edition.test.ts.
//
// Expected values are written out by hand.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entitlements } from "@/lib/authz/types";

/** What the mocked billing module answers in the case under test. */
const billing = vi.hoisted(() => ({
	resolveOrgEntitlements: vi.fn<(orgId: string) => Promise<unknown>>(),
	getOrgBilling: vi.fn<(orgId: string) => Promise<unknown>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/billing/queries", () => ({
	resolveOrgEntitlements: billing.resolveOrgEntitlements,
	getOrgBilling: billing.getOrgBilling,
}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => true }));

import { canOrgCreateTeams } from "@/lib/billing/collaboration";

const ORG = "22222222-2222-4222-8222-222222222222";

/** Every switch off: what an organization with no billing record resolves to. */
const NO_PLAN: Entitlements = {
	organizations: false,
	teams: false,
	sso: false,
	customRoles: false,
	activityExport: false,
	alerting: false,
	advancedAlerting: false,
	byoRunners: false,
	managedPools: false,
	agentPolicy: false,
	quotas: {
		maxConcurrentJobs: 2,
		priorityLevel: 0,
		includedRunnerMinutes: 200,
		activityRetentionDays: 7,
	},
};

/** The enterprise plan's switches. */
const ENTERPRISE_PLAN: Entitlements = {
	...NO_PLAN,
	organizations: true,
	teams: true,
	sso: true,
	customRoles: true,
	activityExport: true,
	alerting: true,
	advancedAlerting: true,
	byoRunners: true,
	managedPools: true,
	agentPolicy: true,
};

/** A paid plan that does not carry teams. */
const TEAM_PLAN: Entitlements = { ...NO_PLAN, organizations: true, alerting: true, byoRunners: true };

/**
 * A resolver with the enterprise module's shape: what the instance licence grants when it grants,
 * and the organization's billing record otherwise.
 */
function licenseAwareResolver(licensed: Entitlements | null) {
	return async (orgId: string): Promise<Entitlements> => {
		if (licensed !== null) return licensed;
		const fromBilling: unknown = await billing.resolveOrgEntitlements(orgId);
		return isEntitlements(fromBilling) ? fromBilling : NO_PLAN;
	};
}

/** Whether an unknown value carries the `teams` switch, which is all these cases read. */
function isEntitlements(value: unknown): value is Entitlements {
	return typeof value === "object" && value !== null && "teams" in value;
}

beforeEach(() => {
	billing.resolveOrgEntitlements.mockReset();
	billing.getOrgBilling.mockReset();
});

describe("canOrgCreateTeams — from the billing record (the default)", () => {
	it("allows an organization whose plan carries teams", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
		expect(await canOrgCreateTeams(ORG)).toBe(true);
		expect(billing.resolveOrgEntitlements).toHaveBeenCalledWith(ORG);
	});

	it("refuses an organization with no billing record", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		expect(await canOrgCreateTeams(ORG)).toBe(false);
	});

	it("refuses an organization on a paid plan that does not carry teams", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(TEAM_PLAN);
		expect(await canOrgCreateTeams(ORG)).toBe(false);
	});

	it("does not answer when the billing record cannot be read", async () => {
		billing.resolveOrgEntitlements.mockRejectedValue(new Error("billing read failed"));
		await expect(canOrgCreateTeams(ORG)).rejects.toThrow("billing read failed");
	});
});

describe("canOrgCreateTeams — from the resolver the enterprise module passes", () => {
	it("hosted, plan carries teams: allowed, from the billing record", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
		expect(await canOrgCreateTeams(ORG, licenseAwareResolver(null))).toBe(true);
		expect(billing.resolveOrgEntitlements).toHaveBeenCalledTimes(1);
	});

	it("hosted, no plan: refused", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		expect(await canOrgCreateTeams(ORG, licenseAwareResolver(null))).toBe(false);
	});

	it("self-managed, licensed, no billing record: allowed, and the billing record is not read", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		expect(await canOrgCreateTeams(ORG, licenseAwareResolver(ENTERPRISE_PLAN))).toBe(true);
		expect(billing.resolveOrgEntitlements).not.toHaveBeenCalled();
	});

	it("self-managed, unlicensed, no billing record: refused", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		expect(await canOrgCreateTeams(ORG, licenseAwareResolver(null))).toBe(false);
	});

	it("a licence that does not name teams: refused, whatever the billing record says", async () => {
		billing.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
		expect(await canOrgCreateTeams(ORG, licenseAwareResolver(TEAM_PLAN))).toBe(false);
		expect(billing.resolveOrgEntitlements).not.toHaveBeenCalled();
	});

	it("asks the resolver for the organization it was given", async () => {
		const resolve = vi.fn(async () => ENTERPRISE_PLAN);
		await canOrgCreateTeams(ORG, resolve);
		expect(resolve).toHaveBeenCalledWith(ORG);
	});

	it("refuses when the `teams` switch is anything other than the boolean true", async () => {
		const answers: unknown[] = ["true", 1, {}, null];
		const allowed: unknown[] = [];
		for (const teams of answers) {
			const odd: unknown = { ...NO_PLAN, teams };
			if (!isEntitlements(odd)) throw new Error("the fixture lost its `teams` member");
			if (await canOrgCreateTeams(ORG, async () => odd)) allowed.push(teams);
		}
		expect(allowed).toEqual([]);
	});

	it("does not answer when the resolver fails", async () => {
		const resolve = async (): Promise<Entitlements> => {
			throw new Error("licence state unreadable");
		};
		await expect(canOrgCreateTeams(ORG, resolve)).rejects.toThrow("licence state unreadable");
	});
});
