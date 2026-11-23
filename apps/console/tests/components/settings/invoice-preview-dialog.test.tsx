// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// EA-7c (#7341): the invoices list and the preview dialog offer OUR stored фактура PDF once it is
// issued, and say the invoice is being issued until then. Neither ever links to Stripe — the dialog
// used to offer "Open receipt" to Stripe's hosted page. Every link in the rendered tree is read, so
// a Stripe href reintroduced under any label fails here.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
}));

import { InvoicePreviewDialog } from "@/components/settings/billing/invoice-preview-dialog";
import { InvoicesTable } from "@/components/settings/billing/invoices-table";

/** An invoice row, issued unless overridden. */
function invoice(overrides: Partial<InvoiceInfo> = {}): InvoiceInfo {
	return {
		id: "inv_1",
		number: "0000000042",
		total: 4900,
		currency: "eur",
		status: "paid",
		paidAt: "2026-06-01T00:00:00.000Z",
		periodStart: null,
		periodEnd: null,
		description: "Team plan",
		facturaIssued: true,
		...overrides,
	};
}

/** A row whose фактура is not issued yet (the procedure nulls its number). */
const BEING_ISSUED = invoice({ id: "inv_2", number: null, facturaIssued: false });

/** Every href in the document, dialogs (portalled to body) included. */
function hrefs(): string[] {
	return Array.from(document.body.querySelectorAll("a[href]")).map((a) => a.getAttribute("href") ?? "");
}

/** Every iframe src in the document. */
function frames(): string[] {
	return Array.from(document.body.querySelectorAll("iframe")).map((f) => f.getAttribute("src") ?? "");
}

describe("InvoicePreviewDialog", () => {
	it("embeds and downloads the stored фактура once it is issued", () => {
		render(<InvoicePreviewDialog invoice={invoice()} open onOpenChange={() => {}} />);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("0000000042")).toBeTruthy();
		expect(frames()).toEqual(["/acme/~/settings/billing/invoices/inv_1/pdf"]);
		expect(hrefs()).toEqual(["/acme/~/settings/billing/invoices/inv_1/pdf?download=1"]);
		expect(within(dialog).queryByText("Your invoice is being issued")).toBeNull();
	});

	it("says the invoice is being issued and offers no document until then", () => {
		render(<InvoicePreviewDialog invoice={BEING_ISSUED} open onOpenChange={() => {}} />);
		const dialog = screen.getByRole("dialog");
		expect(within(dialog).getByText("Your invoice is being issued")).toBeTruthy();
		expect(frames()).toEqual([]);
		expect(hrefs()).toEqual([]);
		expect(within(dialog).queryByText(/receipt/i)).toBeNull();
	});
});

describe("InvoicesTable", () => {
	it("shows the фактура number and its download for an issued row, 'Being issued' otherwise", () => {
		render(<InvoicesTable rows={[invoice(), BEING_ISSUED]} onPreview={() => {}} />);
		expect(screen.getByText("0000000042")).toBeTruthy();
		expect(screen.getByText("Being issued")).toBeTruthy();
		// One download — the issued row's, through our route. The pending row has none.
		expect(hrefs()).toEqual(["/acme/~/settings/billing/invoices/inv_1/pdf?download=1"]);
	});
});
