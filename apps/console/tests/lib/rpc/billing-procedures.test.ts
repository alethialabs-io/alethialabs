// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6127: the billing and usage read procedures over the REAL route handler and oRPC wire. Pins the
// refusals a page renders distinctly from empty and from error (RUBRIC B4): a member without the
// billing permission is FORBIDDEN; a hosted-only read on a deployment with no Stripe is
// ENTITLEMENT_REQUIRED (the edition gate); an org-only read in the personal scope is
// ENTITLEMENT_REQUIRED (ADR 0005 §7 Q2) — and the AI price list is refused to an anonymous caller
// before Stripe is asked (#5219), which the deleted `getLiveAiPrices` action used to guarantee.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { currentActor, authorize, authorizeQuiet, authorizeRead, isStripeConfigured, getAllAiPrices, getOrgBilling, paidSalesOpen } =
	vi.hoisted(() => ({
		paidSalesOpen: vi.fn(() => false),
		currentActor: vi.fn(),
		authorize: vi.fn(),
		authorizeQuiet: vi.fn(),
		authorizeRead: vi.fn(),
		isStripeConfigured: vi.fn(() => false),
		getAllAiPrices: vi.fn(),
		getOrgBilling: vi.fn(),
	}));
vi.mock("@/lib/authz/guard", () => ({ currentActor, authorize, authorizeQuiet, authorizeRead }));
vi.mock("@/lib/billing/eligibility", () => ({ hasAcceptedCurrentDocuments: async () => true, paidSalesOpen }));
vi.mock("@/lib/billing/config", () => ({ isStripeConfigured, aiPaidTiersEnabled: () => false }));
vi.mock("@/lib/billing/pricing", () => ({ getAllAiPrices, getPlanPrice: vi.fn() }));
// A PARTIAL mock: with the enterprise module built (CI), `loadEnterprise` reads other exports of
// this module (`resolveOrgEntitlements`) on the auth path, so only the billing-row read is stubbed.
vi.mock("@/lib/billing/queries", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/billing/queries")>()),
	getOrgBilling,
}));
vi.mock("@/lib/queries/usage-counts", () => ({
	queryResourceCounts: vi.fn(),
	queryRunningJobs: vi.fn(),
	queryProjectResourceCounts: vi.fn(),
	queryProjectRunningJobs: vi.fn(),
}));

import { GET } from "@/app/(private)/[org]/~/rpc/[[...rest]]/route";
import { UnauthorizedError } from "@/lib/auth/errors";
import { ForbiddenError } from "@/lib/authz/types";
import { queryResourceCounts } from "@/lib/queries/usage-counts";

const ACME = { userId: "user-1", orgId: "org-acme" };
const PERSONAL = { userId: "user-1", orgId: "user-1" };

/** One GET to a read procedure at `/acme/~/rpc/<path>`, as the browser makes it. */
function get(path: string, base = "acme"): Promise<Response> {
	return GET(new Request(`http://console.test/${base}/~/rpc/${path}`));
}

/** The typed error code in a refused response's body. */
async function codeOf(res: Response): Promise<unknown> {
	const body: unknown = await res.json();
	if (typeof body !== "object" || body === null || !("json" in body)) return undefined;
	const json: unknown = body.json;
	return typeof json === "object" && json !== null && "code" in json ? json.code : undefined;
}

beforeEach(() => {
	vi.clearAllMocks();
	isStripeConfigured.mockReturnValue(false);
	paidSalesOpen.mockReturnValue(false);
	currentActor.mockResolvedValue(ACME);
	authorize.mockResolvedValue(ACME);
	authorizeQuiet.mockResolvedValue(ACME);
	authorizeRead.mockResolvedValue(ACME);
});

describe("billing.liveAiPrices", () => {
	it("refuses an anonymous caller without asking Stripe (#5219)", async () => {
		currentActor.mockRejectedValue(new UnauthorizedError());
		const res = await get("billing/liveAiPrices");
		expect(res.status).toBe(401);
		expect(getAllAiPrices).not.toHaveBeenCalled();
	});

	it("answers a member with the price list", async () => {
		getAllAiPrices.mockResolvedValue({ ai_free: { amounts: {}, currency: "usd", interval: "month", label: "Free" } });
		const res = await get("billing/liveAiPrices");
		expect(res.status).toBe(200);
		expect(getAllAiPrices).toHaveBeenCalledTimes(1);
	});
});

