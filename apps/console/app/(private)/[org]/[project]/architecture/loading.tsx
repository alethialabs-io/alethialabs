// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/**
 * Instant skeleton shown while the Architecture route prefetches identities + config on the
 * server. Mirrors the canvas surface (full-bleed board + the corner control clusters) so the
 * swap to the live canvas doesn't shift the page.
 */
export default function ProjectArchitectureLoading() {
	return (
		<div className="relative h-[calc(100vh-7rem)] min-h-[520px] w-full overflow-hidden border border-border">
			{/* Top-right: Add + AI */}
			<div className="absolute right-3 top-3 flex items-center gap-2">
				<Skeleton className="h-8 w-16 rounded-md" />
				<Skeleton className="h-8 w-12 rounded-md" />
			</div>
			{/* Bottom-left: controls cluster */}
			<Skeleton className="absolute bottom-3 left-3 h-8 w-64" />
			{/* Bottom-right: cost panel */}
			<Skeleton className="absolute bottom-3 right-3 h-8 w-40 rounded-md" />
			{/* A few placeholder nodes */}
			<div className="absolute left-1/2 top-16 -translate-x-1/2">
				<Skeleton className="h-24 w-56 rounded-lg" />
			</div>
			<div className="absolute left-1/4 top-56">
				<Skeleton className="h-24 w-56 rounded-lg" />
			</div>
			<div className="absolute right-1/4 top-56">
				<Skeleton className="h-24 w-56 rounded-lg" />
			</div>
		</div>
	);
}
