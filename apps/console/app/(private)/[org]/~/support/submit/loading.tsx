// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { FormSkeleton } from "@/components/skeletons/page-skeletons";
import { Skeleton } from "@repo/ui/skeleton";

/** Instant skeleton for the submit-case route — stepper header + form fields. */
export default function SubmitCaseLoading() {
	return (
		<div className="max-w-2xl space-y-8 py-2">
			<div className="flex items-center gap-3">
				{[1, 2, 3, 4, 5].map((i) => (
					<Skeleton key={i} className="h-6 w-6 rounded-full" />
				))}
			</div>
			<FormSkeleton fields={4} />
		</div>
	);
}
