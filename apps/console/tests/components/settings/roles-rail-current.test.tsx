// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The roles rail says which role the detail pane shows (#4980).
//
// The rail is a set of buttons choosing the pane's subject — WAI-ARIA's "current item in a set", so
// the row carries `aria-current`. Without it the selected row read the same as every other to a
// screen reader, and R8 filed the default `owner` row inert for doing nothing when pressed again,
// on every run where no unrelated re-render happened to land inside its window.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RoleRow, RolesBootstrap } from "@/app/server/actions/roles";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/roles",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => {}) }));
vi.mock("@/lib/query/use-roles-query", () => ({
	useRolesQuery: () => ({ data: [], isFetching: false, isPending: false, isPlaceholderData: false }),
	useInvalidateRoles: () => vi.fn(),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/settings/roles/role-sheet", () => ({ RoleSheet: () => null }));
vi.mock("@/components/classification/classification-chips", () => ({ ClassificationChips: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { RolesManager } from "@/components/settings/roles/roles-manager";

/** A built-in role with `n` permission keys, so its rail row's name is `<name><n>`. */
function role(name: string, n: number): RoleRow {
	return {
		id: `role-${name}`,
		name,
		description: `${name} role.`,
		builtin: true,
		permissionKeys: Array.from({ length: n }, (_, i) => `perm.${i}`),
		grantCount: 0,
	};
}

const bootstrap: RolesBootstrap = {
	builtin: [role("owner", 3), role("viewer", 1)],
	permissions: [],
	customRoles: false,
	canManage: false,
};

describe("the roles rail", () => {
	it("marks the selected role's row current — and only that row", async () => {
		render(<RolesManager bootstrap={bootstrap} />);
		const owner = screen.getByRole("button", { name: "owner3" });
		const viewer = screen.getByRole("button", { name: "viewer1" });
		expect(owner).toHaveAttribute("aria-current", "true");
		expect(viewer).not.toHaveAttribute("aria-current");

		await userEvent.setup().click(viewer);
		expect(viewer).toHaveAttribute("aria-current", "true");
		expect(owner).not.toHaveAttribute("aria-current");
	});
});
