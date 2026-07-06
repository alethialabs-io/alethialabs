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
	projects: (org: string) => ["projects", org] as const,
	pricing: (region: string) => ["pricing", region] as const,
	cloudResources: (identityId: string) =>
		["cloud-resources", identityId] as const,
	supportCases: (filter: "all" | "active" | "resolved" = "all") =>
		["support", "cases", filter] as const,
	supportCase: (id: string) => ["support", "case", id] as const,
} as const;
