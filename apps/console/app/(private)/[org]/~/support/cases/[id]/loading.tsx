// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { CaseDetailSkeleton } from "@/components/support/cases/case-detail-skeleton";

/** Instant skeleton shown while the case-detail route reads the case on the server. */
export default function CaseDetailLoading() {
	return <CaseDetailSkeleton />;
}
