// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A role's on-screen name comes from ONE place, and CSS never re-cases it (#5444).
//
// #5413 fixed the roles manager: it rendered `role.name` under Tailwind `capitalize`, which
// re-cased user-typed custom names and gave the built-ins a lowercase accessible name under a
// capitalised visible one. Its review found the same device on the members table (the role
// select, its options and the read-only role cell) and on the Access table's role chip — and three
// separate derivations of "the label for a built-in role" that nothing made agree.
// The create-role sheet's "Start from" chips were one more: built-in keys under `capitalize`, so the
// chip read "Owner" and was named "owner".
//
// jsdom applies no CSS, so `textContent` is what a screen reader reads: under `capitalize` the
// members table said "admin" and the Access chip said "owner". Each assertion below fails on that.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { grantRoleLabel } from "@/components/settings/access/access-filters";
import { AccessManager } from "@/components/settings/access/access-manager";
import { MEMBER_ROLE_FILTER_OPTIONS } from "@/components/settings/members/members-filters";
import { MembersTable } from "@/components/settings/members/members-table";
import { RoleSheet } from "@/components/settings/roles/role-sheet";
import {
	BUILT_IN_ROLE_DESCRIPTIONS,
	BUILT_IN_ROLE_LABELS,
	BUILT_IN_ROLE_NAMES,
	roleDisplayName,
} from "@/lib/authz/registry";
import { INVITE_ROLES } from "@/lib/members/roles";

/** Whether the mocked entitlement grants management (members) / custom roles (access). */
let entitled = true;

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/settings",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-filter-url-sync", () => ({ useFilterUrlSync: () => {} }));
vi.mock("@/components/settings/enterprise-gate", () => ({
	useEntitlement: () => entitled,
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		useSession: () => ({ data: { user: { id: "u_owner" } } }),
		organization: {
			updateMemberRole: vi.fn(),
			removeMember: vi.fn(),
			cancelInvitation: vi.fn(),
		},
	},
}));
vi.mock("@/app/server/actions/members", () => ({ setMemberSuspended: vi.fn() }));
vi.mock("@/app/server/actions/billing", () => ({
	getCollaborationAccess: vi.fn(async () => ({ canInvite: false })),
}));
vi.mock("@/app/server/actions/grants", () => ({
	assignGrant: vi.fn(),
	revokeGrant: vi.fn(),
	getGrantOptions: vi.fn(async () => ({ roles: [], permissions: [], principals: [], resources: {} })),
}));
vi.mock("@/app/server/actions/roles", () => ({ createRole: vi.fn(), updateRole: vi.fn() }));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: undefined }),
}));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));
vi.mock("@/components/settings/members/invite-member-dialog", () => ({
	InviteMemberDialog: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({
	UpgradeDialog: ({ trigger }: { trigger: ReactNode }) => trigger,
}));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: () => null,
}));

/** One member row in the shape `getMembersPage` returns. */
function member(id: string, name: string, role: string) {
	return {
		id,
		userId: `u_${id}`,
		name,
		username: null,
		email: `${id}@example.test`,
		image: null,
		role,
		joinedAt: "2026-01-01T00:00:00.000Z",
		teams: [],
		status: "active",
		lastActiveAt: null,
	};
}

vi.mock("@/lib/query/use-members-query", () => ({
	useMembersPageQuery: () => ({
		data: {
			members: [
				member("owner", "Grace Hopper", "owner"),
				member("ada", "Ada Lovelace", "admin"),
				member("linus", "Linus Torvalds", "viewer"),
			],
			invitations: [],
			resultCount: 3,
			total: 3,
			viewerUserId: "u_owner",
			asOf: "2026-01-04T00:00:00.000Z",
			facets: { statuses: [], roles: [], teams: [] },
		},
		isPending: false,
		isPlaceholderData: false,
	}),
}));

