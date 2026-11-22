// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CanvasSkeleton } from "@/components/design-project/canvas/canvas-skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * Instant skeleton shown while the Architecture route prefetches the design and the board's reads
 * on the server. It is the SAME component the canvas shows while its chunk loads and until its
 * store is seeded, inside the same full-bleed wrapper the page renders — so the board never paints
 * empty and nothing moves when it lands (F009). `SkeletonRoot` is the wrapper, and the one thing
 * that marks the region busy (skeleton rule 1).
 */
export default function ProjectArchitectureLoading() {
	return (
		<SkeletonRoot className="h-full overflow-hidden">
			<CanvasSkeleton />
		</SkeletonRoot>
	);
}
