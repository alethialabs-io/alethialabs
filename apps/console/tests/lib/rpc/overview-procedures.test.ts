// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6118: the overview's read procedures. Tenancy (address beats session, a non-member is a 404) is
// proved for every procedure by tests/integration/rpc-tenancy.*; this file pins what each read
// RETURNS and what it does NOT do.

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The service DB stand-in. Both reads go `select().from().where()`: the seat count awaits that, the
 * deliveries read continues `.orderBy().limit()`. `limit` records what was asked for.
 */
const h = vi.hoisted(() => ({
	seats: 0,
	// The PDP's `can`, for the project grid's create decision (#6817).
	can: vi.fn<(...args: unknown[]) => Promise<{ allowed: boolean }>>(),
	deliveryRows: [] as unknown[],
	limits: [] as number[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/app/server/actions/billing", () => ({
	getOrgUsage: vi.fn(),
	getAiUsageSummary: vi.fn(),
	getCollaborationAccess: vi.fn(),
	// The overview must not read the billing page's summary: it retrieves the Stripe subscription.
	getBillingSummary: vi.fn(() => {
		throw new Error("the overview must not call getBillingSummary (a Stripe round trip)");
	}),
}));
vi.mock("@/lib/billing/queries", () => ({ getOrgBilling: vi.fn() }));
// The project grid's reads (#6817, LST-4 #7486) call the projects page builder and count, the
// connectors read, the PDP and the offered-clouds list in-process; each is replaced, so this file
// loads none of them.
vi.mock("@/lib/queries/projects", () => ({ queryProjectsPage: vi.fn(), countProjects: vi.fn() }));
vi.mock("@/lib/rpc/procedures/connectors", () => ({ readConnectedCloudProviders: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: () => ({ can: h.can }) }));
vi.mock("@/lib/cloud-providers/availability", () => ({ offeredClouds: () => ["aws", "gcp", "azure", "hetzner"] }));
vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/authz/entitlements", () => ({ getEntitlements: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ isBillingConfigured: () => true }));
vi.mock("@/lib/db", () => ({
	// The actor-scoped transaction the grid's reads run in: the builder receives this marker.
	withActorScope: (_actor: unknown, fn: (tx: unknown) => unknown) => fn("scoped-tx"),
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					then: (resolve: (v: unknown) => void) => resolve([{ n: h.seats }]),
					orderBy: () => ({
						limit: async (n: number) => {
							h.limits.push(n);
							return h.deliveryRows;
						},
					}),
				}),
			}),
		}),
	}),
}));

import { getAiUsageSummary, getCollaborationAccess, getOrgUsage } from "@/app/server/actions/billing";
import { getEntitlements } from "@/lib/authz/entitlements";
import { authorize } from "@/lib/authz/guard";
import type { Actor } from "@/lib/authz/types";
import { resolvePlanEntitlements } from "@/lib/billing/plan";
import { getOrgBilling } from "@/lib/billing/queries";
import type { OrganizationBilling } from "@/lib/db/schema";
import { money } from "@repo/format";
import { countProjects, queryProjectsPage } from "@/lib/queries/projects";
import { readConnectedCloudProviders } from "@/lib/rpc/procedures/connectors";
import {
	OVERVIEW_ALERT_ROWS,
	readOverviewAlerts,
	readOverviewProjectsPage,
	readOverviewProjectsSummary,
	readOverviewUsage,
} from "@/lib/rpc/procedures/overview";

const orgActor: Actor = { credential: "session", userId: "u1", orgId: "o1" };
const personalActor: Actor = { credential: "session", userId: "u1", orgId: "u1" };

