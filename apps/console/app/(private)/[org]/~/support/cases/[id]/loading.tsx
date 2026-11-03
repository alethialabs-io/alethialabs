// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CaseDetailSkeleton } from "@/components/support/cases/case-detail-skeleton";
import { readCaseShape } from "@/components/support/cases/read-case-shape";

/**
 * Instant skeleton for the case-detail route, in the shape of THIS case (#6354, B2): it reads the
 * case's shape — its messages, its attachments, whether it is closed — on the server before it
 * draws, through the page's own key in the request's query client (`readCaseShape`). The page's
 * height is the thread's, and the thread is the case's: a skeleton that drew one fixed message was
 * right for a case with one short message and nothing else.
 */
export default async function CaseDetailLoading() {
	return <CaseDetailSkeleton shape={await readCaseShape()} />;
}
