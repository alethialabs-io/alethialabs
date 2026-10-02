// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment node

// The kubeconfig command both surfaces show (#5250) — the console's cluster card and
// `alethia cluster get`. Every expected command below is written out BY HAND, never rebuilt with
// the builder's own template: a test that composed the expectation the way the module composes it
// would agree with the module by construction, including when the flag is wrong.

import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	KUBECONFIG_ISSUE_URL,
	type KubeconfigFacts,
	buildKubeconfigAccess,
	outputString,
	readKubeconfigAccess,
} from "@/lib/clusters/kubeconfig-access";
import type { Db } from "@/lib/db";

/** Facts for a fully-recorded cluster; each test overrides what it is about. */
function facts(over: Partial<KubeconfigFacts>): KubeconfigFacts {
	return {
		provider: "aws",
		clusterName: "eks-euc1-prod-web",
		region: "eu-central-1",
		gcpProjectId: null,
		azureResourceGroup: null,
		...over,
	};
}

describe("buildKubeconfigAccess — one command per cloud", () => {
	it("aws: update-kubeconfig with the EKS name and region", () => {
		expect(buildKubeconfigAccess(facts({}))).toEqual({
			command: "aws eks update-kubeconfig --name eks-euc1-prod-web --region eu-central-1",
			note: null,
		});
	});

	it("gcp: a REGION value makes a regional cluster, so --region", () => {
		expect(
			buildKubeconfigAccess(
				facts({
					provider: "gcp",
					clusterName: "gke-euw3-prod-web",
					region: "europe-west3",
					gcpProjectId: "acme-prod-123",
				}),
			),
		).toEqual({
			command:
				"gcloud container clusters get-credentials gke-euw3-prod-web --region europe-west3 --project acme-prod-123",
			note: null,
		});
	});

	it("gcp: a ZONE value makes a zonal cluster, so --zone (gcp/locals.tf passes var.region verbatim)", () => {
		expect(
			buildKubeconfigAccess(
				facts({
					provider: "gcp",
					clusterName: "gke-euw3-dev-web",
					region: "europe-west3-a",
					gcpProjectId: "acme-dev-123",
				}),
			).command,
		).toBe(
			"gcloud container clusters get-credentials gke-euw3-dev-web --zone europe-west3-a --project acme-dev-123",
		);
	});

	it("azure: get-credentials with the RECORDED resource group, not a re-derived one", () => {
		expect(
			buildKubeconfigAccess(
				facts({
					provider: "azure",
					clusterName: "aks-weu-prod-web",
					region: "westeurope",
					azureResourceGroup: "rg-web-prod",
				}),
			),
		).toEqual({
			command: "az aks get-credentials --resource-group rg-web-prod --name aks-weu-prod-web",
			note: null,
		});
	});

	it("alibaba: no command — the cluster ID is not recorded — and the note names the cluster and the call", () => {
		const got = buildKubeconfigAccess(
			facts({ provider: "alibaba", clusterName: "web-prod", region: "cn-hangzhou" }),
		);
		expect(got.command).toBeNull();
		expect(got.note).toContain("web-prod in cn-hangzhou");
		expect(got.note).toContain("aliyun cs GET /k8s/<cluster-id>/user_config");
		expect(got.note).toContain(KUBECONFIG_ISSUE_URL);
	});

	it("alibaba with no region still names the cluster", () => {
		const got = buildKubeconfigAccess(
			facts({ provider: "alibaba", clusterName: "web-prod", region: null }),
		);
		expect(got.note).toContain("cluster web-prod in the ACK console");
	});

	it("hetzner: says plainly there is no kubeconfig yet, and points at the issue", () => {
		const got = buildKubeconfigAccess(
			facts({ provider: "hetzner", clusterName: "web-prod" }),
		);
		expect(got.command).toBeNull();
		expect(got.note).toMatch(
			/^Alethia does not hand out a kubeconfig for Hetzner clusters yet/,
		);
		expect(got.note).toContain(KUBECONFIG_ISSUE_URL);
	});

	it("an unsupported cloud gets a note, not a guess", () => {
		expect(
			buildKubeconfigAccess(facts({ provider: "civo", clusterName: "x" })),
		).toEqual({
			command: null,
			note: "Alethia has no kubeconfig command for civo clusters.",
		});
	});

	it("an unknown cloud says so", () => {
		expect(buildKubeconfigAccess(facts({ provider: null })).note).toMatch(
			/does not know which cloud/,
		);
	});
});

