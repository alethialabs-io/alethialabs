// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #7738: the runners list's toolbar is the one-row `ListToolbar` — search, the five facets
// (Cloud, Status, Operator, Region, Version), the mono Reset and the section's buttons pushed right.
// It reads and writes the page's filter store; the counts come from the unfiltered set.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNNER_FILTERS } from "@/components/runners/runners-query";
import { RunnersToolbar } from "@/components/runners/runners-toolbar";
import { useRunnerFilters } from "@/lib/stores/use-runner-filters";

/** Renders the toolbar with a small facet universe and one action. */
function renderToolbar() {
	return render(
		<RunnersToolbar
			cloudOptions={[{ value: "aws", label: "AWS", count: 3 }]}
			regionOptions={[{ value: "eu-central-1", label: "eu-central-1", count: 2 }]}
			versionOptions={[{ value: "1.2.0", label: "v1.2.0", count: 1 }]}
			actions={<button type="button">Add runner</button>}
		/>,
	);
}

beforeEach(() => {
	useRunnerFilters.setState({ filters: DEFAULT_RUNNER_FILTERS });
});

describe("RunnersToolbar", () => {
	it("is one row: the search first, the five facets, and the action in the right-aligned group", () => {
		renderToolbar();
		expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		const row = document.querySelector('[data-slot="filter-search"]')?.parentElement;
		expect(row?.firstElementChild?.getAttribute("data-slot")).toBe("filter-search");
		for (const name of ["Cloud", "Status", "Operator", "Region", "Version"]) {
			expect(screen.getByRole("button", { name })).toBeInTheDocument();
		}
		const end = row?.querySelector('[data-slot="list-toolbar-end"]');
		expect(end?.textContent).toBe("Add runner");
		expect(screen.queryByRole("button", { name: /^Reset/ })).toBeNull();
	});

	it("a facet option carries its count from the unfiltered set", async () => {
		renderToolbar();
		await userEvent.click(screen.getByRole("button", { name: "Cloud" }));
		expect(await screen.findByRole("option", { name: "AWS, 3" })).toBeInTheDocument();
	});

	it("a selected status names itself, and its own × clears just that facet", async () => {
		useRunnerFilters.setState({ filters: { ...DEFAULT_RUNNER_FILTERS, statuses: ["DRAINING"], regions: ["eu-central-1"] } });
		renderToolbar();
		expect(screen.getByRole("button", { name: "Status: Draining" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Reset · 2" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Clear Status" }));
		expect(useRunnerFilters.getState().filters.statuses).toEqual([]);
		expect(useRunnerFilters.getState().filters.regions).toEqual(["eu-central-1"]);
	});

	it("more than two selected reads as a count", () => {
		useRunnerFilters.setState({ filters: { ...DEFAULT_RUNNER_FILTERS, statuses: ["ONLINE", "OFFLINE", "DRAINING"] } });
		renderToolbar();
		expect(screen.getByRole("button", { name: "Status 3 selected" })).toBeInTheDocument();
	});

	it("Reset clears every filter", async () => {
		useRunnerFilters.setState({ filters: { ...DEFAULT_RUNNER_FILTERS, search: "edge", operators: ["managed"] } });
		renderToolbar();
		await userEvent.click(screen.getByRole("button", { name: "Reset · 2" }));
		expect(useRunnerFilters.getState().filters).toEqual(DEFAULT_RUNNER_FILTERS);
	});
});
