// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Teams says when its list does not yet answer (#5494). Before the first answer the
// page is a skeleton with no count, no table and no empty state; the audit's `settle()` takes two
// identical such reads as the page's answer unless `main` holds an `aria-busy="true"` node, so the
// skeleton must declare itself busy, and the loaded list must stop declaring it. Drives the real
// list, filter store and `useFilterUrlSync`; only the network edges are mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamsPage } from "@/lib/queries/teams";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/~/settings/teams",
	useSearchParams: () => new URLSearchParams(""),
}));

const { getTeamsPage } = vi.hoisted(() => ({
	getTeamsPage: vi.fn<(query: unknown) => Promise<TeamsPage>>(),
}));

vi.mock("@/app/server/actions/teams", () => ({ getTeamsPage }));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: {} } }));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => true }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({ FeatureUpsell: () => null }));
vi.mock("@/components/settings/teams/manage-team-dialog", () => ({ ManageTeamDialog: () => null }));

import { TeamsList } from "@/components/settings/teams/teams-list";
import { useTeamsFilters } from "@/lib/stores/use-settings-filters";

/** A one-team page. */
const PAGE: TeamsPage = {
	rows: [{ id: "t1", name: "Networking", memberCount: 0, members: [] }],
	resultCount: 1,
	total: 1,
	facets: { sizes: [] },
};

/** The list inside a fresh query provider. */
function tree(): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<TeamsList />
		</QueryClientProvider>
	);
}

/** The list's root — the node that carries `aria-busy`. */
function root(container: HTMLElement): Element {
	const el = container.firstElementChild;
	if (el === null) throw new Error("the list rendered nothing");
	return el;
}

beforeEach(() => {
	sessionStorage.clear();
	useTeamsFilters.getState().reset();
	getTeamsPage.mockReset();
});

describe("TeamsList marks itself busy until its first answer (#5494)", () => {
	it("declares aria-busy on the first-load skeleton", async () => {
		getTeamsPage.mockImplementation(() => new Promise<TeamsPage>(() => {}));
		const { container } = render(tree());
		await waitFor(() => expect(getTeamsPage).toHaveBeenCalled());
		expect(root(container).getAttribute("aria-busy")).toBe("true");
		expect(screen.queryByText("Networking")).toBeNull();
	});

	it("clears aria-busy once the teams have loaded", async () => {
		getTeamsPage.mockResolvedValue(PAGE);
		const { container } = render(tree());
		await waitFor(() => expect(screen.getByText("Networking")).toBeTruthy());
		await waitFor(() => expect(root(container).getAttribute("aria-busy")).toBe("false"));
	});
});
