// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Alert, AlertDescription, AlertTitle } from "@repo/ui/alert";

/**
 * The SSO page for a viewer without `member:view` (#6129): the read router refused the bootstrap
 * with FORBIDDEN, so this is the page's own render — distinct from an empty provider list, from a
 * plan gate and from a failure (RUBRIC B4). The same notice shape the Roles, Access and Activity
 * pages use.
 */
export function SsoNoAccess() {
	return (
		<div className="p-6">
			<Alert>
				<AlertTitle>No access to SSO settings</AlertTitle>
				<AlertDescription>
					You don&apos;t have permission to view single sign-on for this organization. Ask an owner or
					admin for access.
				</AlertDescription>
			</Alert>
		</div>
	);
}
