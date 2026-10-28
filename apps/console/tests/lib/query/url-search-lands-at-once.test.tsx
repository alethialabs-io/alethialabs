// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A search term that came from the LINK is applied at once; only typing waits out the debounce
// (#5861).
//
// `useFilterUrlSync` reads the link into the page's filter store in its mount effect. A list that
// debounced `filters.search` WITHOUT telling the debounce the URL had been read started from the
// store's default `""` and caught up 250–300ms later. For that window its query key was the
// UNFILTERED one: `~/evidence?search=<project>` fetched every environment in the org, and
// `keepPreviousData` held those rows on screen until the filtered answer landed. A strict e2e
// locator in that window matched 13 rows instead of 1 (release-gate run 37918485462,
// deploy-jobs.spec.ts:186).
//
// Each test renders the REAL surface on a link carrying `search=`, with fake timers that are never
// advanced — so no debounce can elapse — and asserts the link's search already reached the surface's
// data seam (the server action or query hook it is asked through) or, where the search is applied
// on the client (support cases, connectors), that the non-matching row is not on screen.
//
// Mutation check (done when this was written): dropping `{ urlRead }` from each surface's
// `useDebouncedValue` call fails that surface's test. The keystroke test passes either way — it is
// there so the fix cannot become "stop debouncing".
//
// The evidence hook is held to more than that: its route prefetches the LINK's key and nothing else,
// so before the link is read into the store the hook asks for the link's own filters (#6126) — its
// first read is the filtered one, and it never asks for the unfiltered roll-up. Mutation check
// (#6126): making the hook read the store before `urlRead` fails the "first fetch" test with `{}`.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectorWithConnection } from "@/app/server/actions/connectors";
import type { SsoBootstrap } from "@/app/server/actions/sso";
import type { CaseListItem } from "@/lib/queries/support";
import { orpc } from "@/lib/rpc/client";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

/** The query string the "pasted link" carries; each test sets it before rendering. */
let currentSearch = "";
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme" }),
	useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
	usePathname: () => "/acme/~/list",
	useSearchParams: () => new URLSearchParams(currentSearch),
}));

// ── Data seams. Every fetch stays in flight; what is asserted is what each was ASKED. ──────────
// The read router: every procedure answers with a promise that never settles, and `rpc.calls` logs
// what each was asked (the evidence page reads `evidence.page` over GET since #6126).
const rpc = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler>, calls: [] as FakeCall[] }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	rpc.handlers["evidence.page"] = () => new Promise(() => {});
	rpc.handlers["support.cases"] = () => new Promise(() => {});
	// The Activity feed's pages and the SSO bootstrap are GET reads since #6129.
	rpc.handlers["activity.page"] = () => new Promise(() => {});
	rpc.handlers["sso.bootstrap"] = () => new Promise(() => {});
	return { orpc: fakeOrpc(rpc.handlers, rpc.calls).orpc };
});

/** Every input `evidence.page` was asked for, in order. */
const evidenceAsked = () => rpc.calls.filter((c) => c.path === "evidence.page").map((c) => c.input);
vi.mock("@/app/server/actions/activity", () => ({ getActivityExportCsv: vi.fn() }));
vi.mock("@/app/server/actions/members", () => ({ getMembers: vi.fn(() => new Promise(() => {})) }));

/** Every search `useRolesQuery` / `useSsoProvidersQuery` was called with, in render order. */
const asked = vi.hoisted(() => ({ roles: [] as Array<string | undefined>, sso: [] as Array<string | undefined> }));
/** The role catalog the route prefetches (#6129) — a viewer's, with one built-in role. */
const catalog = vi.hoisted(() => ({
	data: {
		builtin: [
			{
				id: "role-viewer",
				name: "Viewer",
				description: "Read-only access.",
				builtin: true,
				permissionKeys: [],
				grantCount: 0,
			},
		],
		permissions: [],
		customRoles: false,
		canManage: false,
	},
}));
vi.mock("@/lib/query/use-roles-query", () => ({
	useRolesQuery: (search?: string) => {
		asked.roles.push(search);
		return { data: [], error: null, isFetching: false, isPending: false, isPlaceholderData: false };
	},
	useRoleCatalogQuery: () => ({ data: catalog.data, error: null, isPending: false, isError: false }),
}));
vi.mock("@/lib/query/use-sso-query", () => ({
	useSsoProvidersQuery: (filter?: { search?: string }) => {
		asked.sso.push(filter?.search);
		return { data: [], isFetching: false, isPlaceholderData: false, isPending: false, isError: false, error: null };
	},
	ssoReadKeys: () => [],
}));
vi.mock("@/app/server/actions/roles", () => ({ deleteRole: vi.fn(async () => ({ ok: true, data: { id: "" } })) }));
vi.mock("@/app/server/actions/connectors", () => ({
	deleteConnectorCredential: vi.fn(),
	saveConnectorCredential: vi.fn(),
}));
vi.mock("@/app/server/actions/identities", () => ({
	deleteProviderToken: vi.fn(),
	disconnectCloudAccount: vi.fn(),
	renameCloudAccount: vi.fn(),
	verifyCloudAccount: vi.fn(),
	connectCloudAccount: vi.fn(),
	startCloudConnect: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn(), captureException: vi.fn() }));

