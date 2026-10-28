// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The posture table's column widths (#6126, F019). jsdom does no layout, so the defect itself — in
// Chrome the shared `TableRow`'s hover-mark `::before` lays out as a leading anonymous cell, and an
// explicit `<colgroup>` hands that phantom cell the first width, shifting every column one to the
// right — was measured in headless Chrome (the PR states the numbers). What a unit test CAN hold is
// the structure that fix depends on:
//   · neither the posture table, the waivers table nor the loading skeleton declares a `<colgroup>`;
//   · the widths sit on the HEADER cells, in table order, the environment column unsized so it takes
//     the rest — and the skeleton's header cells carry exactly the table's;
//   · the environment cell's content contributes no width (`w-0 min-w-full`), so a long name
//     truncates instead of widening the table.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useParams: () => ({ org: "acme" }) }));

const { EvidenceTable } = await import("@/components/evidence/evidence-table");
const { EvidenceSkeleton } = await import("@/components/evidence/evidence-skeleton");
const { EvidenceWaivers } = await import("@/components/evidence/evidence-waivers");
const { EVIDENCE_COLUMNS } = await import("@/components/evidence/evidence-layout");
import type { RowGroup } from "@/components/evidence/evidence-derive";

const LONG = "development-environment-with-a-name-far-wider-than-its-column";

const GROUPS: RowGroup[] = [
	{
		key: "p1",
		label: "payments",
		provider: "aws",
		rows: [
			{
				projectId: "p1",
				projectName: "payments",
				projectSlug: "payments",
				environmentId: "e1",
				environmentName: LONG,
				stage: "development",
				provider: "aws",
				region: "eu-west-1",
				verify: null,
				drift: null,
				security: null,
			},
		],
	},
];

/** The width class each header cell carries, in order (`""` for an unsized one). */
function headerWidths(root: HTMLElement): string[] {
	return [...root.querySelectorAll("thead th")].map(
		(th) => th.className.split(/\s+/).find((c) => /^w-\[/.test(c)) ?? "",
	);
}

const EXPECTED = [
	EVIDENCE_COLUMNS.environment,
	EVIDENCE_COLUMNS.verify,
	EVIDENCE_COLUMNS.drift,
	EVIDENCE_COLUMNS.security,
	EVIDENCE_COLUMNS.receipt,
	EVIDENCE_COLUMNS.checked,
	EVIDENCE_COLUMNS.open,
];

describe("evidence column widths (F019)", () => {
	it("the posture table declares no <colgroup>; widths sit on its header cells, environment unsized", () => {
		const { container } = render(<EvidenceTable groups={GROUPS} onOpen={() => {}} />);
		expect(container.querySelector("colgroup")).toBeNull();
		expect(headerWidths(container)).toEqual(EXPECTED);
		expect(EXPECTED[0]).toBe("");
	});

	it("the environment cell's content cannot widen its column", () => {
		const { getByRole } = render(<EvidenceTable groups={GROUPS} onOpen={() => {}} />);
		const wrapper = getByRole("button", { name: LONG }).closest("td")?.firstElementChild;
		expect(wrapper?.className).toMatch(/(^|\s)w-0(\s|$)/);
		expect(wrapper?.className).toMatch(/(^|\s)min-w-full(\s|$)/);
	});

	it("the loading skeleton draws the table's own header cells, widths and all", () => {
		const { container } = render(<EvidenceSkeleton />);
		expect(container.querySelector("colgroup")).toBeNull();
		expect(headerWidths(container)).toEqual(EXPECTED);
	});

	it("the waivers table declares no <colgroup> and leaves its prose column unsized", () => {
		const { container } = render(
			<EvidenceWaivers
				org="acme"
				waivers={[
					{
						jobId: "j1",
						projectName: "payments",
						environmentName: "prod",
						controls: ["KEYLESS-001"],
						reason: "window",
						by: "admin@example.test",
						expiry: null,
						active: true,
						createdAt: "2026-10-01T00:00:00.000Z",
					},
				]}
			/>,
		);
		expect(container.querySelector("colgroup")).toBeNull();
		expect(headerWidths(container)).toEqual(["w-[24%]", "", "w-[170px]", "w-[128px]"]);
	});
});
