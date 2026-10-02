// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The kubeconfig commands both surfaces show (#5250, #5322) — the console's cluster card and
// `alethia cluster get`. Every expected command below is written out BY HAND, never rebuilt with
// the builder's own template: a test that composed the expectation the way the module composes it
// would agree with the module by construction, including when the flag is wrong.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	type KubeconfigFacts,
	buildKubeconfigAccess,
	outputString,
	readKubeconfigAccess,
} from "@/lib/clusters/kubeconfig-access";
import type { Db } from "@/lib/db";
import { clusterKubeconfig } from "@/lib/validations/cli-contract";

/**
 * The table `alethia cluster get`'s test also reads (apps/cli/cmd/clusters_get_test.go): the facts,
 * the answer this builder must give, and the rows the CLI must print for it (#5322). Parsed, not
 * cast, so a malformed table fails here rather than passing on undefined.
 */
const sharedTable = z.object({
	cases: z
		.array(
			z.object({
				id: z.string(),
				facts: z.object({
					clusterId: z.string().nullable(),
					sharedCluster: z.boolean(),
					provider: z.string().nullable(),
					clusterName: z.string().nullable(),
					region: z.string().nullable(),
					gcpProjectId: z.string().nullable(),
					azureResourceGroup: z.string().nullable(),
				}),
				access: clusterKubeconfig,
			}),
		)
		.min(1),
});

const { cases } = sharedTable.parse(
	JSON.parse(
		readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"../../../../cli/cmd/testdata/kubeconfig-access-cases.json",
			),
			"utf8",
		),
	),
);

/** Facts for a fully-recorded aws cluster; each test overrides what it is about. */
function facts(over: Partial<KubeconfigFacts>): KubeconfigFacts {
	return {
		clusterId: "0b3f6c1e-2a4d-4e8f-9c1a-5d7e8f9a0b1c",
		sharedCluster: false,
		provider: "aws",
		clusterName: "eks-euc1-prod-web",
		region: "eu-central-1",
		gcpProjectId: null,
		azureResourceGroup: null,
		...over,
	};
}

describe("buildKubeconfigAccess — the table shared with `alethia cluster get` (#5322)", () => {
	it.each(cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
		expect(buildKubeconfigAccess(c.facts)).toEqual(c.access);
	});

	it("covers every shape: a mint with and without an alternative, a shared cluster, a note, nothing", () => {
		const answers = cases.map((c) => c.access);
		expect(answers.some((a) => a.command && a.alternative)).toBe(true);
		expect(answers.some((a) => a.command && !a.alternative)).toBe(true);
		expect(cases.some((c) => c.facts.sharedCluster && c.access.note)).toBe(true);
		expect(answers.some((a) => !a.command && a.note)).toBe(true);
		expect(answers.some((a) => !a.command && !a.alternative && !a.note)).toBe(true);
	});

	it("every mintable cloud's primary command is the mint", () => {
		for (const provider of ["aws", "gcp", "azure", "alibaba", "hetzner"]) {
			expect(buildKubeconfigAccess(facts({ provider })).command).toBe(
				"alethia cluster kubeconfig eks-euc1-prod-web",
			);
		}
	});

	it("a shared cluster gets no command on ANY cloud, not even the cloud's own", () => {
		for (const provider of ["aws", "gcp", "azure", "alibaba", "hetzner"]) {
			expect(
				buildKubeconfigAccess(
					facts({
						provider,
						sharedCluster: true,
						gcpProjectId: "p-123456",
						azureResourceGroup: "rg-x",
					}),
				),
			).toEqual({
				command: null,
				alternative: null,
				note: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
			});
		}
	});
});

describe("buildKubeconfigAccess — missing and unsafe values drop only the alternative", () => {
	it("no cluster name yet ⇒ nothing to say (all null)", () => {
		const nothing = { command: null, alternative: null, note: null };
		expect(buildKubeconfigAccess(facts({ clusterName: null }))).toEqual(nothing);
		expect(buildKubeconfigAccess(facts({ clusterName: "  " }))).toEqual(nothing);
	});

	it.each([
		["aws", { region: null }],
		["gcp", { region: "europe-west3", gcpProjectId: null }],
		["gcp", { region: null, gcpProjectId: "p-123456" }],
		["azure", { azureResourceGroup: null }],
		["azure", { azureResourceGroup: " " }],
		["aws", { region: "eu-west-1$(id)" }],
		["gcp", { region: "europe-west3", gcpProjectId: "p'x" }],
		["azure", { azureResourceGroup: "rg (prod)" }],
	] as const)("%s with %o ⇒ the mint, and no cloud command", (provider, over) => {
		expect(buildKubeconfigAccess(facts({ provider, ...over }))).toEqual({
			command: "alethia cluster kubeconfig eks-euc1-prod-web",
			alternative: null,
			note: null,
		});
	});

	it("an unsafe name with no usable id gives the bare command, which asks which cluster", () => {
		expect(
			buildKubeconfigAccess(facts({ clusterName: "web; rm -rf ~", clusterId: null })),
		).toEqual({ command: "alethia cluster kubeconfig", alternative: null, note: null });
	});
});

describe("outputString", () => {
	it("reads a bare string and a { value } wrapper, and nothing else", () => {
		expect(outputString("rg-web-prod")).toBe("rg-web-prod");
		expect(outputString({ value: "rg-web-prod", sensitive: false })).toBe(
			"rg-web-prod",
		);
		expect(outputString({ value: 3 })).toBeNull();
		expect(outputString(null)).toBeNull();
		expect(outputString(42)).toBeNull();
	});
});