// #6132 (F030): the upgrade sheet's first question. Signed-in only, like every read; the answer is
// the eligibility module's, so the sheet and the gate read the market through one function.
describe("billing.salesOpen", () => {
	it("refuses an anonymous caller without answering", async () => {
		currentActor.mockRejectedValue(new UnauthorizedError());
		const res = await get("billing/salesOpen");
		expect(res.status).toBe(401);
		expect(paidSalesOpen).not.toHaveBeenCalled();
	});

	it.each([false, true])("answers a member with { open: %s } from paidSalesOpen", async (open) => {
		paidSalesOpen.mockReturnValue(open);
		const res = await get("billing/salesOpen");
		expect(res.status).toBe(200);
		const body: unknown = await res.json();
		expect(body).toMatchObject({ json: { open } });
	});
});

describe("the billing-admin reads", () => {
	it.each(["billing/paymentMethods", "billing/transactions", "billing/planHistory", "billing/invoices"])(
		"%s refuses a member without the billing permission as FORBIDDEN",
		async (path) => {
			authorizeRead.mockRejectedValue(new ForbiddenError("manage_billing", { type: "billing" }));
			const res = await get(path === "billing/invoices" ? `${path}?data=${encodeURIComponent(JSON.stringify({ json: {} }))}` : path);
			expect(res.status).toBe(403);
			expect(await codeOf(res)).toBe("FORBIDDEN");
			expect(getOrgBilling).not.toHaveBeenCalled();
		},
	);

	// A read refetched on every live hint must not write an activity row each time it is ALLOWED, but
	// a DENIED attempt stays on the record: `authorizeRead` (tests/lib/authz/authorize-read.test.ts
	// pins both halves). Here: the billing-admin reads go through it, never through the always-
	// recording `authorize` nor the never-recording `authorizeQuiet`.
	it.each(["billing/paymentMethods", "billing/transactions", "billing/planHistory"])(
		"%s checks the permission through authorizeRead (quiet on allow, recorded on deny)",
		async (path) => {
			await get(path);
			expect(authorizeRead).toHaveBeenCalledWith("manage_billing", { type: "billing" });
			expect(authorize).not.toHaveBeenCalled();
			expect(authorizeQuiet).not.toHaveBeenCalled();
		},
	);

	it.each(["billing/paymentMethods", "billing/transactions", "billing/planHistory"])(
		"%s is plan-gated (ENTITLEMENT_REQUIRED) on a deployment with no hosted billing — never a 500",
		async (path) => {
			const res = await get(path);
			expect(res.status).toBe(402);
			expect(await codeOf(res)).toBe("ENTITLEMENT_REQUIRED");
		},
	);

	it("billing/invoices refuses a filter that is not an invoice status", async () => {
		const input = encodeURIComponent(JSON.stringify({ json: { status: ["owed"] } }));
		const res = await get(`billing/invoices?data=${input}`);
		expect(res.status).toBe(400);
	});
});

describe("the usage reads", () => {
	it.each(["usage/resources", "usage/overTime"])(
		"%s refuses the personal scope as plan-gated rather than answering zeros",
		async (path) => {
			currentActor.mockResolvedValue(PERSONAL);
			const input = encodeURIComponent(JSON.stringify({ json: { range: { preset: "7d" } } }));
			const res = await get(path === "usage/overTime" ? `${path}?data=${input}` : path, "~");
			expect(res.status).toBe(402);
			expect(await codeOf(res)).toBe("ENTITLEMENT_REQUIRED");
			expect(queryResourceCounts).not.toHaveBeenCalled();
		},
	);

	it("usage/overTime refuses an unknown preset", async () => {
		const input = encodeURIComponent(JSON.stringify({ json: { range: { preset: "forever" } } }));
		const res = await get(`usage/overTime?data=${input}`);
		expect(res.status).toBe(400);
	});

	it("usage/project refuses an input that is not a project id", async () => {
		const input = encodeURIComponent(JSON.stringify({ json: { projectId: "not-a-uuid" } }));
		const res = await get(`usage/project?data=${input}`);
		expect(res.status).toBe(400);
	});
});
