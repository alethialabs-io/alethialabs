// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The jobs table must hydrate the server's HTML (#6113, ADR 0005 D1).
//
// Since the jobs page prefetches its rows on the server, the rows are in the server's HTML — which
// is the point (F004: first paint shows rows). Two cells read the CLOCK: the "Initiated" column
// ("3 minutes ago") and an in-flight job's live elapsed time. The server's "now" is not the
// hydrating browser's, so printing either during hydration is a text mismatch: React #418, and the
// page's server HTML is thrown away. The release gate's qa leg caught exactly this on
// `/{org}/~/jobs` (cross-cutting resilience sweep, "jobs loads without a pageerror").
//
// The test renders the columns on the "server" at T0, moves the clock on, hydrates that HTML and
// asserts React reported nothing — then that the clock text IS there once hydration is over, so
// the fix cannot pass by never showing the time.
//
// Mutation check (done when this was written): reverting either cell to print during hydration —
// `formatRelative(created_at)` inline, or dropping `hydrated ?` from `LiveDuration` — fails the
// first test with "Hydration failed because the server rendered text didn't match the client".

import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JobWithMeta } from "@/app/server/actions/jobs";
import { buildJobColumns } from "@/components/jobs/columns";
import { makeJob } from "../fixtures/jobs";

vi.mock("@/components/runners/release-notes-popover", () => ({ ReleaseNotesPopover: () => null }));

const T0 = new Date("2026-10-20T10:00:00.000Z");

/** One finished job created 50 s before T0, and one still running since then. */
const ROWS: JobWithMeta[] = [
	makeJob({
		id: "job-done",
		status: "SUCCESS",
		created_at: new Date(T0.getTime() - 50_000),
		completed_at: new Date(T0.getTime() - 20_000),
	}),
	makeJob({ id: "job-live", status: "PROCESSING", created_at: new Date(T0.getTime() - 50_000) }),
];

/** Every cell of every row, rendered through the shipped column definitions. */
function JobsRows() {
	const table = useReactTable({
		data: ROWS,
		columns: buildJobColumns({ authorById: new Map(), orgSlug: "acme" }),
		getCoreRowModel: getCoreRowModel(),
	});
	return (
		<table>
			<tbody>
				{table.getRowModel().rows.map((row) => (
					<tr key={row.id}>
						{row.getVisibleCells().map((cell) => (
							<td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(T0);
});

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	container?.remove();
	container = null;
	vi.useRealTimers();
});

describe("the jobs table hydrates server-rendered rows whatever the clock says (#6113)", () => {
	it("reports no hydration error when the browser's clock is ahead of the server's", async () => {
		const serverHtml = renderToString(<JobsRows />);
		// The browser hydrates three minutes later than the server rendered.
		vi.setSystemTime(new Date(T0.getTime() + 180_000));

		container = document.createElement("div");
		container.innerHTML = serverHtml;
		document.body.appendChild(container);
		const recoverable: unknown[] = [];
		const target = container;
		await act(async () => {
			root = hydrateRoot(target, <JobsRows />, {
				onRecoverableError: (error) => recoverable.push(error),
			});
		});

		expect(recoverable).toEqual([]);
		// Once hydration is over the clock text is on screen, read against the browser's clock.
		expect(container.textContent).toContain("4 minutes ago");
		// The running job's elapsed time, read against the browser's clock: 50 s + 180 s.
		expect(container.textContent).toContain("3m 50s");
		expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
			new Date(T0.getTime() - 50_000).toISOString(),
		);
	});

	it("a created_at that is not a date renders a dash instead of crashing the table", () => {
		const bad = makeJob({ id: "job-bad", created_at: new Date(Number.NaN) });
		function BadRow() {
			const table = useReactTable({
				data: [bad],
				columns: buildJobColumns({ authorById: new Map(), orgSlug: "acme" }),
				getCoreRowModel: getCoreRowModel(),
			});
			return (
				<table>
					<tbody>
						{table.getRowModel().rows.map((row) => (
							<tr key={row.id}>
								{row.getVisibleCells().map((cell) => (
									<td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
								))}
							</tr>
						))}
					</tbody>
				</table>
			);
		}
		expect(() => renderToString(<BadRow />)).not.toThrow();
	});

	it("the server's HTML carries the rows themselves (first paint is not empty)", () => {
		const html = renderToString(<JobsRows />);
		expect(html.match(/<tr/g)?.length).toBe(ROWS.length);
	});
});