/** A live Team billing row for o1. */
const teamRow: OrganizationBilling = {
	id: "b1",
	organizationId: "o1",
	plan: "team",
	status: "active",
	stripeCustomerId: null,
	stripeSubscriptionId: null,
	seats: null,
	currentPeriodStart: null,
	currentPeriodEnd: null,
	usageHardCap: false,
	aiTier: "ai_free",
	aiSubscriptionStatus: "none",
	aiStripeSubscriptionId: null,
	aiOrgWeeklyCapCredits: null,
	aiPerUserWeeklyCapCredits: null,
	stripeSubscriptionEventAt: null,
	aiStripeSubscriptionEventAt: null,
	billingProvider: null,
	paddleCustomerId: null,
	paddleBusinessId: null,
	paddleAddressId: null,
	paddleSubscriptionId: null,
	paddleSubscriptionEventAt: null,
	aiPaddleSubscriptionId: null,
	aiPaddleSubscriptionEventAt: null,
	cancelEffectiveAt: null,
	payerCapacity: null,
	billingCountry: null,
	authorityAttestation: null,
	vatIdStatus: null,
	vatId: null,
	billingState: null,
	welcomedAt: null,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

beforeEach(() => {
	vi.clearAllMocks();
	h.seats = 3;
	h.deliveryRows = [];
	h.limits = [];
	vi.mocked(getOrgBilling).mockResolvedValue(teamRow);
	vi.mocked(getOrgUsage).mockResolvedValue({
		usedMinutes: 12.5,
		includedMinutes: 500,
		overageMinutes: 0,
		overageCost: money(0, "usd"),
		pct: 0.025,
		approaching: false,
		overLimit: false,
		periodStart: "2026-10-03T14:00:00.000Z",
		periodEnd: "2026-11-03T14:00:00.000Z",
		plan: "team",
		hardCap: false,
		runningJobs: 2,
		maxConcurrentJobs: 8,
	});
	vi.mocked(getAiUsageSummary).mockResolvedValue({
		enabled: true,
		tier: "ai_free",
		sessionUsed: 1,
		sessionBudget: 10,
		sessionResetAt: null,
		weeklyUsed: 2,
		weeklyBudget: 50,
		weeklyResetAt: "2026-10-26T00:00:00.000Z",
		purchasedBalance: 0,
		paidTiersEnabled: false,
		orgWeeklyCapCredits: null,
		perUserWeeklyCapCredits: null,
		canManageCaps: false,
	});
	vi.mocked(getCollaborationAccess).mockResolvedValue({ canInvite: true });
});

describe("overview.usage", () => {
	it("returns the billing period's start, the plan, the seats and the invite gate", async () => {
		const out = await readOverviewUsage(orgActor);
		expect(out).toMatchObject({
			hosted: true,
			plan: "team",
			memberCount: 3,
			canInvite: true,
			runner: { usedMinutes: 12.5, includedMinutes: 500, periodStart: "2026-10-03T14:00:00.000Z" },
			concurrency: { running: 2, max: 8 },
		});
		expect(getOrgBilling).toHaveBeenCalledWith("o1");
	});

	it("counts no seats in the personal scope, which has no members", async () => {
		vi.mocked(getOrgBilling).mockResolvedValue(null);
		vi.mocked(getOrgUsage).mockResolvedValue({ ...(await getOrgUsage()), plan: "community" });
		const out = await readOverviewUsage(personalActor);
		expect(out.memberCount).toBe(0);
		expect(out.plan).toBe("community");
	});

	it("a billing-row read failure FAILS the read — it is never rendered as the community plan", async () => {
		vi.mocked(getOrgBilling).mockRejectedValue(new Error("billing row unreadable"));
		await expect(readOverviewUsage(orgActor)).rejects.toThrow("billing row unreadable");
	});

	it("fails rather than render getOrgUsage's fallback when ITS read of the row fell back", async () => {
		// The row says Team; the usage reader swallowed its own read of that row and answered with
		// the community allowance and window.
		vi.mocked(getOrgUsage).mockResolvedValue({ ...(await getOrgUsage()), plan: "community", includedMinutes: 200 });
		await expect(readOverviewUsage(orgActor)).rejects.toThrow(/fell back/);
	});
});

describe("overview.alerts", () => {
	beforeEach(() => {
		vi.mocked(authorize).mockResolvedValue(orgActor);
	});

	it("reads the newest few deliveries, behind view_alerts", async () => {
		vi.mocked(getEntitlements).mockReturnValue(resolvePlanEntitlements("team", "active"));
		h.deliveryRows = [
			{
				id: "d1",
				org_id: "o1",
				rule_id: null,
				channel_id: null,
				event_key: "job.failed",
				dedupe_key: null,
				context: { title: "Deploy failed" },
				status: "sent",
				attempts: 1,
				max_attempts: 5,
				last_error: null,
				next_attempt_at: null,
				created_at: new Date("2026-10-20T10:00:00.000Z"),
				sent_at: null,
			},
		];
		const out = await readOverviewAlerts();
		expect(authorize).toHaveBeenCalledWith("view_alerts", { type: "alert" });
		expect(h.limits).toEqual([OVERVIEW_ALERT_ROWS]);
		expect(out).toEqual({
			alerting: true,
			deliveries: [expect.objectContaining({ id: "d1", title: "Deploy failed", created_at: "2026-10-20T10:00:00.000Z" })],
		});
	});

	it("carries the plan gate as data, with no rows and no ledger read", async () => {
		vi.mocked(getEntitlements).mockReturnValue(resolvePlanEntitlements("community", "none"));
		h.deliveryRows = [{ id: "never-read" }];
		await expect(readOverviewAlerts()).resolves.toEqual({ alerting: false, deliveries: [] });
		expect(h.limits).toEqual([]);
	});

	it("lets a permission refusal through (the read router turns it into FORBIDDEN)", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("forbidden"));
		await expect(readOverviewAlerts()).rejects.toThrow("forbidden");
		expect(h.limits).toEqual([]);
	});
});

