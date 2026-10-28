// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { ClassificationSkeleton } from "@/components/classification/classification-skeleton";

/**
 * Instant skeleton for Settings · Classification, while the page prefetches the org's taxonomy: the
 * manager's toolbar, then whichever of its two bodies the browser's cached taxonomy says it will
 * draw — the blank slate when there is none (#6320). `ClassificationSkeleton` says why.
 */
export default function ClassificationLoading() {
	return <ClassificationSkeleton />;
}
