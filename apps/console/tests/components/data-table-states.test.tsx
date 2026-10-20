// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DataTable's bodies are distinct renders, derived from the query that feeds it (#6117, F004).
//
// The defect: a table whose first load had not answered said "No results.", then filled with 14
// rows. Empty and still-loading are different answers about the data. These tests lock that:
// - the empty row appears ONLY when the read answered with nothing;
// - a loading table keeps its real header over placeholder rows;
// - a DISABLED query (TanStack v5: `isPending` forever, `isLoading` false) settles to the empty
//   row instead of an endless skeleton;
// - a failed first load is an error with a retry, never the empty row;
// - a failed REFRESH behind rows keeps the rows, under a one-line notice with its own retry;
// - full-width rows span the header's LEAF columns, so grouped columns stay in step.

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import { DataTable, type DataTableQuery } from "@/components/data-table";

interface Row {
	id: string;
	name: string;
	status: string;
}

const COLUMNS: ColumnDef<Row>[] = [
	{ accessorKey: "name", header: "Name" },
	{ accessorKey: "status", header: "Status" },
];

const ROWS: Row[] = [
	{ id: "a", name: "alpha", status: "ok" },
	{ id: "b", name: "bravo", status: "ok" },
];

/** A query-shaped fixture: settled, successful, with no data unless given. */
function q(over: Partial<DataTableQuery> = {}): DataTableQuery {
	return { isLoading: false, isError: false, data: undefined, refetch: vi.fn(), ...over };
}

/** The body state DataTable stamped on its frame. */
function frameState(container: HTMLElement): string | null {
	return container.querySelector("[data-state]")?.getAttribute("data-state") ?? null;
}

