// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Members says when its list does not yet answer the URL (#4999, the audit's F8 — the
// #4980 class on `~/runners`). The audit's `settle()` refuses any read taken while `main` holds an
// `aria-busy="true"` node, so the table must be busy exactly while what it shows may be a
// stand-in: before the link is read into the store, and while the rows are placeholder data.
//
// The route's half — prefetching the filtered key — is `tests/app/filtered-link-prefetch.test.tsx`.
// This file seeds the cache the way that prefetch does and drives the real table, the real
// filter store and the real `useFilterUrlSync`; only the network edges are mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InvitationRow, MemberRow } from "@/app/server/actions/members";
import type { MembersPage } from "@/lib/queries/members";

let currentSearch = "";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/members",
	useSearchParams: () => new URLSearchParams(currentSearch),
}));

const { getMembersPage } = vi.hoisted(() => ({
	getMembersPage: vi.fn<(query: unknown) => Promise<MembersPage>>(),
}));

vi.mock("@/app/server/actions/members", () => ({
	getMembersPage,
	setMemberSuspended: vi.fn(),
}));
vi.mock("@/app/server/actions/billing", () => ({
	getCollaborationAccess: async () => ({ canInvite: false }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: { useSession: () => ({ data: null }), organization: {} },
}));
vi.mock("@/lib/query/use-classification-query", () => ({
	useAssignmentsForKind: () => ({ data: {} }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/settings/members/invite-member-dialog", () => ({ InviteMemberDialog: () => null }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/alerts/confirm-dialog", () => ({ ConfirmDialog: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { MembersTable } from "@/components/settings/members/members-table";
import { useMembersFilters } from "@/lib/stores/use-settings-filters";

/** One active member row. */
function member(id: string): MemberRow {
	return {
		id,
		userId: `u-${id}`,
		name: `Member ${id}`,
		username: null,
		email: `${id}@acme.test`,
		image: null,
		role: "viewer",
		joinedAt: "2026-01-01T00:00:00.000Z",
		teams: [],
		status: "active",
		lastActiveAt: null,
	};
}

/** One pending invitation row. */
function invite(id: string): InvitationRow {
	return { id, email: `${id}@invited.test`, role: "viewer", inviterName: "Owner", createdAt: "2026-01-01T00:00:00.000Z" };
}

/** A members page answering with the given rows, over a six-row universe. */
function pageOf(members: MemberRow[], invitations: InvitationRow[]): MembersPage {
	return {
		members,
		invitations,
		resultCount: members.length + invitations.length,
		total: 6,
		facets: {
			statuses: [
				{ value: "active", label: "Active", count: 5 },
				{ value: "pending", label: "Pending", count: 1 },
				{ value: "suspended", label: "Suspended", count: 0 },
			],
			roles: [{ value: "viewer", label: "Viewer", count: 6 }],
			teams: [],
		},
	};
}

const PRISTINE = pageOf(["a", "b", "c", "d", "e"].map(member), [invite("p")]);
const PENDING = pageOf([], [invite("p")]);

/** A client seeded the way the route's prefetch seeds it: the pristine key, and optionally the link's key. */
function seededClient(withFiltered: boolean): QueryClient {
	const qc = new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: false } } });
	qc.setQueryData(["members", "acme", {}], PRISTINE);
	if (withFiltered) qc.setQueryData(["members", "acme", { statuses: ["pending"] }], PENDING);
	return qc;
}

/** The table inside its query provider. */
function tree(qc: QueryClient): ReactNode {
	return (
		<QueryClientProvider client={qc}>
			<MembersTable />
		</QueryClientProvider>
	);
}

/** The table's root — the node that carries `aria-busy`. */
function root(container: HTMLElement): Element {
	const el = container.firstElementChild;
	if (el === null) throw new Error("the table rendered nothing");
	return el;
}

beforeEach(() => {
	sessionStorage.clear();
	useMembersFilters.getState().reset();
	getMembersPage.mockReset();
	currentSearch = "statuses=pending";
});

describe("MembersTable marks itself busy until its rows answer the URL (#4999)", () => {
	it("is busy in the server render of a filtered link — the store has not read the URL there", () => {
		const html = renderToString(tree(seededClient(true)));
		expect(html).toMatch(/^<div aria-busy="true"/);
	});

	it("is not busy once the link is read and the prefetched filtered key answers it", async () => {
		const { container } = render(tree(seededClient(true)));
		await waitFor(() => expect(root(container).getAttribute("aria-busy")).toBe("false"));
		expect(screen.getByText("p@invited.test")).toBeTruthy();
		expect(screen.queryByText("a@acme.test")).toBeNull();
		expect(getMembersPage).not.toHaveBeenCalled();
	});

	it("stays busy while the filtered key has no data and the pristine rows are its placeholder", async () => {
		getMembersPage.mockImplementation(() => new Promise<MembersPage>(() => {}));
		const { container } = render(tree(seededClient(false)));
		await waitFor(() => expect(getMembersPage).toHaveBeenCalledWith({ statuses: ["pending"] }));
		expect(root(container).getAttribute("aria-busy")).toBe("true");
		// The placeholder is the UNFILTERED list — exactly what the audit must not read as an answer.
		expect(screen.getByText("a@acme.test")).toBeTruthy();
	});
});
