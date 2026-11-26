// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters list's server half (lib/queries/clusters.ts) — the scope, the predicate, the facet
// pass and the in-memory keyset pager behind `readClustersPage()` (the `clusters.page` read).
//
// A cluster's universe is a COMPOSITION (an RLS read, the PDP's visibility, drift and probe
// evidence), so there is no second SQL chain to inspect, as there is for the builders
// `filter-standard-facets.test.ts` drives. What there is instead is two functions over one array,
// and the standard's two properties are asserted in the form that mechanism can carry:
//   · THE FACET SET DOES NOT SHRINK AS THE QUERY NARROWS — a filter is on the rows pass only;
//   · IT DOES SHRINK WHEN THE SCOPE NARROWS — a project page's options are its project's.
// Each narrowing is first checked to have actually narrowed, so a test that filtered nothing
// cannot pass for that reason. And the paging (LST-3 #7485): every cluster is reached exactly once
// across page boundaries, including boundaries inside a run of clusters created in one millisecond.

import { describe, expect, it } from "vitest";
import {
	type ClustersQuery,
	UNKNOWN_CLOUD,
	clusterFacets,
	matchesClustersQuery,
	queryClustersPage,
} from "@/lib/queries/clusters";
import { decodeKeysetCursor } from "@/lib/queries/keyset";
import type { ClusterListItem } from "@/lib/rpc/procedures/clusters";
import { type ClusterOverrides, clusterItem } from "@/tests/components/clusters/fixtures";

/** Every row of the pristine first page, unwrapped. */
function clustersPage(all: ClusterListItem[], query: ClustersQuery = {}, scope: { projectId?: string } = {}) {
	const page = queryClustersPage(all, query, scope, { limit: 100 });
	if (page.facets === null) throw new Error("the first page carries facets");
	return { ...page, facets: page.facets, clusters: page.rows.map((r) => r.cluster) };
}

