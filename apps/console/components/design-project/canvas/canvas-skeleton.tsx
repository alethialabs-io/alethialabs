// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// No "use client": the route's `loading.tsx` (a server component) renders this, and so do the
// canvas's own client-side loading states — one shape for all three, so the swap between them and
// the live board moves nothing.

import { Skeleton } from "@repo/ui/skeleton";
import { cn } from "@repo/ui/utils";

/**
 * The Architecture board while it loads: the full-bleed board with its corner chrome where the live
 * board draws it — the toolbar top-right (run · add · more), the controls bottom-left (zoom, fit,
 * undo, redo) — and three placeholder cards.
 *
 * It is the board ONLY while the board's data is genuinely unknown: `architecture/loading.tsx`, while
 * the server prefetches the design and the board's reads. Once the data is known, the stand-in is
 * `BoardPreview` — the board drawn from that data (#6348) — which falls back to this only for a
 * caller that never provided the data.
 *
 * `overlay` positions it over a mounted board; without it, it fills its parent.
 */
export function CanvasSkeleton({ overlay = false }: { overlay?: boolean }) {
	return (
		<div
			data-slot="canvas-skeleton"
			role="status"
			aria-busy="true"
			aria-label="Loading the board"
			className={cn(
				"overflow-hidden bg-background",
				overlay
					? "absolute inset-0 z-[var(--z-raised)]"
					: "relative h-full min-h-[480px] w-full",
			)}
		>
			{/* Top-right: run · add · more */}
			<div className="absolute right-3 top-3 flex items-center gap-2">
				<Skeleton className="h-8 w-16 rounded-none" />
				<Skeleton className="h-8 w-16 rounded-none" />
				<Skeleton className="h-8 w-8 rounded-none" />
			</div>
			{/* Bottom-left: zoom out · zoom in · fit | undo · redo */}
			<Skeleton className="absolute bottom-3 left-3 h-8 w-[10.25rem] rounded-none" />
			{/* A few placeholder cards */}
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
