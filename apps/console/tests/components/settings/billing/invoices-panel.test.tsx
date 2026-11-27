// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Billing · Invoices on the list standard (lib/query/README.md → "Paging" / "Counts";
// LST-11 #7493). Drives the REAL panel, filter store, `useFilterUrlSync` and `useKeysetList` over
// the real oRPC TanStack utils; only the network edge (`billing.invoices`) is faked, answering keyset
// pages. Locked here:
//   - every invoice is reachable: "Load more" walks the server's cursor, and the last page offers
//     nothing further (the list used to read 200 rows and page them in the browser);
//   - a filter change restarts the walk at page one — no stale cursor reaches the new filter;
//   - a failed LATER page keeps the loaded rows and says so in the footer;
//   - the filtered-empty and first-run-empty states are told apart by the server's `universeEmpty`;
//   - no count pill and no "Showing the N most recent" note;
//   - the list is `aria-busy` until its first answer (#5494).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvoiceFacets } from "@/lib/queries/billing";
import type { KeysetListPage } from "@/lib/queries/keyset";
import type { InvoiceInfo } from "@/lib/rpc/procedures/billing";

const url = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/billing/invoices",
	useSearchParams: () => new URLSearchParams(url.search),
}));
vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("../billing-rpc-fake")).fakeOrpc }));
vi.mock("@/components/settings/billing/invoice-preview-dialog", () => ({
	InvoicePreviewDialog: () => null,
}));

import InvoicesLoading from "@/app/(private)/[org]/~/settings/billing/invoices/loading";
import { invoiceStatusCounts } from "@/components/settings/billing/invoices-filters";
import { InvoicesPanel } from "@/components/settings/billing/invoices-panel";
import { useInvoiceFilters } from "@/lib/stores/use-settings-filters";
import { failed, reads, resetReads } from "../billing-rpc-fake";

/** One paid invoice numbered `ALE-<n>`. */
function invoice(n: number): InvoiceInfo {
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		number: `ALE-${n}`,
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

const FACETS: InvoiceFacets = { status: [{ value: "paid", label: null, count: 3 }] };

/** A first page (facets + universeEmpty) or a later one (both null). */
function page(rows: InvoiceInfo[], nextCursor: string | null, first = true): KeysetListPage<InvoiceInfo, InvoiceFacets> {
	return { rows, nextCursor, facets: first ? FACETS : null, universeEmpty: first ? false : null };
}

/** The input of the n-th call to the invoices read. */
function inputOf(call: number): unknown {
	return reads.invoices.mock.calls[call]?.[0];
}

/** The panel inside a fresh query provider (no retry delay: a real failure retries once). */
function tree(): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } });
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

