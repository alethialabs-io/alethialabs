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
// The custom-role list is the server half. `rolesQuery` answers per search key, so a test can
// model the universe (no search), a settled search, and a search still in flight on the
// previous answer (`keepPreviousData` → isPlaceholderData).
interface FakeRolesResult {
	data: RoleRow[] | undefined;
	isFetching: boolean;
	isPending: boolean;
	isPlaceholderData: boolean;
}
const rolesQuery = vi.hoisted(() => ({
	answer: (_search: string | undefined): FakeRolesResult => ({
		data: [],
		isFetching: false,
		isPending: false,
		isPlaceholderData: false,
	}),
}));
vi.mock("@/lib/query/use-roles-query", () => ({
	useRolesQuery: (search?: string) => rolesQuery.answer(search),
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

/** A settled answer carrying `data`. */
function settled(data: RoleRow[]): FakeRolesResult {
	return { data, isFetching: false, isPending: false, isPlaceholderData: false };
}

const custom = (n: number): RoleRow[] =>
	Array.from({ length: n }, (_, i) => ({
		id: `role-custom-${i}`,
		name: `deployer-${i}`,
		description: "Custom.",
		builtin: false,
		permissionKeys: [],
		grantCount: 0,
	}));

describe("roles: a search that matches nothing", () => {
	beforeEach(() => {
		useRolesFilters.getState().reset();
		rolesQuery.answer = () => settled([]);
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

	it("does not claim 'no match' while the current search is still loading on the previous answer", () => {
		// The previous search matched nothing; the new one is in flight. `data` is the stale `[]`.
		useRolesFilters.getState().set("search", "deployer");
		rolesQuery.answer = (search) =>
			search === undefined
				? settled(custom(5))
				: { data: [], isFetching: true, isPending: false, isPlaceholderData: true };
		render(<RolesManager bootstrap={bootstrap} />);
		expect(screen.queryByText("No roles match")).toBeNull();
	});

	it("does not claim 'no match' before the first answer for a restored search", () => {
		useRolesFilters.getState().set("search", "deployer");
		rolesQuery.answer = (search) =>
			search === undefined
				? settled(custom(5))
				: { data: undefined, isFetching: true, isPending: true, isPlaceholderData: false };
		render(<RolesManager bootstrap={bootstrap} />);
		expect(screen.queryByText("No roles match")).toBeNull();
	});

	it("counts the whole role universe, not the search result, in the empty state", () => {
		// 1 built-in + 5 custom roles; the search matches none of them, so the SEARCHED custom list
		// is empty — the count must still say 6.
		useRolesFilters.getState().set("search", "zqxvjk");
		rolesQuery.answer = (search) => settled(search === undefined ? custom(5) : []);
		render(<RolesManager bootstrap={bootstrap} />);
		expect(screen.getByText("None of the 6 roles match these filters.")).toBeInTheDocument();
	});
});
