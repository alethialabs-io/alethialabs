// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HeaderSkeleton, TableSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the settings/activity route. */
export default function ActivityLoading() {
	return (
		<div className="space-y-6">
			<HeaderSkeleton />
			<TableSkeleton rows={8} />
		</div>
	);
}
