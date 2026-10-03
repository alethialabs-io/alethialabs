// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the pending paid-setup record when the tab's storage is unavailable.
//
// A private window or blocked site data makes sessionStorage throw. The record is then held in a
// module-level copy, so closing (and unmounting) the create-a-team sheet still does not lose the
// charge it refers to; a reload does, which the file header and the close confirmation both state.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/billing", () => ({}));
vi.mock("@/app/server/actions/legal", () => ({}));
vi.mock("@/app/server/actions/org-settings", () => ({}));
vi.mock("@/app/server/actions/workspace", () => ({}));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));
vi.mock("sonner", () => ({ toast: {} }));

import {
	type PendingPaidSetup,
	pendingPaidSetupKey,
	readPendingPaidSetup,
	writePendingPaidSetup,
} from "@/components/org/pending-paid-setup";

const record: PendingPaidSetup = {
	subscriptionId: "sub_1",
	customerId: "cus_1",
	name: "Acme Cloud",
	slug: "acme-cloud",
	currency: "eur",
	declaration: { capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" },
	billing: {
		name: "Acme GmbH",
		line1: "Hauptstr. 1",
		city: "Berlin",
		postalCode: "10115",
		country: "DE",
		taxType: "eu_vat",
		taxValue: "",
		useAsPrimary: false,
	},
	customerDetailsSaved: true,
	createdOrgId: "org-1",
	createdSlug: "acme-cloud",
	linked: true,
	slugRefusal: null,
};

afterEach(() => {
	vi.restoreAllMocks();
	window.sessionStorage.clear();
});

describe("pending paid setup — storage", () => {
	it("round-trips through sessionStorage, attestation included", () => {
		writePendingPaidSetup("user-1", record);
		expect(window.sessionStorage.getItem(pendingPaidSetupKey("user-1"))).toContain("CTO");
		expect(readPendingPaidSetup("user-1")).toEqual(record);
		expect(readPendingPaidSetup("user-2")).toBeNull();
	});

	it("keeps the record in the page when storage throws", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError");
		});
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("SecurityError");
		});
		writePendingPaidSetup("user-3", record);
		expect(readPendingPaidSetup("user-3")).toEqual(record);
	});

	it("writes and reads nothing without a user id", () => {
		writePendingPaidSetup("", record);
		expect(window.sessionStorage.length).toBe(0);
		expect(readPendingPaidSetup("")).toBeNull();
	});
});
