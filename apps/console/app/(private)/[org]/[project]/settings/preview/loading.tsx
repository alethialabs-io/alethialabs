// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Skeleton for the project Preview environments settings page. */
export default function PreviewSettingsLoading() {
	return (
		<div className="space-y-4">
			<Skeleton className="h-6 w-48" />
			<Skeleton className="h-4 w-72" />
			<Skeleton className="h-[360px] w-full rounded-lg" />
		</div>
	);
}