describe("InvoicesPanel pages through the keyset contract (#7493)", () => {
	it("walks every page with Load more, and the last page offers nothing further", async () => {
		reads.invoices.mockImplementation(async (input) => {
			const cursor = typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
			if (cursor === undefined) return page([invoice(3), invoice(2)], "c-2");
			if (cursor === "c-2") return page([invoice(1)], null, false);
			throw new Error(`unexpected cursor ${String(cursor)}`);
		});
		render(tree());
		await screen.findByText("ALE-3");
		expect(inputOf(0)).not.toHaveProperty("cursor");

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("ALE-1");
		expect(inputOf(1)).toMatchObject({ cursor: "c-2" });
		// Every row stays, in order, and the end says nothing at all.
		expect(screen.getByText("ALE-3")).toBeInTheDocument();
		expect(screen.getByText("ALE-2")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("a filter change restarts the walk at page one", async () => {
		reads.invoices.mockImplementation(async (input) => {
			const cursor = typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
			return cursor === undefined ? page([invoice(2)], "c-1") : page([invoice(1)], null, false);
		});
		render(tree());
		await screen.findByText("ALE-2");
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("ALE-1");

		const before = reads.invoices.mock.calls.length;
		act(() => useInvoiceFilters.getState().set("statuses", ["void"]));
		await waitFor(() => expect(reads.invoices.mock.calls.length).toBeGreaterThan(before));
		const restarted = inputOf(before);
		expect(restarted).toEqual({ status: ["void"] });
		expect(restarted).not.toHaveProperty("cursor");
	});

	it("a failed later page keeps the loaded rows and offers a retry in the footer", async () => {
		reads.invoices.mockImplementation(async (input) => {
			const cursor = typeof input === "object" && input !== null && "cursor" in input ? input.cursor : undefined;
			if (cursor === undefined) return page([invoice(2)], "c-1");
			throw failed();
		});
		render(tree());
		await screen.findByText("ALE-2");
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(await screen.findByText("Couldn't load more", undefined, { timeout: 4000 })).toBeInTheDocument();
		expect(screen.getByText("ALE-2")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
	});
});

describe("InvoicesPanel states and counts (#7493, CON-PB2)", () => {
	it("a filtered view with no rows offers Clear filters, which resets the bar", async () => {
		url.search = "statuses=void";
		reads.invoices.mockResolvedValue(page([], null));
		render(tree());
		const clear = await screen.findByRole("button", { name: "Clear filters" });
		expect(screen.getByText("No invoices match these filters.")).toBeInTheDocument();
		fireEvent.click(clear);
		await waitFor(() => expect(useInvoiceFilters.getState().filters.statuses).toEqual([]));
	});

	it("an org with no invoices at all is the first-run line, with no Clear filters", async () => {
		reads.invoices.mockResolvedValue({ rows: [], nextCursor: null, facets: { status: [] }, universeEmpty: true });
		render(tree());
		expect(await screen.findByText(/invoices appear here after your first payment/)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
	});

	it("carries no count pill and no 'most recent' note, however many rows loaded", async () => {
		reads.invoices.mockResolvedValue(page([invoice(3), invoice(2), invoice(1)], "c-more"));
		const { container } = render(tree());
		await screen.findByText("ALE-3");
		expect(container.querySelector("[data-slot='count-pill']")).toBeNull();
		expect(screen.queryByText(/Showing/)).toBeNull();
		expect(screen.queryByText(/most recent/)).toBeNull();
		expect(screen.queryByTestId("invoices-cap-note")).toBeNull();
	});

	it("declares aria-busy around the first load, and clears it once the rows land", async () => {
		reads.invoices.mockImplementation(() => new Promise(() => {}));
		const pending = render(tree());
		await waitFor(() => expect(reads.invoices).toHaveBeenCalled());
		expect(pending.container.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
		pending.unmount();

		resetReads();
		reads.invoices.mockResolvedValue(page([invoice(1)], null));
		const { container } = render(tree());
		await screen.findByText("ALE-1");
		await waitFor(() => expect(container.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("false"));
	});
});

describe("invoiceStatusCounts reads the first page's facet pass", () => {
	it("gives every status an entry, from the server's counts", () => {
		expect(invoiceStatusCounts(FACETS)).toEqual({ open: 0, overdue: 0, paid: 3, refunded: 0, void: 0 });
	});

	it("counts nothing before a first page has landed", () => {
		expect(invoiceStatusCounts(null)).toEqual({ open: 0, overdue: 0, paid: 0, refunded: 0, void: 0 });
	});
});

/**
 * The real toolbar row's controls in order — `facet` for a `FacetFilter`, `search` for the search,
 * `control` for any other button (the quick range and the date range in `extra`).
 */
function realToolbarParts(container: HTMLElement): string[] {
	const facet = container.querySelector('[data-slot="facet-filter"]');
	const row = facet?.parentElement;
	if (!row) throw new Error("the panel drew no toolbar");
	return [...row.children].map((el) => {
		if (el.getAttribute("data-slot") === "facet-filter") return "facet";
		if (el.getAttribute("data-slot") === "filter-search") return "search";
		return "control";
	});
}

describe("the route's loading skeleton is the panel's own row (#7876)", () => {
	it("draws the toolbar as ListToolbarSkeleton, one placeholder per real control, in order", async () => {
		reads.invoices.mockResolvedValue(page([invoice(1)], null));
		const real = render(tree());
		await screen.findByText("ALE-1");
		const realParts = realToolbarParts(real.container);
		const realColumns = real.container.querySelectorAll("thead th").length;
		real.unmount();
		expect(realParts).toEqual(["facet", "control", "control"]);

		const { container } = render(<InvoicesLoading />);
		const row = container.querySelector('[data-slot="list-toolbar-skeleton"]');
		if (!row) throw new Error("the loading skeleton drew no ListToolbarSkeleton");
		const drawn = [...row.children].map((el) => {
			const part = el.getAttribute("data-part");
			return part === "extra" ? (el.getAttribute("data-size") ?? "") : (part ?? "");
		});
		expect(drawn).toEqual(realParts);
		expect(container.querySelectorAll('[data-slot="data-table-skeleton"] thead th')).toHaveLength(realColumns);
	});

	it("has no count-pill placeholder and no hand-rolled filter row", () => {
		const { container } = render(<InvoicesLoading />);
		expect(container.querySelector(".rounded-full")).toBeNull();
		expect(container.querySelectorAll(".flex-wrap")).toHaveLength(1);
	});
});
