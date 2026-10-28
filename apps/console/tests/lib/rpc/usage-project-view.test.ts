// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127: every project-scoped usage read asks the PDP for `view` on the project — not only whether
// the project is in the addressed org — and a member without it gets FORBIDDEN with NO usage query
// run. Driven over the real route handler and oRPC wire; the PDP answer and the queries are stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const PROJECT = "33333333-3333-4333-8333-333333333333";
const ACME = { userId: "user-1", orgId: "11111111-1111-4111-8111-111111111111" };

const h = vi.hoisted(() => ({
	projectOrg: "11111111-1111-4111-8111-111111111111" as string | null,
	queries: {
		queryJobMinutesByProject: vi.fn(),
		queryJobMinutesSeriesByProject: vi.fn(),
		queryProjectResourceCounts: vi.fn(),
		queryProjectRunningJobs: vi.fn(),
		sumCreditsByProject: vi.fn(),
		aiCreditsSeriesByProject: vi.fn(),
		getOrgBilling: vi.fn(),
	},
	currentActor: vi.fn(),
	authorizeRead: vi.fn(),
}));

vi.mock("@/lib/authz/guard", () => ({
	currentActor: h.currentActor,
	authorizeRead: h.authorizeRead,
	authorizeQuiet: vi.fn(),
	authorize: vi.fn(),
}));
vi.mock("@/lib/billing/eligibility", () => ({ hasAcceptedCurrentDocuments: async () => true }));
vi.mock("@/lib/db", () => ({
	getServiceDb: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => (h.projectOrg ? [{ orgId: h.projectOrg }] : []) }),
			}),
		}),
	}),
}));
vi.mock("@/lib/queries/runner-usage", () => ({
	queryJobMinutesByOrg: vi.fn(),
	queryJobMinutesSeries: vi.fn(),
	queryJobMinutesByProject: h.queries.queryJobMinutesByProject,
	queryJobMinutesSeriesByProject: h.queries.queryJobMinutesSeriesByProject,
}));
vi.mock("@/lib/queries/usage-counts", () => ({
	queryResourceCounts: vi.fn(),
	queryRunningJobs: vi.fn(),
	queryProjectResourceCounts: h.queries.queryProjectResourceCounts,
	queryProjectRunningJobs: h.queries.queryProjectRunningJobs,
}));
vi.mock("@/lib/billing/ai-quota", () => ({
	aiCreditsSeries: vi.fn(),
	oldestUsageSince: vi.fn(),
	purchasedBalance: vi.fn(),
	sumCredits: vi.fn(),
	sumCreditsByProject: h.queries.sumCreditsByProject,
	aiCreditsSeriesByProject: h.queries.aiCreditsSeriesByProject,
}));
// A PARTIAL mock: with the enterprise module built (CI), `loadEnterprise` reads other exports of
// this module (`resolveOrgEntitlements`) on the auth path, so only the billing-row read is stubbed.
vi.mock("@/lib/billing/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/queries")>()),
	getOrgBilling: h.queries.getOrgBilling,
}));

import { GET } from "@/app/(private)/[org]/~/rpc/[[...rest]]/route";
import { ForbiddenError } from "@/lib/authz/types";

/** The four project-scoped reads, each with an input naming PROJECT. */
const READS = [
	["usage/project", { projectId: PROJECT }],
	["usage/projectResources", { projectId: PROJECT }],
	["usage/projectAi", { projectId: PROJECT }],
	["usage/projectOverTime", { projectId: PROJECT, range: { preset: "7d" } }],
] as const;

/** One GET to a read procedure at `/acme/~/rpc/<path>`, as the browser makes it. */
function get(path: string, input: unknown): Promise<Response> {
	const data = encodeURIComponent(JSON.stringify({ json: input }));
	return GET(new Request(`http://console.test/acme/~/rpc/${path}?data=${data}`));
}

beforeEach(() => {
	vi.clearAllMocks();
	h.projectOrg = ACME.orgId;
	h.currentActor.mockResolvedValue(ACME);
	h.authorizeRead.mockResolvedValue(ACME);
	h.queries.getOrgBilling.mockResolvedValue(null);
	h.queries.queryJobMinutesByProject.mockResolvedValue({ job_minutes: 0, job_count: 0 });
	h.queries.queryJobMinutesSeriesByProject.mockResolvedValue([]);
	h.queries.queryProjectResourceCounts.mockResolvedValue({ clusters: 0, estimatedMonthlyCost: 0 });
	h.queries.queryProjectRunningJobs.mockResolvedValue(0);
	h.queries.sumCreditsByProject.mockResolvedValue(0);
	h.queries.aiCreditsSeriesByProject.mockResolvedValue([]);
});

/** Whether any usage query ran. */
const anyQueryRan = () => Object.values(h.queries).some((q) => q.mock.calls.length > 0);

describe("usage.project* and the project's `view` permission", () => {
	it.each(READS)("%s: a member WITHOUT view on the project is FORBIDDEN, and no usage query runs", async (path, input) => {
		h.authorizeRead.mockRejectedValue(new ForbiddenError("view", { type: "project", id: PROJECT }));
		const res = await get(path, input);
		expect(res.status).toBe(403);
		expect(h.authorizeRead).toHaveBeenCalledWith("view", { type: "project", id: PROJECT });
		expect(anyQueryRan()).toBe(false);
	});

	it.each(READS)("%s: a member WITH view is answered (the control for the refusal above)", async (path, input) => {
		const res = await get(path, input);
		expect(res.status).toBe(200);
		expect(anyQueryRan()).toBe(true);
	});

	it.each(READS)("%s: a project of ANOTHER org is NOT_FOUND before the PDP is asked", async (path, input) => {
		h.projectOrg = "99999999-9999-4999-8999-999999999999";
		const res = await get(path, input);
		expect(res.status).toBe(404);
		expect(h.authorizeRead).not.toHaveBeenCalled();
		expect(anyQueryRan()).toBe(false);
	});
});
