// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6732 — the job header's duration. A Plan cancelled after 120 days in the queue read "2880h 19m",
// for two reasons: `formatDuration` had no unit above hours, and the page showed the job's whole
// wait as its "duration" although the job never started. A job with no `started_at` has no run
// time, so the header says it never started and how long it waited.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/jobs", () => ({ applyPlan: vi.fn(), cancelJob: vi.fn(), rerunJob: vi.fn() }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme", id: JOB_ID }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-job-log-stream", () => ({ useJobLogStream: () => ({ logs: [] }) }));
vi.mock("@/components/runners/runner-select-popover", () => ({ RunnerSelectPopover: () => null }));

import { JobDetail } from "@/app/(private)/[org]/~/jobs/[id]/job-detail";
import { orpc } from "@/lib/rpc/client";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const CREATED = "2026-07-19T10:00:00.000Z";
/** 120 days and 19 minutes after CREATED: the production row the issue was filed from. */
const COMPLETED = "2026-11-16T10:19:00.000Z";

/** A terminal PLAN; each case sets which timestamps it has. */
function job(fields: { status: string; started_at: string | null }) {
	return {
		id: JOB_ID,
		job_type: "PLAN",
		project_id: "proj-1",
		environment_id: "env-1",
		project_name: "payments",
		project_slug: "payments",
		environment_name: "staging",
		runner_id: null,
		created_at: CREATED,
		completed_at: COMPLETED,
		error_message: null,
		config_snapshot: null,
		execution_metadata: null,
		...fields,
	};
}

/** Renders the page over a cache already holding what the server prefetched. */
function renderPage(row: ReturnType<typeof job>) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(orpc.jobs.detail.queryKey({ input: { id: JOB_ID } }), row as never);
	client.setQueryData(orpc.jobs.logsHead.queryKey({ input: { id: JOB_ID } }), { lines: [], lastId: 0 });
	render(
		<QueryClientProvider client={client}>
			<JobDetail jobId={JOB_ID} column="mx-auto max-w-4xl" />
		</QueryClientProvider>,
	);
}

describe("Job detail — duration", () => {
	it("says a job that never started waited, in days, rather than calling the wait its duration", () => {
		renderPage(job({ status: "CANCELLED", started_at: null }));
		expect(screen.getByText("Never started · waited 120d 0h")).toBeInTheDocument();
		expect(screen.queryByText(/2880h/)).not.toBeInTheDocument();
	});

	it("shows a job that did start by its span alone", () => {
		renderPage(job({ status: "SUCCESS", started_at: "2026-07-19T10:01:00.000Z" }));
		expect(screen.getByText("120d 0h")).toBeInTheDocument();
		expect(screen.queryByText(/Never started/)).not.toBeInTheDocument();
	});
});
