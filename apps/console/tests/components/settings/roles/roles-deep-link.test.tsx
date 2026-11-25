// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `?selected=<role id>` opens that role's detail AT ONCE, even when the custom role sits on page
// three of the alphabetical rail (LST-8 #7490): it is read by id through the same builder and scope
// as the rail, never by walking the pages to it — and never by falling back to the first built-in.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoleRow, RolesBootstrap } from "@/app/server/actions/roles";
import type { RolesPage } from "@/lib/queries/roles";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
	usePathname: () => "/acme/~/settings/roles",
	useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => ({ ok: true, data: { id: "" } })) }));
vi.mock("@/lib/actions/use-action-mutation", () => ({
	useActionMutation: () => ({ mutate: vi.fn(), isPending: false, variables: undefined }),
}));

const h = vi.hoisted(() => ({ asked: [] as unknown[] }));

/** A role row; built-ins carry `builtin: true`. */
function role(id: string, name: string, builtin = false): RoleRow {
	return { id, name, description: `${name} description.`, builtin, permissionKeys: [], grantCount: 0 };
}

const LINKED = "00000000-0000-4000-8000-0000000000f6";

/** Three pages of two custom roles; the linked one is the LAST row of page three. */
const PAGES: Record<string, RolesPage> = {
	first: {
		rows: [role("00000000-0000-4000-8000-0000000000f1", "auditor"), role("00000000-0000-4000-8000-0000000000f2", "billing")],
		nextCursor: "p2",
		facets: { kinds: [] },
		universeEmpty: false,
	},
	p2: { rows: [], nextCursor: "p3", facets: null, universeEmpty: null },
	p3: { rows: [role(LINKED, "zz-release-managers")], nextCursor: null, facets: null, universeEmpty: null },
};

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.roles": async (input) => {
				h.asked.push(input);
				const q = typeof input === "object" && input !== null ? input : {};
				if ("id" in q && q.id === LINKED) {
					return { rows: [role(LINKED, "zz-release-managers")], nextCursor: null, facets: { kinds: [] }, universeEmpty: false };
				}
				const cursor = "cursor" in q && typeof q.cursor === "string" ? q.cursor : "first";
				return PAGES[cursor];
			},
		}).orpc,
	};
});
const CATALOG: RolesBootstrap = {
	builtin: [role("role-owner", "owner", true)],
	permissions: [],
	customRoles: true,
	canManage: false,
};
vi.mock("@/lib/query/use-roles-query", () => ({
	useRoleCatalogQuery: () => ({ data: CATALOG, error: null, isPending: false, isError: false }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/settings/roles/role-sheet", () => ({ RoleSheet: () => null }));
vi.mock("@/components/settings/roles/permission-matrix", () => ({ PermissionMatrix: () => null }));
vi.mock("@/components/classification/classification-chips", () => ({ ClassificationChips: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { RolesManager } from "@/components/settings/roles/roles-manager";
import { useRolesFilters } from "@/lib/stores/use-settings-filters";

beforeEach(() => {
	h.asked.length = 0;
	sessionStorage.clear();
	useRolesFilters.getState().reset();
});

describe("a deep link to a custom role", () => {
	it("opens a role on page three at once, read by id — without walking to it", async () => {
		window.history.replaceState(null, "", `/acme/~/settings/roles?selected=${LINKED}`);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<RolesManager />
			</QueryClientProvider>,
		);
		// The detail pane shows the linked role's description — not the first built-in's.
		expect(await screen.findByText("zz-release-managers description.")).toBeTruthy();
		expect(screen.queryByText("owner description.")).toBeNull();
		await waitFor(() => expect(h.asked).toContainEqual({ id: LINKED }));
		expect(h.asked.some((i) => typeof i === "object" && i !== null && "cursor" in i && i.cursor !== undefined)).toBe(false);
	});
});