// ── Page furniture that is not under test. ────────────────────────────────────────────────────
vi.mock("@/lib/query/use-projects-query", () => ({ useProjectsQuery: () => ({ data: [] }) }));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useActiveOrgSlug: () => "acme",
	useWorkspaceStore: (sel: (s: unknown) => unknown) =>
		sel({ entitlements: { quotas: { activityRetentionDays: 7 } } }),
}));
vi.mock("@/components/settings/enterprise-gate", () => ({ useEntitlement: () => false }));
vi.mock("@/components/org/upgrade-org-sheet", () => ({ UpgradeOrgSheet: () => null }));
vi.mock("@/components/settings/upgrade/upgrade-dialog", () => ({ UpgradeDialog: () => null }));
vi.mock("@/components/settings/roles/role-sheet", () => ({ RoleSheet: () => null }));
vi.mock("@/components/settings/sso/provider-sheet", () => ({ ProviderSheet: () => null }));
vi.mock("@/components/classification/classification-chips", () => ({ ClassificationChips: () => null }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));

import { ConnectorsPage } from "@/components/connectors/connectors-page";
import { DEFAULT_EVIDENCE_FILTERS } from "@/components/evidence/evidence-query";
import { ActivityLog } from "@/components/settings/activity/activity-log";
import { RolesManager } from "@/components/settings/roles/roles-manager";
import { SsoManager } from "@/components/settings/sso/sso-manager";
import { CaseList } from "@/components/support/cases/case-list";
import { useFilterUrlSync } from "@/hooks/use-filter-url-sync";
import { useEvidenceQuery } from "@/lib/query/use-evidence-query";
import { useConnectorFilters } from "@/lib/stores/use-connector-filters";
import { useEvidenceFilters } from "@/lib/stores/use-evidence-filters";
import { useActivityFilters, useRolesFilters, useSsoFilters } from "@/lib/stores/use-settings-filters";
import { useSupportFilters } from "@/lib/stores/use-support-filters";

/** Renders under a fresh QueryClient — a shared one would carry one test's keys into the next. */
function renderWithClient(ui: ReactElement, seed?: (qc: QueryClient) => void) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000 } } });
	seed?.(qc);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>{children}</QueryClientProvider>
	);
	return render(ui, { wrapper });
}

/** Lets the mount effects' promises settle WITHOUT moving the clock — no debounce can elapse. */
async function settleWithoutTime(): Promise<void> {
	await act(async () => {});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	sessionStorage.clear();
	asked.roles.length = 0;
	asked.sso.length = 0;
	rpc.calls.length = 0;
	useEvidenceFilters.getState().reset();
	useActivityFilters.getState().reset();
	useRolesFilters.getState().reset();
	useSsoFilters.getState().reset();
	useSupportFilters.getState().reset();
	useConnectorFilters.getState().reset();
});

afterEach(() => {
	vi.useRealTimers();
	currentSearch = "";
});

/** The Evidence page's pipeline, composed exactly as `EvidenceClient` composes it. */
function EvidenceHarness(): null {
	const urlRead = useFilterUrlSync(useEvidenceFilters, DEFAULT_EVIDENCE_FILTERS);
	useEvidenceQuery(urlRead);
	return null;
}

describe("useEvidenceQuery — ~/evidence?search=…", () => {
	it("makes its FIRST fetch with the link's search, and never asks for the unfiltered roll-up", async () => {
		currentSearch = "search=payments";
		renderWithClient(<EvidenceHarness />);
		await settleWithoutTime();

		const calls = evidenceAsked();
		expect(calls[0], "the first fetch is the link's filtered key").toEqual({ search: "payments" });
		expect(calls).not.toContainEqual({});
	});

	it("still debounces what is TYPED once the link has been read", async () => {
		currentSearch = "search=payments";
		renderWithClient(<EvidenceHarness />);
		await settleWithoutTime();
		rpc.calls.length = 0;

		act(() => useEvidenceFilters.getState().set("search", "paymentsx"));
		await settleWithoutTime();
		expect(evidenceAsked(), "a keystroke waits out the debounce").toEqual([]);

		await act(async () => vi.advanceTimersByTime(300));
		expect(evidenceAsked()).toEqual([{ search: "paymentsx" }]);
	});
});

