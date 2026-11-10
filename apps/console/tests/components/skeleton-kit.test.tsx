// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The skeleton kit draws the shapes of the components it stands in for (#6117).
//
// jsdom does no layout, so these assert STRUCTURE: the table skeleton is built from the same
// frame and table primitives as `DataTable`, with the column and row counts asked for; the
// settings skeleton draws one section per entry with that many label | control rows. And the
// kit no longer exports a title skeleton, because the console has no page titles.

import { render } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";

import { DataTable } from "@/components/data-table";
import { DataTableSkeleton } from "@/components/skeletons/data-table-skeleton";
import * as kit from "@/components/skeletons/page-skeletons";
import { SettingsColumnsSkeleton } from "@/components/skeletons/page-skeletons";

describe("DataTableSkeleton", () => {
	it("draws the asked-for columns and rows inside DataTable's own frame", () => {
		const { container } = render(<DataTableSkeleton columns={5} rows={3} />);
		expect(container.querySelectorAll("thead th")).toHaveLength(5);
		const rows = container.querySelectorAll("tbody tr");
		expect(rows).toHaveLength(3);
		expect(rows[0]?.querySelectorAll("td")).toHaveLength(5);

		const columns: ColumnDef<{ id: string }>[] = [{ accessorKey: "id", header: "Id" }];
		const real = render(<DataTable columns={columns} data={[]} />).container;
		const realFrame = real.querySelector("[data-state]");
		const skelFrame = container.querySelector('[data-slot="data-table-skeleton"]')?.firstElementChild;
		expect(skelFrame?.className).toBe(realFrame?.className);
		// The same table primitive underneath, so the cell padding is the table's own.
		expect(container.querySelector('[data-slot="table-container"]')).not.toBeNull();
	});

	it("is hidden from assistive technology", () => {
		const { container } = render(<DataTableSkeleton />);
		expect(container.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
	});
});

describe("SettingsColumnsSkeleton", () => {
	it("draws one section per entry, each with that many field rows", () => {
		const { container } = render(<SettingsColumnsSkeleton sections={[4, 2]} />);
		const root = container.firstElementChild;
		// The same two-up grid as `SettingsColumns`.
		expect(root?.className).toContain("lg:grid-cols-2");
		const sections = root ? [...root.children] : [];
		expect(sections).toHaveLength(2);
		const rowsIn = (s: Element) => s.querySelectorAll(".py-1 > div").length;
		expect(sections.map(rowsIn)).toEqual([4, 2]);
	});
});

describe("the kit", () => {
	it("has no title skeleton", () => {
		expect(Object.keys(kit)).not.toContain("HeaderSkeleton");
		expect(Object.keys(kit)).not.toContain("TableSkeleton");
	});
});
