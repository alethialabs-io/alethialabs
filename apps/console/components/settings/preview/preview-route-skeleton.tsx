"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Preview environments route's SYNCHRONOUS loading form (decision CON-M4, R6 F-22).
//
// The route's `loading.tsx` used to be an async server component that read the viewer's linked git
// accounts before it drew, because the Source row has two layouts (the repository row, or the "No
// Git accounts linked" panel) and nothing else on the page says which. An async `loading.tsx` is
// itself a suspension, so the route showed the generic settings skeleton while the specific one
// waited. The answer now comes from the query cache, read without a request:
//
//   · known — the exact layout. The project settings layout (`[project]/settings/layout.tsx`)
//     prefetches and hydrates the accounts above this boundary, so every render of this skeleton
//     under it, a hard load included, has the answer;
//   · not known (the layout's read failed) — the repository row, which is what the picker shows
//     while it reads the list itself. A viewer with nothing linked then sees that row give way to
//     the panel. Before the layout seeded the cache this was every navigation from a route that had
//     not read the accounts (#7200's accepted cost); now it is only a failed read.

import { useQuery } from "@tanstack/react-query";
import { orpc } from "@/lib/rpc/client";
import { PreviewSettingsSkeleton, linkedFromProviders } from "./preview-settings-skeleton";

/** The Preview environments page in loading form, its Source row taken from the cached accounts. */
export function PreviewRouteSkeleton() {
	const linked = useQuery(orpc.projects.linkedGitProviders.queryOptions({ enabled: false }));
	return <PreviewSettingsSkeleton linked={linkedFromProviders(linked.data)} />;
}
