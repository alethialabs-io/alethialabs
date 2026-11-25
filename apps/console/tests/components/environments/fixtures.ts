// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Environments page's read, for its component tests: a project with a default `development`
// environment and a non-default `production`, a viewer who may change and promote, nothing in
// flight — and the table's and the promotions history's first pages (LST-3 #7485). A test overrides what it is about.

import type { QueryClient } from "@tanstack/react-query";
import type { EnvironmentFacetSet, EnvironmentFacts, EnvironmentsPage } from "@/lib/queries/environments";
import type { PromotionsPage } from "@/lib/queries/promotions";
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

/** The table's row for an environment: the facts `environments.page` returns. */
export function factsOf(env: EnvRow): EnvironmentFacts {
	return { id: env.id, name: env.name, stage: env.stage, status: env.status, created_at: env.updated_at };
}

/** Facet counts over `envs`, as the first page carries them. */
export function facetsOf(envs: EnvRow[]): EnvironmentFacetSet {
	const statuses = [...new Set(envs.map((e) => e.status))].sort();
	return {
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
	};
}

/**
 * The table's first (and last) page: `rows` matched, with the facets and the emptiness of `all`.
 * `rows` defaults to every environment — what a pristine bar gets.
 */
export function pageOf(all: EnvRow[], rows: EnvRow[] = all): EnvironmentsPage {
	return { rows: rows.map(factsOf), nextCursor: null, facets: facetsOf(all), universeEmpty: all.length === 0 };
}

/** The infinite cache entry a route's prefetch leaves for one first page. */
function firstPage<T>(page: T) {
	return { pages: [page], pageParams: [null] };
}

/** The keys the view's two paged reads use for the pristine list of project `payments`. */
const TABLE_KEY = [["environments", "page"], { input: { project: "payments" }, type: "infinite" }];
const PROMOTIONS_KEY = [["environments", "promotions"], { input: { project: "payments" }, type: "infinite" }];

/**
 * Seeds the table's first page (`page`, default: every environment of `overview`) and an empty
 * promotions history, as the route's prefetch leaves them.
 */
export function seedLists(
	qc: QueryClient,
	overview: EnvironmentsOverview,
	page: EnvironmentsPage = pageOf(overview.envs),
	promotions: PromotionsPage = { rows: [], nextCursor: null, facets: null, universeEmpty: true },
) {
	qc.setQueryData(TABLE_KEY, firstPage(page));
	qc.setQueryData(PROMOTIONS_KEY, firstPage(promotions));
}

/** The panels' read. */
export function overviewOf(over: Partial<EnvironmentsOverview> = {}): EnvironmentsOverview {
	const envs = over.envs ?? [DEV, PROD];
	return {
		projectId: PROJECT_ID,
		canManage: true,
		canPromote: true,
		envs,
		consistency: { envs: [], rows: [] },
		reconcile: [],
		activePromotion: null,
		protectionByEnv: {},
		...over,
	};
}
