// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Activity feed's normalize step (the console filter standard, lib/query/README.md) in a module
// with no "use client" and no server imports: the route builds the first page's key through it on
// the server (#6129) and the feed's `useKeysetList` builds the same key in the browser, so the two cannot
// disagree about what the key is. A client-only module imported by a server component is a client
// REFERENCE there, not a callable function — which is why this is not in a client module.

import { presetRange } from "@repo/ui/range";
import type { ActivityQuery } from "@/app/server/actions/activity";

/** Stable, cache-friendly copy of an ActivityQuery: arrays sorted, empties dropped,
 * cursor excluded (it's the pageParam). Pure — the route and the feed both build their key
 * through it, so the server prefetches the key the browser asks for. */
export function normalizeActivityQuery(query: ActivityQuery): ActivityQuery {
	const sorted = (xs?: string[]) => (xs && xs.length ? [...xs].sort() : undefined);
	return {
		...(query.projectId ? { projectId: query.projectId } : {}),
		...(query.within ? { within: query.within } : {}),
		...(query.from ? { from: query.from } : {}),
		...(query.to ? { to: query.to } : {}),
		...(query.search?.trim() ? { search: query.search.trim() } : {}),
		...(sorted(query.actorIds) ? { actorIds: sorted(query.actorIds) } : {}),
		...(sorted(query.resourceTypes) ? { resourceTypes: sorted(query.resourceTypes) } : {}),
		...(sorted(query.resourceIds) ? { resourceIds: sorted(query.resourceIds) } : {}),
		...(query.decision != null ? { decision: query.decision } : {}),
	};
}

/**
 * The `ts` bounds a query asks for, at `now`. A relative `within` is resolved HERE, at read time,
 * to "from that long ago, open-ended", so the same link read next month answers next month's
 * window (#6740). Otherwise the explicit ISO bounds, either of which may be absent.
 */
export function activityTimeBounds(
	query: Pick<ActivityQuery, "within" | "from" | "to">,
	now: Date = new Date(),
): { from?: Date; to?: Date } {
	if (query.within) return { from: presetRange(query.within, now).from };
	return {
		...(query.from ? { from: new Date(query.from) } : {}),
		...(query.to ? { to: new Date(query.to) } : {}),
	};
}
