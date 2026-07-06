// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Skeleton } from "@repo/ui/skeleton";

/** Skeleton for the Settings content column (the section-nav is provided by the layout). */
export default function SettingsLoading() {
	return (
		<div className="space-y-4">
			<Skeleton className="h-6 w-40" />
			<Skeleton className="h-4 w-64" />
			<Skeleton className="h-40 w-full rounded-lg" />
		</div>
	);
}