describe("ActivityLog — ~/settings/activity?search=…", () => {
	it("asks for the link's search before any debounce has elapsed", async () => {
		currentSearch = "search=deploy";
		renderWithClient(<ActivityLog />);
		await settleWithoutTime();

		const searches = rpc.calls
			.filter((c) => c.path === "activity.page")
			.map((c) => (typeof c.input === "object" && c.input !== null && "search" in c.input ? c.input.search : undefined));
		expect(searches).toContain("deploy");
	});
});

describe("CaseList — ~/support/my-cases?search=…", () => {
	const item = (id: string, case_number: number, subject: string): CaseListItem => ({
		id,
		case_number,
		subject,
		type: "technical",
		category: "runners",
		severity: "normal",
		status: "open",
		last_message_at: new Date("2026-10-09T08:00:00.000Z"),
		last_author_type: "customer",
		created_at: new Date("2026-10-09T08:00:00.000Z"),
		unread: false,
		requester_name: null,
		is_mine: true,
	});

	it("shows only the matching case before any debounce has elapsed", async () => {
		currentSearch = "search=registry";
		renderWithClient(<CaseList orgSlug="acme" seeAll={false} />, (qc) =>
			qc.setQueryData(orpc.support.cases.queryOptions({ input: { bucket: "all" } }).queryKey, [
				item("c1", 1042, "Runner cannot reach the registry"),
				item("c2", 1043, "Invoice address is wrong"),
			]),
		);
		await settleWithoutTime();

		expect(screen.getByText("Runner cannot reach the registry")).toBeInTheDocument();
		expect(screen.queryByText("Invoice address is wrong"), "the unfiltered row is not on screen").toBeNull();
	});
});

describe("RolesManager — ~/settings/roles?search=…", () => {
	it("asks for the link's search before any debounce has elapsed", async () => {
		currentSearch = "search=deployer";
		renderWithClient(<RolesManager />);
		await settleWithoutTime();

		expect(asked.roles).toContain("deployer");
	});
});

describe("SsoManager — ~/settings/sso?search=…", () => {
	const bootstrap: SsoBootstrap = {
		sso: true,
		canManage: false,
		orgId: "org-acme",
		slug: "acme",
		origin: "https://console.example",
	};

	it("asks for the link's search before any debounce has elapsed", async () => {
		currentSearch = "search=okta";
		renderWithClient(<SsoManager bootstrap={bootstrap} />);
		await settleWithoutTime();

		expect(asked.sso).toContain("okta");
	});
});

describe("ConnectorsPage — ~/connectors?search=…", () => {
	/** One observability connector from the catalog the board read returns. */
	const connector = (slug: string, name: string, organization: string): ConnectorWithConnection => ({
		id: `c-${slug}`,
		slug,
		name,
		description: `${name}.`,
		category: "observability",
		auth_method: "api_key",
		organization,
		icon_url: `/icons/${slug}.png`,
		docs_url: null,
		support_url: null,
		privacy_url: null,
		status: "active",
		sort_order: 0,
		created_at: null,
		updated_at: null,
		connected: false,
		connection_details: null,
		group: "observability",
	});

	it("shows only the matching connector before any debounce has elapsed", async () => {
		currentSearch = "search=Datadog";
		// The route prefetches the board for the LINK's filter and hydrates it; the seed is that
		// entry. Only a read keyed on `{ search: "Datadog" }` finds it: a debounce that started from
		// the store's empty search would ask the unfiltered key, find nothing, and show no Datadog.
		const datadog = connector("datadog", "Datadog", "Datadog, Inc.");
		const grafana = connector("grafana", "Grafana", "Grafana Labs");
		renderWithClient(<ConnectorsPage orgSlug="acme" />, (qc) =>
			qc.setQueryData(orpc.connectors.board.queryOptions({ input: { search: "Datadog" } }).queryKey, {
				view: {
					query: { search: "Datadog" },
					rows: [datadog],
					facets: { groups: [], health: [], vendors: [] },
					total: 2,
				},
				integrations: [datadog, grafana],
				canManage: false,
				platformConfigured: {},
			}),
		);
		await settleWithoutTime();

		expect(screen.getAllByText("Datadog").length).toBeGreaterThan(0);
		expect(screen.queryByText("Grafana"), "the unfiltered connector is not on the board").toBeNull();
	});
});
