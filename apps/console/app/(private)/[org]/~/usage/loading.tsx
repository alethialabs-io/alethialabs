// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HeaderSkeleton, PanelSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the usage route. */
export default function UsageLoading() {
	return (
		<div className="mx-auto w-full min-w-0 max-w-[1200px] space-y-6">
			<HeaderSkeleton />
			<PanelSkeleton lines={6} />
		</div>
	);
}
