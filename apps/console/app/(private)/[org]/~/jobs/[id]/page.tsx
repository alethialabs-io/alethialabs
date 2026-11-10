// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { HydrationBoundary, dehydrate } from "@tanstack/react-query";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getQueryClient } from "@/lib/query/client";
import { serverOrpc } from "@/lib/rpc/server";
import { JOB_DETAIL_COLUMN } from "./detail-column";
import { JobDetail } from "./job-detail";

/**
 * `/{org}/~/jobs/{id}` — one job (#6121). Prefetches EXACTLY what the client reads on first paint —
 * the job (`jobs.detail`) and the head of its log (`jobs.logsHead`) — in-process through the read
 * router, and hands the dehydrated cache to `JobDetail`, so the page paints the job and its log
 * without a client fetch. An id that cannot be a job is a 404 here rather than a failed read.
 * `loading.tsx` covers the prefetch window.
 */
export default async function JobDetailRoute({ params }: { params: Promise<{ org: string; id: string }> }) {
	const { id } = await params;
	if (!z.uuid().safeParse(id).success) notFound();

	const queryClient = getQueryClient();
	const rpc = serverOrpc();
	await Promise.all([
		queryClient.prefetchQuery(rpc.jobs.detail.queryOptions({ input: { id } })),
		queryClient.prefetchQuery(rpc.jobs.logsHead.queryOptions({ input: { id } })),
	]);

	return (
		<HydrationBoundary state={dehydrate(queryClient)}>
			{/* Keyed by the job, so moving to another job (a re-run, an apply) starts its log afresh. */}
			{/* The route decides the prose column and shares it with `loading.tsx` (detail-column.ts). */}
			<JobDetail key={id} jobId={id} column={JOB_DETAIL_COLUMN} />
		</HydrationBoundary>
	);
}
