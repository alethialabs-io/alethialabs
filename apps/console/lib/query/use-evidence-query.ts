// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only
"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import type { OrgEvidence } from "@/lib/queries/evidence";
import { fetchEvidenceData } from "./resource-fetchers";
import { qk } from "./keys";

/**
 * The active org's evidence roll-up (verify verdicts + drift posture + waivers).
 * Server-prefetched and hydrated, then polled every 30s — drift scans and new deploys
 * land on the day-2 cadence, not sub-second, so a slow poll keeps it fresh cheaply.
 */
export function useEvidenceQuery(): UseQueryResult<OrgEvidence> {
	const { org } = useParams<{ org: string }>();
	return useQuery({
		queryKey: qk.evidence(org),
		queryFn: fetchEvidenceData,
		refetchInterval: 30_000,
	});
}
