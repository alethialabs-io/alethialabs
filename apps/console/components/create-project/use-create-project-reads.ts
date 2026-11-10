// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { orpc } from "@/lib/rpc/client";
import type { ScanProposal } from "@/lib/scanner/schema";
import { isScanJobId } from "./scan-job-id";

// THE CREATE FLOW'S READS (#6131), over the read router's `projects.*` procedures
// (lib/rpc/procedures/projects.ts). The `/~/new` route prefetches the first-paint ones on the server
// (`linkedGitProviders`, and for an import the scan's status — plus its proposal once scanned), so
// these hooks find their data in the hydrated cache and fetch nothing on mount.

/** The caller's linked git providers — the import panel's first paint (F034). */
export function useLinkedGitProviders() {
	return useQuery(orpc.projects.linkedGitProviders.queryOptions());
}

/**
 * Where an import's scan is, as the Configure screen renders it. `PENDING` with `jobStatus: null`
 * means the status has not been read yet; `FAILED` is a scan job that ended without a digest, which
 * used to read as "scanning…" forever; `ERROR` is a read that failed — distinct from a scan that is
 * missing (`NOT_FOUND`) and from one still running (RUBRIC B4).
 */
export type ScanResult =
	| { status: "NOT_FOUND" }
	| { status: "PENDING"; jobStatus: string | null }
	| { status: "FAILED"; jobStatus: string }
	| { status: "NEEDS_SETUP"; needsIdentity: boolean }
	| { status: "READY"; proposal: ScanProposal }
	| { status: "ERROR" };

/** Job states a scan does not come back from. */
const TERMINAL_WITHOUT_DIGEST = new Set(["FAILED", "CANCELLED"]);

/**
 * The import's scan, live: the cheap STATUS read rides the `jobs` topic (lib/query/topics.ts), so
 * the screen learns the scan finished within a second of the runner writing it — the 2.5 s
 * `setInterval` poll this replaces is gone. The PROPOSAL is read once the status says the digest is
 * there, and never again for this scan: it costs a model inference.
 *
 * "Never again" is enforced by the observer, not by `staleTime`. The realtime resync after a
 * reconnect (`lib/realtime/client/coalescer.ts` `flushAll`) invalidates EVERY query and refetches
 * every ACTIVE one whatever its staleTime — so once the proposal is in the cache its observer is
 * disabled, and a disabled query is not active: no hint, resync, focus or remount refetches it. The
 * server keeps one inference per scan as well (`inferredStacks` in lib/rpc/procedures/projects.ts).
 *
 * `jobId` null (a scratch on-ramp) reads nothing and answers null.
 */
export function useScanResult(jobId: string | null): { result: ScanResult | null; retry: () => void } {
	const valid = jobId !== null && isScanJobId(jobId);
	const input = { jobId: jobId ?? "" };
	const status = useQuery({ ...orpc.projects.scanStatus.queryOptions({ input }), enabled: valid });
	const scanned = status.data?.status === "SCANNED";
	const queryClient = useQueryClient();
	const proposalOptions = orpc.projects.scanProposal.queryOptions({ input });
	// Answered once → inactive for good (see above): only a read with nothing cached may run.
	const answered = queryClient.getQueryData(proposalOptions.queryKey) !== undefined;
	const proposal = useQuery({
		...proposalOptions,
		enabled: valid && scanned && !answered,
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
	});
	const retry = () => {
		if (status.isError) void status.refetch();
		if (proposal.isError) void proposal.refetch();
	};

	if (jobId === null) return { result: null, retry };
	if (!valid) return { result: { status: "NOT_FOUND" }, retry };
	if (status.isError || proposal.isError) return { result: { status: "ERROR" }, retry };
	const s = status.data;
	if (!s) return { result: { status: "PENDING", jobStatus: null }, retry };
	if (s.status === "NOT_FOUND") return { result: { status: "NOT_FOUND" }, retry };
	if (s.status === "PENDING") {
		return {
			result: TERMINAL_WITHOUT_DIGEST.has(s.jobStatus)
				? { status: "FAILED", jobStatus: s.jobStatus }
				: { status: "PENDING", jobStatus: s.jobStatus },
			retry,
		};
	}
	// Scanned: the proposal is being inferred until it lands.
	return { result: proposal.data ?? { status: "PENDING", jobStatus: "SUCCESS" }, retry };
}

/**
 * Whether the org can still take `name` (F035), checked while the user types: debounced, and only
 * for a name the client-side rules already accept (`enabled`). `availability` is only ever the
 * answer for the name currently in the field — an answer for what was typed a moment ago is not
 * shown as if it were about this one.
 */
export function useNameAvailability(name: string, enabled: boolean) {
	const wanted = name.trim();
	const debounced = useDebouncedValue(wanted, 300);
	const settled = debounced === wanted;
	const query = useQuery({
		...orpc.projects.nameAvailability.queryOptions({ input: { name: debounced } }),
		enabled: enabled && debounced.length > 0,
	});
	const current = enabled && settled && query.data ? query.data : undefined;
	return {
		availability: current,
		checking: enabled && wanted.length > 0 && (!settled || query.isFetching),
		// The check itself failed for this name: said, so a missing "taken" is not read as "free".
		failed: enabled && settled && query.isError,
	};
}
