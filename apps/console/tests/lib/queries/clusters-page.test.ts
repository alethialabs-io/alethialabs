// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The clusters list's server half (lib/queries/clusters.ts) — the scope, the predicate and the
// facet pass behind `readClustersPage()` (the `clusters.page` read).
//
// A cluster's universe is a COMPOSITION (an RLS read, the PDP's visibility, drift and probe
// evidence), so there is no second SQL chain to inspect, as there is for the builders
// `filter-standard-facets.test.ts` drives. What there is instead is two functions over one array,
// and the standard's two properties are asserted in the form that mechanism can carry:
//   · THE FACET SET DOES NOT SHRINK AS THE QUERY NARROWS — a filter is on the rows pass only;
//   · IT DOES SHRINK WHEN THE SCOPE NARROWS — a project page's options are its project's.
// Each narrowing is first checked to have actually narrowed, so a test that filtered nothing
// cannot pass for that reason.

import { describe, expect, it } from "vitest";
import {
	type ClusterFacts,
	type ClustersQuery,
	UNKNOWN_CLOUD,
	clusterFacets,
	clustersPage,
	matchesClustersQuery,
} from "@/lib/queries/clusters";

/** A cluster fixture; every field the predicates and the facets read is overridable. */
function cluster(over: Partial<ClusterFacts> & { name: string }): ClusterFacts {
	const { name, ...rest } = over;
	return {
		id: "project-a",
		project_name: "payments",
		environment_stage: name,
		region: "eu-central-1",
		cloud_identities: { provider: "aws" },
		status: "ACTIVE",
		status_since: "2026-11-01T00:00:00.000Z",
		project_cluster: {
			cluster_name: `eks-${name}`,
			status: "ACTIVE",
			observation: { kind: "reported", observedAt: "2026-11-01T00:00:00.000Z", source: "deploy", fresh: true },
		},
		project_databases: [],
		project_caches: [],
		...rest,
	};
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

describe("clustersPage — the two passes", () => {
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
		expect(narrowed.total).toBe(pristine.total);
		expect(narrowed.resultCount).toBe(narrowed.rows.length);
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

	it("keeps the universe's order and returns the same row objects", () => {
		const page = clustersPage(ALL, { clouds: ["aws"] });
		expect(page.rows).toEqual([prod, staging, failedRun]);
		expect(page.rows[0]).toBe(prod);
	});
});

describe("clustersPage — the project is a scope, applied to BOTH passes", () => {
	it("a project's page lists, counts and offers only its own clusters", () => {
		const org = clustersPage(ALL);
		const project = clustersPage(ALL, {}, { projectId: "project-b" });
		expect(project.rows).toEqual([otherProject, noCloud]);
		expect(project.total).toBe(2);
		// The facet pass saw the scope: no option for a cloud or a region the project does not have.
		expect(values(project.facets.clouds)).toEqual(["gcp", UNKNOWN_CLOUD]);
		expect(values(project.facets.regions)).toEqual(["eu-central-1", "europe-west3"]);
		expect(values(org.facets.clouds)).toContain("aws");
		expect(project.facets).toEqual(clusterFacets([otherProject, noCloud]));
	});

	it("inside a scope a filter still narrows the rows and not the facets", () => {
		const scoped = clustersPage(ALL, {}, { projectId: "project-a" });
		const filtered = clustersPage(ALL, { statuses: ["failed"] }, { projectId: "project-a" });
		expect(filtered.rows).toEqual([failedRun]);
		expect(filtered.facets).toEqual(scoped.facets);
		expect(filtered.total).toBe(3);
	});

	it("a project with no cluster is an empty scope — `total` 0, not `no match`", () => {
		const page = clustersPage(ALL, { search: "production" }, { projectId: "project-none" });
		expect(page).toMatchObject({ rows: [], resultCount: 0, total: 0 });
		expect(page.facets.clouds).toEqual([]);
	});
});
