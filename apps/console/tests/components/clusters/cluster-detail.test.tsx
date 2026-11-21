// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6819: a cluster's record (the drawer a table row opens). It names the cluster, leads somewhere
// from every state — its project, its environment on the board, and the run that last moved it —
// and never prints a backend's text as its own sentence: what a probe was told is behind "Details".

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";
import { ENV, UNREACHABLE, clusterItem } from "./fixtures";

const h = vi.hoisted(() => ({ handlers: {} as Record<string, FakeHandler> }));
vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("@/app/server/actions/missing-cluster", () => ({ markEnvironmentDestroyedAction: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
vi.mock("@/components/clusters/kubeconfig-download/kubeconfig-download", () => ({
	KubeconfigDownload: ({ allowed }: { allowed: boolean }) => (allowed ? <div data-testid="kubeconfig-download" /> : null),
}));

import { cloudLabel, providerName } from "@/components/clusters/cloud-label";
import { ClusterDetailSheet, clusterMeta } from "@/components/clusters/cluster-detail";
import { clusterPosture } from "@/components/clusters/cluster-posture";

/** Opens the record of `cluster`. */
function openRecord(cluster: ClusterListItem) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ClusterDetailSheet cluster={cluster} posture={clusterPosture(cluster)} orgSlug="acme" onClose={vi.fn()} />
		</QueryClientProvider>,
	);
}

describe("ClusterDetailSheet", () => {
	it("is a titled dialog, led by the environment", () => {
		openRecord(clusterItem());
		expect(screen.getByRole("dialog", { name: "production · shop" })).toBeInTheDocument();
	});

	it("renders nothing open while no cluster is selected", () => {
		const client = new QueryClient();
		render(
			<QueryClientProvider client={client}>
				<ClusterDetailSheet cluster={null} posture={null} orgSlug="acme" onClose={vi.fn()} />
			</QueryClientProvider>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("links to the project and to the environment on the board", () => {
		openRecord(clusterItem());
		expect(screen.getByRole("link", { name: "Open project" })).toHaveAttribute("href", "/acme/shop/architecture");
		expect(screen.getByRole("link", { name: "Open Architecture" })).toHaveAttribute(
			"href",
			`/acme/shop/architecture?environment_id=${ENV}`,
		);
	});

	it("a failed last run links to that run — the status is not a dead end", () => {
		openRecord(clusterItem({ status: "FAILED", last_job_id: "job-9" }));
		expect(screen.getByText("Last run failed")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "View last run" })).toHaveAttribute("href", "/acme/~/jobs/job-9");
	});

	it("offers no last-run link when the viewer can see no run", () => {
		openRecord(clusterItem({ status: "FAILED", last_job_id: null }));
		expect(screen.queryByRole("link", { name: "View last run" })).toBeNull();
	});

	it("says what an unreachable control plane means in its own words; the probe's text is behind Details", () => {
		openRecord(clusterItem({ project_cluster: { observation: UNREACHABLE } }));
		const observed = document.querySelector('[data-slot="cluster-observed"]');
		expect(observed).toHaveTextContent("could not reach the control plane");
		expect(observed).toHaveTextContent("Check that the cluster is running");
		const details = observed?.querySelector("details");
		expect(details).not.toBeNull();
		expect(details).toHaveTextContent("dial tcp 10.0.0.1:443: i/o timeout");
		// The sentence itself does not carry the raw text.
		expect(observed?.querySelector("p")).not.toHaveTextContent("dial tcp");
	});

	it("opens ArgoCD through one link — not a button nested in an anchor", () => {
		openRecord(clusterItem({ project_cluster: { argocd_url: "https://argocd.shop.example" } }));
		const link = screen.getByRole("link", { name: "Open ArgoCD in a new tab" });
		expect(link).toHaveAttribute("href", "https://argocd.shop.example");
		expect(link).toHaveAttribute("target", "_blank");
		expect(link.querySelector("button")).toBeNull();
		expect(link.closest("button")).toBeNull();
	});

	it("shows the access block only for a cluster with an endpoint, with the download where it is allowed", () => {
		const { unmount } = openRecord(clusterItem());
		expect(document.querySelector('[data-slot="cluster-access"]')).toBeNull();
		unmount();
		openRecord(
			clusterItem({
				can_download_kubeconfig: true,
				project_cluster: {
					cluster_endpoint: "https://10.0.0.1",
					kubeconfig: { command: "alethia cluster kubeconfig shop-prod", alternative: null, note: null },
				},
			}),
		);
		expect(document.querySelector('[data-slot="cluster-access"]')).toHaveTextContent("https://10.0.0.1");
		expect(screen.getByRole("button", { name: "Copy kubeconfig command" })).toBeInTheDocument();
		expect(screen.getByTestId("kubeconfig-download")).toBeInTheDocument();
	});

	it("lists each component with its own status", () => {
		openRecord(
			clusterItem({
				project_databases: [
					{ name: "orders", engine: "postgres", endpoint: null, reader_endpoint: null, master_credentials_secret_arn: null, status: "FAILED" },
				],
			}),
		);
		const rows = [...document.querySelectorAll('[data-slot="cluster-component"]')];
		expect(rows.map((row) => row.textContent)).toEqual([
			expect.stringContaining("Control plane"),
			expect.stringContaining("orders"),
		]);
		expect(rows[1]).toHaveTextContent("Failed");
	});
});

describe("cloudLabel / clusterMeta", () => {
	it("a cluster with no known cloud account is not labelled as any cloud", () => {
		const unknown = clusterItem({ cloud_identities: null });
		expect(cloudLabel(unknown)).toBeNull();
		expect(clusterMeta(unknown)).toBe("eu-central-1");
	});

	it("a provider the label table does not know is shown as itself — never as another cloud", () => {
		expect(providerName("aws")).toBe("AWS");
		expect(providerName("some-new-cloud")).toBe("some-new-cloud");
	});

	it("names the cloud, the region and the Kubernetes version", () => {
		expect(clusterMeta(clusterItem({ project_cluster: { k8s_version: "1.31" } }))).toBe(
			"AWS · eu-central-1 · Kubernetes 1.31",
		);
	});
});
