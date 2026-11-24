// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// "My cases" pages by keyset (#7389): `support.cases` answers one page per cursor, and the list
// walks them with "Load more". Pinned here, against the REAL CaseList over a fake read router:
//   - a full first page offers "Load more", and a short one does not (it is the end);
//   - "Load more" asks for the page after page one's LAST row (its activity and id) in the same
//     bucket, and appends that page under the first;
//   - the walk continues from the second page's last row and stops at a short page;
//   - a case both pages hold (a reply lifted it while the reader paged) is drawn once;
//   - the toolbar shows no count until the last page is in — a loaded count is not the total;
//   - a filter is SENT to the server (#7396): a case beyond page one that matches it is on the
//     filtered first page, and the facet options are the server's counts, labelled in label order.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CASE_PAGE_SIZE, type CaseFacets, type CaseListItem, type CasePage } from "@/lib/queries/support";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/support/my-cases",
	useSearchParams: () => new URLSearchParams(),
}));

const rpc = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(rpc.handlers, rpc.calls).orpc };
});

import { CaseList } from "@/components/support/cases/case-list";
import { caseFacetOptions } from "@/components/support/cases/case-query";
import { useSupportFilters } from "@/lib/stores/use-support-filters";

/** The facets the fake read answers on a first page: what the server's facet pass would count. */
const FACETS: CaseFacets = {
	severity: [
		{ value: "normal", label: null, count: CASE_PAGE_SIZE },
		{ value: "urgent", label: null, count: 1 },
	],
	type: [{ value: "technical", label: null, count: CASE_PAGE_SIZE + 1 }],
};

/** One page as `support.cases` answers it: the facets on a first page (no cursor) only. */
function asPage(rows: CaseListItem[], input: unknown): CasePage {
	const later = typeof input === "object" && input !== null && "cursor" in input && input.cursor;
	return { rows, facets: later ? null : FACETS };
}

/** A case whose activity is `minute` minutes after a fixed instant — larger is newer. */
function item(n: number, minute: number): CaseListItem {
	const at = new Date(Date.parse("2026-11-01T00:00:00.000Z") + minute * 60_000);
	return {
		id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
		case_number: 1000 + n,
		subject: `Case subject ${n}`,
		type: "technical",
		category: "runners",
		severity: "normal",
		status: "open",
		last_message_at: at,
		last_author_type: "customer",
		created_at: at,
		unread: false,
		requester_name: null,
		is_mine: true,
	};
}

/** `count` cases numbered from `from`, newest first, all sharing ONE timestamp (a tie). */
function tiedPage(from: number, count: number, minute: number): CaseListItem[] {
	return Array.from({ length: count }, (_, i) => item(from + count - 1 - i, minute));
}

/** The inputs `support.cases` was asked for, in order. */
const casesAsked = () => rpc.calls.filter((c) => c.path === "support.cases").map((c) => c.input);

/** Renders `ui` under a fresh QueryClient. */
function renderWithClient(ui: ReactElement) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** Lets pending fetches and their renders settle. */
async function settle() {
	await act(async () => {
		for (let i = 0; i < 5; i++) await Promise.resolve();
	});
}

beforeEach(() => {
	useSupportFilters.getState().reset();
	rpc.calls.length = 0;
	for (const k of Object.keys(rpc.handlers)) delete rpc.handlers[k];
});

