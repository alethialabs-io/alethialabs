// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";

/** Rendered by the Activity pages in place of the feed when the caller lacks
 *  `activity:view_activity` (#3932) — the same notice shape the Roles and SSO pages use. */
export function ActivityNoAccess() {
	return (
		<div className="p-6">
			<Alert>
				<AlertTitle>No access to activity</AlertTitle>
				<AlertDescription>
					You don&apos;t have permission to view this organization&apos;s Activity log. Ask
					an owner or admin for access.
				</AlertDescription>
			</Alert>
		</div>
	);
}
