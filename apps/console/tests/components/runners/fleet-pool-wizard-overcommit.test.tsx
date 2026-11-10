// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — the fleet-pool wizard renders from the whole form it watches: a per-location floor that
// needs more runners than the maximum is said on the Capacity step, and raising the maximum clears
// it. The wizard reads its values through `useWatch`, so this pins that an edit on one step still
// reaches what a later step renders.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/query/use-fleet-query", () => ({
	useCreatePool: () => ({ mutateAsync: vi.fn() }),
	useUpdatePool: () => ({ mutateAsync: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { FleetPoolWizard } from "@/components/runners/fleet-pool-wizard";

describe("FleetPoolWizard — the overcommit notice follows the watched values", () => {
	it("warns when the floor × locations exceeds the max, and clears when the max is raised", async () => {
		const user = userEvent.setup();
		render(<FleetPoolWizard open onOpenChange={() => {}} pool={null} usedProviders={[]} />);

		// Cloud → Placement. The default locations are two (fsn1, nbg1).
		await user.click(screen.getByRole("button", { name: /Next/ }));
		const floor = await screen.findByRole("spinbutton", { name: /Minimum per location/ });
		await user.clear(floor);
		await user.type(floor, "6");

		// Placement → Capacity: 6 × 2 = 12 runners, over the default max of 10.
		await user.click(screen.getByRole("button", { name: /Next/ }));
		expect(await screen.findByText(/needs 12\s+runners — above your max of 10/)).toBeInTheDocument();

		const max = screen.getByRole("spinbutton", { name: /^Maximum/ });
		await user.clear(max);
		await user.type(max, "20");
		expect(screen.queryByText(/above your max of/)).toBeNull();
	});
});
