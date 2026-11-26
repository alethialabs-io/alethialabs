// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";
import { Skeleton } from "@repo/ui/skeleton";

/** The agent policy page's pending render: the toolbar and three setting cards. */
export function AgentPolicySkeleton() {
	return (
		<div className="space-y-6" aria-busy="true" aria-label="Loading agent settings" data-skeleton="agent-policy">
			<PageToolbarSkeleton description />
			{[0, 1, 2].map((card) => (
				<div key={card} className="space-y-2.5 rounded-sm border border-border bg-surface p-4">
					<Skeleton className="h-3.5 w-40" />
					<Skeleton className="h-3 w-[70%]" />
					<Skeleton className="h-3 w-1/2" />
				</div>
			))}
		</div>
	);
}
