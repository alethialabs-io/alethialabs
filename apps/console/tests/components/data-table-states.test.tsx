// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DataTable's four bodies are four different renders (#6117, F004).
//
// The defect: a table whose first load had not answered said "No results.", then filled with 14
// rows. Empty and still-loading are different answers about the data. These tests lock that the
// empty row appears ONLY when the read answered with nothing, that a pending table keeps its real
// header over placeholder rows, and that a failed read is an error with a retry, never the empty
// row and never an endless skeleton.

import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";

import { DataTable } from "@/components/data-table";

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

/** The body state DataTable stamped on its frame. */
function frameState(container: HTMLElement): string | null {
	return container.querySelector("[data-state]")?.getAttribute("data-state") ?? null;
}

describe("DataTable body states", () => {
	it("pending: keeps the real header, draws placeholder rows, and never the empty message", () => {
		const { container } = render(
			<DataTable columns={COLUMNS} data={[]} isPending skeletonRows={4} emptyMessage="Nothing here" />,
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

	it("pending with the default row count still draws placeholders", () => {
		const { container } = render(<DataTable columns={COLUMNS} data={[]} isPending />);
		expect(container.querySelectorAll('[data-slot="data-table-skeleton-row"]')).toHaveLength(6);
		expect(screen.queryByText("No results.")).toBeNull();
	});

	it("answered with nothing: the empty message, and no placeholders", () => {
		const { container } = render(
			<DataTable columns={COLUMNS} data={[]} emptyMessage="Nothing here" />,
		);
		expect(screen.getByText("Nothing here")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="data-table-skeleton-row"]')).toBeNull();
		expect(container.querySelector("tbody")?.hasAttribute("aria-busy")).toBe(false);
		expect(frameState(container)).toBe("ready");
	});

	it("error: an error state with a retry, never the empty message", () => {
		const onRetry = vi.fn();
		const { container } = render(
			<DataTable
				columns={COLUMNS}
				data={[]}
				error={new Error("connection refused at 10.0.0.1")}
				onRetry={onRetry}
				emptyMessage="Nothing here"
			/>,
		);
		expect(screen.queryByText("Nothing here")).toBeNull();
		const alert = screen.getByRole("alert");
		expect(alert.getAttribute("data-state")).toBe("error");
		// The raw error text is not shown: it can carry server detail.
		expect(screen.queryByText(/connection refused/)).toBeNull();
		fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
		expect(frameState(container)).toBe("error");
	});

	it("error wins over pending, so a failure is never an endless skeleton", () => {
		const { container } = render(
			<DataTable columns={COLUMNS} data={[]} isPending error={new Error("x")} />,
		);
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(container.querySelector('[data-slot="data-table-skeleton-row"]')).toBeNull();
	});

	it("error wins over stale rows, so a failed refetch says it failed", () => {
		render(<DataTable columns={COLUMNS} data={ROWS} error="boom" />);
		expect(screen.getByRole("alert")).toBeInTheDocument();
		expect(screen.queryByText("alpha")).toBeNull();
	});

	it("rows: the data, with no error and no placeholders", () => {
		render(<DataTable columns={COLUMNS} data={ROWS} error={null} isPending={false} />);
		expect(screen.getByText("alpha")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("hides the paging footer while pending or failed", () => {
		const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `r${i}`, status: "ok" }));
		const ready = render(<DataTable columns={COLUMNS} data={many} pageSize={10} />);
		expect(within(ready.container).getByText(/Page 1 of 3/)).toBeInTheDocument();
		ready.unmount();
		const failed = render(<DataTable columns={COLUMNS} data={many} pageSize={10} error="x" />);
		expect(within(failed.container).queryByText(/Page 1 of/)).toBeNull();
	});
});
