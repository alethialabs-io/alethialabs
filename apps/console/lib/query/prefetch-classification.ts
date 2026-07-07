// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Server-side helper to batch-seed a list's classification chips into the query cache. Call
// it from a server component before rendering a HydrationBoundary: one round-trip fetches the
// chips for every row (getAssignmentsForKind) and seeds each resource's per-key cache, so the
// client chips + pickers render from cache with zero per-row fetches.

import type { QueryClient } from "@tanstack/react-query";
import { getAssignmentsForKind } from "@/app/server/actions/classification/assignments";
import type { ResourceKind } from "@/lib/db/schema/enums";
import { qk } from "./keys";

/**
 * Batch-fetches classification chips for `ids` of one `kind` and seeds each row's per-resource
 * query cache on `queryClient` (empty rows seeded to `[]` so they don't refetch). Best-effort:
 * a failure never blocks the page render (chips just lazily fetch on the client).
 */
export async function seedClassificationAssignments(
	queryClient: QueryClient,
	kind: ResourceKind,
	ids: string[],
): Promise<void> {
	if (ids.length === 0) return;
	try {
		const map = await getAssignmentsForKind(kind, ids);
		for (const id of ids) {
			queryClient.setQueryData(
				qk.classificationAssignments(kind, id),
				map[id] ?? [],
			);
		}
	} catch {
		// Non-fatal — the client falls back to per-row fetches.
	}
}
