// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6113 (ADR 0005 stress test R4): a route handler under `/{org}/` must answer a non-member with the
// same 404 as an unknown org — not 401 ("sign in"), which is what the invoice PDF route said.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { authorize } = vi.hoisted(() => ({ authorize: vi.fn() }));
vi.mock("@/lib/authz/guard", () => ({ authorize }));
vi.mock("@/lib/billing/invoices", () => ({ getOrgInvoice: vi.fn(async () => null) }));
vi.mock("@/lib/storage", () => ({ storage: { get: vi.fn() } }));
vi.mock("@/lib/storage/invoice-pdf", () => ({ INVOICE_PDF_BUCKET: "invoices" }));

import { GET } from "@/app/(private)/[org]/~/settings/billing/invoices/[id]/pdf/route";
import { ForbiddenError } from "@/lib/authz/types";

const call = () => GET(new Request("http://console.test/acme/~/settings/billing/invoices/inv-1/pdf"), { params: Promise.resolve({ id: "inv-1" }) });

beforeEach(() => {
	authorize.mockReset();
});

describe("invoice PDF refusals", () => {
	it("answers a non-member of the addressed org with 404", async () => {
		authorize.mockRejectedValue(Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }));
		expect((await call()).status).toBe(404);
	});

	it("answers a member without billing permission with 403", async () => {
		authorize.mockRejectedValue(new ForbiddenError("manage_billing", { type: "billing" }));
		expect((await call()).status).toBe(403);
	});

	it("answers no session with 401", async () => {
		authorize.mockRejectedValue(new Error("Unauthorized"));
		expect((await call()).status).toBe(401);
	});
});
