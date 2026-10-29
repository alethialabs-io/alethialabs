// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import type { ResourceKind } from "@/lib/db/schema/enums";
import { serverOrpc } from "@/lib/rpc/server";

// THE SERVER HALF OF `ClassificationControl` (#6334, ADR 0005 — the jobs slice's shape). The control
// paints its picker only once it knows the caller holds `org:edit`, and its chips only once it has
// the resource's assignments; read on the client, both arrive AFTER first paint, so the "Classify"
// button was missing from the server render. A route that renders the control prefetches these reads
// in-process, under exactly the keys `lib/query/use-classification-query.ts` asks for, into the
// request's QueryClient — its `HydrationBoundary` then hands them down and the control paints whole.
//
// `retry: false`: a failed read must not hold the first byte for a retry the browser makes anyway. A
// failed read is not dehydrated (`lib/query/client.ts`), so the client reads again and the control
// renders its own error state (`RegionError`) for what fails there.

/** The reads every control on a page shares: the edit decision and the taxonomy the picker lists. */
function sharedReads(queryClient: QueryClient): Promise<void>[] {
	const rpc = serverOrpc();
	return [
		queryClient.prefetchQuery(
			rpc.classification.canEdit.queryOptions({ input: undefined, retry: false }),
		),
		queryClient.prefetchQuery(rpc.classification.dimensions.queryOptions({ input: {}, retry: false })),
	];
}

/**
 * Prefetches what ONE resource's `ClassificationControl` reads on first paint: the edit decision,
 * the taxonomy, and that resource's chips (`classification.assignments`).
 */
export async function prefetchClassificationOf(
	queryClient: QueryClient,
	kind: ResourceKind,
	resourceId: string,
): Promise<void> {
	const rpc = serverOrpc();
	await Promise.all([
		...sharedReads(queryClient),
		queryClient.prefetchQuery(
			rpc.classification.assignments.queryOptions({ input: { kind, resourceId }, retry: false }),
		),
	]);
}

/**
 * Prefetches what a LIST of one kind's `ClassificationControl`s reads on first paint: the edit
 * decision, the taxonomy, and every row's chips in the one batched read the list hydrates its rows
 * from (`classification.assignmentsForKind`, `resourceIds` in the list's order — it is the key).
 */
export async function prefetchClassificationOfList(
	queryClient: QueryClient,
	kind: ResourceKind,
	resourceIds: string[],
): Promise<void> {
	const rpc = serverOrpc();
	await Promise.all([
		...sharedReads(queryClient),
		...(resourceIds.length > 0
			? [
					queryClient.prefetchQuery(
						rpc.classification.assignmentsForKind.queryOptions({
							input: { kind, resourceIds },
							retry: false,
						}),
					),
				]
			: []),
	]);
}
