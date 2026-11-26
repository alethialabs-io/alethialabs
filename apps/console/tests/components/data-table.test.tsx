// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DataTable's SERVER mode (components/data-table.tsx, #7482): `keyset={useKeysetList(…)}`.
//   - every loaded row renders — no page numbers, no rows-per-page picker, no "of N", no "total";
//   - the footer is ListFooter: "Load more" while there is more, nothing at the end;
//   - column sorting is off (the server owns the order; sorting loaded pages would invent one);
//   - the body states come from the list's first-page state: placeholders while pending, the
//     region error with retry on a failed first page, and a failed LATER page keeps the rows with
//     the footer's retry line rather than the stale-refresh notice.

import { render, screen, within } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/data-table";
import type { KeysetList } from "@/lib/query/use-keyset-list";

interface Row {
	id: string;
	name: string;
}

const COLUMNS: ColumnDef<Row>[] = [{ accessorKey: "name", header: "Name" }];

/** `n` rows, more than any client page size, so a stray client pager would show itself. */
function rows(n: number): Row[] {
	return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `row ${String(i).padStart(3, "0")}` }));
}

/** A settled keyset list holding `loaded`, overridable per test. */
function list(loaded: Row[], over: Partial<KeysetList<Row>> = {}): KeysetList<Row> {
	return {
		rows: loaded,
		facets: null,
		universeEmpty: false,
		query: { isLoading: false, isError: false, data: { pages: [] }, error: null, refetch: vi.fn() },
		isPending: false,
		isPlaceholderData: false,
		hasMore: true,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: vi.fn(),
		...over,
	};
}

describe("DataTable server mode", () => {
	it("renders every loaded row, with Load more and no page or count chrome", () => {
		render(<DataTable columns={COLUMNS} keyset={list(rows(75))} />);
		// 75 body rows + the header row: nothing was paged away in the browser.
		expect(screen.getAllByRole("row")).toHaveLength(76);
		expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
		expect(screen.queryByText(/total|Page \d+ of|Showing \d+ of/)).toBeNull();
		expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
		expect(screen.queryByText("Rows")).toBeNull();
	});

	it("at the end of the list the footer is gone and nothing replaces it", () => {
		const { container } = render(<DataTable columns={COLUMNS} keyset={list(rows(3), { hasMore: false })} />);
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
		expect(container.querySelector('[data-slot="list-footer"]')).toBeNull();
	});

	it("does not sort client-side: the header is not a sort control", () => {
		render(<DataTable columns={COLUMNS} keyset={list(rows(3))} />);
		const header = screen.getByRole("columnheader", { name: "Name" });
		expect(within(header).queryByRole("button")).toBeNull();
	});

	it("pending first page: placeholder rows, no footer", () => {
		const { container } = render(
			<DataTable
				columns={COLUMNS}
				keyset={list([], { isPending: true, query: { isLoading: true, isError: false, error: null, refetch: vi.fn() } })}
			/>,
		);
		expect(container.querySelectorAll('[data-slot="data-table-skeleton-row"]').length).toBeGreaterThan(0);
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("failed first page: the region error with a retry", () => {
		const refetch = vi.fn();
		render(
			<DataTable
				columns={COLUMNS}
				keyset={list([], { query: { isLoading: false, isError: true, error: new Error("x"), refetch } })}
			/>,
		);
		screen.getByRole("button", { name: /try again|retry/i }).click();
		expect(refetch).toHaveBeenCalled();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("failed LATER page: the rows stay and the footer says so — not the stale-refresh notice", () => {
		const { container } = render(<DataTable columns={COLUMNS} keyset={list(rows(5), { loadMoreFailed: true })} />);
		expect(screen.getAllByRole("row")).toHaveLength(6);
		expect(screen.getByText("Couldn't load more")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="data-table-stale"]')).toBeNull();
	});

	it("failed REFRESH behind loaded rows: the rows stay under the shared stale-refresh notice", () => {
		const refetch = vi.fn();
		const { container } = render(
			<DataTable
				columns={COLUMNS}
				keyset={list(rows(3), {
					query: { isLoading: false, isError: true, data: { pages: [] }, error: new Error("x"), refetch },
				})}
			/>,
		);
		expect(screen.getAllByRole("row")).toHaveLength(4);
		const notice = container.querySelector('[data-slot="data-table-stale"]');
		expect(notice).not.toBeNull();
		expect(notice).toHaveAttribute("role", "status");
		expect(screen.getByText("Couldn't refresh — showing earlier data")).toBeInTheDocument();
		screen.getByRole("button", { name: "Try again" }).click();
		expect(refetch).toHaveBeenCalled();
	});

	it("an empty answer is the empty row, with no footer", () => {
		render(<DataTable columns={COLUMNS} keyset={list([], { hasMore: false })} emptyMessage="No things match" />);
		expect(screen.getByText("No things match")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});
});