describe("readOverviewProjectsPage (#6817, LST-4 #7486)", () => {
	const PRISTINE = { q: "", clouds: [], repos: [], sort: "activity" as const };
	const PAGE = { rows: [], nextCursor: null, facets: { clouds: [], repos: [] }, universeEmpty: true };
	const CURSOR = { at: "2026-11-20T10:00:00.000Z", id: "00000000-0000-4000-8000-000000000001" };

	beforeEach(() => {
		vi.mocked(queryProjectsPage).mockReset();
		vi.mocked(queryProjectsPage).mockResolvedValue(PAGE);
		vi.mocked(authorize).mockReset();
		vi.mocked(authorize).mockResolvedValue(orgActor);
	});

	it("authorizes view on projects, then reads ONE page in the actor's scoped transaction", async () => {
		const out = await readOverviewProjectsPage({ ...PRISTINE, cursor: CURSOR, limit: 20 });
		expect(out).toBe(PAGE);
		expect(authorize).toHaveBeenCalledWith("view", { type: "project" });
		expect(queryProjectsPage).toHaveBeenCalledWith("scoped-tx", PRISTINE, { cursor: CURSOR, limit: 20 });
	});

	it("page one with no limit: no cursor, the contract's default page size, and the query untouched", async () => {
		await readOverviewProjectsPage({ ...PRISTINE, q: "shop", ids: ["00000000-0000-4000-8000-000000000002"] });
		expect(queryProjectsPage).toHaveBeenCalledWith(
			"scoped-tx",
			{ ...PRISTINE, q: "shop", ids: ["00000000-0000-4000-8000-000000000002"] },
			{ cursor: undefined, limit: 50 },
		);
	});

	it("a refused projects read refuses the page, and nothing is read", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("forbidden"));
		await expect(readOverviewProjectsPage(PRISTINE)).rejects.toThrow("forbidden");
		expect(queryProjectsPage).not.toHaveBeenCalled();
	});
});

describe("readOverviewProjectsSummary (#6817, LST-4 #7486)", () => {
	const can = h.can;

	beforeEach(() => {
		vi.mocked(countProjects).mockReset();
		vi.mocked(countProjects).mockResolvedValue(7);
		vi.mocked(readConnectedCloudProviders).mockReset();
		vi.mocked(readConnectedCloudProviders).mockResolvedValue(["aws"]);
		vi.mocked(authorize).mockReset();
		vi.mocked(authorize).mockResolvedValue(orgActor);
		can.mockReset();
		can.mockResolvedValue({ allowed: true });
	});

	it("the organization's project count, counted in the scoped transaction", async () => {
		const out = await readOverviewProjectsSummary(orgActor);
		expect(out.projectCount).toBe(7);
		expect(countProjects).toHaveBeenCalledWith("scoped-tx");
	});

	it("the connected clouds could not be read: `null`, and the summary still answers", async () => {
		vi.mocked(readConnectedCloudProviders).mockRejectedValue(new Error("boom"));
		const out = await readOverviewProjectsSummary(orgActor);
		expect(out.connectedProviders).toBeNull();
		expect(out.projectCount).toBe(7);
	});

	it("carries the offered clouds and the viewer's create decision, asked quietly of the PDP", async () => {
		can.mockResolvedValue({ allowed: false });
		const out = await readOverviewProjectsSummary(orgActor);
		expect(out.offeredClouds).toEqual(["aws", "gcp", "azure", "hetzner"]);
		expect(out.canCreate).toBe(false);
		expect(can).toHaveBeenCalledWith(orgActor, "create", { type: "project" });
	});

	it("a refused projects read refuses the summary, as it refuses the page", async () => {
		vi.mocked(authorize).mockRejectedValue(new Error("forbidden"));
		await expect(readOverviewProjectsSummary(orgActor)).rejects.toThrow("forbidden");
		expect(countProjects).not.toHaveBeenCalled();
	});
});
