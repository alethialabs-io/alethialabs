// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6736: a cluster found deleted outside Alethia offers three ways out — Redeploy, Tear down, Mark as
// destroyed — on the cluster card AND on the environment card, and ONLY for a missing cluster. Nothing
// changes until a person clicks: the mark asks first, says plainly that no cloud resources are touched,
// and sends nothing when cancelled.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvReconcileState } from "@/app/server/actions/reconcile";
import type { ControlPlaneObservation } from "@/lib/clusters/observed-state";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import type { EnvRow } from "@/lib/rpc/procedures/environments";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";

const h = vi.hoisted(() => ({
	handlers: {} as Record<string, FakeHandler>,
	markEnvironmentDestroyedAction: vi.fn(),
}));

vi.mock("@/lib/rpc/client", async () => {
	const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
	return { orpc: fakeOrpc(h.handlers).orpc };
});
vi.mock("@/app/server/actions/missing-cluster", () => ({
	markEnvironmentDestroyedAction: h.markEnvironmentDestroyedAction,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/stores/use-workspace-store", () => ({ useActiveOrgSlug: () => "acme" }));
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
vi.mock("@/components/clusters/kubeconfig-download/kubeconfig-download", () => ({ KubeconfigDownload: () => null }));

import { ClusterCard } from "@/components/clusters/cluster-card";
import { clusterCardShape } from "@/components/clusters/cluster-card-shape";
import { MARK_DESTROYED_DESCRIPTION } from "@/components/clusters/missing-cluster-actions";
import { EnvironmentCard } from "@/components/environments/environment-card";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const ENV = "22222222-2222-4222-8222-222222222222";
const SCANNED = "2026-11-09T00:00:00.000Z";

const MISSING: ControlPlaneObservation = { kind: "missing", source: "drift", observedAt: SCANNED, deleted: ["aws_eks_cluster.main"] };
const REPORTED: ControlPlaneObservation = { kind: "reported", observedAt: SCANNED, source: "probe", fresh: true };
const UNREACHABLE: ControlPlaneObservation = { kind: "unreachable", observedAt: SCANNED, message: "timeout" };

/** A cluster list entry whose control plane is observed as `observation`, its environment `status`. */
function cluster(observation: ControlPlaneObservation, status = "ACTIVE"): ClusterListItem {
	return {
		id: PROJECT,
		project_name: "shop",
		project_slug: "shop",
		region: "eu-central-1",
		environment_id: ENV,
		environment_stage: "production",
		status,
		status_since: "2026-11-01T00:00:00.000Z",
		cloud_identities: { provider: "aws" },
		project_cluster: {
			id: "cluster-1",
			cluster_name: "shop-prod",
			cluster_endpoint: null,
			cluster_arn: null,
			cluster_version: null,
			k8s_version: null,
			argocd_url: null,
			status: "ACTIVE",
			observation,
			kubeconfig: { command: null, alternative: null, note: null },
		},
		project_databases: [],
		project_caches: [],
		project_dns: null,
		apps_destination_repo: null,
		can_download_kubeconfig: false,
		kubeconfig_download_note: null,
		classification: [],
	};
}

const ENV_ROW: EnvRow = {
	id: ENV,
	name: "production",
	stage: "production",
	is_default: true,
	status: "ACTIVE",
	updated_at: "2026-11-01T00:00:00.000Z",
	byo_admission_enforce: false,
	byo_admission_has_charts: false,
	byo_admission_pending: false,
};

/** The environment's reconcile state, with `clusterMissing` as given. */
function reconcile(clusterMissing: EnvReconcileState["clusterMissing"]): EnvReconcileState {
	return {
		environmentId: ENV,
		autoHeal: false,
		driftInSync: false,
		deliveryInSync: null,
		deployPending: false,
		clusterMissing,
		lastDeployedAt: "2026-07-16T12:00:00.000Z",
		probe: { reachable: null, message: null, probedAt: null },
	};
}

/** Renders `node` under a fresh query client (the mark's mutation needs one). */
function withClient(node: ReactNode) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** Renders the environment card for `env` with `missing` as its cluster finding. */
function environmentCard(missing: EnvReconcileState["clusterMissing"], env: EnvRow = ENV_ROW) {
	return withClient(
		<EnvironmentCard
			env={env}
			org="acme"
			project="shop"
			projectId={PROJECT}
			reconcile={reconcile(missing)}
			protection={undefined}
			classAssignments={[]}
			canEdit
			onEditRules={vi.fn()}
			onToggleHeal={vi.fn()}
			onEditAdmission={vi.fn()}
			onDuplicate={vi.fn()}
			onDelete={vi.fn()}
		/>,
	);
}

/** The three actions, as the screen offers them (null for one that is absent). */
function offered() {
	return {
		redeploy: screen.queryByRole("link", { name: "Redeploy" }),
		tearDown: screen.queryByRole("link", { name: "Tear down" }),
		mark: screen.queryByRole("button", { name: "Mark as destroyed" }),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	h.handlers["clusters.list"] = async () => [];
	h.handlers["environments.overview"] = async () => null;
	h.handlers["workspace.environments"] = async () => [];
});

describe("the cluster card", () => {
	it("offers all three for a missing cluster; both links open the environment on the board", () => {
		withClient(<ClusterCard data={cluster(MISSING)} />);
		const { redeploy, tearDown, mark } = offered();
		expect(mark).not.toBeNull();
		const board = `/acme/shop/architecture?environment_id=${ENV}`;
		expect(redeploy).toHaveAttribute("href", board);
		expect(tearDown).toHaveAttribute("href", board);
	});

	it.each([
		["reported", REPORTED],
		["unreachable", UNREACHABLE],
	])("offers none of them for a %s cluster", (_, observation) => {
		withClient(<ClusterCard data={cluster(observation)} />);
		expect(offered()).toEqual({ redeploy: null, tearDown: null, mark: null });
	});

	it("offers none while a run is in flight on the environment — the run writes its own outcome", () => {
		withClient(<ClusterCard data={cluster(MISSING, "PROVISIONING")} />);
		expect(offered()).toEqual({ redeploy: null, tearDown: null, mark: null });
	});

	it("its skeleton shape agrees: the actions block is drawn exactly when the card renders it", () => {
		expect(clusterCardShape(cluster(MISSING)).resolve).toBe(true);
		expect(clusterCardShape(cluster(REPORTED)).resolve).toBe(false);
		expect(clusterCardShape(cluster(MISSING, "PROVISIONING")).resolve).toBe(false);
	});
});

describe("the environment card", () => {
	it("offers all three when its reconcile state reports the cluster missing", () => {
		environmentCard({ observedAt: SCANNED, source: "drift", deleted: ["aws_eks_cluster.main"] });
		const { redeploy, tearDown, mark } = offered();
		expect(redeploy).not.toBeNull();
		expect(tearDown).not.toBeNull();
		expect(mark).not.toBeNull();
	});

	it("offers none when the cluster is not missing", () => {
		environmentCard(null);
		expect(offered()).toEqual({ redeploy: null, tearDown: null, mark: null });
	});
});

describe("Mark as destroyed", () => {
	it("asks first, says no cloud resources are touched, and sends nothing on Cancel", async () => {
		const user = userEvent.setup();
		withClient(<ClusterCard data={cluster(MISSING)} />);

		await user.click(screen.getByRole("button", { name: "Mark as destroyed" }));
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Mark production as destroyed?");
		expect(dialog).toHaveTextContent(MARK_DESTROYED_DESCRIPTION);
		expect(MARK_DESTROYED_DESCRIPTION).toMatch(/No cloud resources are touched/);

		await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(h.markEnvironmentDestroyedAction).not.toHaveBeenCalled();
	});

	it("on confirm, sends the project and the environment", async () => {
		h.markEnvironmentDestroyedAction.mockResolvedValue({ ok: true, data: { environmentId: ENV } });
		const user = userEvent.setup();
		withClient(<ClusterCard data={cluster(MISSING)} />);

		await user.click(screen.getByRole("button", { name: "Mark as destroyed" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Mark as destroyed" }));

		expect(h.markEnvironmentDestroyedAction).toHaveBeenCalledWith({ projectId: PROJECT, environmentId: ENV });
	});
});
