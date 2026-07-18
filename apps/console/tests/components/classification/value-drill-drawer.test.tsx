// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Locks the fetch-error UX for the value drill-down drawer (#713). The dangerous case: on a fetch
// failure the drawer must NOT render "No resources use this value. Unused values are safe to delete"
// — that would invite deleting a value that may actually be in use. It must surface the error + a
// retry instead.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ValueDTO } from "@/app/server/actions/classification/dimensions";
import { ValueDrillDrawer } from "@/components/classification/value-drill-drawer";

const { getValueResourceBreakdown } = vi.hoisted(() => ({
	getValueResourceBreakdown: vi.fn(),
}));
vi.mock("@/app/server/actions/classification/assignments", () => ({
	getValueResourceBreakdown,
}));

/** Renders under a fresh QueryClient (retries off so a mock rejection fails fast). */
function render(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return rtlRender(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const VALUE: ValueDTO = {
	id: "v1",
	dimension_id: "d1",
	value: "production",
	label: "Production",
	color: null,
	enforcement: null,
	position: 0,
	assignmentCount: 3,
};

describe("ValueDrillDrawer fetch-error state", () => {
	it("shows an error + retry (never 'safe to delete') when the breakdown fetch fails", async () => {
		getValueResourceBreakdown.mockRejectedValue(new Error("boom"));
		render(
			<ValueDrillDrawer value={VALUE} dimensionLabel="Environment" onClose={() => {}} />,
		);

		await waitFor(() =>
			expect(
				screen.getByText(/Couldn't load which resources use this value/i),
			).toBeInTheDocument(),
		);
		// The misleading "unused → safe to delete" copy must NOT appear on a fetch failure.
		expect(screen.queryByText(/safe to delete/i)).not.toBeInTheDocument();
		expect(screen.queryByText(/No resources use this value/i)).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
	});

	it("shows the unused-value empty state when the fetch succeeds with no resources", async () => {
		getValueResourceBreakdown.mockResolvedValue([]);
		render(
			<ValueDrillDrawer value={VALUE} dimensionLabel="Environment" onClose={() => {}} />,
		);

		await waitFor(() =>
			expect(screen.getByText(/No resources use this value/i)).toBeInTheDocument(),
		);
		expect(screen.getByText(/safe to delete/i)).toBeInTheDocument();
	});
});
