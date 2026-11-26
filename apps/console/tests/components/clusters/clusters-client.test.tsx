// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6819 (RUBRIC B3/B4): the clusters list's renders are different things. Pending is the skeleton,
// never the empty state; a refusal says the viewer lacks access and offers no retry; a failure says
// it failed and offers one; no clusters in scope is the empty state with ITS next action; clusters
// the filters exclude is "no match" with a way back; and clusters are a table, one row per cluster,
// led by the environment. A refresh that fails after data arrived keeps the rows.
//
// And the list is on the filter standard: the read's input is the normalized query, a project is a
// SCOPE in that input and never a filter, and the open row is in the URL. And on the list standard
// (LST-3 #7485): the read is `useKeysetList(orpc.clusters.page, query)`, the table is in server
// mode with its footer, there is no count and no `?page=`.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";
import { clusterItem } from "./fixtures";

const h = vi.hoisted(() => ({
	query: {} as Record<string, unknown>,
	inputs: [] as unknown[],
	replace: vi.fn(),
	search: new URLSearchParams(),
	project: undefined as string | undefined,
	handlers: {} as Record<string, FakeHandler>,
	loadMore: vi.fn(),
	loadMoreFailed: false,
}));

/** The list's state, as `useKeysetList` would derive it from `h.query` (the first page's status). */
vi.mock("@/lib/query/use-keyset-list", () => ({
	useKeysetList: (_procedure: unknown, input: unknown) => {
		h.inputs.push(input);
		const q = h.query as {
			data?: { rows: unknown[]; facets: unknown; universeEmpty: boolean | null; nextCursor: string | null };
			isPlaceholderData?: boolean;
		};
		return {
			rows: q.data?.rows ?? [],
			facets: q.data?.facets ?? null,
			universeEmpty: q.data?.universeEmpty ?? null,
			query: h.query,
			isPending: q.data === undefined,
			isPlaceholderData: q.isPlaceholderData ?? false,
			hasMore: q.data?.nextCursor != null,
			loadingMore: false,
			loadMoreFailed: h.loadMoreFailed,
			loadMore: h.loadMore,
		};
	},
}));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ project: h.project }),
	usePathname: () => (h.project ? `/acme/${h.project}/clusters` : "/acme/~/clusters"),
	useRouter: () => ({ replace: h.replace, push: vi.fn(), refresh: vi.fn() }),
	useSearchParams: () => h.search,
}));
vi.mock("@/app/server/actions/missing-cluster", () => ({ markEnvironmentDestroyedAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
vi.mock("@/components/clusters/kubeconfig-download/kubeconfig-download", () => ({ KubeconfigDownload: () => null }));

import { ClustersClient } from "@/app/(private)/[org]/~/clusters/clusters-client";
import { useClustersFilters } from "@/lib/stores/use-clusters-filters";

const refetch = vi.fn();
const FACETS = {
	clouds: [{ value: "aws", label: null, count: 3 }],
	statuses: [
		{ value: "failed", label: null, count: 1 },
		{ value: "pending", label: null, count: 0 },
		{ value: "active", label: null, count: 2 },
		{ value: "idle", label: null, count: 0 },
	],
	regions: [{ value: "eu-central-1", label: null, count: 3 }],
};

/** The read's first page for `rows`; `universeEmpty` unless the scope holds `total` clusters. */
function page(rows: ClusterListItem[], total = rows.length, nextCursor: string | null = null) {
	return {
		rows: rows.map((cluster) => ({ id: cluster.project_cluster.id, cluster })),
		nextCursor,
		facets: FACETS,
		universeEmpty: total === 0,
	};
}

/** A cluster `id` of environment `environment` in project `projectName`. */
function cluster(id: string, environment: string, projectName = "shop", over: Partial<ClusterListItem> = {}) {
	return clusterItem({ ...over, environment_stage: environment, project_name: projectName, project_cluster: { id } });
}

/** Renders the list (the drawer's mutations need a query client). */
function renderList(projectId?: string) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ClustersClient projectId={projectId} />
		</QueryClientProvider>,
	);
}

/** The environments the table's rows lead with, in order. */
function rowEnvironments(): string[] {
	return screen.getAllByRole("button", { name: /^Open .+ in .+$/ }).map((button) => button.textContent ?? "");
}

beforeEach(() => {
	vi.clearAllMocks();
	h.inputs.length = 0;
	h.search = new URLSearchParams();
	h.project = undefined;
	h.loadMoreFailed = false;
	delete h.handlers["clusters.detail"];
	h.query = { data: undefined, isError: false, isLoading: true, isPlaceholderData: false, error: null, refetch };
	act(() => useClustersFilters.getState().reset());
});

describe("ClustersClient — pending, refused, failed and empty are distinct", () => {
	it("pending is the skeleton, in the list's shape — not the empty state", () => {
		const { container } = renderList();
		const skeleton = container.querySelector('[data-skeleton="clusters"]');
		expect(skeleton).toHaveAttribute("aria-busy", "true");
		// The org list has a Project column; a project's own list does not.
		expect(skeleton?.querySelectorAll("th")).toHaveLength(6);
		expect(screen.queryByText(/No clusters/)).toBeNull();
	});

	it("a project's skeleton has no Project column", () => {
		h.project = "shop";
		const { container } = renderList("p1");
		expect(container.querySelectorAll('[data-skeleton="clusters"] th')).toHaveLength(5);
	});

	it("a refusal says the viewer lacks access, with nothing to retry", () => {
		h.query = { ...h.query, isError: true, error: new ORPCError("FORBIDDEN", { defined: true, status: 403 }) };
		renderList();
		expect(screen.getByText("You don't have access to clusters")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
		expect(screen.queryByText(/No clusters/)).toBeNull();
	});

	it("a failure is an error with a retry — not the empty state", async () => {
		h.query = { ...h.query, isError: true, error: new Error("boom") };
		renderList();
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load clusters");
		await userEvent.click(screen.getByRole("button", { name: /try again/i }));
		expect(refetch).toHaveBeenCalledOnce();
		expect(screen.queryByText(/No clusters/)).toBeNull();
	});

	it("an organization with no clusters is told how one appears, and offered the action that names where it goes", () => {
		h.query = { ...h.query, isLoading: false, data: page([]) };
		renderList();
		expect(screen.getByText("No clusters under management")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Create a project" })).toHaveAttribute("href", "/acme/~/new");
	});

	it("a project with no clusters offers Open Architecture — its next step stays in the project", () => {
		h.project = "shop";
		h.query = { ...h.query, isLoading: false, data: page([]) };
		renderList("p1");
		expect(screen.getByText("This project has no clusters yet")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Open Architecture" })).toHaveAttribute("href", "/acme/shop/architecture");
		expect(screen.queryByRole("link", { name: /projects/i })).toBeNull();
	});

	it("clusters the filters exclude is `no match`, with a way back — never the onboarding state", async () => {
		h.query = { ...h.query, isLoading: false, data: page([], 3) };
		act(() => useClustersFilters.getState().set("statuses", ["failed"]));
		renderList();
		expect(screen.getByText("No clusters match these filters.")).toBeInTheDocument();
		expect(screen.queryByText("No clusters under management")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
		expect(useClustersFilters.getState().filters.statuses).toEqual([]);
	});
});

describe("ClustersClient — the table", () => {
	const THREE = [cluster("c1", "production"), cluster("c2", "staging"), cluster("c3", "production", "search")];

	it("is one row per cluster, led by the environment — two environments of one project are two rows", () => {
		h.query = { ...h.query, isLoading: false, data: page(THREE) };
		renderList();
		expect(screen.getByRole("table")).toBeInTheDocument();
		expect(rowEnvironments()).toEqual(["production", "staging", "production"]);
		expect(screen.getByRole("button", { name: "Open staging in shop" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Open production in search" })).toBeInTheDocument();
		expect(screen.getByRole("columnheader", { name: /project/i })).toBeInTheDocument();
		// One row, no description line, and no count anywhere in it (lib/query/README.md → "Counts").
		expect(document.querySelector('[data-slot="page-toolbar"]')).toBeNull();
		const row = document.querySelector('[data-slot="filter-search"]')?.parentElement;
		expect(row?.textContent ?? "").not.toMatch(/\d/);
		expect(screen.queryByText(/Every cluster this organization/)).toBeNull();
	});

	it("pages by keyset: a further page is the footer's Load more, never page numbers", async () => {
		h.query = { ...h.query, isLoading: false, data: page(THREE, 3, "next") };
		renderList();
		expect(screen.queryByRole("button", { name: /next page|previous page/i })).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(h.loadMore).toHaveBeenCalledOnce();
		expect(h.replace).not.toHaveBeenCalled(); // the cursor never enters the URL
	});

	it("at the end there is no footer at all", () => {
		h.query = { ...h.query, isLoading: false, data: page(THREE) };
		renderList();
		expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
	});

	it("a failed later page keeps the rows and offers the retry line", () => {
		h.loadMoreFailed = true;
		h.query = { ...h.query, isLoading: false, data: page(THREE, 3, "next") };
		renderList();
		expect(rowEnvironments()).toHaveLength(3);
		expect(screen.getByText("Couldn't load more")).toBeInTheDocument();
	});

	it("links each row's project, on the organization's list", () => {
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		expect(screen.getByRole("link", { name: "shop" })).toHaveAttribute("href", "/acme/shop/architecture");
	});

	it("a failed last run is a link to that run", () => {
		h.query = {
			...h.query,
			isLoading: false,
			data: page([cluster("c1", "production", "shop", { status: "FAILED", last_job_id: "job-9" })]),
		};
		renderList();
		expect(screen.getByRole("link", { name: "Last run failed" })).toHaveAttribute("href", "/acme/~/jobs/job-9");
	});

	it("keeps the rows when a refresh fails after data arrived, and says they may be out of date", () => {
		h.query = { ...h.query, isLoading: false, data: page(THREE), isError: true, error: new Error("boom") };
		renderList();
		expect(rowEnvironments()).toHaveLength(3);
		expect(screen.getByText(/Couldn't refresh/)).toBeInTheDocument();
	});

	it("dims the rows and reports busy while they are the previous query's", () => {
		h.query = { ...h.query, isLoading: false, data: page(THREE), isPlaceholderData: true };
		const { container } = renderList();
		expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(container.querySelector(".opacity-60")).not.toBeNull();
	});
});

describe("ClustersClient — the filter standard", () => {
	it("the organization's pristine read has an empty input", () => {
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		expect(h.inputs.at(-1)).toEqual({});
	});

	it("a project is a SCOPE in the read's input — not a filter, and not a Project column", () => {
		h.project = "shop";
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList("p2");
		expect(h.inputs.at(-1)).toEqual({ projectId: "p2" });
		expect(useClustersFilters.getState().filters).toEqual({ search: "", clouds: [], statuses: [], regions: [] });
		expect(screen.queryByRole("columnheader", { name: /project/i })).toBeNull();
		// Nothing about the project is written into the query string.
		expect(h.replace).not.toHaveBeenCalled();
	});

	it("a selection becomes the read's input, sorted, beside the scope", () => {
		h.project = "shop";
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList("p2");
		act(() => useClustersFilters.getState().set("statuses", ["pending", "failed"]));
		expect(h.inputs.at(-1)).toEqual({ projectId: "p2", statuses: ["failed", "pending"] });
	});

	it("a filter the link carries is read into the store, and so into the input", () => {
		h.search = new URLSearchParams("clouds=aws");
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		expect(useClustersFilters.getState().filters.clouds).toEqual(["aws"]);
		expect(h.inputs.at(-1)).toEqual({ clouds: ["aws"] });
	});

	it("offers the four statuses with their counts, from the read's facets", async () => {
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		await userEvent.click(screen.getByRole("button", { name: "Status" }));
		const counts: Record<string, number> = { "Needs attention": 1, "In progress": 0, Healthy: 2, Unverified: 0 };
		for (const [label, count] of Object.entries(counts)) {
			expect(await screen.findByRole("option", { name: `${label}, ${count}` })).toBeInTheDocument();
		}
	});

	it("a selected status names itself on the trigger, and its own × clears just that facet", async () => {
		h.search = new URLSearchParams("statuses=failed&regions=eu-central-1");
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		expect(screen.getByRole("button", { name: "Status: Needs attention" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Clear Status" }));
		expect(useClustersFilters.getState().filters.statuses).toEqual([]);
		expect(useClustersFilters.getState().filters.regions).toEqual(["eu-central-1"]);
	});
});

describe("ClustersClient — the open row is in the URL", () => {
	it("opening a row writes its cluster id into `?selected=`", async () => {
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		await userEvent.click(screen.getByRole("button", { name: "Open production in shop" }));
		expect(h.replace).toHaveBeenCalledWith("/acme/~/clusters?selected=c1", { scroll: false });
	});

	it("a link that names a row opens its record", () => {
		h.search = new URLSearchParams("selected=c2");
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production"), cluster("c2", "staging")]) };
		renderList();
		expect(screen.getByRole("dialog", { name: "staging · shop" })).toBeInTheDocument();
	});

	it("a deep link to a cluster that is not on a loaded page (page 3) opens it at once, read by id", async () => {
		const FAR = "33333333-3333-4333-8333-333333333333";
		h.search = new URLSearchParams(`selected=${FAR}`);
		// Two rows loaded and more to come: the selected cluster's row is pages away.
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production"), cluster("c2", "staging")], 120, "next") };
		const asked: unknown[] = [];
		h.handlers["clusters.detail"] = async (input) => {
			asked.push(input);
			return cluster(FAR, "qa", "billing");
		};
		renderList();
		expect(await screen.findByRole("dialog", { name: "qa · billing" })).toBeInTheDocument();
		expect(asked).toEqual([{ clusterId: FAR }]);
		// Nothing was paged to get there.
		expect(h.loadMore).not.toHaveBeenCalled();
	});

	it("on a project's list the by-id read carries the project as its scope", async () => {
		const FAR = "33333333-3333-4333-8333-333333333333";
		h.project = "shop";
		h.search = new URLSearchParams(`selected=${FAR}`);
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")], 120, "next") };
		const asked: unknown[] = [];
		h.handlers["clusters.detail"] = async (input) => {
			asked.push(input);
			return null;
		};
		renderList("p2");
		await waitFor(() => expect(asked).toEqual([{ clusterId: FAR, projectId: "p2" }]));
		// The cluster is not visible in this scope: nothing opens.
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("a loaded row opens from the page, with no by-id read", () => {
		h.search = new URLSearchParams("selected=c2");
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production"), cluster("c2", "staging")]) };
		h.handlers["clusters.detail"] = async () => {
			throw new Error("must not be asked");
		};
		renderList();
		expect(screen.getByRole("dialog", { name: "staging · shop" })).toBeInTheDocument();
	});

	it("a link that names a row the list does not have opens nothing", () => {
		h.search = new URLSearchParams("selected=gone");
		h.query = { ...h.query, isLoading: false, data: page([cluster("c1", "production")]) };
		renderList();
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