describe("readKubeconfigAccess", () => {
	/** A drizzle-shaped fake: records the WHERE, the join and the order, and returns the given rows. */
	function fakeDb(rows: unknown[]) {
		const seen: {
			where?: SQL;
			join?: SQL;
			order?: SQL;
			selected?: Record<string, unknown>;
			calls: number;
		} = { calls: 0 };
		const chain = {
			from: () => chain,
			leftJoin: (_t: unknown, on: SQL) => {
				seen.join = on;
				return chain;
			},
			where: (w: SQL) => {
				seen.where = w;
				return chain;
			},
			orderBy: (o: SQL) => {
				seen.order = o;
				return chain;
			},
			limit: () => Promise.resolve(rows),
		};
		const db = {
			select: (s: Record<string, unknown>) => {
				seen.calls += 1;
				seen.selected = s;
				return chain;
			},
		};
		return { db, seen };
	}

	/** Hands the structural fake to the typed parameter — the repo's test convention (see list-route.test.ts). */
	function asDb(fake: unknown): Db {
		return fake as never;
	}

	/** Renders a captured SQL fragment as Postgres text with its parameters. */
	function render(fragment: SQL | undefined) {
		if (!fragment) throw new Error("the fragment was never captured");
		const q = new PgDialect().sqlToQuery(fragment);
		return { sql: q.sql.replace(/\s+/g, " "), params: q.params };
	}

	const locator = {
		clusterId: "33333333-3333-4333-8333-333333333333",
		projectId: "11111111-1111-4111-8111-111111111111",
		environmentId: "22222222-2222-4222-8222-222222222222",
		clusterName: "aks-weu-prod-web",
		provider: "aws",
		region: "eu-west-1",
	};

	/** One joined row: a dedicated environment whose last deploy recorded `over`. */
	function joined(over: Record<string, unknown>) {
		return {
			placementMode: "dedicated",
			provider: null,
			region: null,
			snapshotPlacement: null,
			gcpProjectId: null,
			azureResourceGroup: null,
			...over,
		};
	}

	it("prefers what the last successful DEPLOY recorded over the caller's fallbacks", async () => {
		const { db, seen } = fakeDb([
			joined({
				provider: "azure",
				region: "westeurope",
				azureResourceGroup: { value: "rg-web-prod" },
			}),
		]);
		await expect(readKubeconfigAccess(asDb(db), locator)).resolves.toEqual({
			command: "alethia cluster kubeconfig aks-weu-prod-web",
			alternative: "az aks get-credentials --resource-group rg-web-prod --name aks-weu-prod-web",
			note: null,
		});
		// The owning environment, left-joined to ONLY its project's SUCCESSful DEPLOYs, newest first.
		expect(render(seen.where)).toEqual({
			sql: '"project_environments"."id" = $1',
			params: [locator.environmentId],
		});
		expect(render(seen.join)).toEqual({
			sql: '("jobs"."environment_id" = "project_environments"."id" and "jobs"."project_id" = $1 and "jobs"."job_type" = $2 and "jobs"."status" = $3)',
			params: [locator.projectId, "DEPLOY", "SUCCESS"],
		});
		expect(render(seen.order).sql).toBe('"jobs"."created_at" desc nulls last');
		// Scalar paths only — never the whole snapshot (it carries a git token).
		expect(Object.keys(seen.selected ?? {})).toEqual([
			"placementMode",
			"provider",
			"region",
			"snapshotPlacement",
			"gcpProjectId",
			"azureResourceGroup",
		]);
	});

	it("falls back to the caller's provider and region when no deploy is recorded", async () => {
		const { db } = fakeDb([joined({})]);
		await expect(
			readKubeconfigAccess(asDb(db), { ...locator, clusterName: "eks-x" }),
		).resolves.toEqual({
			command: "alethia cluster kubeconfig eks-x",
			alternative: "aws eks update-kubeconfig --name eks-x --region eu-west-1",
			note: null,
		});
	});

	it.each([
		["the environment's column says namespace", { placementMode: "namespace" }],
		["the environment's column says vcluster", { placementMode: "vcluster" }],
		["the deploy's snapshot says namespace", { snapshotPlacement: "namespace" }],
		["the deploy's snapshot says vcluster", { snapshotPlacement: "vcluster" }],
	])("a shared cluster when %s: the refusal's sentence, no command", async (_why, over) => {
		const { db } = fakeDb([joined({ provider: "aws", region: "eu-west-1", ...over })]);
		await expect(readKubeconfigAccess(asDb(db), locator)).resolves.toEqual({
			command: null,
			alternative: null,
			note: "Kubeconfig mints are not available for an environment placed on a shared cluster.",
		});
	});

	it("does not query at all for a cluster with no name, or with no owning environment", async () => {
		const unnamed = fakeDb([]);
		await expect(
			readKubeconfigAccess(asDb(unnamed.db), { ...locator, clusterName: null }),
		).resolves.toEqual({ command: null, alternative: null, note: null });
		expect(unnamed.seen.calls).toBe(0);

		const orphan = fakeDb([]);
		await readKubeconfigAccess(asDb(orphan.db), {
			...locator,
			environmentId: null,
			provider: "hetzner",
		});
		expect(orphan.seen.calls).toBe(0);
	});
});
