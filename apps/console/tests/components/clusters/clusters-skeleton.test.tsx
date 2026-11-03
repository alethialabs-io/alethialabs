// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6349 (RUBRIC B2): the clusters skeleton draws the page the viewer is about to get. Both cluster
// routes' `loading.tsx` read the cluster list through the request's query client before they draw:
// no clusters draws the empty state's frame, clusters draw the card grid with a placeholder per card
// (each from its cluster's own `ClusterCardShape`), and a failed read draws the card grid. The skeleton
// used to draw two cards always (wrong for an org with none), then the empty frame always (wrong for
// every org with clusters). These tests pin the decision and the structure; the pixels are the
// release gate's to measure.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";

const h = vi.hoisted(() => {
	const client: { current: unknown } = { current: undefined };
	return { listRead: vi.fn<() => Promise<unknown>>(), client, project: { current: "shop" } };
});

// The routes' server read, answered per test, through ONE query client per test (the request's).
vi.mock("@/lib/rpc/server", () => ({
	serverOrpc: () => ({
		clusters: {
			list: {
				queryOptions: (options: object) => ({
					queryKey: ["clusters", "list"],
					queryFn: () => h.listRead(),
					...options,
				}),
			},
		},
	}),
}));
vi.mock("@/lib/query/client", () => ({ getQueryClient: () => h.client.current }));
vi.mock("@/lib/rpc/client", () => ({
	orpc: {
		workspace: {
			projects: {
				queryOptions: (options: object) => ({
					queryKey: ["workspace", "projects"],
					queryFn: () => Promise.reject(new Error("a skeleton must not fetch")),
					...options,
				}),
			},
		},
	},
}));
vi.mock("next/navigation", () => ({ useParams: () => ({ project: h.project.current }) }));
vi.mock("@/lib/query/use-clusters-query", () => ({
	useClustersQuery: () => ({ data: [], isError: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
vi.mock("@/components/clusters/kubeconfig-download/kubeconfig-download", () => ({
	KubeconfigDownload: ({ allowed }: { allowed: boolean }) =>
		allowed ? <button type="button" data-testid="kubeconfig-download" /> : null,
}));

const { ClusterCard } = await import("@/components/clusters/cluster-card");
const { CLUSTER_CARD_BLOCK, CLUSTER_COMPONENT_ROW, clusterCardShape } = await import(
	"@/components/clusters/cluster-card-shape"
);
const { CLUSTERS_REGION, ClustersSkeleton, MAX_CLUSTER_PLACEHOLDERS } = await import(
	"@/components/clusters/clusters-skeleton"
);
const { projectShapes } = await import("@/components/clusters/project-clusters-skeleton");
const { ClustersClient } = await import("@/app/(private)/[org]/~/clusters/clusters-client");
const { default: ClustersLoading } = await import("@/app/(private)/[org]/~/clusters/loading");
const { default: ClustersRoute } = await import("@/app/(private)/[org]/~/clusters/page");
const { default: ProjectClustersLoading } = await import("@/app/(private)/[org]/[project]/clusters/loading");

/** A cluster list entry for project `projectId`, with the blocks `extra` turns on. */
function item(projectId: string, extra: Partial<ClusterListItem> = {}, cluster: Partial<ClusterListItem["project_cluster"]> = {}): ClusterListItem {
	return {
		id: projectId,
		project_name: `project-${projectId}`,
		region: "eu-central-1",
		environment_stage: "production",
		status: "ACTIVE",
		cloud_identities: { provider: "aws" },
		project_cluster: {
			id: `cluster-${projectId}`,
			cluster_name: null,
			cluster_endpoint: null,
			cluster_arn: null,
			cluster_version: null,
			k8s_version: null,
			argocd_url: null,
			status: "ACTIVE",
			kubeconfig: { command: null, alternative: null, note: null },
			...cluster,
		},
		project_databases: [],
		project_caches: [],
		project_dns: null,
		apps_destination_repo: null,
		can_download_kubeconfig: false,
		kubeconfig_download_note: null,
		classification: [],
		...extra,
	};
}

/** A cluster with everything a card can draw: data services, DNS, every access line, ArgoCD. */
const FULL = item(
	"p1",
	{
		project_databases: [
			{ name: "db", engine: "postgres", endpoint: "db.local", reader_endpoint: null, master_credentials_secret_arn: null, status: "ACTIVE" },
		],
		project_caches: [{ name: "cache", engine: "redis", endpoint: null, status: "ACTIVE" }],
		project_dns: { domain_name: "shop.example.com", enabled: true },
		can_download_kubeconfig: true,
		kubeconfig_download_note: "Downloads are read-only.",
	},
	{
		cluster_endpoint: "https://k8s.example.com",
		argocd_url: "https://argocd.example.com",
		kubeconfig: { command: "alethia cluster kubeconfig shop", alternative: "aws eks update-kubeconfig", note: null },
	},
);

/** A cluster still provisioning: the control plane only, no access block, no ArgoCD. */
const BARE = item("p2");

/** A cluster with an endpoint but no command: the access block's note instead of the command rows. */
const NOTED = item("p3", {}, { cluster_endpoint: "https://k8s.example.com", kubeconfig: { command: null, alternative: null, note: "No command for this cloud." } });

/** The blocks a rendered card or placeholder draws, counted the same way for both. */
interface Drawn {
	components: number;
	access: { codeRows: number; captions: number; download: boolean } | null;
	argocd: boolean;
}

/** Counts a RENDERED `ClusterCard`'s blocks. */
function drawnCard(container: HTMLElement): Drawn {
	const rows = [...container.querySelectorAll("div")].filter((el) => el.className === CLUSTER_COMPONENT_ROW);
	const blocks = [...container.querySelectorAll("div")].filter((el) => el.className === CLUSTER_CARD_BLOCK);
	const access = blocks.find((el) => el.textContent?.includes("Cluster access"));
	return {
		components: rows.length,
		access: access
			? {
					codeRows: access.querySelectorAll("code").length,
					captions: access.querySelectorAll("p").length,
					download: access.querySelector('[data-testid="kubeconfig-download"]') !== null,
				}
			: null,
		argocd: blocks.some((el) => el.textContent?.includes("ArgoCD")),
	};
}

/** Counts one card PLACEHOLDER's blocks. */
function drawnPlaceholder(card: Element): Drawn {
	const access = card.querySelector('[data-slot="cluster-card-skeleton-access"]');
	return {
		components: card.querySelector('[data-slot="cluster-card-skeleton-components"]')?.children.length ?? 0,
		access: access
			? {
					codeRows: access.querySelectorAll('[data-row="code"]').length,
					captions: access.querySelectorAll('[data-row="caption"]').length,
					download: access.querySelector('[data-row="download"]') !== null,
				}
			: null,
		argocd: card.querySelector('[data-slot="cluster-card-skeleton-argocd"]') !== null,
	};
}

/** What a rendered skeleton draws: the empty frame, or the grid with its placeholder cards. */
function drawn(container: HTMLElement): "empty-frame" | Drawn[] {
	const root = container.querySelector('[data-slot="clusters-skeleton"]');
	if (!root) throw new Error("no clusters skeleton rendered");
	expect(root.getAttribute("aria-busy")).toBe("true");
	expect(container.querySelector('[data-slot="empty"]')).toBeNull();
	const cards = root.querySelectorAll('[data-slot="cluster-card-skeleton"]');
	if (cards.length === 0) return "empty-frame";
	return [...cards].map(drawnPlaceholder);
}

/** Renders `node` under a query client holding the shell's project list. */
function withProjects(node: ReactNode, projects: { id: string; slug: string }[] | undefined) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	if (projects) client.setQueryData(["workspace", "projects"], projects);
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

beforeEach(() => {
	h.listRead.mockReset();
	// The request's client, with the console's 30s `staleTime` (lib/query/client.ts): it is what lets
	// the page's prefetch be answered by the read `loading.tsx` just made instead of a second one.
	h.client.current = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
	h.project.current = "shop";
});

describe("clusterCardShape — the card's own blocks", () => {
	it.each([
		["everything", FULL],
		["a bare cluster", BARE],
		["an endpoint with a note", NOTED],
	])("matches what ClusterCard renders for %s", (_, data) => {
		const { container } = render(<ClusterCard data={data} />);
		const shape = clusterCardShape(data);
		expect(drawnCard(container)).toEqual({ components: shape.components, access: shape.access, argocd: shape.argocd });
	});

	it("a placeholder draws its cluster's shape block for block", () => {
		for (const data of [FULL, BARE, NOTED]) {
			const shape = clusterCardShape(data);
			const result = drawn(render(<ClustersSkeleton shapes={[shape]} />).container);
			expect(result).toEqual([{ components: shape.components, access: shape.access, argocd: shape.argocd }]);
		}
	});
});

describe("ClustersSkeleton — the page the viewer is about to get", () => {
	it("no clusters draws the empty state's frame, at the empty state's own classes", () => {
		const skeleton = render(<ClustersSkeleton shapes={[]} />);
		expect(drawn(skeleton.container)).toBe("empty-frame");
		const frame = skeleton.container.querySelector('[data-slot="clusters-skeleton"]')?.className;
		expect(skeleton.container.textContent).toBe("");
		skeleton.unmount();

		const empty = render(<ClustersClient />).container.querySelector('[data-slot="empty"]');
		expect(empty).not.toBeNull();
		expect(frame).toBe(empty?.className);
		expect(frame?.split(" ")).toContain(CLUSTERS_REGION);
	});

	it("N clusters draw the card grid with one placeholder per card, up to the cap", () => {
		const one = drawn(render(<ClustersSkeleton shapes={[clusterCardShape(BARE)]} />).container);
		expect(one).toHaveLength(1);
		const many = Array.from({ length: MAX_CLUSTER_PLACEHOLDERS + 3 }, () => clusterCardShape(FULL));
		expect(drawn(render(<ClustersSkeleton shapes={many} />).container)).toHaveLength(MAX_CLUSTER_PLACEHOLDERS);
	});

	it("an unanswered read draws the card grid, not the empty frame", () => {
		const result = drawn(render(<ClustersSkeleton shapes={undefined} />).container);
		expect(result).not.toBe("empty-frame");
		expect(result).toHaveLength(2);
	});
});

describe("the org route's loading.tsx reads the cluster list before it draws", () => {
	it("no clusters draws the empty frame", async () => {
		h.listRead.mockResolvedValue([]);
		expect(drawn(render(await ClustersLoading()).container)).toBe("empty-frame");
	});

	it("clusters draw one placeholder per cluster, each in its own shape", async () => {
		h.listRead.mockResolvedValue([FULL, BARE]);
		const result = drawn(render(await ClustersLoading()).container);
		expect(result).toEqual(
			[FULL, BARE].map((d) => {
				const { components, access, argocd } = clusterCardShape(d);
				return { components, access, argocd };
			}),
		);
	});

	it("a failed read draws the card grid", async () => {
		h.listRead.mockRejectedValue(new Error("unavailable"));
		const result = drawn(render(await ClustersLoading()).container);
		expect(result).not.toBe("empty-frame");
		expect(result).toHaveLength(2);
	});

	it("is one read with the page's prefetch, not two", async () => {
		h.listRead.mockResolvedValue([BARE]);
		await ClustersLoading();
		await ClustersRoute();
		expect(h.listRead).toHaveBeenCalledTimes(1);
	});
});

describe("the project route's loading.tsx keeps this project's cards", () => {
	const PROJECTS = [
		{ id: "p1", slug: "shop" },
		{ id: "p2", slug: "blog" },
	];

	it("the project's own clusters draw its cards", async () => {
		h.listRead.mockResolvedValue([FULL, BARE, item("p1")]);
		const result = drawn(withProjects(await ProjectClustersLoading(), PROJECTS).container);
		expect(result).toHaveLength(2);
	});

	it("a project with no cluster draws the empty frame, though the org has some", async () => {
		h.project.current = "docs";
		h.listRead.mockResolvedValue([FULL, BARE]);
		const result = drawn(withProjects(await ProjectClustersLoading(), [...PROJECTS, { id: "p9", slug: "docs" }]).container);
		expect(result).toBe("empty-frame");
	});

	it("an org with no clusters draws the empty frame, even before the project resolves", async () => {
		h.listRead.mockResolvedValue([]);
		expect(drawn(withProjects(await ProjectClustersLoading(), undefined).container)).toBe("empty-frame");
	});

	it("a failed read, or a project the shell cannot resolve, draws the card grid", async () => {
		h.listRead.mockRejectedValue(new Error("unavailable"));
		expect(drawn(withProjects(await ProjectClustersLoading(), PROJECTS).container)).toHaveLength(2);
		expect(projectShapes([clusterCardShape(BARE)], undefined)).toBeUndefined();
	});
});
