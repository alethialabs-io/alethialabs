// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #7050 — the CLI team routes apply the rule the console's team endpoints apply.
//
//   · Create (`POST /api/cli/orgs/:id/teams`): the caller's membership role must hold
//     `team:create` (owners and admins), then the organization must hold the `teams` entitlement,
//     read through the enterprise module's licence-aware resolver. The entitlement cells are the
//     four of #7016 — hosted with and without the plan, self-managed licensed (no billing record)
//     and unlicensed — plus a build with no enterprise module.
//   · Delete (`DELETE /api/cli/orgs/:id/teams/:teamId`): the caller's role must hold `team:delete`.
//
// The route's PDP check (`member:manage_members`) is exercised through the real guard in
// orgs-routes-authz.test.ts; here it is stubbed to pass so each refusal below is the new rule's.
// The resolver below has the enterprise module's shape (a licence answer, else the billing read);
// the module's own resolver under a real signed licence is exercised in
// ee/src/instance-edition.test.ts. Expected values are written out by hand.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Entitlements } from "@/lib/authz/types";

/** The slice of the enterprise module the team gate reads. */
interface EnterpriseStub {
	resolveEntitlements: (orgId: string) => Promise<unknown>;
}

const h = vi.hoisted(() => {
	/** The registered enterprise module, or null for a build without one. */
	const enterprise: { current: EnterpriseStub | null } = { current: null };
	return {
		/** What each `select … limit` returns, in call order (member role, then the team row). */
		limit: vi.fn<() => Promise<unknown[]>>(),
		insertValues: vi.fn(),
		deleteWhere: vi.fn(async () => undefined),
		enterprise,
		resolveOrgEntitlements: vi.fn<(orgId: string) => Promise<unknown>>(),
	};
});

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz/guard", () => ({
	authorizeCli: async () => ({
		actor: { userId: "user-1", orgId: "org-1" },
		credential: "session",
	}),
	ensureCliOrgAccess: async () => null,
}));
vi.mock("@/lib/enterprise", () => ({ getEnterprise: () => h.enterprise.current }));
vi.mock("@/lib/billing/queries", () => ({
	resolveOrgEntitlements: h.resolveOrgEntitlements,
	getOrgBilling: vi.fn(),
}));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured: () => true }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({ from: () => ({ where: () => ({ limit: h.limit }) }) }),
		insert: () => ({
			values: (v: unknown) => {
				h.insertValues(v);
				// A real uuid: the response is checked against the CLI wire contract (`teamWire.id`).
				return {
					returning: async () => [{ id: "44444444-4444-4444-8444-444444444444", name: "Platform" }],
				};
			},
		}),
		delete: () => ({ where: h.deleteWhere }),
	}),
}));

import { DELETE } from "@/app/api/cli/orgs/[id]/teams/[teamId]/route";
import { POST } from "@/app/api/cli/orgs/[id]/teams/route";

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

/** A plan that carries teams. */
const ENTERPRISE_PLAN: Entitlements = { ...NO_PLAN, organizations: true, teams: true, sso: true };

/** Registers an enterprise module whose resolver answers from `licensed`, else the billing record. */
function registerEnterprise(licensed: Entitlements | null): void {
	h.enterprise.current = {
		resolveEntitlements: async (orgId: string) =>
			licensed ?? (await h.resolveOrgEntitlements(orgId)),
	};
}

/** The caller's active membership row holds `role`. */
function callerRole(role: string): void {
	h.limit.mockResolvedValueOnce([{ role }]);
}

/** Calls the create route the way `alethia teams create` does. */
function create(): Promise<Response> {
	return POST(
		new Request("https://console.local/api/cli/orgs/org-1/teams", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Platform" }),
		}),
		{ params: Promise.resolve({ id: "org-1" }) },
	);
}

/** Calls the delete route the way `alethia teams delete` does. */
function remove(): Promise<Response> {
	return DELETE(
		new Request("https://console.local/api/cli/orgs/org-1/teams/team-1", { method: "DELETE" }),
		{ params: Promise.resolve({ id: "org-1", teamId: "team-1" }) },
	);
}

