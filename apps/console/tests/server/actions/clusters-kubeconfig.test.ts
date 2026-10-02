// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// getClusters — the console cluster card's read — carries the SAME kubeconfig object the CLI route
// serves (#5250). The builder is real; only the transaction is faked. What is asserted is the
// wiring: each provisioned cluster gets its own answer, keyed on its own owning environment, and a
// project with no cluster row gets none.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ currentActor: vi.fn() }));
vi.mock("@/lib/db", () => ({ withActorScope: vi.fn() }));

import { getClusters } from "@/app/server/actions/clusters";
import { currentActor } from "@/lib/authz/guard";
import { withActorScope } from "@/lib/db";

/** Results handed out per `select()` call, in order. */
let results: unknown[][];
let selects: number;

/** A drizzle-shaped thenable fake: every builder method chains, awaiting yields the next result. */
function fakeTx() {
	return {
		select: () => {
			const rows = results[selects] ?? [];
			selects += 1;
			const chain = {
				from: () => chain,
				leftJoin: () => chain,
				innerJoin: () => chain,
				where: () => chain,
				orderBy: () => chain,
				limit: () => Promise.resolve(rows),
				then: (ok: (v: unknown[]) => unknown) => Promise.resolve(rows).then(ok),
			};
			return chain;
		},
	};
}

/** One joined base row; each test overrides what it is about. */
function baseRow(over: Record<string, unknown>) {
	return {
		id: "p1",
		project_name: "web",
		region: "europe-west3",
		environment_stage: "prod",
		environment_id: "e1",
		status: "ACTIVE",
		provider: "gcp",
		cluster_id: "c1",
		cluster_environment_id: "e1",
		cluster_name: "gke-euw3-prod-web",
		cluster_endpoint: "https://10.0.0.1",
		cluster_outputs: {},
		cluster_version: "1.30",
		argocd_url: null,
		cluster_status: "ACTIVE",
		dns_domain_name: null,
		dns_enabled: null,
		apps_destination_repo: null,
		...over,
	};
}

describe("getClusters — kubeconfig (#5250)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		selects = 0;
		vi.mocked(currentActor).mockResolvedValue({ userId: "u1", orgId: "o1" } as never);
		vi.mocked(withActorScope).mockImplementation(((
			_actor: unknown,
			fn: (tx: unknown) => unknown,
		) => fn(fakeTx())) as never);
	});

	it("attaches each cluster's command, built from its own last deploy", async () => {
		results = [
			[
				baseRow({}),
				baseRow({
					id: "p2",
					environment_id: "e2",
					cluster_id: null,
					cluster_status: null,
					cluster_name: null,
				}),
			],
			[], // databases
			[], // caches
			[
				{
					placementMode: "dedicated",
					provider: "gcp",
					region: "europe-west3-a",
					snapshotPlacement: null,
					gcpProjectId: { value: "acme-prod-123" },
					azureResourceGroup: null,
				},
			],
		];
		const clusters = await getClusters();
		expect(clusters[0].project_cluster?.kubeconfig).toEqual({
			command: "alethia cluster kubeconfig gke-euw3-prod-web",
			alternative:
				"gcloud container clusters get-credentials gke-euw3-prod-web --zone europe-west3-a --project acme-prod-123",
			note: null,
		});
		// No cluster row ⇒ no cluster, and no deploy read for it.
		expect(clusters[1].project_cluster).toBeNull();
		expect(selects).toBe(4);
	});

	it("gives Hetzner the mint, with no cloud alternative (#5322)", async () => {
		results = [[baseRow({ provider: "hetzner", cluster_name: "web-prod" })], [], [], []];
		const [c] = await getClusters();
		expect(c.project_cluster?.kubeconfig).toEqual({
			command: "alethia cluster kubeconfig web-prod",
			alternative: null,
			note: null,
		});
	});

	it("carries the shared-cluster sentence for a vcluster environment, and no command (#5322)", async () => {
		results = [
			[baseRow({})],
			[],
			[],
			[
				{
					placementMode: "vcluster",
					provider: "gcp",
					region: "europe-west3",
					snapshotPlacement: "vcluster",
					gcpProjectId: { value: "acme-prod-123" },
					azureResourceGroup: null,
				},
			],
		];
		const [c] = await getClusters();
		expect(c.project_cluster?.kubeconfig).toEqual({
			command: null,
			alternative: null,
			note: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
		});
	});
});
