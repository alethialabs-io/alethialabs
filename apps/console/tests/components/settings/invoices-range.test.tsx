// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Billing › Invoices' date filter (#6731). Its default is ALL TIME — no bound — and the
// bar must say so: the trigger used to read "All time" beside a date picker showing the last 7
// days, and the menu had no "All time" to pick. A relative preset must travel as the preset
// (resolved by the read at read time), not as a frozen window under a relative name, and one date
// choice is one filter on "Reset · N". The pure codec is driven directly; the bar is driven
// through the real panel, store and `useFilterUrlSync`, with only the network edge faked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The link the panel is opened on: `useFilterUrlSync` replaces the store with it on mount (#6814).
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/billing/invoices",
	useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/lib/rpc/client", async () => ({ orpc: (await import("./billing-rpc-fake")).fakeOrpc }));
vi.mock("@/components/settings/billing/invoice-preview-dialog", () => ({
	InvoicePreviewDialog: () => null,
}));

import {
	ALL_TIME_LABEL,
	DEFAULT_INVOICE_FILTERS,
	NO_WINDOW_LABEL,
	normalizeInvoiceQuery,
} from "@/components/settings/billing/invoices-filters";
import {
	CUSTOM_RANGE_LABEL,
	parseRangeFilter as parseInvoiceRange,
	rangeFilterLabel,
	rangeFromPick as invoiceRangeFromPick,
	rangeWindowValue as invoiceWindowValue,
} from "@/lib/query/range-filter";

/** The invoices trigger label for a decoded choice (all time is this page's default). */
function invoiceRangeLabel(range: ReturnType<typeof parseInvoiceRange>): string {
	return rangeFilterLabel(range, ALL_TIME_LABEL);
}
import { InvoicesPanel } from "@/components/settings/billing/invoices-panel";
import { filterStateFromUrl } from "@/lib/query/filter-url-codec";
import { invoiceReaderFilters } from "@/lib/rpc/inputs/invoices";
import { countActiveFilters } from "@/lib/stores/create-filter-store";
import { useInvoiceFilters } from "@/lib/stores/use-settings-filters";
import { presetRange } from "@repo/ui/range";
import { reads, resetReads } from "./billing-rpc-fake";

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
	sessionStorage.clear();
	nav.search = "";
	useInvoiceFilters.getState().reset();
	resetReads();
	// A keyset page since #7493: an empty, final first page.
	reads.invoices.mockResolvedValue({ rows: [], nextCursor: null, facets: null, universeEmpty: true });
});

describe("the invoices default is all time, and the bar says so (#6731)", () => {
	it("the pristine filter asks for no bound at all", () => {
		expect(parseInvoiceRange(DEFAULT_INVOICE_FILTERS.range)).toEqual({ kind: "default" });
		expect(normalizeInvoiceQuery(DEFAULT_INVOICE_FILTERS)).toEqual({});
		expect(invoiceRangeLabel(parseInvoiceRange(""))).toBe(ALL_TIME_LABEL);
	});

	it("renders All time with no date window beside it", async () => {
		render(tree());
		await waitFor(() => expect(reads.invoices).toHaveBeenCalled());
		expect(screen.getByRole("button", { name: ALL_TIME_LABEL })).toBeTruthy();
		expect(screen.getByRole("button", { name: NO_WINDOW_LABEL })).toBeTruthy();
		// Every read the panel made was unbounded.
		for (const [input] of reads.invoices.mock.calls) {
			expect(input).not.toHaveProperty("paidFrom");
			expect(input).not.toHaveProperty("paidWithin");
		}
	});

	it("offers All time in the menu, and picking it clears a chosen window", async () => {
		nav.search = "range=30d";
		render(tree());
		fireEvent.click(await screen.findByRole("button", { name: "Last 30 days" }));
		fireEvent.click(await screen.findByRole("button", { name: ALL_TIME_LABEL }));
		expect(useInvoiceFilters.getState().filters.range).toBe("");
	});
});

describe("a relative preset round-trips as relative (#6731)", () => {
	it("a preset pick is stored as the preset id, not as resolved bounds", () => {
		const window = presetRange("30d");
		expect(invoiceRangeFromPick(window, "Last 30 days")).toBe("30d");
	});

	it("a link carrying the preset asks the read for the preset", () => {
		const filters = filterStateFromUrl(new URLSearchParams("range=30d"), DEFAULT_INVOICE_FILTERS);
		expect(normalizeInvoiceQuery(filters)).toEqual({ paidWithin: "30d" });
		expect(invoiceRangeLabel(parseInvoiceRange(filters.range))).toBe("Last 30 days");
	});

	it("the read resolves the preset against ITS clock, so a later visit sees a later window", () => {
		const nov = new Date("2026-11-16T12:00:00.000Z");
		const dec = new Date("2026-12-16T12:00:00.000Z");
		const atNov = invoiceReaderFilters({ paidWithin: "30d" }, nov);
		const atDec = invoiceReaderFilters({ paidWithin: "30d" }, dec);
		// `presetRange` counts calendar days in the host's zone, so the bound is asked of it rather
		// than hand-computed (a DST change inside the window moves it by an hour).
		expect(atNov).toEqual({ paidFrom: presetRange("30d", nov).from.toISOString() });
		expect(atDec).toEqual({ paidFrom: presetRange("30d", dec).from.toISOString() });
		expect(atDec.paidFrom).not.toBe(atNov.paidFrom);
		// No upper bound: "the last 30 days" ends whenever the read happens.
		expect(atNov).not.toHaveProperty("paidTo");
	});

	it("a typed range is a fixed window and is labelled as one, never with a relative name", () => {
		const window = { from: new Date("2026-11-06T00:00:00.000Z"), to: new Date("2026-11-16T00:00:00.000Z") };
		const value = invoiceRangeFromPick(window, "10d");
		expect(value).toBe(invoiceWindowValue(window));
		expect(invoiceRangeLabel(parseInvoiceRange(value))).toBe(CUSTOM_RANGE_LABEL);
		expect(normalizeInvoiceQuery({ statuses: [], range: value })).toEqual({
			paidFrom: "2026-11-06T00:00:00.000Z",
			paidTo: "2026-11-16T00:00:00.000Z",
		});
	});

	it("an unreadable range decodes as all time, not as a window nobody chose", () => {
		expect(parseInvoiceRange("last-fortnight")).toEqual({ kind: "default" });
		expect(parseInvoiceRange("nope/2026-11-16T00:00:00.000Z")).toEqual({ kind: "default" });
	});
});

describe("one date choice is one filter on Reset · N (#6731)", () => {
	it("counts a preset, and a window, as 1", () => {
		expect(countActiveFilters({ ...DEFAULT_INVOICE_FILTERS, range: "14d" }, DEFAULT_INVOICE_FILTERS)).toBe(1);
		const window = invoiceWindowValue({ from: new Date("2026-11-01T00:00:00.000Z"), to: new Date("2026-11-02T00:00:00.000Z") });
		expect(countActiveFilters({ ...DEFAULT_INVOICE_FILTERS, range: window }, DEFAULT_INVOICE_FILTERS)).toBe(1);
	});

	it("the bar's reset reads 1 after a preset pick", async () => {
		render(tree());
		fireEvent.click(await screen.findByRole("button", { name: ALL_TIME_LABEL }));
		fireEvent.click(await screen.findByRole("button", { name: "Last 14 days" }));
		await act(async () => {});
		expect(useInvoiceFilters.getState().filters.range).toBe("14d");
		expect(screen.getByText(/Reset/).textContent).toMatch(/1/);
	});
});