/** One grant row in the shape `getAccessGrantsPage` returns. */
function grant(id: string, roleName: string) {
	return {
		id,
		principalType: "user",
		principalId: `u_${id}`,
		principalLabel: `${id}@example.test`,
		effect: "allow" as const,
		roleName,
		permissionKey: null,
		resourceType: "org",
		resourceId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

vi.mock("@/lib/query/use-access-grants-query", () => ({
	useAccessGrantsPageQuery: () => ({
		data: {
			rows: [grant("g1", "owner"), grant("g2", "k8s-readers"), grant("g3", "iOS team")],
			resultCount: 3,
			total: 3,
			facets: { scopes: [], roles: [], effects: [] },
		},
		isPending: false,
		isPlaceholderData: false,
	}),
}));

/** Render `ui` inside the query client every settings surface expects. */
function renderWithClient(ui: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	entitled = true;
});

describe("the role label source (lib/authz/registry.ts)", () => {
	it("labels every built-in, and only the built-ins have descriptions to match", () => {
		expect(Object.keys(BUILT_IN_ROLE_LABELS).sort()).toEqual(
			Object.keys(BUILT_IN_ROLE_DESCRIPTIONS).sort(),
		);
		expect([...BUILT_IN_ROLE_NAMES].sort()).toEqual(Object.keys(BUILT_IN_ROLE_LABELS).sort());
	});

	it("shows a built-in key by its label and a custom name exactly as typed", () => {
		expect(roleDisplayName("owner")).toBe("Owner");
		expect(roleDisplayName("k8s-readers")).toBe("k8s-readers");
		expect(roleDisplayName("iOS team")).toBe("iOS team");
		// A custom role that happens to be called `owner` keeps its own spelling when the caller
		// knows it is custom.
		expect(roleDisplayName("owner", false)).toBe("owner");
		expect(roleDisplayName("owner", true)).toBe("Owner");
	});

	it("is the source the members filter, the invite picker and the Access facet read", () => {
		expect(MEMBER_ROLE_FILTER_OPTIONS.map((o) => o.label)).toEqual(
			BUILT_IN_ROLE_NAMES.map((n) => BUILT_IN_ROLE_LABELS[n]),
		);
		for (const r of INVITE_ROLES) expect(r.label).toBe(roleDisplayName(r.value));
		expect(grantRoleLabel("viewer")).toBe("Viewer");
		expect(grantRoleLabel("k8s-readers")).toBe("k8s-readers");
		expect(grantRoleLabel("permission:project:deploy")).toBe("project:deploy");
	});
});

describe("Settings › Members renders role labels, not CSS-capitalised keys", () => {
	it("the role select's trigger shows the label, uncapitalised by CSS", () => {
		renderWithClient(<MembersTable />);
		const triggers = screen.getAllByRole("combobox", { name: "Role" });
		const texts = triggers.map(
			(t) => t.querySelector('[data-slot="select-value"]')?.textContent?.trim(),
		);
		expect(texts).toContain("Admin");
		expect(texts).toContain("Viewer");
		expect(texts).not.toContain("admin");
		for (const t of triggers) expect(t.className).not.toMatch(/\bcapitalize\b/);
	});

	it("the read-only role cell shows the label", () => {
		entitled = false;
		renderWithClient(<MembersTable />);
		const table = screen.getByRole("table");
		expect(within(table).getByText("Admin")).toBeInTheDocument();
		expect(within(table).getByText("Viewer")).toBeInTheDocument();
		expect(within(table).getByText("Owner")).toBeInTheDocument();
		expect(within(table).queryByText("admin")).toBeNull();
	});
});

describe("Settings › Access renders the role chip without re-casing", () => {
	it("a built-in grant shows its label; a custom role shows exactly what was typed", () => {
		renderWithClient(<AccessManager />);
		const table = screen.getByRole("table");
		expect(within(table).getByText("Owner")).toBeInTheDocument();
		const custom = within(table).getByText("k8s-readers");
		expect(within(table).getByText("iOS team")).toBeInTheDocument();
		expect(custom.className).not.toMatch(/\bcapitalize\b/);
		expect(within(table).queryByText("owner")).toBeNull();
	});
});

describe("Settings › Roles › the create sheet's \"Start from\" chips", () => {
	it("name each built-in template by its label, not its CSS-capitalised key", () => {
		const templates = BUILT_IN_ROLE_NAMES.map((name) => ({
			id: `builtin:${name}`,
			name,
			description: null,
			builtin: true,
			permissionKeys: [],
			grantCount: 0,
		}));
		renderWithClient(
			<RoleSheet
				open
				onOpenChange={() => {}}
				role={null}
				templates={templates}
				canManage
				onSaved={() => {}}
			/>,
		);
		for (const name of BUILT_IN_ROLE_NAMES) {
			const chip = screen.getByRole("button", { name: BUILT_IN_ROLE_LABELS[name] });
			expect(chip.className).not.toMatch(/\bcapitalize\b/);
		}
		expect(screen.queryByRole("button", { name: "owner" })).toBeNull();
	});
});
