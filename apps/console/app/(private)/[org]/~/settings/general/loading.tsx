// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FormSkeleton, HeaderSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the settings/general route. */
export default function GeneralLoading() {
	return (
		<div className="space-y-6">
			<HeaderSkeleton />
			<FormSkeleton fields={4} />
		</div>
	);
}
