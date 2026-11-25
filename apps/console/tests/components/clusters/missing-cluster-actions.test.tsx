// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6736: a cluster found deleted outside Alethia offers three ways out — Redeploy, Tear down, Mark as
// destroyed — in the cluster's record, and ONLY for a missing cluster. Nothing changes until a person
// clicks: the mark asks first, says plainly that no cloud resources are touched, and sends nothing
// when cancelled. (The Environments page offers the same three in its notice; that is asserted in
// tests/components/environments/environments-view-notices.test.tsx.)

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import type { FakeHandler } from "@/tests/helpers/fake-orpc";
import { ENV, MISSING, PROJECT, REPORTED, UNREACHABLE, clusterItem } from "./fixtures";

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
vi.mock("@/components/classification/classification-control", () => ({ ClassificationControl: () => null }));
vi.mock("@/components/clusters/kubeconfig-download/kubeconfig-download", () => ({ KubeconfigDownload: () => null }));

import { ClusterDetailSheet } from "@/components/clusters/cluster-detail";
import { clusterPosture } from "@/components/clusters/cluster-posture";
import { MARK_DESTROYED_DESCRIPTION } from "@/components/clusters/missing-cluster-actions";

/** Opens the record of `cluster` under a fresh query client (the mark's mutation needs one). */
function openRecord(cluster: ClusterListItem) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<ClusterDetailSheet cluster={cluster} posture={clusterPosture(cluster)} orgSlug="acme" onClose={vi.fn()} />
		</QueryClientProvider>,
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
	h.handlers["clusters.page"] = async () => ({ rows: [], nextCursor: null, facets: { clouds: [], statuses: [], regions: [] }, universeEmpty: true });
	h.handlers["environments.overview"] = async () => null;
	h.handlers["workspace.environments"] = async () => [];
});

describe("the cluster record", () => {
	it("offers all three for a missing cluster; both links open the environment on the board", () => {
		openRecord(clusterItem({ project_cluster: { observation: MISSING } }));
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
		openRecord(clusterItem({ project_cluster: { observation } }));
		expect(offered()).toEqual({ redeploy: null, tearDown: null, mark: null });
	});

	it("offers none while a run is in flight on the environment — the run writes its own outcome", () => {
		openRecord(clusterItem({ status: "PROVISIONING", project_cluster: { observation: MISSING } }));
		expect(offered()).toEqual({ redeploy: null, tearDown: null, mark: null });
	});
});

describe("Mark as destroyed", () => {
	it("asks first, says no cloud resources are touched, and sends nothing on Cancel", async () => {
		const user = userEvent.setup();
		openRecord(clusterItem({ project_cluster: { observation: MISSING } }));

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
		openRecord(clusterItem({ project_cluster: { observation: MISSING } }));

		await user.click(screen.getByRole("button", { name: "Mark as destroyed" }));
		const dialog = await screen.findByRole("alertdialog");
		await user.click(within(dialog).getByRole("button", { name: "Mark as destroyed" }));

		expect(h.markEnvironmentDestroyedAction).toHaveBeenCalledWith({ projectId: PROJECT, environmentId: ENV });
	});
});
