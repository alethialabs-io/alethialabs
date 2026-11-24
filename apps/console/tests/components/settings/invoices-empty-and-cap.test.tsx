// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2 (R6 F-25, F-26). A filtered invoices view with no rows offers "Clear filters" instead of
// a dead table row, and a list that reached the read's cap says so instead of dropping the oldest
// invoices silently. The cap constant is locked to the read's default `limit`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";

const url = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/billing/invoices",
	useSearchParams: () => new URLSearchParams(url.search),
}));
vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./billing-rpc-fake")).fakeOrpc }));
vi.mock("@/components/settings/billing/invoice-preview-dialog", () => ({
	InvoicePreviewDialog: () => null,
}));

import { INVOICE_LIST_CAP } from "@/components/settings/billing/invoices-filters";
import { InvoicesPanel } from "@/components/settings/billing/invoices-panel";
import { useInvoiceFilters } from "@/lib/stores/use-settings-filters";
import { reads, resetReads } from "./billing-rpc-fake";

/** One paid invoice with the given id. */
function invoice(id: string): InvoiceInfo {
	return {
		id,
		number: `ALE-${id}`,
		total: 4900,
		currency: "eur",
		status: "paid",
		paidAt: "2026-06-01T00:00:00.000Z",
		periodStart: null,
		periodEnd: null,
		description: null,
		facturaIssued: true,
	};
}

/** The panel inside a fresh query provider. */
function tree(): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<InvoicesPanel />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	url.search = "";
	sessionStorage.clear();
	useInvoiceFilters.getState().reset();
	resetReads();
});

describe("Invoices filtered-empty and cap (CON-PB2)", () => {
	it("a filtered view with no rows offers Clear filters, which resets the bar", async () => {
		// The link carries the filter, as a shared filtered view does; the URL sync reads it in.
		url.search = "statuses=void";
		reads.invoices.mockResolvedValue([]);
		render(tree());
		const clear = await screen.findByRole("button", { name: "Clear filters" });
		expect(screen.getByText("No invoices match these filters.")).toBeInTheDocument();
		fireEvent.click(clear);
		await waitFor(() => expect(useInvoiceFilters.getState().filters.statuses).toEqual([]));
	});

	it("an unfiltered empty list is the first-run line, with no Clear filters", async () => {
		reads.invoices.mockResolvedValue([]);
		render(tree());
		expect(await screen.findByText(/invoices appear here after your first payment/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});

	it("a list that reached the cap says it shows only the most recent", async () => {
		reads.invoices.mockResolvedValue(
			Array.from({ length: INVOICE_LIST_CAP }, (_, i) => invoice(String(i))),
		);
		render(tree());
		expect(await screen.findByTestId("invoices-cap-note")).toHaveTextContent(
			`Showing the ${INVOICE_LIST_CAP} most recent invoices`,
		);
	});

	it("a list under the cap carries no note", async () => {
		reads.invoices.mockResolvedValue([invoice("1")]);
		render(tree());
		await screen.findByText("ALE-1");
		expect(screen.queryByTestId("invoices-cap-note")).toBeNull();
	});

	it("the cap is the read's default limit", () => {
		const src = readFileSync(resolve(__dirname, "../../../lib/billing/invoices.ts"), "utf8");
		expect(src).toContain(`.limit(filters.limit ?? ${INVOICE_LIST_CAP})`);
	});
});
