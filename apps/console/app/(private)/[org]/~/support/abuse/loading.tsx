// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { AbuseFormSkeleton } from "@/components/support/abuse/abuse-form";

/**
 * Instant skeleton for the abuse-report route: the form's own loading form — its line of copy, its
 * three ruled sections at their fields' real heights and the submit row — drawn from the form's
 * layout so the swap to the form moves nothing (#6354, B2).
 */
export default function ReportAbuseLoading() {
	return <AbuseFormSkeleton />;
}
