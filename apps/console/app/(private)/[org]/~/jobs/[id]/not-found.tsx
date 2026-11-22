"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { useParams } from "next/navigation";
import { JobNotFoundState } from "@/components/jobs/job-not-found-state";

/**
 * The job route's own 404 (#6121): an address whose id cannot be a job, which `page.tsx` refuses
 * before any read. It is the SAME state the page draws for a job that is absent or not visible to
 * the reader (R6 D-25) — one sentence and one way back, to this organization's jobs. A `not-found`
 * file receives no params, so the organization is read from the address.
 */
export default function JobNotFound() {
	const { org } = useParams<{ org: string }>();
	return <JobNotFoundState orgSlug={org} />;
}
