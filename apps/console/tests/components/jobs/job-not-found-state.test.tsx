// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// One answer for a job that is not there (R6 D-25), however the address was wrong. An id that
// cannot be a job is refused by `page.tsx` with notFound(); a well-formed id whose read settles with
// no job the reader can see — absent and invisible alike — is handed to notFound() by `JobDetail`
// (#7875). Both therefore render the segment's `not-found.tsx`: `[ 404 ]`, "Nothing here.", the job
// reason line, and the one way back, to this organization's jobs. This pins the boundary's copy and
// exit, and pins that the detail page reaches it only on a definitive not-found.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { notFound } = vi.hoisted(() => ({
	notFound: vi.fn(() => {
		throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
	}),
}));

vi.mock("next/navigation", () => ({
	notFound,
	useParams: () => ({ org: "acme", id: JOB_ID }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/app/server/actions/jobs", () => ({ applyPlan: vi.fn(), cancelJob: vi.fn(), rerunJob: vi.fn() }));
vi.mock("@/hooks/use-job-log-stream", () => ({
	useJobLogStream: () => ({ logs: [], state: null, reconnect: () => {}, complete: true }),
}));
vi.mock("@/components/runners/runner-select-popover", () => ({ RunnerSelectPopover: () => null }));

import JobNotFound from "@/app/(private)/[org]/~/jobs/[id]/not-found";
import { JobDetail } from "@/app/(private)/[org]/~/jobs/[id]/job-detail";
import { orpc } from "@/lib/rpc/client";

const JOB_ID = "00000000-0000-4000-8000-000000000000";

/** Renders the detail page over a cache whose job read has SETTLED to `job`. */
function renderDetail(job: null) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(orpc.jobs.detail.queryKey({ input: { id: JOB_ID } }), job);
	client.setQueryData(orpc.jobs.logsHead.queryKey({ input: { id: JOB_ID } }), { lines: [], lastId: 0, final: true });
	return render(
		<QueryClientProvider client={client}>
			<JobDetail jobId={JOB_ID} column="mx-auto max-w-4xl" />
		</QueryClientProvider>,
	);
}

describe("the job not-found answer", () => {
	it("the route's not-found.tsx is the 404 form with the job reason line and one exit, for the organization in the address", () => {
		render(<JobNotFound />);
		expect(screen.getByText("404", { exact: true })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Nothing here." })).toBeInTheDocument();
		expect(
			screen.getByText("This job doesn't exist, or it belongs to another organization.", { exact: true }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Back to jobs" })).toHaveAttribute("href", "/acme/~/jobs");
		expect(screen.queryByRole("link", { name: /go home/i })).toBeNull();
	});

	it("a well-formed id whose read settles with no job hands the page to that boundary", () => {
		// React reports the thrown digest to the console on its way to the boundary; that is the
		// mechanism, not a failure, so it is silenced for this render only.
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() => renderDetail(null)).toThrow("NEXT_HTTP_ERROR_FALLBACK;404");
		quiet.mockRestore();
		// React re-renders once after a render throws before giving up, so it may be called twice.
		expect(notFound).toHaveBeenCalled();
		// No second rendering of the not-found state inside the page.
		expect(screen.queryByText("Job not found.")).toBeNull();
	});
});
