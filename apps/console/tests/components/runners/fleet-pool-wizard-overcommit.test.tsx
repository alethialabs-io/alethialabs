// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the fleet-pool wizard renders from the whole form it watches: a per-location floor that
// needs more runners than the maximum is said on the Capacity step, and raising the maximum clears
// it. The values are watched by the wizard engine, so this pins that an edit on one step still
// reaches what a later step renders.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/fleet", () => ({
	createFleetPoolAction: vi.fn(),
	updateFleetPoolAction: vi.fn(),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/lib/query/topics", () => ({ TOPIC_KEYS: { fleet: () => [["fleet"]] } }));
vi.mock("@/lib/query/use-fleet-query", () => ({
	useFleetQuery: () => ({ data: { configs: [] }, isError: false }),
}));
vi.mock("@/lib/rpc/client", () => ({
	orpc: {
		connectors: {
			board: {
				queryOptions: () => ({
					queryKey: ["connectors", "board"],
					queryFn: async () => ({ offeredClouds: ["hetzner"] }),
				}),
			},
		},
	},
}));
vi.mock("@/lib/wizard/location", async () => {
	const harness = await import("@/tests/components/runners/fleet-pool-wizard-harness");
	return { useWizardEnvironment: harness.useTestWizardEnvironment };
});

import { FleetPoolWizard } from "@/components/runners/fleet-pool-wizard";
import { resetTestPage } from "@/tests/components/runners/fleet-pool-wizard-harness";

beforeEach(() => {
	resetTestPage();
});

describe("FleetPoolWizard — the overcommit notice follows the watched values", () => {
	it("warns when the floor × locations exceeds the max, and clears when the max is raised", async () => {
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<FleetPoolWizard open onOpenChange={() => {}} pool={null} usedProviders={[]} />
			</QueryClientProvider>,
		);

		// Cloud → Placement: two locations, and a floor of 6 in each.
		await waitFor(() => expect(screen.getByRole("button", { name: "Next" })).toBeEnabled());
		await user.click(screen.getByRole("button", { name: "Next" }));
		const locations = await screen.findByLabelText(/^Locations/);
		await user.clear(locations);
		await user.type(locations, "fsn1, nbg1");
		const floor = screen.getByRole("spinbutton", { name: /Minimum per location/ });
		await user.clear(floor);
		await user.type(floor, "6");

		// Placement → Capacity: 6 × 2 = 12 runners, over the default max of 10.
		await user.click(screen.getByRole("button", { name: "Next" }));
		expect(await screen.findByText(/needs 12\s+runners — above your max of 10/)).toBeInTheDocument();

		const max = screen.getByRole("spinbutton", { name: /^Maximum/ });
		await user.clear(max);
		await user.type(max, "20");
		expect(screen.queryByText(/above your max of/)).toBeNull();
	});
});
