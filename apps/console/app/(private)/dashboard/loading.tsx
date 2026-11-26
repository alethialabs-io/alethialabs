// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { MarkLoader } from "@repo/brand/loader";

/**
 * /dashboard/* while it resolves the person's org and redirects into the org-scoped tree. The
 * destination is not known until the server answers (the overview, any `/{org}/~/…` page, or
 * onboarding), so there is no layout to draw a skeleton of: this is the full-page `[·]` loader,
 * centred in the viewport. Synchronous, as every `loading.tsx` must be.
 */
export default function DashboardLoading() {
	return (
		<div className="flex min-h-dvh items-center justify-center bg-background text-foreground">
			<MarkLoader size="page" label="Opening your workspace" />
		</div>
	);
}
