// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A table row must not generate a box that takes part in table layout (#6237).
//
// THE DEFECT. `TableRow` carried `.vx-clamp`, whose corner marks are an absolutely positioned
// `::before` on the element that carries the class. On a `<tr>` that pseudo-element is a child of
// the row, and Chrome lays it out as a leading anonymous table cell. In a `<colgroup>` table the
// phantom cell took the first `<col>`'s width and every real column shifted one slot right
// (measured for #6235: a 128px column starting at x=283, a 36px column overprinting its neighbour).
//
// WHAT THIS CAN AND CANNOT SEE. jsdom does no layout and does not apply tokens.css, so it cannot
// measure where a column starts. What decides it is two facts this file CAN read:
//   1. whether the row's own `::before` is suppressed — the row's class list, and the rule in
//      tokens.css that the suppressing class resolves to (declared AFTER the rule that generates the
//      pseudo-element, at equal specificity, so it wins);
//   2. that the marks are drawn by the first CELL's `::before`, a child of a cell, which is not a
//      table-row child and so cannot become an anonymous cell.
// Plus the structural half: every row's element children are cells, as many as the header has and
// as the `<colgroup>` declares. The release gate's audit leg measures real tables in a browser.

import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "../src/table";

const TOKENS = join(dirname(fileURLToPath(import.meta.url)), "../../brand/src/tokens.css");
const CSS = readFileSync(TOKENS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The offset of the first rule whose selector list contains `selector`, or -1. */
function ruleAt(selector: string): number {
	const re = new RegExp(`(^|[\\s,}])${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[,{]`);
	const m = re.exec(CSS);
	return m ? m.index : -1;
}

/** The declaration body of the first rule whose selector list contains `selector`. */
function ruleBody(selector: string): string {
	const at = ruleAt(selector);
	if (at < 0) throw new Error(`tokens.css has no rule for ${selector}`);
	const open = CSS.indexOf("{", at);
	return CSS.slice(open + 1, CSS.indexOf("}", open));
}

/** A three-column table with an explicit column list, the shape #6235 had to abandon. */
function ColgroupTable() {
	return (
		<Table className="table-fixed">
			<colgroup>
				<col style={{ width: "50%" }} />
				<col style={{ width: "128px" }} />
				<col style={{ width: "36px" }} />
			</colgroup>
			<TableHeader>
				<TableRow>
					<TableHead>Environment</TableHead>
					<TableHead>Verify</TableHead>
					<TableHead>Checked</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow>
					<TableCell>production</TableCell>
					<TableCell>pass</TableCell>
					<TableCell>2m</TableCell>
				</TableRow>
				<TableRow data-clamped="">
					<TableCell>staging</TableCell>
					<TableCell>fail</TableCell>
					<TableCell>1h</TableCell>
				</TableRow>
			</TableBody>
		</Table>
	);
}

/** Every `TableRow` rendered in `root`. */
function rows(root: HTMLElement): HTMLTableRowElement[] {
	return [...root.querySelectorAll<HTMLTableRowElement>('tr[data-slot="table-row"]')];
}

describe("TableRow generates no table-layout box of its own (#6237)", () => {
	it("tokens.css: .vx-clamp-none suppresses the clamp's ::before, and wins over the base rule", () => {
		expect(ruleBody(".vx-clamp-none::before")).toMatch(/content\s*:\s*none/);
		const base = ruleAt(".vx-clamp::before");
		expect(base).toBeGreaterThanOrEqual(0);
		// Equal specificity (one class, one pseudo-element), so source order decides.
		expect(ruleAt(".vx-clamp-none::before")).toBeGreaterThan(base);
	});

	it("every row suppresses its own ::before", () => {
		const { container } = render(<ColgroupTable />);
		const all = rows(container);
		expect(all).toHaveLength(3);
		for (const tr of all) expect(tr.classList).toContain("vx-clamp-none");
	});

	it("a consumer className cannot drop the suppression", () => {
		const { container } = render(
			<Table>
				<TableBody>
					<TableRow className="vx-clamp hover:bg-transparent">
						<TableCell>x</TableCell>
					</TableRow>
				</TableBody>
			</Table>,
		);
		expect(rows(container)[0].classList).toContain("vx-clamp-none");
	});

	it("every row's children are cells, as many as the header and the <colgroup> declare", () => {
		const { container } = render(<ColgroupTable />);
		const cols = container.querySelectorAll("colgroup > col").length;
		const head = container.querySelectorAll("thead th").length;
		expect(cols).toBe(3);
		expect(head).toBe(cols);
		for (const tr of rows(container)) {
			const kids = [...tr.children].map((c) => c.tagName);
			expect(kids).toHaveLength(cols);
			for (const tag of kids) expect(["TD", "TH"]).toContain(tag);
		}
	});

	it("the marks are drawn by the row's first CELL, positioned against the row", () => {
		const { container } = render(<ColgroupTable />);
		const table = container.querySelector('table[data-slot="table"]');
		if (!(table instanceof HTMLTableElement)) throw new Error("no table");
		const classes = table.className.split(/\s+/);
		const cell = "[&_[data-slot=table-row]>:first-child]:before:";
		expect(classes).toContain(`${cell}absolute`);
		expect(classes).toContain(`${cell}inset-[calc(-1*var(--cl-gap))]`);
		expect(classes).toContain(`${cell}opacity-0`);
		expect(classes.some((c) => c.startsWith(`${cell}[mask:`))).toBe(true);
		expect(classes).toContain("[&_[data-slot=table-row]:hover>:first-child]:before:opacity-[var(--cl-op)]");
		// Nothing on the table draws a pseudo-element on the ROW itself.
		expect(classes.filter((c) => /\[data-slot=table-row\][^>]*\]:before:/.test(c))).toEqual([]);
		// The row stays the containing block the cell's marks resolve against.
		expect(ruleBody(".vx-clamp")).toMatch(/position\s*:\s*relative/);
		for (const tr of rows(container)) expect(tr.classList).toContain("vx-clamp");
	});
});
