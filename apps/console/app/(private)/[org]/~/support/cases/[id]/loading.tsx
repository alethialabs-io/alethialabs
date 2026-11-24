// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CaseDetailSkeleton } from "@/components/support/cases/case-detail-skeleton";

/**
 * Instant skeleton for the case-detail route (G-24). Synchronous, as every `loading.tsx` must be
 * (RUBRIC, "The skeleton rules", rule 4 — decision CON-M4): it used to read the case's shape on the
 * server before drawing, which made it suspend, so the support layout's skeleton could paint first
 * and the viewer got three renders. It now draws the shape that needs no read — the opening shape
 * every case has (an open case, its first requester message) — in the page's own frames. The thread
 * is a bounded scroller and B2 leaves an open-ended list's bottom edge out of its score, so the
 * skeleton never has to know how many messages there are.
 */
export default function CaseDetailLoading() {
	return <CaseDetailSkeleton />;
}
