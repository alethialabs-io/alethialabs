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

// The link the page is opened on. A search reaches the roles store the way it does in the
// product: `useFilterUrlSync` replaces the store with the link's view on mount (#6814), so a
// search planted in the store beforehand would be dropped by a link that does not carry it.
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/roles",
	useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => ({ ok: true, data: { id: "" } })) }));
// The role catalog is a prefetched GET read since #6129 (`members.roleCatalog`); the test's
// catalog is handed to the manager through it.
const CATALOG = vi.hoisted((): { current: RolesBootstrap | null } => ({ current: null }));
// The custom-role list is the server half, paged through `useKeysetList` (LST-8 #7490).
// `rolesQuery` answers per search key, so a test can model a settled search and a search still in
// flight on the previous answer (`keepPreviousData` → isPlaceholderData).
interface FakeRolesResult {
	rows: RoleRow[];
	isPending: boolean;
	isPlaceholderData: boolean;
}
const rolesQuery = vi.hoisted(() => ({
	answer: (_search: string | undefined): FakeRolesResult => ({
		rows: [],
		isPending: false,
		isPlaceholderData: false,
	}),
}));
// The delete is a mutation since #6129; nothing here deletes, so it is an idle stand-in.
vi.mock("@/lib/actions/use-action-mutation", () => ({
	useActionMutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));
vi.mock("@/lib/query/use-roles-query", () => ({
	useRoleCatalogQuery: () => ({ data: CATALOG.current ?? undefined, error: null, isPending: false, isError: false }),
}));
vi.mock("@/lib/query/use-keyset-list", async () => {
	const { settledKeysetList } = await import("../../helpers/keyset-list");
	return {
		useKeysetList: (_procedure: unknown, query: { search?: string }) => {
			const { rows, ...state } = rolesQuery.answer(query.search);
			return settledKeysetList(rows, state);
		},
	};
});
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
CATALOG.current = bootstrap;

/** Open the page on a link carrying `search`. */
function openOnSearch(search: string): void {
	nav.search = new URLSearchParams({ search }).toString();
}

/** A settled answer carrying `rows`. */
function settled(rows: RoleRow[]): FakeRolesResult {
	return { rows, isPending: false, isPlaceholderData: false };
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
		nav.search = "";
		useRolesFilters.getState().reset();
		rolesQuery.answer = () => settled([]);
	});

	it("renders the shared empty state in place of the master-detail, and Reset clears the search", async () => {
		openOnSearch("zqxvjk");
		const user = userEvent.setup();
		const { container } = render(<RolesManager />);

		expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
		expect(screen.getByText("No roles match")).toBeInTheDocument();
		// The excluded role is not still on screen in the detail pane.
		expect(screen.queryByText("Read-only access.")).toBeNull();

		await user.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(useRolesFilters.getState().filters.search).toBe("");
		expect(screen.queryByText("No roles match")).toBeNull();
	});

	it("does not render it when the search matches a role", () => {
		openOnSearch("view");
		render(<RolesManager />);
		expect(screen.queryByText("No roles match")).toBeNull();
		expect(screen.getAllByText("Viewer").length).toBeGreaterThan(0);
	});

	it("does not claim 'no match' while the current search is still loading on the previous answer", () => {
		// The previous search matched nothing; the new one is in flight. `data` is the stale `[]`.
		openOnSearch("deployer");
		rolesQuery.answer = (search) =>
			search === undefined
				? settled(custom(5))
				: { rows: [], isPending: false, isPlaceholderData: true };
		render(<RolesManager />);
		expect(screen.queryByText("No roles match")).toBeNull();
	});

	it("does not claim 'no match' before the first answer for a restored search", () => {
		openOnSearch("deployer");
		rolesQuery.answer = (search) =>
			search === undefined
				? settled(custom(5))
				: { rows: [], isPending: true, isPlaceholderData: false };
		render(<RolesManager />);
		expect(screen.queryByText("No roles match")).toBeNull();
	});

	it("states no count in the empty state — the console carries no list totals", () => {
		openOnSearch("zqxvjk");
		rolesQuery.answer = (search) => settled(search === undefined ? custom(5) : []);
		render(<RolesManager />);
		expect(screen.getByText("No built-in or custom role matches these filters.")).toBeInTheDocument();
		expect(screen.queryByText(/None of the \d+/)).toBeNull();
	});
});
