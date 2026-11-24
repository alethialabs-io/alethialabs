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
	// The selection is URL state (R6 E-23), written with `history.replaceState`; jsdom keeps
	// `window.location` in step with it, which is what Next's own hook reads.
	useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => ({ ok: true, data: { id: "" } })) }));
// The role catalog is a prefetched GET read since #6129 (`members.roleCatalog`); the test's
// catalog is handed to the manager through it.
const CATALOG = vi.hoisted((): { current: RolesBootstrap | null } => ({ current: null }));
// The delete is a mutation since #6129; nothing here deletes, so it is an idle stand-in.
vi.mock("@/lib/actions/use-action-mutation", () => ({
	useActionMutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock("@/lib/query/use-roles-query", () => ({
	useRoleCatalogQuery: () => ({ data: CATALOG.current ?? undefined, error: null, isPending: false, isError: false }),
}));
// The custom roles page through `useKeysetList` since LST-8 (#7490); none here.
vi.mock("@/lib/query/use-keyset-list", async () => {
	const { settledKeysetList } = await import("../../helpers/keyset-list");
	return { useKeysetList: () => settledKeysetList([]) };
});
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
CATALOG.current = bootstrap;

describe("the roles rail", () => {
	it("marks the selected role's row current — and only that row", async () => {
		window.history.replaceState(null, "", "/acme/~/settings/roles");
		const { rerender } = render(<RolesManager />);
		const owner = screen.getByRole("button", { name: "Owner3" });
		const viewer = screen.getByRole("button", { name: "Viewer1" });
		expect(owner).toHaveAttribute("aria-current", "true");
		expect(viewer).not.toHaveAttribute("aria-current");

		await userEvent.setup().click(viewer);
		expect(window.location.search).toBe("?selected=role-viewer");
		rerender(<RolesManager />);
		expect(viewer).toHaveAttribute("aria-current", "true");
		expect(owner).not.toHaveAttribute("aria-current");
	});
});

// CON-PB2, R6 E-09: without the plan, Create role is disabled WITH the reason — it used to be an
// enabled button that opened an upgrade dialog.
describe("Create role without the plan", () => {
	it("is disabled and says which plan has it", () => {
		window.history.replaceState(null, "", "/acme/~/settings/roles");
		render(<RolesManager />);
		const create = screen.getByRole("button", { name: /create role/i });
		expect(create).toBeDisabled();
		expect(create).toHaveAccessibleDescription(/Custom roles are available on the .+ plan\./);
	});

	it("a link naming a role opens on it", () => {
		window.history.replaceState(null, "", "/acme/~/settings/roles?selected=role-viewer");
		render(<RolesManager />);
		expect(screen.getByRole("button", { name: "Viewer1" })).toHaveAttribute("aria-current", "true");
	});
});
