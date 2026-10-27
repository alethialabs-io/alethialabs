// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6131: the Configure screen's scan, read from the cache the route hydrated instead of polled every
// 2.5 s. What the hook answers for each thing the two reads can hold — and, as important, that a
// scan job which ENDED without a digest is "failed", not "scanning…" forever (the old poll's only
// exit was a digest, so a failed scan spun until the tab closed).
//
// The cache is seeded the way the route's prefetch seeds it, with `staleTime: Infinity` so nothing
// refetches: every answer here comes from the hydrated entries alone, which is RUBRIC B1's claim.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { useScanResult } from "@/components/create-project/use-create-project-reads";
import { orpc } from "@/lib/rpc/client";

const JOB = "00000000-0000-4000-8000-0000000000aa";

/** A client that never refetches, seeded with the scan's status (and its proposal, when given). */
function seeded(status: unknown, proposal?: unknown): QueryClient {
	const client = new QueryClient({
		defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
	});
	// Spread into plain arrays: the keys are the read router's, the values what the route hydrates.
	client.setQueryData([...orpc.projects.scanStatus.queryKey({ input: { jobId: JOB } })], status);
	if (proposal !== undefined) {
		client.setQueryData([...orpc.projects.scanProposal.queryKey({ input: { jobId: JOB } })], proposal);
	}
	return client;
}

/** The hook's answer for `jobId` over `client`'s cache. */
function answer(client: QueryClient, jobId: string | null) {
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(() => useScanResult(jobId), { wrapper }).result.current.result;
}

describe("useScanResult — the scan as the Configure screen renders it", () => {
	it("a scratch on-ramp has no scan", () => {
		expect(answer(new QueryClient(), null)).toBeNull();
	});

	it("a running scan is PENDING, with the job's state", () => {
		expect(answer(seeded({ status: "PENDING", jobStatus: "PROCESSING" }), JOB)).toEqual({
			status: "PENDING",
			jobStatus: "PROCESSING",
		});
	});

	it.each(["FAILED", "CANCELLED"])("a scan job that ended %s without a digest is FAILED, not scanning", (jobStatus) => {
		expect(answer(seeded({ status: "PENDING", jobStatus }), JOB)).toEqual({
			status: "FAILED",
			jobStatus,
		});
	});

	it("a scan the reader cannot see is NOT_FOUND", () => {
		expect(answer(seeded({ status: "NOT_FOUND" }), JOB)).toEqual({ status: "NOT_FOUND" });
	});

	it("a `?scan=` that cannot be a job id is NOT_FOUND without a read", () => {
		expect(answer(new QueryClient(), "not-a-uuid")).toEqual({ status: "NOT_FOUND" });
	});

	it("a scanned job answers with its proposal's state", () => {
		expect(
			answer(seeded({ status: "SCANNED" }, { status: "NEEDS_SETUP", needsIdentity: true }), JOB),
		).toEqual({ status: "NEEDS_SETUP", needsIdentity: true });
	});
});
