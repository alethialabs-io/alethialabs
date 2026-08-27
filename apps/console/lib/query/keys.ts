// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed TanStack Query key factory. Centralising keys here keeps server prefetch and
 * client `useQuery` in lockstep (identical keys → hydration hits) and makes
 * invalidation precise. Resource keys are scoped by org slug so switching orgs never
 * serves another org's cached rows.
 */
import type { NormalizedEvidenceQuery } from "@/components/evidence/evidence-query";

export const qk = {
	jobs: (org: string) => ["jobs", org] as const,
	/** The jobs PAGE, parameterized by the normalized filter query (normalizeJobsQuery).
	 * Distinct from the shared unfiltered `jobs` cache, which palette/breadcrumbs/
	 * overview/runners/plan all consume. */
	jobsPage: (org: string, query: unknown) => ["jobs", org, "page", query] as const,
	/** Evidence roll-up, parameterized by the normalized filter query
	 * (normalizeEvidenceQuery — stable object, so equal filters hit the cache). */
	evidence: (org: string, query: NormalizedEvidenceQuery) =>
		["evidence", org, query] as const,
	job: (org: string, id: string) => ["jobs", org, "detail", id] as const,
	jobStatus: (org: string, id: string) =>
		["jobs", org, "detail", id, "status"] as const,
	runners: (org: string) => ["runners", org] as const,
	clusters: (org: string) => ["clusters", org] as const,
	fleet: (org: string) => ["fleet", org] as const,
	addons: (projectId: string, environmentId?: string | null) =>
		["addons", projectId, environmentId ?? "default"] as const,
	environmentStatus: (projectId: string, environmentId?: string | null) =>
		["environment-status", projectId, environmentId ?? "default"] as const,
	projects: (org: string) => ["projects", org] as const,
	projectUsage: (projectId: string) => ["project-usage", projectId] as const,
	projectUsageOverTime: (projectId: string, from: string, to: string) =>
		["project-usage", projectId, "over-time", from, to] as const,
	pricing: (region: string) => ["pricing", region] as const,
	cloudResources: (identityId: string) =>
		["cloud-resources", identityId] as const,
	supportCases: (filter: "all" | "active" | "resolved" = "all") =>
		["support", "cases", filter] as const,
	supportCase: (id: string) => ["support", "case", id] as const,
	roles: (org: string, search?: string) =>
		search ? (["roles", org, search] as const) : (["roles", org] as const),
	/** Activity log, parameterized by the normalized filter query (sans cursor — the
	 * cursor is the infinite query's pageParam, never part of the key). */
	activity: (org: string, query: unknown) => ["activity", org, query] as const,
	/** Org member rows (filter facets + name resolution on activity). */
	members: (org: string) => ["members", org] as const,
	ssoProviders: (org: string, filter?: unknown) =>
		filter
			? (["sso", "providers", org, filter] as const)
			: (["sso", "providers", org] as const),
	classificationDimensions: (search?: string) =>
		search
			? (["classification", "dimensions", search] as const)
			: (["classification", "dimensions"] as const),
	classificationAssignments: (kind: string, id: string) =>
		["classification", "assignments", kind, id] as const,
	classificationAssignmentsForKind: (kind: string, ids: string[]) =>
		["classification", "assignments-batch", kind, ids] as const,
	classificationCanEdit: () => ["classification", "can-edit"] as const,

	// ── Surfaces joining the filter standard (#2871 seams) ──────────────────────────────
	//
	// Declared here, ahead of their consumers, because six lanes of the console consolidation
	// each migrate a list page onto lib/query/README.md's pipeline and each needs a key. Six
	// branches adding a line to one file is six conflicts; the seams issue owns the file so the
	// lanes never touch it.
	//
	// All take the NORMALIZED filter object (the `normalize*Query()` step), never raw component
	// state — an unsorted array or a stray whitespace fragments the cache into keys that never
	// hit. `unknown` mirrors `jobsPage`/`activity`: the key factory does not need the shape, and
	// typing it here would drag every page's query type into this module.
	alertChannels: (org: string, query?: unknown) =>
		query ? (["alerts", "channels", org, query] as const) : (["alerts", "channels", org] as const),
	alertPolicies: (org: string, query?: unknown) =>
		query ? (["alerts", "policies", org, query] as const) : (["alerts", "policies", org] as const),
	connectors: (org: string, query?: unknown) =>
		query ? (["connectors", org, query] as const) : (["connectors", org] as const),
	teams: (org: string, query?: unknown) =>
		query ? (["teams", org, query] as const) : (["teams", org] as const),
	accessGrants: (org: string, query?: unknown) =>
		query ? (["access", "grants", org, query] as const) : (["access", "grants", org] as const),
	invoices: (org: string, query?: unknown) =>
		query ? (["billing", "invoices", org, query] as const) : (["billing", "invoices", org] as const),
	transactions: (org: string, query?: unknown) =>
		query
			? (["billing", "transactions", org, query] as const)
			: (["billing", "transactions", org] as const),
} as const;
