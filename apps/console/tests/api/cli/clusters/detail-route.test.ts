// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// GET /api/cli/clusters/:id — the backing route for `alethia cluster get`.
//
// What this file owns is #5250's wire half: the detail response carries a `kubeconfig` object,
// built by the shared module (lib/clusters/kubeconfig-access.ts) from the cluster's OWN row —
// its project, its owning environment, its name, and the cloud of ITS placement — and validated
// against the frozen CLI contract. The builder's per-cloud logic is the module's test; here the
// module is real and only the database is faked, so a route that passed the wrong environment or
// dropped the field fails here, not in a user's terminal.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz/guard", () => ({ authorizeCli: vi.fn() }));
vi.mock("@/lib/db", () => ({ getServiceDb: vi.fn() }));
vi.mock("@/lib/gitops/deploy-status", () => ({
	readGitopsDeployStatus: vi.fn(),
}));

import { GET } from "@/app/api/cli/clusters/[id]/route";
import { authorizeCli } from "@/lib/authz/guard";
import { getServiceDb } from "@/lib/db";
import { readGitopsDeployStatus } from "@/lib/gitops/deploy-status";
import { cliClusterDetailResponse } from "@/lib/validations/cli-contract";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const CLUSTER_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const ENV_ID = "66666666-6666-4666-8666-666666666666";

/** The joined cluster row the route's first query returns. */
function clusterRow(over: Record<string, unknown> = {}) {
	return {
		id: CLUSTER_ID,
		cluster_name: "aks-weu-prod-web",
		cluster_version: "1.30",
		instance_types: ["Standard_D4s_v5"],
		node_min_size: 2,
		node_max_size: 5,
		node_desired_size: 2,
		status: "ACTIVE",
		status_message: null,
		argocd_url: null,
		estimated_monthly_cost: null,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		project_name: "web",
		environment: "prod",
		region: "westeurope",
		project_id: PROJECT_ID,
		environment_id: ENV_ID,
		provider: "azure",
		...over,
	};
}

/** The second query's row: the owning environment joined to what its last successful DEPLOY recorded. */
let deployRows: unknown[];
let clusterRows: unknown[];
/** Every `.where` the route issued, in order. */
let wheres: unknown[];

/** A drizzle-shaped fake: the first select is the cluster row, the second the deploy job. */
function fakeDb() {
	let call = 0;
	return {
		select: () => {
			call += 1;
			const rows = call === 1 ? clusterRows : deployRows;
			const chain = {
				from: () => chain,
				innerJoin: () => chain,
				leftJoin: () => chain,
				where: (w: unknown) => {
					wheres.push(w);
					return chain;
				},
				orderBy: () => chain,
				limit: () => Promise.resolve(rows),
			};
			return chain;
		},
	};
}

/** Drives the handler and returns status + parsed body. */
async function drive() {
	const res = await GET(new Request(`https://x/api/cli/clusters/${CLUSTER_ID}`), {
		params: Promise.resolve({ id: CLUSTER_ID }),
	});
	return { status: res.status, body: await res.json() };
}

describe("GET /api/cli/clusters/:id — kubeconfig (#5250)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		wheres = [];
		clusterRows = [clusterRow()];
		deployRows = [];
		vi.mocked(authorizeCli).mockResolvedValue({
			actor: { userId: USER, orgId: ORG },
			credential: "session",
			orgScope: [ORG, USER],
		});
		vi.mocked(getServiceDb).mockReturnValue(fakeDb() as never);
		vi.mocked(readGitopsDeployStatus).mockRejectedValue(new Error("no snapshot"));
	});

	it("serves the command built from what the last deploy recorded, and the contract accepts it", async () => {
		deployRows = [
			{
				placementMode: "dedicated",
				provider: "azure",
				region: "westeurope",
				snapshotPlacement: "dedicated",
				gcpProjectId: null,
				azureResourceGroup: { value: "rg-web-prod" },
			},
		];
		const { status, body } = await drive();
		expect(status).toBe(200);
		const parsed = cliClusterDetailResponse.parse(body);
		expect(parsed.kubeconfig).toEqual({
			command: "alethia cluster kubeconfig aks-weu-prod-web",
			alternative: "az aks get-credentials --resource-group rg-web-prod --name aks-weu-prod-web",
			note: null,
		});
		// The internal join columns never reach the wire.
		expect(body.cluster).not.toHaveProperty("provider");
		expect(body.cluster).not.toHaveProperty("environment_id");
		// Two reads: the org-scoped cluster row, then its deploy history.
		expect(wheres).toHaveLength(2);
	});

	it("prints no guessed cloud command when a value is unrecorded — the mint still stands", async () => {
		// Azure, and no deploy recorded a resource group.
		const { body } = await drive();
		expect(cliClusterDetailResponse.parse(body).kubeconfig).toEqual({
			command: "alethia cluster kubeconfig aks-weu-prod-web",
			alternative: null,
			note: null,
		});
	});

	it("gives Hetzner the mint, which is its only way (#5322)", async () => {
		clusterRows = [clusterRow({ provider: "hetzner", cluster_name: "web-prod" })];
		const { body } = await drive();
		expect(cliClusterDetailResponse.parse(body).kubeconfig).toEqual({
			command: "alethia cluster kubeconfig web-prod",
			alternative: null,
			note: null,
		});
	});

	it("gives a namespace environment the mint refusal's sentence and no command (#5322)", async () => {
		deployRows = [
			{
				placementMode: "namespace",
				provider: "azure",
				region: "westeurope",
				snapshotPlacement: "namespace",
				gcpProjectId: null,
				azureResourceGroup: { value: "rg-web-prod" },
			},
		];
		const { body } = await drive();
		expect(cliClusterDetailResponse.parse(body).kubeconfig).toEqual({
			command: null,
			alternative: null,
			note: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
		});
	});

	it("a cluster with no name yet has nothing to say, and no deploy read", async () => {
		clusterRows = [clusterRow({ cluster_name: null })];
		const { body } = await drive();
		expect(cliClusterDetailResponse.parse(body).kubeconfig).toEqual({
			command: null,
			alternative: null,
			note: null,
		});
		expect(wheres).toHaveLength(1);
	});

	it("404s for a cluster outside the org before reading any deploy", async () => {
		clusterRows = [];
		const { status } = await drive();
		expect(status).toBe(404);
		expect(wheres).toHaveLength(1);
	});
});
