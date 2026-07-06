// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HeaderSkeleton, PanelSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the settings/sso route. */
export default function SsoLoading() {
	return (
		<div className="space-y-6">
			<HeaderSkeleton />
			<PanelSkeleton lines={5} />
		</div>
	);
}
