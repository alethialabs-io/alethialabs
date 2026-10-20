// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FormSkeleton } from "@/components/skeletons/page-skeletons";
import { PageToolbarSkeleton } from "@repo/ui/page-toolbar";

/** Instant skeleton for the abuse-report route: the toolbar's line of copy, then the form fields. */
export default function ReportAbuseLoading() {
	return (
		<div className="max-w-2xl space-y-8 py-2">
			<PageToolbarSkeleton />
			<FormSkeleton fields={5} />
		</div>
	);
}