/** A uuid whose last group is `n`, so ids order the way their numbers do. */
function uuidOf(n: number): string {
	return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

let seq = 100;

/** A cluster fixture; every field the predicates and the facets read is overridable. */
function cluster(over: ClusterOverrides & { name: string }): ClusterListItem {
	const { name, project_cluster, ...rest } = over;
	seq -= 1;
	return clusterItem({
		id: "project-a",
		project_name: "payments",
		environment_stage: name,
		region: "eu-central-1",
		cloud_identities: { provider: "aws" },
		status: "ACTIVE",
		status_since: "2026-11-01T00:00:00.000Z",
		...rest,
		project_cluster: {
			// Each fixture is created a second before the previous one, so ALL is newest first.
			id: uuidOf(seq),
			created_at: new Date(Date.UTC(2026, 10, 1) + seq * 1000).toISOString(),
			cluster_name: `eks-${name}`,
			status: "ACTIVE",
			observation: { kind: "reported", observedAt: "2026-11-01T00:00:00.000Z", source: "deploy", fresh: true },
			...project_cluster,
		},
	});
}

const prod = cluster({ name: "production" });
const staging = cluster({ name: "staging", status: "PROVISIONING" });
const failedRun = cluster({ name: "qa", status: "FAILED", region: "eu-west-1" });
const otherProject = cluster({
	name: "production",
	id: "project-b",
	project_name: "search",
	region: "europe-west3",
	cloud_identities: { provider: "gcp" },
});
const noCloud = cluster({ name: "legacy", id: "project-b", project_name: "search", cloud_identities: null });
const ALL = [prod, staging, failedRun, otherProject, noCloud];

/** The values of one facet. */
function values(options: { value: string }[]): string[] {
	return options.map((o) => o.value);
}

describe("matchesClustersQuery", () => {
	it("an empty query matches every cluster", () => {
		expect(ALL.every((c) => matchesClustersQuery(c, {}))).toBe(true);
	});

	it("search reads the environment, the project and the cluster name", () => {
		expect(ALL.filter((c) => matchesClustersQuery(c, { search: "STAG" }))).toEqual([staging]);
		expect(ALL.filter((c) => matchesClustersQuery(c, { search: "search" }))).toEqual([otherProject, noCloud]);
		expect(ALL.filter((c) => matchesClustersQuery(c, { search: "eks-qa" }))).toEqual([failedRun]);
	});

	it("a cluster with no known cloud is its own cloud option, never AWS", () => {
		expect(ALL.filter((c) => matchesClustersQuery(c, { clouds: [UNKNOWN_CLOUD] }))).toEqual([noCloud]);
		expect(ALL.filter((c) => matchesClustersQuery(c, { clouds: ["aws"] }))).toEqual([prod, staging, failedRun]);
	});

	it("status filters on the derived posture: a failed last run needs attention", () => {
		expect(ALL.filter((c) => matchesClustersQuery(c, { statuses: ["failed"] }))).toEqual([failedRun]);
		expect(ALL.filter((c) => matchesClustersQuery(c, { statuses: ["pending"] }))).toEqual([staging]);
		expect(ALL.filter((c) => matchesClustersQuery(c, { statuses: ["failed", "pending"] }))).toEqual([staging, failedRun]);
	});

	it("filters combine: every selected dimension must match", () => {
		expect(ALL.filter((c) => matchesClustersQuery(c, { clouds: ["aws"], regions: ["eu-west-1"] }))).toEqual([failedRun]);
		expect(ALL.filter((c) => matchesClustersQuery(c, { clouds: ["gcp"], regions: ["eu-west-1"] }))).toEqual([]);
	});
});

describe("queryClustersPage — the two passes", () => {
	const narrowing: ClustersQuery[] = [
		{ search: "staging" },
		{ clouds: ["gcp"] },
		{ statuses: ["failed"] },
		{ regions: ["europe-west3"] },
		{ clouds: ["aws"], statuses: ["pending"] },
		{ search: "matches-nothing-at-all" },
	];

	it.each(narrowing)("the facet options do not shrink under %o", (query) => {
		const pristine = clustersPage(ALL);
		const narrowed = clustersPage(ALL, query);
		// The query did narrow the rows — otherwise the comparison below proves nothing.
		expect(narrowed.rows.length).toBeLessThan(pristine.rows.length);
		expect(narrowed.facets).toEqual(pristine.facets);
		// The scope still holds clusters: an empty filtered page is "no match", never first run.
		expect(narrowed.universeEmpty).toBe(false);
	});

	it("counts every cluster in each facet, with the four statuses always present", () => {
		const { facets } = clustersPage(ALL);
		expect(facets.clouds).toEqual([
			{ value: "aws", label: null, count: 3 },
			{ value: "gcp", label: null, count: 1 },
			{ value: UNKNOWN_CLOUD, label: null, count: 1 },
		]);
		expect(facets.statuses).toEqual([
			{ value: "failed", label: null, count: 1 },
			{ value: "pending", label: null, count: 1 },
			{ value: "active", label: null, count: 3 },
			{ value: "idle", label: null, count: 0 },
		]);
		expect(values(facets.regions)).toEqual(["eu-central-1", "eu-west-1", "europe-west3"]);
	});

	it("rows are newest cluster first, keyed by the CLUSTER's id, carrying the same objects", () => {
		const page = clustersPage(ALL, { clouds: ["aws"] });
		expect(page.clusters).toEqual([prod, staging, failedRun]);
		expect(page.clusters[0]).toBe(prod);
		// Two clusters of one project are two rows with two ids — never one id the page join folds.
		expect(page.rows.map((r) => r.id)).toEqual([prod, staging, failedRun].map((c) => c.project_cluster.id));
		expect(page).not.toHaveProperty("total");
		expect(page).not.toHaveProperty("resultCount");
	});
});

describe("queryClustersPage — the project is a scope, applied to BOTH passes", () => {
	it("a project's page lists and offers only its own clusters", () => {
		const org = clustersPage(ALL);
		const project = clustersPage(ALL, {}, { projectId: "project-b" });
		expect(project.clusters).toEqual([otherProject, noCloud]);
		// The facet pass saw the scope: no option for a cloud or a region the project does not have.
		expect(values(project.facets.clouds)).toEqual(["gcp", UNKNOWN_CLOUD]);
		expect(values(project.facets.regions)).toEqual(["eu-central-1", "europe-west3"]);
		expect(values(org.facets.clouds)).toContain("aws");
		expect(project.facets).toEqual(clusterFacets([otherProject, noCloud]));
	});

	it("inside a scope a filter still narrows the rows and not the facets", () => {
		const scoped = clustersPage(ALL, {}, { projectId: "project-a" });
		const filtered = clustersPage(ALL, { statuses: ["failed"] }, { projectId: "project-a" });
		expect(filtered.clusters).toEqual([failedRun]);
		expect(filtered.facets).toEqual(scoped.facets);
	});

	it("a project with no cluster is an empty scope — `universeEmpty`, not `no match`", () => {
		const page = clustersPage(ALL, { search: "production" }, { projectId: "project-none" });
		expect(page).toMatchObject({ rows: [], universeEmpty: true, nextCursor: null });
		expect(page.facets.clouds).toEqual([]);
	});
});

describe("queryClustersPage — keyset paging in memory (LST-3 #7485)", () => {
	/** `n` clusters, THREE to a millisecond, so page boundaries fall inside runs of ties. */
	function fleet(n: number): ClusterListItem[] {
		return Array.from({ length: n }, (_, i) => {
			const c = cluster({ name: `env-${i}` });
			return {
				...c,
				project_cluster: {
					...c.project_cluster,
					id: uuidOf(i + 1),
					created_at: new Date(Date.UTC(2026, 0, 1) + Math.floor(i / 3)).toISOString(),
				},
			};
		});
	}

	it("walks every cluster exactly once, newest first, ties broken by id", () => {
		const all = fleet(23);
		const seen: string[] = [];
		let cursor: ReturnType<typeof decodeKeysetCursor> | undefined;
		for (let guard = 0; guard < 20; guard++) {
			const page = queryClustersPage(all, {}, {}, { cursor: cursor ?? undefined, limit: 5 });
			seen.push(...page.rows.map((r) => r.id));
			// Facets and the emptiness probe ride the first page only.
			expect(page.facets === null).toBe(guard > 0);
			expect(page.universeEmpty === null).toBe(guard > 0);
			if (page.nextCursor === null) break;
			cursor = decodeKeysetCursor(page.nextCursor);
		}
		expect(seen).toHaveLength(23);
		expect(new Set(seen).size).toBe(23);
		expect(seen).toEqual([...seen].sort().reverse());
	});

	it("says there is no next page exactly when the last row is on this one", () => {
		const all = fleet(10);
		expect(queryClustersPage(all, {}, {}, { limit: 10 }).nextCursor).toBeNull();
		expect(queryClustersPage(all, {}, {}, { limit: 9 }).nextCursor).not.toBeNull();
	});

	it("a later page of a filtered walk stays inside the filter", () => {
		const all = [...fleet(12), failedRun];
		const first = queryClustersPage(all, { statuses: ["active"] }, {}, { limit: 4 });
		const cursor = first.nextCursor === null ? undefined : (decodeKeysetCursor(first.nextCursor) ?? undefined);
		const second = queryClustersPage(all, { statuses: ["active"] }, {}, { cursor, limit: 100 });
		expect([...first.rows, ...second.rows].map((r) => r.cluster)).not.toContain(failedRun);
		expect(first.rows.length + second.rows.length).toBe(12);
	});
});
