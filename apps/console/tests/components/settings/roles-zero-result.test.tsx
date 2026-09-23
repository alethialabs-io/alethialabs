// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A roles search that matches nothing lands in the SHARED empty state (#4939).
//
// The audit's F10 typed a token no role carries into `~/settings/roles` and found no
// `[data-slot="empty"]` in `main`: each rail bucket printed a muted line of its own, and the
// detail pane went on showing the first built-in role — a role the filter had just excluded.
// Both directions are asserted: the empty state replaces the master-detail when nothing matches,
// and does NOT appear when the same search matches a role.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleRow, RolesBootstrap } from "@/app/server/actions/roles";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/roles",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => {}) }));
// The custom-role list is the server half; none exist in this org, and the search is settled.
vi.mock("@/lib/query/use-roles-query", () => ({
	useRolesQuery: () => ({ data: [], isFetching: false, isPlaceholderData: false }),
	useInvalidateRoles: () => vi.fn(),
}));
vi.mock("@/hooks/use-debounced-value", () => ({
	useDebouncedValue: <T,>(value: T): T => value,
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/settings/roles/role-sheet", () => ({ RoleSheet: () => null }));
vi.mock("@/components/classification/classification-chips", () => ({ ClassificationChips: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { RolesManager } from "@/components/settings/roles/roles-manager";
import { useRolesFilters } from "@/lib/stores/use-settings-filters";

const viewer: RoleRow = {
	id: "role-viewer",
	name: "Viewer",
	description: "Read-only access.",
	builtin: true,
	permissionKeys: [],
	grantCount: 0,
};

const bootstrap: RolesBootstrap = {
	builtin: [viewer],
	permissions: [],
	customRoles: false,
	canManage: false,
};

describe("roles: a search that matches nothing", () => {
	beforeEach(() => {
		useRolesFilters.getState().reset();
	});

	it("renders the shared empty state in place of the master-detail, and Reset clears the search", async () => {
		useRolesFilters.getState().set("search", "zqxvjk");
		const user = userEvent.setup();
		const { container } = render(<RolesManager bootstrap={bootstrap} />);

		expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
		expect(screen.getByText("No roles match")).toBeInTheDocument();
		// The excluded role is not still on screen in the detail pane.
		expect(screen.queryByText("Read-only access.")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Reset filters" }));
		expect(useRolesFilters.getState().filters.search).toBe("");
		expect(screen.queryByText("No roles match")).toBeNull();
	});

	it("does not render it when the search matches a role", () => {
		useRolesFilters.getState().set("search", "view");
		render(<RolesManager bootstrap={bootstrap} />);
		expect(screen.queryByText("No roles match")).toBeNull();
		expect(screen.getAllByText("Viewer").length).toBeGreaterThan(0);
	});
});