beforeEach(() => {
	h.limit.mockReset();
	h.insertValues.mockReset();
	h.deleteWhere.mockClear();
	h.resolveOrgEntitlements.mockReset();
	h.enterprise.current = null;
});

describe("POST /api/cli/orgs/:id/teams — the teams entitlement, through the licence-aware resolver", () => {
	beforeEach(() => callerRole("owner"));

	it("hosted, plan carries teams: created", async () => {
		registerEnterprise(null);
		h.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
		const res = await create();
		expect(res.status).toBe(201);
		expect(h.resolveOrgEntitlements).toHaveBeenCalledWith("org-1");
		expect(h.insertValues).toHaveBeenCalledWith({ name: "Platform", organizationId: "org-1" });
	});

	it("hosted, no plan: refused with the console's reason, nothing written", async () => {
		registerEnterprise(null);
		h.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		const res = await create();
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "Teams require an Enterprise plan." });
		expect(h.insertValues).not.toHaveBeenCalled();
	});

	it("self-managed, licensed, no billing record: created, and the billing record is not read", async () => {
		registerEnterprise(ENTERPRISE_PLAN);
		h.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		const res = await create();
		expect(res.status).toBe(201);
		expect(h.resolveOrgEntitlements).not.toHaveBeenCalled();
	});

	it("self-managed, unlicensed, no billing record: refused", async () => {
		registerEnterprise(null);
		h.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		const res = await create();
		expect(res.status).toBe(403);
		expect(h.insertValues).not.toHaveBeenCalled();
	});

	it("no enterprise module: refused from the community baseline, the billing record unread", async () => {
		h.resolveOrgEntitlements.mockResolvedValue(ENTERPRISE_PLAN);
		const res = await create();
		expect(res.status).toBe(403);
		expect(h.resolveOrgEntitlements).not.toHaveBeenCalled();
		expect(h.insertValues).not.toHaveBeenCalled();
	});
});

describe("POST /api/cli/orgs/:id/teams — who may create a team", () => {
	beforeEach(() => {
		registerEnterprise(ENTERPRISE_PLAN);
	});

	it.each(["owner", "admin", "viewer,admin"])("%s: created", async (role) => {
		callerRole(role);
		expect((await create()).status).toBe(201);
	});

	it.each(["operator", "viewer", "member"])("%s: refused, nothing written", async (role) => {
		callerRole(role);
		const res = await create();
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Only an organization owner or admin can create teams.",
		});
		expect(h.insertValues).not.toHaveBeenCalled();
	});

	it("no active membership in the organization: refused", async () => {
		h.limit.mockResolvedValueOnce([]);
		expect((await create()).status).toBe(403);
		expect(h.insertValues).not.toHaveBeenCalled();
	});

	it("asks the role before the plan, as the console's endpoint does", async () => {
		registerEnterprise(null);
		callerRole("viewer");
		const res = await create();
		expect(await res.json()).toEqual({
			error: "Only an organization owner or admin can create teams.",
		});
		expect(h.resolveOrgEntitlements).not.toHaveBeenCalled();
	});
});

describe("DELETE /api/cli/orgs/:id/teams/:teamId — who may delete a team", () => {
	it.each(["owner", "admin"])("%s: deleted", async (role) => {
		callerRole(role);
		h.limit.mockResolvedValueOnce([{ id: "team-1" }]);
		const res = await remove();
		expect(res.status).toBe(200);
		expect(h.deleteWhere).toHaveBeenCalledTimes(1);
	});

	it.each(["operator", "viewer", "member"])("%s: refused, nothing deleted", async (role) => {
		callerRole(role);
		const res = await remove();
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({
			error: "Only an organization owner or admin can delete teams.",
		});
		expect(h.deleteWhere).not.toHaveBeenCalled();
	});

	it("is not gated on the plan: an admin deletes a team in an organization without one", async () => {
		registerEnterprise(null);
		h.resolveOrgEntitlements.mockResolvedValue(NO_PLAN);
		callerRole("admin");
		h.limit.mockResolvedValueOnce([{ id: "team-1" }]);
		expect((await remove()).status).toBe(200);
		expect(h.resolveOrgEntitlements).not.toHaveBeenCalled();
	});
});
