// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The promotions history's server half — one keyset page of a project's promotions, newest first
// (lib/query/README.md → "Paging"; LST-3 #7485).
//
// The history is APPEND-ONLY (a promotion row is created once and only its status moves), so it
// pages in SQL: ordered and compared on `created_at` truncated to ms, then the id, with one extra
// row read so the end is known exactly. It used to be one unbounded read of every promotion the
// project ever ran, shipped whole to the browser and paged eight at a time there.
//
// No filters and no facets: the history has no filter bar, so the page carries `facets: null`
// through `keysetListPage` and `universeEmpty` — whether the project has run any promotion — on the
// first page, which is what decides whether the section renders at all. Its own module, not
// lib/queries/environments.ts: that one is imported by a client dialog, and this one reads tables.

import { and, eq } from "drizzle-orm";
import type { Tx } from "@/lib/db";
import { environmentPromotions } from "@/lib/db/schema";
import {
	KEYSET_DEFAULT_LIMIT,
	type KeysetListPage,
	type KeysetPageRequest,
	keysetAfter,
	keysetFetchLimit,
	keysetListPage,
	keysetOrderBy,
	keysetPage,
	keysetSortKey,
} from "@/lib/queries/keyset";

/** A promotion row as the history shows it (`created_at` is an ISO string). */
export interface PromotionHistoryRow {
	id: string;
	source_environment_id: string;
	target_environment_id: string;
	status: string;
	error_message: string | null;
	created_at: string;
}

/** One keyset page of the promotions history: no facets, ever. */
export type PromotionsPage = KeysetListPage<PromotionHistoryRow, null>;

/**
 * One keyset page of `projectId`'s promotions, newest first, strictly after `request.cursor`. The
 * caller has bound the project to the actor's org and authorized `view` on it; `tx` is the actor's
 * RLS-scoped transaction. The project is a predicate on the rows read and on the first-page
 * emptiness probe alike.
 *
 * @param tx the actor-scoped transaction
 * @param projectId the project whose history this is (the route's scope)
 * @param request the decoded cursor (absent on page one) and the page size
 */
export async function queryPromotionsPage(
	tx: Pick<Tx, "select">,
	projectId: string,
	request: KeysetPageRequest = { limit: KEYSET_DEFAULT_LIMIT },
): Promise<PromotionsPage> {
	const sortKey = keysetSortKey(environmentPromotions.created_at);
	const fetched = await tx
		.select({
			id: environmentPromotions.id,
			source_environment_id: environmentPromotions.source_environment_id,
			target_environment_id: environmentPromotions.target_environment_id,
			status: environmentPromotions.status,
			error_message: environmentPromotions.error_message,
			created_at: environmentPromotions.created_at,
		})
		.from(environmentPromotions)
		.where(
			and(
				eq(environmentPromotions.project_id, projectId),
				keysetAfter(sortKey, environmentPromotions.id, request.cursor),
			),
		)
		.orderBy(...keysetOrderBy(sortKey, environmentPromotions.id))
		.limit(keysetFetchLimit(request.limit));

	const page = keysetPage(fetched, request.limit, (row) => ({ at: row.created_at, id: row.id }));
	const rows = page.rows.map((row) => ({ ...row, created_at: row.created_at.toISOString() }));
	// On page one the rows pass already answers emptiness: no cursor narrowed it, so an empty first
	// page IS an empty history. No second read.
	const first = request.cursor === undefined ? { facets: null, universeEmpty: rows.length === 0 } : null;
	return keysetListPage({ rows, nextCursor: page.nextCursor }, first);
}
