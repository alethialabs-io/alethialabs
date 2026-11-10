// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import type { QueryClient } from "@tanstack/react-query";
import { DEFAULT_PRESET, presetRange } from "@repo/ui/range";
import { type ActivityWindow, activityQueryFromUrl } from "@/components/settings/activity/activity-filters";
import type { ParamReader } from "@/lib/query/filter-url-codec";
import { readRefusalOf, retryUnlessRefused } from "@/lib/rpc/refusal";
import { serverOrpc } from "@/lib/rpc/server";

/**
 * The Activity routes' prefetch (#6129, B1), shared by the org feed and a project's feed so the two
 * cannot drift apart: the default window resolved ONCE, here, and the first page of
 * `activity.page` for the link's filters in that window — the exact infinite key `useActivityQuery`
 * asks for — plus `members.list`, which names the actors. Returns the window, which the feed must
 * be handed (a window resolved in the browser is a different key), and whether the log refused the
 * viewer (`view_activity` withdrawn between the permission check and the read).
 */
export async function prefetchActivityFeed(
	queryClient: QueryClient,
	params: ParamReader,
	projectId?: string,
): Promise<{ defaultWindow: ActivityWindow; forbidden: boolean }> {
	const range = presetRange(DEFAULT_PRESET);
	const defaultWindow = { from: range.from.toISOString(), to: range.to.toISOString() };
	const query = activityQueryFromUrl(params, defaultWindow, projectId);
	const rpc = serverOrpc();
	const page = rpc.activity.page.infiniteOptions({
		input: (cursor: number | null) => (cursor == null ? query : { ...query, cursor }),
		initialPageParam: null,
		getNextPageParam: (last) => last.nextCursor,
		retry: retryUnlessRefused,
	});
	await Promise.all([
		queryClient.prefetchInfiniteQuery(page),
		queryClient.prefetchQuery(rpc.members.list.queryOptions({ input: undefined, staleTime: 60_000 })),
	]);
	const forbidden = readRefusalOf(queryClient.getQueryState(page.queryKey)?.error) === "forbidden";
	return { defaultWindow, forbidden };
}
