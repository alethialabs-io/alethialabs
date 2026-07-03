// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HeaderSkeleton, TableSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the settings/access route. */
export default function AccessLoading() {
	return (
		<div className="space-y-6">
			<HeaderSkeleton />
			<TableSkeleton rows={6} />
		</div>
	);
}
