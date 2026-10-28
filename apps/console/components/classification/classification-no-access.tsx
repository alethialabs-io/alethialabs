// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";

/**
 * The Classification page for a viewer the taxonomy read refused (`org:view`, #6129): its own
 * render — distinct from an empty taxonomy (the blank slate), from a plan gate and from a failure
 * (RUBRIC B4). The same notice shape the Roles, Access, SSO and Activity pages use.
 */
export function ClassificationNoAccess() {
	return (
		<div className="p-6">
			<Alert>
				<AlertTitle>No access to classification</AlertTitle>
				<AlertDescription>
					You don&apos;t have permission to view this organization&apos;s classification taxonomy. Ask
					an owner or admin for access.
				</AlertDescription>
			</Alert>
		</div>
	);
}
