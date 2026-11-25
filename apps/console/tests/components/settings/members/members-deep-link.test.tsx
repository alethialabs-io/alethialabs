// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `?selected=<member or invitation id>` opens that row AT ONCE, even when it sits on page three of
// the alphabetical list (LST-8 #7490): it is read by id through the same builder and scope as the
// list and shown above it, never by walking the pages to it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MembersListRow, MembersPage } from "@/lib/queries/members";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/settings/members",
	useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: {} } }));
vi.mock("@/app/server/actions/members", () => ({ setMemberSuspended: vi.fn() }));
vi.mock("@/lib/query/use-members-query", () => ({
	useMembersGateQuery: () => ({ data: { canManage: false, canInvite: false, plan: "team", inviteBlockedReason: "x" } }),
}));
vi.mock("@/lib/query/use-classification-query", () => ({ useAssignmentsForKind: () => ({ data: undefined }) }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
vi.mock("@/components/settings/members/invite-member-dialog", () => ({ InviteMemberDialog: () => null }));

const h = vi.hoisted(() => ({ asked: [] as unknown[] }));
const AS_OF = "2026-01-04T00:00:00.000Z";

/** A member row of the list, named `name`. */
function memberRow(id: string, name: string): MembersListRow {
	return {
		kind: "member",
		id,
		userId: `u-${id}`,
		name,
		username: null,
		email: `${id}@example.test`,
		image: null,
		role: "viewer",
		joinedAt: "2026-01-01T00:00:00.000Z",
		teams: [],
		status: "active",
		lastActiveAt: null,
		isYou: false,
		asOf: AS_OF,
	};
}

const LINKED = "00000000-0000-4000-8000-0000000000e6";

/** Three pages; the linked member is the LAST row of page three. */
const PAGES: Record<string, MembersPage> = {
	first: {
		rows: [memberRow("m1", "Ada"), memberRow("m2", "Bea")],
		nextCursor: "p2",
		facets: { statuses: [], roles: [], teams: [] },
		universeEmpty: false,
	},
	p2: { rows: [memberRow("m3", "Cy")], nextCursor: "p3", facets: null, universeEmpty: null },
	p3: { rows: [memberRow(LINKED, "Zoe Zander")], nextCursor: null, facets: null, universeEmpty: null },
};

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.page": async (input) => {
				h.asked.push(input);
				const q = typeof input === "object" && input !== null ? input : {};
				if ("id" in q && q.id === LINKED) {
					return { rows: [memberRow(LINKED, "Zoe Zander")], nextCursor: null, facets: PAGES.first.facets, universeEmpty: false };
				}
				const cursor = "cursor" in q && typeof q.cursor === "string" ? q.cursor : "first";
				return PAGES[cursor];
			},
		}).orpc,
	};
});

import { MembersTable } from "@/components/settings/members/members-table";
import { useMembersFilters } from "@/lib/stores/use-settings-filters";

beforeEach(() => {
	h.asked.length = 0;
	sessionStorage.clear();
	useMembersFilters.getState().reset();
});

describe("a deep link to a member", () => {
	it("opens a member on page three at once, read by id — without walking to it", async () => {
		window.history.replaceState(null, "", `/acme/~/settings/members?selected=${LINKED}`);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<MembersTable />
			</QueryClientProvider>,
		);
		const linked = await screen.findByRole("region", { name: "Linked member" });
		expect(within(linked).getByText("Zoe Zander")).toBeTruthy();
		await waitFor(() => expect(h.asked).toContainEqual({ id: LINKED }));
		expect(h.asked.some((i) => typeof i === "object" && i !== null && "cursor" in i && i.cursor !== undefined)).toBe(false);
		// The list below is still page one.
		expect(screen.getByText("Ada")).toBeTruthy();
		expect(screen.queryByText("Cy")).toBeNull();
	});
});
