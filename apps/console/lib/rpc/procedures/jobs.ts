// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { presetRange } from "@repo/ui/range";
import { getJobsPage, type JobsQuery } from "@/app/server/actions/jobs";
import { query } from "@/lib/rpc/base";
import { type JobsPageInput, jobsPageInput } from "@/lib/rpc/inputs/jobs";

/**
 * Turns the wire input into the existing reader's query: a preset is resolved to concrete bounds
 * HERE, at read time, so "last 12 months" means the twelve months before this read.
 */
export function toJobsQuery(input: JobsPageInput, now: Date = new Date()): JobsQuery {
	const { range, ...filters } = input;
	const bounds =
		"preset" in range
			? (() => {
					const r = presetRange(range.preset, now);
					return { from: r.from.toISOString(), to: r.to.toISOString() };
				})()
			: range;
	return { ...filters, ...bounds };
}

/**
 * The jobs domain's reads (#6113 slice; #6121 owns the rest of the domain).
 *
 * `page` calls the existing reader IN-PROCESS — a plain function call, not a server-action POST —
 * so the read no longer queues behind other actions. Moving the reader's body out of the
 * `"use server"` module is #6121's, per the ADR 0005 stress test (R10).
 */
export const jobsRouter = {
	page: query.input(jobsPageInput).handler(({ input }) => getJobsPage(toJobsQuery(input))),
};
