// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed TanStack Query key factory. Centralising keys here keeps server prefetch and
 * client `useQuery` in lockstep (identical keys → hydration hits) and makes
 * invalidation precise. Resource keys are scoped by org slug so switching orgs never
 * serves another org's cached rows.
 */
export const qk = {
	jobs: (org: string) => ["jobs", org] as const,
	job: (org: string, id: string) => ["jobs", org, "detail", id] as const,
	jobStatus: (org: string, id: string) =>
		["jobs", org, "detail", id, "status"] as const,
	runners: (org: string) => ["runners", org] as const,
	clusters: (org: string) => ["clusters", org] as const,
	fleet: (org: string) => ["fleet", org] as const,
	addons: (projectId: string, environmentId?: string | null) =>
		["addons", projectId, environmentId ?? "default"] as const,
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
} as const;
