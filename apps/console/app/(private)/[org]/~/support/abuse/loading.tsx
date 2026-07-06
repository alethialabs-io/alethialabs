// SPDX-FileCopyrightText: 2026 Alethia Labs OÜ <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FormSkeleton, HeaderSkeleton } from "@/components/skeletons/page-skeletons";

/** Instant skeleton for the abuse-report route — header + form fields. */
export default function ReportAbuseLoading() {
	return (
		<div className="max-w-2xl space-y-8 py-2">
			<HeaderSkeleton />
			<FormSkeleton fields={5} />
		</div>
	);
}
