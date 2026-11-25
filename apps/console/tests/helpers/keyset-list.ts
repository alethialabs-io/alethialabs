// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A settled `KeysetList` for component tests that stand in for `useKeysetList` (LST-8 #7490): the
// rows given, the facets given, one page, nothing loading or failed — unless the test overrides a
// field to put the list in the state it is about.

import type { KeysetList } from "@/lib/query/use-keyset-list";
import type {
	MembersFacets,
	MembersListInvite,
	MembersListMember,
	MembersListRow,
	MembersPage,
} from "@/lib/queries/members";

/** A settled one-page keyset list over `rows`, with `overrides` applied on top. */
export function settledKeysetList<Row, Facets = unknown>(
	rows: Row[],
	overrides: Partial<KeysetList<Row, Facets>> = {},
): KeysetList<Row, Facets> {
	return {
		rows,
		facets: null,
		universeEmpty: rows.length === 0,
		query: { isLoading: false, isError: false, data: { pages: [rows] }, error: null, refetch: () => undefined },
		isPending: false,
		isPlaceholderData: false,
		hasMore: false,
		loadingMore: false,
		loadMoreFailed: false,
		loadMore: () => undefined,
		...overrides,
	};
}

/** A members page as the tests used to write it: members, invitations, who reads it and when. */
interface LegacyMembersPage {
	members: Omit<MembersListMember, "kind" | "isYou" | "asOf">[];
	invitations: Omit<MembersListInvite, "kind" | "asOf">[];
	viewerUserId: string;
	asOf: string;
	facets: MembersFacets;
}

/**
 * The keyset page (`members.page`, LST-8 #7490) carrying a legacy fixture's rows: members, then
 * invitations, each stamped with the server's `kind`, `isYou` and `asOf`, one page, no further.
 */
export function membersPageOf(legacy: LegacyMembersPage): MembersPage {
	const rows: MembersListRow[] = [
		...legacy.members.map((m): MembersListRow => ({
			...m,
			kind: "member",
			isYou: m.userId === legacy.viewerUserId,
			asOf: legacy.asOf,
		})),
		...legacy.invitations.map((i): MembersListRow => ({ ...i, kind: "invite", asOf: legacy.asOf })),
	];
	return { rows, nextCursor: null, facets: legacy.facets, universeEmpty: rows.length === 0 };
}