describe("DataTable body states", () => {
	it("loading: keeps the real header, draws placeholder rows, and never the empty message", () => {
		const { container } = render(
			<DataTable
				columns={COLUMNS}
				data={[]}
				query={q({ isLoading: true })}
				skeletonRows={4}
				emptyMessage="Nothing here"
			/>,
		);
		expect(screen.queryByText("Nothing here")).toBeNull();
		expect(screen.getByRole("columnheader", { name: /Name/ })).toBeInTheDocument();
		const placeholders = container.querySelectorAll('[data-slot="data-table-skeleton-row"]');
		expect(placeholders).toHaveLength(4);
		// One placeholder cell per real column, so the row has the table's own geometry.
		expect(placeholders[0]?.querySelectorAll("td")).toHaveLength(COLUMNS.length);
		expect(container.querySelector("tbody")?.getAttribute("aria-busy")).toBe("true");
		expect(frameState(container)).toBe("pending");
	});

	it("loading with the default row count still draws placeholders", () => {
		const { container } = render(
			<DataTable columns={COLUMNS} data={[]} query={q({ isLoading: true })} />,
		);
		expect(container.querySelectorAll('[data-slot="data-table-skeleton-row"]')).toHaveLength(6);
		expect(screen.queryByText("No results.")).toBeNull();
	});

	it("answered with nothing: the empty message, and no placeholders", () => {
		const { container } = render(
			<DataTable columns={COLUMNS} data={[]} query={q({ data: [] })} emptyMessage="Nothing here" />,
		);
		expect(screen.getByText("Nothing here")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="data-table-skeleton-row"]')).toBeNull();
		expect(container.querySelector("tbody")?.hasAttribute("aria-busy")).toBe(false);
		expect(frameState(container)).toBe("ready");
	});

	it("a REAL disabled query settles to the empty row, not an endless skeleton", async () => {
		const client = new QueryClient();
		let seen: { isPending: boolean; isLoading: boolean } | null = null;
		/** Feeds DataTable a real TanStack result for a query that never runs. */
		function Harness() {
			const query = useQuery({ queryKey: ["disabled"], queryFn: () => ROWS, enabled: false });
			seen = { isPending: query.isPending, isLoading: query.isLoading };
			return (
				<DataTable columns={COLUMNS} data={query.data ?? []} query={query} emptyMessage="Nothing here" />
			);
		}
		const { container } = render(
			<QueryClientProvider client={client}>
				<Harness />
			</QueryClientProvider>,
		);
		await waitFor(() => expect(screen.getByText("Nothing here")).toBeInTheDocument());
		// The premise, measured rather than assumed: v5 reports a disabled query as pending.
		expect(seen).toEqual({ isPending: true, isLoading: false });
		expect(container.querySelector('[data-slot="data-table-skeleton-row"]')).toBeNull();
	});

	it("failed first load: an error state with a retry, never the empty message", () => {
		const refetch = vi.fn();
		const { container } = render(
			<DataTable
				columns={COLUMNS}
				data={[]}
				query={q({ isError: true, refetch })}
				emptyMessage="Nothing here"
			/>,
		);
		expect(screen.queryByText("Nothing here")).toBeNull();
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("data-state")).toBe("error");
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
		expect(frameState(container)).toBe("error");
	});

	it("an error wins over loading, so a failure is never an endless skeleton", () => {
		const { container } = render(
			<DataTable columns={COLUMNS} data={[]} query={q({ isLoading: true, isError: true })} />,
		);
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="data-table-skeleton-row"]')).toBeNull();
	});

	it("failed refresh behind rows: the rows stay, under a notice with its own retry", () => {
		const refetch = vi.fn();
		const { container } = render(
			<DataTable columns={COLUMNS} data={ROWS} query={q({ isError: true, data: ROWS, refetch })} />,
		);
		expect(screen.getByText("alpha")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		const notice = screen.getByRole("status");
		expect(notice.textContent).toContain("Couldn't refresh");
		fireEvent.click(within(notice).getByRole("button", { name: "Try again" }));
		expect(refetch).toHaveBeenCalledTimes(1);
		expect(frameState(container)).toBe("ready");
	});

	it("rows: the data, with no error, no notice and no placeholders", () => {
		render(<DataTable columns={COLUMNS} data={ROWS} query={q({ data: ROWS })} />);
		expect(screen.getByText("alpha")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("hides the paging footer while the first load fails", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `r${i}`, status: "ok" }));
		const ready = render(<DataTable columns={COLUMNS} data={many} pageSize={10} />);
		expect(within(ready.container).getByText(/Page 1 of 3/)).toBeInTheDocument();
		ready.unmount();
		const failed = render(
			<DataTable columns={COLUMNS} data={many} pageSize={10} query={q({ isError: true })} />,
		);
		expect(within(failed.container).queryByText(/Page 1 of/)).toBeNull();
	});
});

describe("DataTable full-width rows with grouped columns", () => {
	// One top-level def holding two leaf columns, plus one plain column: three header cells wide.
	const GROUPED: ColumnDef<Row>[] = [
		{
			id: "who",
			header: "Who",
			columns: [
				{ accessorKey: "name", header: "Name" },
				{ accessorKey: "id", header: "Id" },
			],
		},
		{ accessorKey: "status", header: "Status" },
	];

	it("the empty row spans every leaf column", () => {
		render(<DataTable columns={GROUPED} data={[]} />);
		expect(screen.getByText("No results.").getAttribute("colspan")).toBe("3");
	});

	it("placeholder rows draw one cell per leaf column", () => {
		const { container } = render(
			<DataTable columns={GROUPED} data={[]} query={q({ isLoading: true })} skeletonRows={1} />,
		);
		const row = container.querySelector('[data-slot="data-table-skeleton-row"]');
		expect(row?.querySelectorAll("td")).toHaveLength(3);
	});

	it("the error row spans every leaf column", () => {
		render(<DataTable columns={GROUPED} data={[]} query={q({ isError: true })} />);
		expect(screen.getByRole("alert").closest("td")?.getAttribute("colspan")).toBe("3");
	});
});
