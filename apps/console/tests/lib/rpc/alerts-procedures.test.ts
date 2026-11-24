// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Alerts hub's settings read (#6125, moved from the `getAlertsBootstrap` server action): what it
// asks the PDP, what it answers below the plan gate, and that a reader without `view_alerts` is a
// typed FORBIDDEN on the wire — the refusal the hub renders as its own state, distinct from an error.
// The list readers' tenancy contract is tests/actions/list-page-reads.test.ts; their org binding
// across the router is the tenancy suite (tests/integration/rpc-tenancy.shared.ts).

import { createRouterClient, ORPCError } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorize: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getPdp: vi.fn() }));
vi.mock("@/lib/crypto/secrets", () => ({ isCredEncryptionConfigured: vi.fn(() => false) }));
vi.mock("@/app/server/actions/projects", () => ({ getProjects: vi.fn() }));
vi.mock("@/lib/queries/alerts-lists", () => ({
	queryAlertChannelsPage: vi.fn(),
	queryAlertPoliciesPage: vi.fn(),
	queryAlertDeliveriesPage: vi.fn(),
}));

import { getProjects } from "@/app/server/actions/projects";
import { CATEGORIES } from "@/lib/alerts/catalog";
import { getPdp } from "@/lib/authz";
import { authorize } from "@/lib/authz/guard";
import { ForbiddenError } from "@/lib/authz/types";
import { queryAlertDeliveriesPage } from "@/lib/queries/alerts-lists";
import { encodeKeysetCursor } from "@/lib/queries/keyset";
import { alertsRouter, readAlertsSettings } from "@/lib/rpc/procedures/alerts";

const can = vi.fn();

/** The actor the mocked guard resolves, with the plan's alerting entitlements. */
function actor(alerting: boolean, advancedAlerting = false) {
	return { orgId: "org-1", userId: "user-1", entitlements: { alerting, advancedAlerting } };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getPdp).mockReturnValue({ can } as never);
	can.mockResolvedValue({ allowed: true });
	vi.mocked(getProjects).mockResolvedValue([{ id: "p-1", project_name: "payments" }] as never);
});

describe("alerts.settings", () => {
	it("asks for view_alerts, probes manage_alerts with can(), and lists the org's projects", async () => {
		vi.mocked(authorize).mockResolvedValue(actor(true, true) as never);
		const settings = await readAlertsSettings();
		expect(authorize).toHaveBeenCalledWith("view_alerts", { type: "alert" });
		expect(can).toHaveBeenCalledWith(expect.anything(), "manage_alerts", { type: "alert" });
		expect(settings).toMatchObject({
			alerting: true,
			advancedAlerting: true,
			canManage: true,
			encryptionConfigured: false,
			categories: CATEGORIES,
		});
		expect(settings.conditionOptions.projects).toEqual([{ value: "p-1", label: "payments" }]);
		expect(settings.conditionOptions.jobTypes.length).toBeGreaterThan(0);
	});

	it("a non-manager gets canManage=false — the probe answers, it does not refuse", async () => {
		vi.mocked(authorize).mockResolvedValue(actor(true) as never);
		can.mockResolvedValue({ allowed: false, reason: "no_grant" });
		expect((await readAlertsSettings()).canManage).toBe(false);
	});

	it("below the plan gate it is data, not a refusal — and it reads no projects for an editor nobody sees", async () => {
		vi.mocked(authorize).mockResolvedValue(actor(false) as never);
		const settings = await readAlertsSettings();
		expect(settings.alerting).toBe(false);
		expect(settings.conditionOptions).toEqual({ projects: [], jobTypes: [], resourceTypes: [], actions: [] });
		expect(getProjects).not.toHaveBeenCalled();
	});

	it("a project list that fails to load leaves the options empty, not the hub broken", async () => {
		vi.mocked(authorize).mockResolvedValue(actor(true) as never);
		vi.mocked(getProjects).mockRejectedValue(new Error("db down"));
		expect((await readAlertsSettings()).conditionOptions.projects).toEqual([]);
	});

	it("a reader without view_alerts is FORBIDDEN on the wire", async () => {
		vi.mocked(authorize).mockRejectedValue(new ForbiddenError("view_alerts", { type: "alert" }));
		const client = createRouterClient(alertsRouter, { context: { actor: { credential: "session", userId: "u", orgId: "o" } } });
		const failure = await client.settings().catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(ORPCError);
		if (failure instanceof ORPCError) expect(failure.code).toBe("FORBIDDEN");
	});
});

// The delivery ledger pages by keyset (#7489): the procedure's input is the filter plus the shared
// paging fields (`keysetPageInput()`), split apart before the builder sees them.
describe("alerts.deliveries — the keyset paging contract at the boundary", () => {
	const client = () =>
		createRouterClient(alertsRouter, { context: { actor: { credential: "session", userId: "u", orgId: "o" } } });
	const PAGE = { rows: [], nextCursor: null, facets: null, universeEmpty: null };

	beforeEach(() => {
		vi.mocked(authorize).mockResolvedValue(actor(true) as never);
		vi.mocked(queryAlertDeliveriesPage).mockResolvedValue(PAGE as never);
	});

	it("page one: the filter alone reaches the builder, with no cursor and the default limit of 50", async () => {
		await client().deliveries({ status: ["failed"] });
		expect(queryAlertDeliveriesPage).toHaveBeenCalledWith("org-1", { status: ["failed"] }, { cursor: undefined, limit: 50 });
	});

	it("a later page: the opaque cursor is DECODED at the boundary and handed over as a position", async () => {
		const id = "11111111-1111-4111-8111-111111111111";
		const cursor = encodeKeysetCursor({ at: "2026-11-20T10:00:00.123456Z", id });
		await client().deliveries({ search: "build", cursor, limit: 25 });
		expect(queryAlertDeliveriesPage).toHaveBeenCalledWith(
			"org-1",
			{ search: "build" },
			{ cursor: { at: "2026-11-20T10:00:00.123Z", id }, limit: 25 },
		);
	});

	it("a malformed cursor is BAD_REQUEST — never a silent restart at page one", async () => {
		await expect(client().deliveries({ cursor: "not-a-cursor" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(queryAlertDeliveriesPage).not.toHaveBeenCalled();
	});

	it("a limit above 100 is refused, not clamped — the old 200-row ask is gone", async () => {
		await expect(client().deliveries({ limit: 200 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(queryAlertDeliveriesPage).not.toHaveBeenCalled();
	});
});
