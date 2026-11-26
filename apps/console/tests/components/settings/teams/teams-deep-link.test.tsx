// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `?selected=<team id>` opens that team's roster AT ONCE, even when the team sits on page three of
// the alphabetical walk (LST-8 #7490): the team is read by id through the same builder and scope as
// the list, never by walking the pages to it.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamRow } from "@/app/server/actions/teams";
import type { TeamsPage } from "@/lib/queries/teams";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/teams",
	useSearchParams: () => new URLSearchParams(window.location.search),
}));

const h = vi.hoisted(() => ({ asked: [] as unknown[] }));

/** A team row named `name`. */
function team(id: string, name: string): TeamRow {
	return { id, name, memberCount: 0, members: [] };
}

/** Three pages of two teams; the linked team is the LAST row of page three. */
const PAGES: Record<string, TeamsPage> = {
	first: { rows: [team("t1", "Alpha"), team("t2", "Bravo")], nextCursor: "p2", facets: { sizes: [] }, universeEmpty: false },
	p2: { rows: [team("t3", "Charlie"), team("t4", "Delta")], nextCursor: "p3", facets: null, universeEmpty: null },
	p3: { rows: [team("t5", "Echo"), team("t6", "Zulu Platform")], nextCursor: null, facets: null, universeEmpty: null },
};
const LINKED = "00000000-0000-4000-8000-000000000006";

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return {
		orpc: fakeOrpc({
			"members.teams": async (input) => {
				h.asked.push(input);
				const q = typeof input === "object" && input !== null ? input : {};
				if ("id" in q && q.id === LINKED) {
					return { rows: [team(LINKED, "Zulu Platform")], nextCursor: null, facets: { sizes: [] }, universeEmpty: false };
				}
				const cursor = "cursor" in q && typeof q.cursor === "string" ? q.cursor : "first";
				return PAGES[cursor];
			},
		}).orpc,
	};
});
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: {} } }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({ FeatureUpsell: () => null }));
// The roster dialog itself is not under test — WHICH team it opens on is.
vi.mock("@/components/settings/teams/manage-team-dialog", () => ({
	ManageTeamDialog: ({ team: t }: { team: TeamRow }) => <div role="dialog" aria-label={`Roster of ${t.name}`} />,
}));

import { TeamsList } from "@/components/settings/teams/teams-list";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";

beforeEach(() => {
	h.asked.length = 0;
	sessionStorage.clear();
	useTeamsFilters.getState().reset();
});

describe("a deep link to a team", () => {
	it("opens a team on page three at once, read by id — without walking to it", async () => {
		window.history.replaceState(null, "", `/acme/~/settings/teams?selected=${LINKED}`);
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<TeamsList entitled />
			</QueryClientProvider>,
		);
		expect(await screen.findByRole("dialog", { name: "Roster of Zulu Platform" })).toBeTruthy();
		// The first page and the by-id read — and never page two or three.
		await waitFor(() => expect(h.asked).toContainEqual({ id: LINKED }));
		expect(h.asked.some((i) => typeof i === "object" && i !== null && "cursor" in i && i.cursor !== undefined)).toBe(false);
		// The list behind it is still page one.
		expect(screen.getByText("Alpha")).toBeTruthy();
		expect(screen.queryByText("Echo")).toBeNull();
	});

	it("opens a team already on a loaded page without a second read", async () => {
		window.history.replaceState(null, "", "/acme/~/settings/teams?selected=t2");
		const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={qc}>
				<TeamsList entitled />
			</QueryClientProvider>,
		);
		expect(await screen.findByRole("dialog", { name: "Roster of Bravo" })).toBeTruthy();
		expect(h.asked.filter((i) => typeof i === "object" && i !== null && "id" in i)).toEqual([]);
	});
});
