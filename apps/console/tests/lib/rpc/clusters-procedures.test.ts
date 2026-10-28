// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// #6122: the clusters read procedures. Tenancy (address beats session, a non-member is a 404, another
// org's cluster is never served) is proved for every procedure by tests/integration/rpc-tenancy.*;
// WHICH clusters count is proved against Postgres by tests/integration/usage-counts.test.ts. This file
// pins the wiring with only the transaction faked:
//   · `project:view` is enforced before anything is read;
//   · the list follows project visibility: its WHERE is the org predicate FIRST, then
//     `project_cluster.project_id` among the projects the caller may view (the PDP's deny-aware set,
//     `cliViewableProjectIds` — the set the CLI's cluster list filters on), then the managed-cluster
//     definition. Asserted on the RENDERED SQL, the text postgres receives. That the PDP's set leaves
//     out a project-scoped deny is driven against the real engine in
//     tests/integration/console-project-bound.test.ts;
//   · each cluster carries the SAME kubeconfig object the CLI route serves (#5250), keyed on its own
//     owning environment, and its data services are that environment's — not the project's default's;
//   · the page's list adds, per cluster, the download permission (`cluster:access_readonly`, asked only
//     of clusters with an endpoint, fail-closed) and the classification chips (only with `org:view`).

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	/** Results handed out per `select()` call, in order. */
	results: [] as unknown[][],
	selects: 0,
	/** The PDP's answers, by `action:type:id`. A missing key is allowed; "throw" rejects. */
	decisions: new Map<string, boolean | "throw">(),
	can: [] as string[],
	enforced: [] as string[],
	chipIds: [] as string[][],
	/** The size of each bulkCheck call. */
	bulk: [] as number[],
	/** The projects the caller may view, as the PDP's deny-aware set answers it. */
	viewable: [] as string[],
	/** How many times that set was asked for. */
	viewableAsked: 0,
	/** Every `where(...)` argument, in order; the first is the base list's. */
	wheres: [] as unknown[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/authz", () => ({
	getPdp: () => ({
		enforce: async (_actor: unknown, action: string, ref: { type: string }) => {
			h.enforced.push(`${action}:${ref.type}`);
			if (h.decisions.get(`${action}:${ref.type}:`) === false) {
				const { ForbiddenError } = await import("@/lib/authz/types");
				throw new ForbiddenError("view", { type: "project" }, "no_grant");
			}
		},
		can: async (_actor: unknown, action: string, ref: { type: string; id?: string }) => {
			const key = `${action}:${ref.type}:${ref.id ?? ""}`;
			h.can.push(key);
			const d = h.decisions.get(key);
			if (d === "throw") throw new Error("pdp down");
			return { allowed: d !== false };
		},
		bulkCheck: async (_actor: unknown, checks: { action: string; resource: { type: string; id?: string } }[]) => {
			h.bulk.push(checks.length);
			return checks.map(({ action, resource }) => {
				const key = `${action}:${resource.type}:${resource.id ?? ""}`;
				h.can.push(key);
				if (h.decisions.get(key) === "throw") throw new Error("pdp down");
				return { allowed: h.decisions.get(key) !== false };
			});
		},
	}),
}));
vi.mock("@/lib/cli/project-access", () => ({
	cliViewableProjectIds: async () => {
		h.viewableAsked += 1;
		return h.viewable;
	},
}));
vi.mock("@/lib/db", () => ({
	withActorScope: (_actor: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx()),
}));
vi.mock("@/lib/queries/classification", () => ({
	assignmentsForKind: async (_tx: unknown, _kind: string, ids: string[]) => {
		h.chipIds.push(ids);
		return new Map([[ids[0], [{ value_id: "v1", value: "pci" }]]]);
	},
}));

/** A drizzle-shaped thenable fake: every builder method chains, awaiting yields the next result. */
function fakeTx() {
	return {
		select: () => {
			const rows = h.results[h.selects] ?? [];
			h.selects += 1;
			const chain = {
				from: () => chain,
				leftJoin: () => chain,
				innerJoin: () => chain,
				where: (w: unknown) => {
					h.wheres.push(w);
					return chain;
				},
				orderBy: () => chain,
				limit: () => Promise.resolve(rows),
				then: (ok: (v: unknown[]) => unknown) => Promise.resolve(rows).then(ok),
			};
			return chain;
		},
	};
}

import { type Actor, ForbiddenError } from "@/lib/authz/types";
import { readClusterList, readClusters } from "@/lib/rpc/procedures/clusters";

const ACTOR: Actor = { userId: "u1", orgId: "o1", credential: "session" };

const dialect = new PgDialect();

