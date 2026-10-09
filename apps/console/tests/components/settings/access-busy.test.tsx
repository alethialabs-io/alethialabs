// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Settings · Access does not show an entitled org the upsell while the workspace store loads, and
// says when its list does not yet answer (#5850).
//
// The release gate's audit-interaction leg read `/[org]/[project]/settings/access` as a list of 0
// rows although `seed-filters.ts` had written two grants into that project. The page gated its
// grants query on `useEntitlement("customRoles")`, which reads the workspace store — `null` until
// `fetchWorkspace()` answers after hydration, and `null` reads as "not entitled". So an Enterprise
// org was first shown `FeatureUpsell`, an `EmptyState` with no `aria-busy` beside it, and the
// audit's `settle()` took two identical reads of it as the answer whenever that round trip ran
// past its ~900 ms window. Drives the real manager, the real workspace store (left unloaded, which
// is its state on every first paint) and the real grants query hook; only the network edges are
// mocked.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccessGrantsPage } from "@/lib/queries/access-grants";

vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn() }),
	usePathname: () => "/acme/proj/settings/access",
	useSearchParams: () => new URLSearchParams(""),
}));

const { getAccessGrantsPage } = vi.hoisted(() => ({
	getAccessGrantsPage: vi.fn<(query: unknown) => Promise<AccessGrantsPage>>(),
}));

vi.mock("@/app/server/actions/grants", () => ({
	getAccessGrantsPage,
	assignGrant: vi.fn(),
	revokeGrant: vi.fn(),
	getGrantOptions: vi.fn(async () => ({ roles: [], permissions: [], principals: [], resources: {} })),
}));
vi.mock("@/app/server/actions/workspace", () => ({
	getWorkspaceContext: vi.fn(),
	setActiveOrganization: vi.fn(),
}));
vi.mock("@/components/settings/upgrade/feature-upsell", () => ({
	FeatureUpsell: () => <div>Custom access is an Enterprise feature</div>,
}));

import { AccessManager } from "@/components/settings/access/access-manager";
import { useAccessFilters } from "@/lib/stores/use-settings-filters";
import { useWorkspaceStore } from "@/lib/stores/use-workspace-store";

const UPSELL = "Custom access is an Enterprise feature";

/** One project-scoped grant bound to a team, in the shape `getAccessGrantsPage` returns. */
function grant(id: string, effect: "allow" | "deny") {
	return {
		id,
		principalType: "team",
		principalId: "team-1",
		principalLabel: `Filters team ${id}`,
		effect,
		roleName: null,
		permissionKey: null,
		resourceType: "project",
		resourceId: "proj-1",
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

/** The two-grant page `seed-filters.ts` puts behind the project's Access list. */
const PAGE: AccessGrantsPage = {
	rows: [grant("a", "allow"), grant("b", "deny")],
	resultCount: 2,
	total: 2,
	facets: {
		scopes: [{ value: "project", label: "Project", count: 2 }],
		roles: [{ value: "—", label: "—", count: 2 }],
		effects: [
			{ value: "allow", label: "Allow", count: 1 },
			{ value: "deny", label: "Deny", count: 1 },
		],
	},
};

/** The manager inside a fresh query provider, as the project-scoped page renders it. */
function tree(customRoles: boolean): ReactNode {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return (
		<QueryClientProvider client={qc}>
			<AccessManager projectId="proj-1" customRoles={customRoles} />
		</QueryClientProvider>
	);
}

/** Every node in the render that declares itself busy. */
function busyNodes(container: HTMLElement): Element[] {
	return [...container.querySelectorAll('[aria-busy="true"]')];
}

beforeEach(() => {
	sessionStorage.clear();
	useAccessFilters.getState().reset();
	// The store as every first paint finds it: `fetchWorkspace()` has not answered yet.
	useWorkspaceStore.setState({ entitlements: null });
	getAccessGrantsPage.mockReset();
});

describe("Settings · Access before the workspace store has loaded (#5850)", () => {
	it("shows an entitled org its grants, never the upsell", async () => {
		getAccessGrantsPage.mockResolvedValue(PAGE);
		render(tree(true));
		expect(screen.queryByText(UPSELL)).toBeNull();
		await waitFor(() => expect(screen.getByText("Filters team a")).toBeTruthy());
		expect(screen.getByText("Filters team b")).toBeTruthy();
		expect(screen.queryByText(UPSELL)).toBeNull();
	});

	it("declares aria-busy on the first-load skeleton, and clears it once the grants answer", async () => {
		let answer: (page: AccessGrantsPage) => void = () => {};
		getAccessGrantsPage.mockImplementation(() => new Promise<AccessGrantsPage>((resolve) => (answer = resolve)));
		const { container } = render(tree(true));
		await waitFor(() => expect(getAccessGrantsPage).toHaveBeenCalled());
		expect(busyNodes(container).length).toBeGreaterThan(0);
		expect(container.querySelector('[data-slot="empty"]')).toBeNull();

		answer(PAGE);
		await waitFor(() => expect(screen.getByText("Filters team a")).toBeTruthy());
		await waitFor(() => expect(busyNodes(container)).toEqual([]));
	});

	it("still shows the upsell to an org the server says is not entitled", () => {
		render(tree(false));
		expect(screen.getByText(UPSELL)).toBeTruthy();
		expect(getAccessGrantsPage).not.toHaveBeenCalled();
	});
});
