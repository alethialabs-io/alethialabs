// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CanvasSkeleton } from "@/components/design-project/canvas/canvas-skeleton";
import { SkeletonRoot } from "@/components/skeleton/skeleton-root";

/**
 * Skeleton for the bare project, `/{org}/{project}`. That page only redirects to Architecture, and
 * every other view under the project draws its own `loading.tsx`, so this one paints only on the
 * way to the board — it is the board's shape: the same `CanvasSkeleton` inside the same full-bleed
 * wrapper `architecture/loading.tsx` renders, so nothing moves when the redirect lands (B2). Same
 * reasoning as `settings/loading.tsx`, which is General's shape because settings redirects there.
 *
 * `CanvasSkeleton` still marks itself busy as well; that second statement belongs to the canvas
 * component and goes when it is drawn inside `SkeletonRoot` everywhere.
 */
export default function ProjectLoading() {
	return (
		<SkeletonRoot className="h-full overflow-hidden">
			<CanvasSkeleton />
		</SkeletonRoot>
	);
}
