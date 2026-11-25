// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members, CON-L10 (R6 E-10, E-11, E-13). Drives the REAL `MembersTable` with its data
// hooks mocked:
//
//   · E-10 — the viewer's own row offers no Suspend or Remove, and no selection checkbox, so no
//     single or bulk action can be aimed at yourself from this table;
//   · E-13 — a pending invitation says when it was sent, and "Resend invitation" repeats it at its
//     role through Better Auth's `inviteMember({ resend: true })`;
//   · E-11 — the selection is the intersection of what was ticked with the rows on screen: a filter
//     that hides a ticked row takes it out of the count the bulk bar acts on.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	inviteMember: vi.fn(async (_input: unknown) => ({ error: null })),
}));

/** A member row as `members.page` returns it. */
function memberRow(id: string, userId: string, name: string, role: string) {
	return {
		id,
		userId,
		name,
		username: null,
		email: `${userId}@example.test`,
		image: null,
		role,
		joinedAt: "2026-01-01T00:00:00.000Z",
		teams: [],
		status: "active",
		lastActiveAt: null,
	};
}

const ADA = memberRow("mem_ada", "u_ada", "Ada Lovelace", "admin");
const LINUS = memberRow("mem_linus", "u_linus", "Linus Torvalds", "viewer");
const GRACE = memberRow("mem_grace", "u_grace", "Grace Hopper", "owner");

/** The page the mocked query answers with; the viewer is Ada, an admin. */
let pageData = buildPage([GRACE, ADA, LINUS]);

/**
 * A page holding `members` and one invitation sent two days before `asOf`, whose link expires
 * `expiresAt` (by default five days after `asOf`).
 */
function buildPage(members: ReturnType<typeof memberRow>[], expiresAt = "2026-01-09T00:00:00.000Z") {
	return {
		members,
		invitations: [
			{
				id: "inv_1",
				email: "new@example.test",
				role: "operator",
				inviterName: "Ada Lovelace",
				createdAt: "2026-01-02T00:00:00.000Z",
				expiresAt,
			},
		],
		resultCount: members.length + 1,
		total: 4,
		viewerUserId: "u_ada",
		asOf: "2026-01-04T00:00:00.000Z",
		facets: { statuses: [], roles: [], teams: [] },
	};
}

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/settings/members",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/hooks/use-filter-url-sync", () => ({ useFilterUrlSync: () => true }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			updateMemberRole: vi.fn(),
			removeMember: vi.fn(),
			cancelInvitation: vi.fn(),
			inviteMember: (input: unknown) => h.inviteMember(input),
		},
	},
}));
vi.mock("@/app/server/actions/members", () => ({ setMemberSuspended: vi.fn() }));
vi.mock("@/lib/query/use-keyset-list", async () => {
	const { membersPageOf, settledKeysetList } = await import("../../helpers/keyset-list");
	// One list per fixture object, so a render that did not "refetch" hands back the same rows.
	const lists = new WeakMap<object, unknown>();
	return {
		useKeysetList: () => {
			const cached = lists.get(pageData);
			if (cached) return cached;
			const page = membersPageOf(pageData);
			const list = settledKeysetList(page.rows, { facets: page.facets, universeEmpty: page.universeEmpty });
			lists.set(pageData, list);
			return list;
		},
	};
});
vi.mock("@/lib/query/use-members-query", () => ({
	useMembersGateQuery: () => ({
		data: { canManage: true, canInvite: false, plan: "team", inviteBlockedReason: "x" },
	}),
}));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: undefined }),
}));
vi.mock("@/components/classification/classification-control", () => ({
	ClassificationControl: () => null,
}));
vi.mock("@/components/settings/members/invite-member-dialog", () => ({
	InviteMemberDialog: ({ trigger }: { trigger: ReactNode }) => trigger,
}));

import { MembersTable } from "@/components/settings/members/members-table";

/** The table inside the query client it expects, as a fresh element on every call. */
function tree(client: QueryClient) {
	return (
		<QueryClientProvider client={client}>
			<MembersTable />
		</QueryClientProvider>
	);
}

beforeEach(() => {
	pageData = buildPage([GRACE, ADA, LINUS]);
	h.inviteMember.mockClear();
});

describe("the viewer's own row (R6 E-10)", () => {
	it("has no row menu and no selection checkbox", () => {
		render(tree(new QueryClient()));
		expect(screen.queryByRole("button", { name: /Manage member Ada Lovelace/ })).toBeNull();
		expect(screen.queryByRole("checkbox", { name: "Select Ada Lovelace" })).toBeNull();
		// Everyone else who is not the owner keeps theirs.
		expect(screen.getByRole("button", { name: "Manage member Linus Torvalds" })).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Select Linus Torvalds" })).toBeInTheDocument();
	});
});

describe("a pending invitation (R6 E-13)", () => {
	it("says when it was sent", () => {
		render(tree(new QueryClient()));
		expect(screen.getByText("invited by Ada Lovelace · 2 days ago")).toBeInTheDocument();
	});

	it("can be sent again, at its role", async () => {
		const user = userEvent.setup();
		render(tree(new QueryClient()));
		await user.click(screen.getByRole("button", { name: "Manage invitation new@example.test" }));
		await user.click(await screen.findByRole("menuitem", { name: "Resend invitation" }));
		await waitFor(() => expect(h.inviteMember).toHaveBeenCalledTimes(1));
		expect(h.inviteMember).toHaveBeenCalledWith({
			email: "new@example.test",
			role: "operator",
			resend: true,
		});
	});
});

describe("the selection follows the rows on screen (R6 E-11)", () => {
	it("drops a ticked row a filter hides, and brings it back when the row returns", async () => {
		const client = new QueryClient();
		const { rerender } = render(tree(client));
		fireEvent.click(screen.getByRole("checkbox", { name: "Select Linus Torvalds" }));
		await waitFor(() => expect(screen.getByText("selected")).toBeInTheDocument());

		// A filter answer without Linus: nothing on screen is selected, so no bulk bar.
		pageData = buildPage([GRACE, ADA]);
		rerender(tree(client));
		expect(screen.queryByText("selected")).toBeNull();

		// The filter cleared: the tick was never forgotten, only not shown.
		pageData = buildPage([GRACE, ADA, LINUS]);
		rerender(tree(client));
		expect(screen.getByText("selected")).toBeInTheDocument();
		expect(screen.getByRole("checkbox", { name: "Select Linus Torvalds" })).toBeChecked();
	});
});

// #6827 (from CON-L10): an invitation says when its link stops working, and an expired one says so
// and offers Resend on the row.
describe("an invitation's expiry", () => {
	it("says when a live link expires, with no inline Resend", () => {
		render(tree(new QueryClient()));
		expect(screen.getByText("Link expires in 5 days")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Resend invitation to new@example.test" })).toBeNull();
	});

	it("an expired link says so, reads Expired, and offers Resend at its role", async () => {
		pageData = buildPage([GRACE, ADA, LINUS], "2026-01-03T00:00:00.000Z");
		const user = userEvent.setup();
		render(tree(new QueryClient()));
		expect(screen.getByText("Link expired 1 day ago")).toBeInTheDocument();
		expect(screen.getByText("Expired")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Resend invitation to new@example.test" }));
		await waitFor(() =>
			expect(h.inviteMember).toHaveBeenCalledWith({
				email: "new@example.test",
				role: "operator",
				resend: true,
			}),
		);
	});
});
