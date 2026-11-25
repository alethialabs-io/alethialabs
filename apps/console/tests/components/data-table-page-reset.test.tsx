// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A CONTROLLED page index is written only when a person pages (#7673).
//
// TanStack resets the page index whenever `data` changes, and reports that through
// `onPaginationChange`. `~/clusters` and `~/settings/members` turned the report into a page-URL
// write built from the search params they rendered with. On a facet click those params do not
// carry the new facet yet, so that write landed after `useFilterUrlSync`'s and dropped the facet
// from the URL: the list narrowed, the link did not (F8 `applied: false`). New data must therefore
// call `onPageIndexChange` NOT AT ALL, and a real page change must still call it exactly once.

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it, vi } from "vitest";
import { DataTable } from "@/components/data-table";

interface Row {
	id: string;
	name: string;
}

const columns: ColumnDef<Row, unknown>[] = [{ accessorKey: "name", header: "Name" }];

/** `n` rows named r0…r(n-1). */
function rows(n: number): Row[] {
	return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `r${i}` }));
}

describe("DataTable — controlled page index", () => {
	it("does not report a page change when only the data changes (a filter narrowed it)", async () => {
		const onPageIndexChange = vi.fn();
		const { rerender } = render(<DataTable columns={columns} data={rows(30)} pageSize={10} pageIndex={0} onPageIndexChange={onPageIndexChange} />);
		// TanStack QUEUES its auto-reset on a microtask, so each data change is flushed before the
		// assertion — without the flush this test passed on the broken table too.
		for (const n of [12, 25]) {
			rerender(<DataTable columns={columns} data={rows(n)} pageSize={10} pageIndex={0} onPageIndexChange={onPageIndexChange} />);
			await act(async () => {
				await new Promise((resolve) => setTimeout(resolve, 0));
			});
		}
		expect(onPageIndexChange).not.toHaveBeenCalled();
	});

	it("still reports a page the reader asks for, once", () => {
		const onPageIndexChange = vi.fn();
		render(<DataTable columns={columns} data={rows(30)} pageSize={10} pageIndex={0} onPageIndexChange={onPageIndexChange} />);
		fireEvent.click(screen.getByRole("button", { name: "Next page" }));
		expect(onPageIndexChange).toHaveBeenCalledTimes(1);
		expect(onPageIndexChange).toHaveBeenCalledWith(1);
	});

	it("marks each real row as a list item, and nothing else (#7673)", () => {
		const { container } = render(<DataTable columns={columns} data={rows(3)} pageSize={10} />);
		expect(container.querySelectorAll("[data-list-item]")).toHaveLength(3);
		const { container: empty } = render(<DataTable columns={columns} data={[]} pageSize={10} />);
		expect(empty.querySelectorAll("[data-list-item]")).toHaveLength(0);
	});
});