describe("buildKubeconfigAccess — missing and unsafe values", () => {
	it("no cluster name yet ⇒ nothing to say (both null)", () => {
		expect(buildKubeconfigAccess(facts({ clusterName: null }))).toEqual({
			command: null,
			note: null,
		});
		expect(buildKubeconfigAccess(facts({ clusterName: "  " }))).toEqual({
			command: null,
			note: null,
		});
	});

	it.each([
		["aws", { region: null }, "region"],
		["gcp", { region: "europe-west3", gcpProjectId: null }, "GCP project ID"],
		["gcp", { region: null, gcpProjectId: "p-123456" }, "region"],
		["azure", { azureResourceGroup: null }, "resource group"],
		["azure", { azureResourceGroup: " " }, "resource group"],
	] as const)(
		"%s with %o ⇒ no command, and the note names the missing %s",
		(provider, over, label) => {
			const got = buildKubeconfigAccess(facts({ provider, ...over }));
			expect(got.command).toBeNull();
			expect(got.note).toBe(
				`Alethia has no recorded ${label} for this cluster, so it cannot build the command. Redeploy the environment to record it.`,
			);
		},
	);

	it.each([
		["aws", { clusterName: "web; rm -rf ~" }, "cluster name"],
		["aws", { region: "eu-west-1$(id)" }, "region"],
		["gcp", { region: "europe-west3", gcpProjectId: "p'x" }, "GCP project ID"],
		["azure", { azureResourceGroup: "rg (prod)" }, "resource group"],
	] as const)(
		"%s with %o ⇒ refuses to print a command a shell would misread (%s)",
		(provider, over, label) => {
			const got = buildKubeconfigAccess(facts({ provider, ...over }));
			expect(got.command).toBeNull();
			expect(got.note).toContain(`The recorded ${label} contains characters`);
		},
	);
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
	/** A drizzle-shaped fake: records the WHERE and returns the given rows. */
	function fakeDb(rows: unknown[]) {
		const seen: { where?: SQL; selected?: Record<string, unknown>; calls: number } = {
			calls: 0,
		};
		const chain = {
			from: () => chain,
			where: (w: SQL) => {
				seen.where = w;
				return chain;
			},
			orderBy: () => chain,
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

	const locator = {
		projectId: "11111111-1111-4111-8111-111111111111",
		environmentId: "22222222-2222-4222-8222-222222222222",
		clusterName: "aks-weu-prod-web",
		provider: "aws",
		region: "eu-west-1",
	};

	it("prefers what the last successful DEPLOY recorded over the caller's fallbacks", async () => {
		const { db, seen } = fakeDb([
			{
				provider: "azure",
				region: "westeurope",
				gcpProjectId: null,
				azureResourceGroup: { value: "rg-web-prod" },
			},
		]);
		await expect(readKubeconfigAccess(asDb(db), locator)).resolves.toEqual({
			command: "az aks get-credentials --resource-group rg-web-prod --name aks-weu-prod-web",
			note: null,
		});
		// Scoped to THIS cluster's owning env, its project, and only SUCCESSful DEPLOYs.
		if (!seen.where) throw new Error("the query was never filtered");
		const q = new PgDialect().sqlToQuery(seen.where);
		expect(q.sql.replace(/\s+/g, " ")).toBe(
			'("jobs"."project_id" = $1 and "jobs"."environment_id" = $2 and "jobs"."job_type" = $3 and "jobs"."status" = $4)',
		);
		expect(q.params).toEqual([
			locator.projectId,
			locator.environmentId,
			"DEPLOY",
			"SUCCESS",
		]);
		// Four scalar paths — never the whole snapshot (it carries a git token).
		expect(Object.keys(seen.selected ?? {})).toEqual([
			"provider",
			"region",
			"gcpProjectId",
			"azureResourceGroup",
		]);
	});

	it("falls back to the caller's provider and region when no deploy is recorded", async () => {
		const { db } = fakeDb([]);
		await expect(
			readKubeconfigAccess(asDb(db), { ...locator, clusterName: "eks-x" }),
		).resolves.toEqual({
			command: "aws eks update-kubeconfig --name eks-x --region eu-west-1",
			note: null,
		});
	});

	it("does not query at all for a cluster with no name, or with no owning environment", async () => {
		const unnamed = fakeDb([]);
		await expect(
			readKubeconfigAccess(asDb(unnamed.db), { ...locator, clusterName: null }),
		).resolves.toEqual({ command: null, note: null });
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
