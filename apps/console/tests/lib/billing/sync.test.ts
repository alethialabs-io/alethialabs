// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from "vitest";

// mapStatus is pure, but sync.ts pulls in the DB/Stripe write path at import time — stub
// those so the unit test stays I/O-free (their behavior is covered by integration tests).
vi.mock("@/lib/billing/credit-grants", () => ({ ensureIncludedCredit: vi.fn() }));
vi.mock("@/lib/billing/queries", () => ({ upsertOrgBilling: vi.fn() }));
vi.mock("@/lib/billing/config", () => ({ planForPriceId: vi.fn() }));

import { mapStatus } from "@/lib/billing/sync";

describe("mapStatus", () => {
	it("maps live statuses through unchanged", () => {
		expect(mapStatus("active")).toBe("active");
		expect(mapStatus("trialing")).toBe("trialing");
	});

	it("collapses dunning statuses to past_due", () => {
		expect(mapStatus("past_due")).toBe("past_due");
		expect(mapStatus("unpaid")).toBe("past_due");
	});

	it("collapses terminal statuses to canceled", () => {
		expect(mapStatus("canceled")).toBe("canceled");
		expect(mapStatus("incomplete_expired")).toBe("canceled");
	});

	it("treats any other status as none", () => {
		expect(mapStatus("incomplete")).toBe("none");
		expect(mapStatus("paused")).toBe("none");
	});
});
