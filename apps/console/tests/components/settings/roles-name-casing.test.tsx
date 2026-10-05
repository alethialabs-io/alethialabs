// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A role is shown by its NAME — a built-in by its label, a custom role exactly as typed (#5413).
//
// Both the rail and the detail header rendered `role.name` under CSS `capitalize`. For a built-in
// that is a registry key (`owner`), so the row LOOKED like "Owner" but its accessible name was
// `owner 41`. For a custom role it re-cased what the user typed — `k8s-readers` showed as
// `K8s-Readers` and `iOS team` as `IOS Team`. jsdom applies no CSS, so this test reads the text the
// component renders AND asserts the class is gone: the defect lived in the class, not the text.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RoleRow, RolesBootstrap } from "@/app/server/actions/roles";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/roles",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => {}) }));

/** The custom roles the mocked server-side query returns. */
const customRoles: RoleRow[] = [
	{
		id: "role-k8s",
		name: "k8s-readers",
		description: "Read clusters.",
		builtin: false,
		permissionKeys: ["perm.0"],
		grantCount: 0,
	},
	{
		id: "role-ios",
		name: "iOS team",
		description: null,
		builtin: false,
		permissionKeys: [],
		grantCount: 0,
	},
];
vi.mock("@/lib/query/use-roles-query", () => ({
	useRolesQuery: () => ({
		data: customRoles,
		isFetching: false,
		isPending: false,
		isPlaceholderData: false,
	}),
	useInvalidateRoles: () => vi.fn(),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/settings/roles/role-sheet", () => ({ RoleSheet: () => null }));
vi.mock("@/components/settings/roles/permission-matrix", () => ({ PermissionMatrix: () => null }));
vi.mock("@/components/classification/classification-chips", () => ({ ClassificationChips: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { RolesManager } from "@/components/settings/roles/roles-manager";

const bootstrap: RolesBootstrap = {
	builtin: [
		{
			id: "role-owner",
			name: "owner",
			description: "Full control.",
			builtin: true,
			permissionKeys: ["perm.0", "perm.1"],
			grantCount: 0,
		},
	],
	permissions: [],
	customRoles: true,
	canManage: true,
};

/** True when any element in `root` (or `root` itself) carries the CSS `capitalize` utility. */
function hasCapitalize(root: HTMLElement): boolean {
	return root.classList.contains("capitalize") || root.querySelector(".capitalize") !== null;
}

describe("role names on the Roles page", () => {
	it("a built-in role is called by its label — visibly and to assistive tech", () => {
		render(<RolesManager bootstrap={bootstrap} />);
		// jsdom joins the row's name and count spans with no space: "<name><permission count>".
		const owner = screen.getByRole("button", { name: "Owner2" });
		expect(hasCapitalize(owner)).toBe(false);
	});

	it("a custom role's name is rendered exactly as the user typed it, never re-cased", () => {
		render(<RolesManager bootstrap={bootstrap} />);
		const cases: Array<[name: string, permissionCount: number]> = [
			["k8s-readers", 1],
			["iOS team", 0],
		];
		for (const [name, count] of cases) {
			const row = screen.getByRole("button", { name: `${name}${count}` });
			expect(within(row).getByText(name)).toBeInTheDocument();
			expect(hasCapitalize(row)).toBe(false);
		}
	});

	it("the detail header names the selected role the same way the rail does", () => {
		render(<RolesManager bootstrap={bootstrap} />);
		// The default selection is the first built-in, so the header shows its label.
		const headers = screen.getAllByText("Owner").filter((el) => el.closest("button") === null);
		expect(headers).toHaveLength(1);
		expect(headers.some(hasCapitalize)).toBe(false);
	});
});
