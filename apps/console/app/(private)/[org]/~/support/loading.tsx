// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CardGridSkeleton, HeaderSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the support landing hub — header + entry-point card grid. */
export default function SupportLoading() {
	return (
		<div className="space-y-8 py-2">
			<HeaderSkeleton />
			<CardGridSkeleton count={5} minWidth="260px" height="h-28" />
		</div>
	);
}