describe("CaseList paging", () => {
	it("a short first page is the whole list: no Load more, and the count is shown", async () => {
		rpc.handlers["support.cases"] = async (input) => asPage(tiedPage(1, 3, 10), input);
		renderWithClient(<CaseList orgSlug="acme" />);
		await screen.findByText("Case subject 3");

		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(screen.getAllByRole("listitem")).toHaveLength(3);
		expect(casesAsked()).toEqual([{ bucket: "all" }]);
	});

	it("Load more asks for the page after page one's last row and appends it, until a short page", async () => {
		// Page one: CASE_PAGE_SIZE cases, all at one timestamp — the boundary falls inside a tie.
		const first = tiedPage(100, CASE_PAGE_SIZE, 30);
		// Page two: full again; it repeats page one's top case (a reply lifted it meanwhile — the
		// list must draw it once) and continues the tie.
		const second = [first[0], ...tiedPage(40, CASE_PAGE_SIZE - 1, 30)];
		// Page three: short — the end.
		const third = tiedPage(1, 2, 5);
		rpc.handlers["support.cases"] = async (input) => {
			if (typeof input !== "object" || input === null || !("cursor" in input) || !input.cursor) {
				return asPage(first, input);
			}
			const cursor = input.cursor;
			if (typeof cursor === "object" && cursor !== null && "id" in cursor && cursor.id === first.at(-1)?.id) {
				return asPage(second, input);
			}
			return asPage(third, input);
		};

		const { container } = renderWithClient(<CaseList orgSlug="acme" />);
		await screen.findByText("Case subject 149");
		expect(screen.getAllByRole("listitem")).toHaveLength(CASE_PAGE_SIZE);
		// More may exist, so no count yet: a pill reading 50 would claim to be the total.
		expect(within(container).queryByText(String(CASE_PAGE_SIZE))).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("Case subject 40");

		const last = first.at(-1);
		expect(casesAsked()[1]).toEqual({
			bucket: "all",
			cursor: { at: last?.last_message_at.toISOString(), id: last?.id },
		});
		// 50 + 49 new; the repeated case is drawn once.
		expect(screen.getAllByRole("listitem")).toHaveLength(CASE_PAGE_SIZE * 2 - 1);
		expect(screen.getAllByText("Case subject 149")).toHaveLength(1);

		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		await screen.findByText("Case subject 1");
		await settle();

		const secondLast = second.at(-1);
		expect(casesAsked()[2]).toEqual({
			bucket: "all",
			cursor: { at: secondLast?.last_message_at.toISOString(), id: secondLast?.id },
		});
		expect(screen.getAllByRole("listitem")).toHaveLength(CASE_PAGE_SIZE * 2 + 1);
		// A short page is the end: the control goes, and the total is now known.
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(within(container).getByText(String(CASE_PAGE_SIZE * 2 + 1))).toBeInTheDocument();
		expect(casesAsked()).toHaveLength(3);
	});

	it("a filter is applied by the server: a case beyond page one is on the filtered first page", async () => {
		// Unfiltered, page one is full of `normal` cases, and the one `urgent` case is older than all
		// of them — beyond page one. Before #7396 the filter ran over the loaded rows and found nothing.
		const first = tiedPage(100, CASE_PAGE_SIZE, 30);
		const urgent = { ...item(1, 1), severity: "urgent" as const, subject: "The urgent one" };
		rpc.handlers["support.cases"] = async (input) => {
			const wantsUrgent =
				typeof input === "object" &&
				input !== null &&
				"severity" in input &&
				Array.isArray(input.severity) &&
				input.severity.includes("urgent");
			return asPage(wantsUrgent ? [urgent] : first, input);
		};

		renderWithClient(<CaseList orgSlug="acme" />);
		await screen.findByText("Case subject 149");
		expect(screen.queryByText("The urgent one")).toBeNull();

		act(() => useSupportFilters.getState().set("severity", ["urgent"]));
		await screen.findByText("The urgent one");
		await settle();

		// The filter reached the read's input (so its key), with no cursor: it is a first page.
		expect(casesAsked().at(-1)).toEqual({ bucket: "all", severity: ["urgent"] });
		expect(screen.getAllByRole("listitem")).toHaveLength(1);
		// The filtered result is the whole of it: no Load more, and the count is the total.
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});
});

describe("caseFacetOptions", () => {
	it("labels the server's counts in label order and drops values nobody has", () => {
		const labels = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
		expect(caseFacetOptions(FACETS.severity, labels)).toEqual([
			{ value: "normal", label: "Normal", count: CASE_PAGE_SIZE },
			{ value: "urgent", label: "Urgent", count: 1 },
		]);
	});

	it("offers nothing before the first page has landed", () => {
		expect(caseFacetOptions(undefined, { normal: "Normal" })).toEqual([]);
	});
});