/** Narrows a captured `where(...)` argument to the drizzle SQL it must be. */
function isSql(x: unknown): x is SQL {
	return typeof x === "object" && x !== null && "queryChunks" in x;
}

/** The base list's WHERE, rendered as postgres receives it, whitespace collapsed. */
function baseWhere(): { sql: string; params: readonly unknown[] } {
	const w = h.wheres[0];
	if (!isSql(w)) throw new Error("the base list read was built with no WHERE");
	const q = dialect.sqlToQuery(w);
	return { sql: q.sql.replace(/\s+/g, " ").trim(), params: q.params };
}

/** One joined base row (one cluster); each test overrides what it is about. */
function baseRow(over: Record<string, unknown>) {
	return {
		id: "p1",
		project_name: "web",
		region: "europe-west3",
		environment_stage: "prod",
		environment_status: "ACTIVE",
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

/** The kubeconfig read's row for a dedicated GCP environment. */
const GCP_DEPLOY = {
	placementMode: "dedicated",
	provider: "gcp",
	region: "europe-west3-a",
	snapshotPlacement: null,
	gcpProjectId: { value: "acme-prod-123" },
	azureResourceGroup: null,
};

beforeEach(() => {
	h.results = [];
	h.selects = 0;
	h.decisions = new Map();
	h.can = [];
	h.enforced = [];
	h.chipIds = [];
	h.bulk = [];
	h.viewable = ["p1"];
	h.viewableAsked = 0;
	h.wheres = [];
});

describe("readClusters", () => {
	it("enforces project:view before it reads anything, and a refusal reads nothing", async () => {
		h.decisions.set("view:project:", false);
		await expect(readClusters(ACTOR)).rejects.toBeInstanceOf(ForbiddenError);
		expect(h.enforced).toEqual(["view:project"]);
		expect(h.selects).toBe(0);
		expect(h.viewableAsked).toBe(0);
	});

	it("keeps only the clusters of projects the caller may view: org predicate first, then visibility", async () => {
		h.viewable = ["p1", "p2"];
		h.results = [[]];
		await readClusters(ACTOR);
		const { sql, params } = baseWhere();
		// Written out by hand, never rebuilt with the `eq`/`inArray` the procedure uses.
		expect(sql.startsWith('("project_cluster"."org_id" = $1 and "project_cluster"."project_id" in ($2, $3) and (')).toBe(
			true,
		);
		expect(params).toEqual(["o1", "p1", "p2"]);
		expect(h.viewableAsked).toBe(1);
	});

	it("a caller who may view no project lists no cluster", async () => {
		h.viewable = [];
		h.results = [[]];
		expect(await readClusters(ACTOR)).toEqual([]);
		expect(baseWhere().sql.startsWith('("project_cluster"."org_id" = $1 and false and (')).toBe(true);
		expect(baseWhere().params).toEqual(["o1"]);
	});

	it("attaches each cluster's command, built from its own last deploy (#5250)", async () => {
		h.results = [[baseRow({})], [], [], [GCP_DEPLOY]];
		const [c] = await readClusters(ACTOR);
		expect(c.project_cluster.kubeconfig).toEqual({
			command: "alethia cluster kubeconfig gke-euw3-prod-web",
			alternative:
				"gcloud container clusters get-credentials gke-euw3-prod-web --zone europe-west3-a --project acme-prod-123",
			note: null,
		});
		expect(h.enforced).toEqual(["view:project"]);
	});

	it("gives Hetzner the mint, with no cloud alternative (#5322)", async () => {
		h.results = [[baseRow({ provider: "hetzner", cluster_name: "web-prod" })], [], [], []];
		const [c] = await readClusters(ACTOR);
		expect(c.project_cluster.kubeconfig).toEqual({
			command: "alethia cluster kubeconfig web-prod",
			alternative: null,
			note: null,
		});
	});

	it("carries the shared-cluster sentence for a vcluster environment, and no command (#5322)", async () => {
		h.results = [
			[baseRow({})],
			[],
			[],
			[{ ...GCP_DEPLOY, placementMode: "vcluster", snapshotPlacement: "vcluster" }],
		];
		const [c] = await readClusters(ACTOR);
		expect(c.project_cluster.kubeconfig).toEqual({
			command: null,
			alternative: null,
			note: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
		});
	});

	it("is one entry per CLUSTER, each with its own environment's lifecycle and data services", async () => {
		// One project, two environments, each with a dedicated cluster. A still-provisioning cluster has
		// no name yet, so it costs no kubeconfig read.
		h.results = [
			[
				baseRow({}),
				baseRow({
					cluster_id: "c2",
					cluster_environment_id: "e2",
					environment_stage: "staging",
					environment_status: "PROVISIONING",
					cluster_name: null,
					cluster_endpoint: null,
					cluster_status: "PENDING",
				}),
			],
			[
				{ environment_id: "e1", name: "db-prod", engine: "pg", endpoint: null, reader_endpoint: null, provider_outputs: null, status: "ACTIVE" },
				{ environment_id: "e2", name: "db-staging", engine: "pg", endpoint: null, reader_endpoint: null, provider_outputs: null, status: "CREATING" },
			],
			[{ environment_id: "e2", name: "cache-staging", engine: "redis", endpoint: null, status: "PENDING" }],
			[GCP_DEPLOY],
		];
		const clusters = await readClusters(ACTOR);
		expect(clusters.map((c) => [c.project_cluster.id, c.environment_stage, c.status])).toEqual([
			["c1", "prod", "ACTIVE"],
			["c2", "staging", "PROVISIONING"],
		]);
		expect(clusters.map((c) => c.project_databases.map((d) => d.name))).toEqual([["db-prod"], ["db-staging"]]);
		expect(clusters.map((c) => c.project_caches.map((d) => d.name))).toEqual([[], ["cache-staging"]]);
		expect(clusters[1].project_cluster.kubeconfig).toEqual({ command: null, alternative: null, note: null });
		// base + databases + caches + ONE kubeconfig read (the unnamed cluster needs none).
		expect(h.selects).toBe(4);
	});

	it("reads nothing more when there are no clusters under management", async () => {
		h.results = [[]];
		expect(await readClusters(ACTOR)).toEqual([]);
		expect(h.selects).toBe(1);
	});
});

describe("readClusterList", () => {
	it("asks cluster:access_readonly only of clusters with an endpoint, and answers per cluster", async () => {
		h.results = [
			[
				baseRow({}),
				baseRow({ cluster_id: "c2", cluster_environment_id: "e2" }),
				baseRow({ cluster_id: "c3", cluster_environment_id: "e3", cluster_endpoint: null }),
			],
			[],
			[],
			[GCP_DEPLOY],
			[GCP_DEPLOY],
			[GCP_DEPLOY],
		];
		h.decisions.set("access_readonly:cluster:c2", false);
		const list = await readClusterList(ACTOR);
		expect(list.map((c) => [c.project_cluster.id, c.can_download_kubeconfig])).toEqual([
			["c1", true],
			["c2", false],
			["c3", false],
		]);
		expect(h.can.filter((k) => k.startsWith("access_readonly"))).toEqual([
			"access_readonly:cluster:c1",
			"access_readonly:cluster:c2",
		]);
		// One batched check, not one per cluster.
		expect(h.bulk).toEqual([2]);
	});

	it("explains instead of offering a download the mint refuses (a DRAFT environment over a live cluster)", async () => {
		h.results = [[baseRow({ environment_status: "DRAFT" })], [], [], [GCP_DEPLOY]];
		const [c] = await readClusterList(ACTOR);
		expect(c.can_download_kubeconfig).toBe(false);
		expect(c.kubeconfig_download_note).toMatch(/undeployed plan/);
	});

	it("says nothing about the mint to a viewer without the permission", async () => {
		h.results = [[baseRow({ environment_status: "DRAFT" })], [], [], [GCP_DEPLOY]];
		h.decisions.set("access_readonly:cluster:c1", false);
		const [c] = await readClusterList(ACTOR);
		expect([c.can_download_kubeconfig, c.kubeconfig_download_note]).toEqual([false, null]);
	});

	it("is fail-closed: a PDP error is no download, not a failed page", async () => {
		h.results = [[baseRow({})], [], [], [GCP_DEPLOY]];
		h.decisions.set("access_readonly:cluster:c1", "throw");
		const [c] = await readClusterList(ACTOR);
		expect(c.can_download_kubeconfig).toBe(false);
	});

	it("carries the chips with org:view, in one batched read keyed on the cluster rows", async () => {
		h.results = [[baseRow({}), baseRow({ cluster_id: "c2", cluster_environment_id: "e2" })], [], [], [GCP_DEPLOY], [GCP_DEPLOY]];
		const list = await readClusterList(ACTOR);
		expect(h.chipIds).toEqual([["c1", "c2"]]);
		expect(list.map((c) => c.classification.length)).toEqual([1, 0]);
	});

	it("renders the clusters chipless without org:view, and never reads the chips", async () => {
		h.results = [[baseRow({})], [], [], [GCP_DEPLOY]];
		h.decisions.set("view:org:", false);
		const [c] = await readClusterList(ACTOR);
		expect(c.classification).toEqual([]);
		expect(h.chipIds).toEqual([]);
	});
});
