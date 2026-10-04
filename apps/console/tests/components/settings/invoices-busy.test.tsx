// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Billing · Invoices says when its list does not yet answer (#5494). Before the first
// answer the panel is a skeleton under a null count pill; the audit's `settle()` takes two
// identical such reads as the page's answer unless `main` holds an `aria-busy="true"` node, so the
// skeleton must sit inside a busy node, and the loaded list must stop declaring it. Drives the
// real panel, filter store and `useFilterUrlSync`; only the network edges are mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceInfo } from "@/app/server/actions/billing";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/billing/invoices",
	useSearchParams: () => new URLSearchParams(""),
}));

const { listInvoices } = vi.hoisted(() => ({
	listInvoices: vi.fn<(params: unknown) => Promise<InvoiceInfo[]>>(),
}));

vi.mock("@/app/server/actions/billing", () => ({ listInvoices }));
vi.mock("@/components/settings/billing/invoice-preview-dialog", () => ({
	InvoicePreviewDialog: () => null,
}));

import { InvoicesPanel } from "@/components/settings/billing/invoices-panel";
import { useInvoiceFilters } from "@/lib/stores/use-settings-filters";

/** One paid invoice. */
const INVOICE: InvoiceInfo = {
	id: "inv_1",
	number: "ALE-0001",
	total: 4900,
	currency: "eur",
	status: "paid",
	paidAt: "2026-06-01T00:00:00.000Z",
	periodStart: null,
	periodEnd: null,
	description: null,
	hasPdf: false,
	hostedInvoiceUrl: null,
};

/** The panel inside a fresh query provider. */
function tree(): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<InvoicesPanel />
		</QueryClientProvider>
	);
}

/** The node that carries the list's `aria-busy`; fails the test when there is none. */
function busyNode(container: HTMLElement): Element {
	const el = container.querySelector("[aria-busy]");
	if (el === null) throw new Error("the invoices list declares no aria-busy");
	return el;
}

beforeEach(() => {
	sessionStorage.clear();
	useInvoiceFilters.getState().reset();
	listInvoices.mockReset();
});

describe("InvoicesPanel marks its list busy until its first answer (#5494)", () => {
	it("declares aria-busy around the first-load skeleton", async () => {
		listInvoices.mockImplementation(() => new Promise<InvoiceInfo[]>(() => {}));
		const { container } = render(tree());
		await waitFor(() => expect(listInvoices).toHaveBeenCalled());
		expect(busyNode(container).getAttribute("aria-busy")).toBe("true");
		expect(screen.queryByText("ALE-0001")).toBeNull();
	});

	it("clears aria-busy once the invoices have loaded", async () => {
		listInvoices.mockResolvedValue([INVOICE]);
		const { container } = render(tree());
		await waitFor(() => expect(screen.getByText("ALE-0001")).toBeTruthy());
		await waitFor(() => expect(busyNode(container).getAttribute("aria-busy")).toBe("false"));
	});
});
