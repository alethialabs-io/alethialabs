// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments page's read, for its component tests: a project with a default `development`
// environment and a non-default `production`, a viewer who may change and promote, nothing in
// flight. A test overrides what it is about.

import type { EnvironmentsOverview, EnvRow } from "@/lib/rpc/procedures/environments";

export const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

/** One environment row; `id` and `name` are the test's, the rest default to a live, settled one. */
export function envRow(over: Partial<EnvRow> & Pick<EnvRow, "id" | "name">): EnvRow {
	return {
		stage: "development",
		is_default: false,
		status: "ACTIVE",
		updated_at: "2026-10-01T00:00:00.000Z",
		byo_admission_enforce: false,
		byo_admission_has_charts: false,
		byo_admission_pending: false,
		...over,
	};
}

export const DEV = envRow({ id: "env-dev", name: "development", is_default: true });
export const PROD = envRow({
	id: "env-prod",
	name: "production",
	stage: "production",
	updated_at: "2026-10-02T00:00:00.000Z",
});

/** The list half of the read for `envs` with every one of them matching: what a pristine bar gets. */
export function pageOf(envs: EnvRow[]): EnvironmentsOverview["page"] {
	const statuses = [...new Set(envs.map((e) => e.status))].sort();
	return {
		rowIds: envs.map((e) => e.id),
		resultCount: envs.length,
		total: envs.length,
		facets: {
			stages: ["development", "staging", "production"].map((stage) => ({
				value: stage,
				label: null,
				count: envs.filter((e) => e.stage === stage).length,
			})),
			statuses: statuses.map((status) => ({
				value: status,
				label: null,
				count: envs.filter((e) => e.status === status).length,
			})),
		},
	};
}

/** The read. `page` follows `envs` unless a test gives its own (a filtered answer). */
export function overviewOf(over: Partial<EnvironmentsOverview> = {}): EnvironmentsOverview {
	const envs = over.envs ?? [DEV, PROD];
	return {
		projectId: PROJECT_ID,
		canManage: true,
		canPromote: true,
		envs,
		page: pageOf(envs),
		consistency: { envs: [], rows: [] },
		reconcile: [],
		promotions: [],
		activePromotion: null,
		protectionByEnv: {},
		...over,
	};
}
