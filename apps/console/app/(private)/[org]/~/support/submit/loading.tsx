// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { SubmitCaseFormSkeleton } from "@/components/support/submit/submit-case-form";

/**
 * Instant skeleton for the submit-case route: the wizard's own loading form, in the page's own
 * `max-w-2xl` column — the stepper, step 1's two columns of type cards and the button row, drawn
 * from the form's layout so the swap to the form moves nothing (#6354, B2).
 */
export default function SubmitCaseLoading() {
	return (
		<div className="max-w-2xl">
			<SubmitCaseFormSkeleton />
		</div>
	);
}
