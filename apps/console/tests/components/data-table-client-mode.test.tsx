// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// DataTable's CLIENT mode renders every row it is given and does not page (LST-14, #7496).
//
// It used to page by default — 20 rows, a "N total · Page N of M" footer and a rows-per-page
// picker — and to offer a "Showing N of M · Show more" window. The list standard retired both
// (epic #7481): a list read from the server pages through `keyset=`, and a list the client holds
// whole is shown whole. These assert the retired footers cannot come back unnoticed.

import { render, screen } from "@testing-library/react";
import type { ColumnDef } from "@tanstack/react-table";
import { describe, expect, it } from "vitest";
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

describe("DataTable — client mode", () => {
	it("renders every row, past the 20 it used to page at", () => {
		const { container } = render(<DataTable columns={columns} data={rows(45)} />);
		expect(container.querySelectorAll("[data-list-item]")).toHaveLength(45);
		expect(screen.getByText("r44")).toBeInTheDocument();
	});

	it("draws no page numbers, no rows-per-page picker, no total and no Show more", () => {
		render(<DataTable columns={columns} data={rows(45)} />);
		expect(screen.queryByText(/Page \d+ of/)).toBeNull();
		expect(screen.queryByText(/\btotal\b/)).toBeNull();
		expect(screen.queryByText(/Showing \d+ of/)).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
		expect(screen.queryByRole("button", { name: /Next page|Previous page|Show more/ })).toBeNull();
	});

	it("marks each real row as a list item, and nothing else (#7673)", () => {
		const { container } = render(<DataTable columns={columns} data={rows(3)} />);
		expect(container.querySelectorAll("[data-list-item]")).toHaveLength(3);
		const { container: empty } = render(<DataTable columns={columns} data={[]} />);
		expect(empty.querySelectorAll("[data-list-item]")).toHaveLength(0);
	});
});
