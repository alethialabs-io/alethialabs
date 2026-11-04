// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { EvidenceSkeleton } from "@/components/evidence/evidence-skeleton";

/**
 * Instant skeleton shown while the Evidence route prefetches the roll-up. It is the same component
 * the client draws while its read is pending, which mirrors the loaded layout — filter bar, the
 * Environments heading and count, the posture table's real columns, and the waivers panel — so the
 * swap to data does not shift the page.
 */
export default function EvidenceLoading() {
	return <EvidenceSkeleton />;
}
