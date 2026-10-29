// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6350 — the job page's skeleton must be the page's shape (RUBRIC B2), and it was wrong twice over:
//
// 1. A navigation to a job never painted it. `~/jobs/loading.tsx` wrapped every segment under
//    `~/jobs`, `[id]` included, so the LIST skeleton was the first boundary on the way to a job. The
//    list now lives in the `(list)` route group, whose boundary wraps the list alone.
// 2. Its strip under the log drew three disclosure rows while the page drew one to three, depending
//    on which payloads the job had. The page now draws all three for every job, and the skeleton
//    draws one row per title from the same list (`JOB_DETAIL_SECTIONS`).
//
// The log pane between them is `flex-1`, so its edges are exactly the header above it and that strip
// below it; jsdom has no layout, so what is pinned here is the STRUCTURE that sets those edges.

import fs from "node:fs";
import path from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/jobs", () => ({ applyPlan: vi.fn(), cancelJob: vi.fn(), rerunJob: vi.fn() }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme", id: JOB_ID }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-job-log-stream", () => ({ useJobLogStream: () => ({ logs: [] }) }));
vi.mock("@/components/runners/runner-select-popover", () => ({ RunnerSelectPopover: () => null }));

import { JOB_DETAIL_SECTIONS } from "@/app/(private)/[org]/~/jobs/[id]/detail-column";
import { JobDetail } from "@/app/(private)/[org]/~/jobs/[id]/job-detail";
import JobDetailLoading from "@/app/(private)/[org]/~/jobs/[id]/loading";
import { orpc } from "@/lib/rpc/client";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

/** A finished job with NEITHER payload — the shape that used to draw one row under the log. */
const BARE_JOB = {
	id: JOB_ID,
	job_type: "PLAN",
	status: "SUCCESS",
	project_id: "proj-1",
	environment_id: "env-1",
	project_name: "payments",
	project_slug: "payments",
	environment_name: "staging",
	runner_id: null,
	created_at: null,
	started_at: null,
	completed_at: null,
	error_message: null,
	config_snapshot: null,
	execution_metadata: null,
};

/** Renders the page over a cache already holding what the server prefetched. */
function renderPage(job: Record<string, unknown>) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(orpc.jobs.detail.queryKey({ input: { id: JOB_ID } }), job as never);
	client.setQueryData(orpc.jobs.logsHead.queryKey({ input: { id: JOB_ID } }), { lines: [], lastId: 0 });
	return render(
		<QueryClientProvider client={client}>
			<JobDetail jobId={JOB_ID} column="mx-auto max-w-4xl" />
		</QueryClientProvider>,
	);
}

/** The level-2 headings a container draws, as text. */
function headingTexts(container: HTMLElement): string[] {
	return within(container)
		.queryAllByRole("heading", { level: 2, hidden: true })
		.map((h) => h.textContent ?? "");
}

describe("job detail skeleton — the strip under the log", () => {
	it("the page draws every detail section for a job with no payloads, in the skeleton's order", () => {
		const { container } = renderPage(BARE_JOB);
		expect(headingTexts(container)).toEqual([...JOB_DETAIL_SECTIONS]);
	});

	it("the page draws the same sections for a job with both payloads", () => {
		const { container } = renderPage({
			...BARE_JOB,
			config_snapshot: { region: "eu-west-1" },
			execution_metadata: { tofu_version: "1.8.0" },
		});
		expect(headingTexts(container)).toEqual([...JOB_DETAIL_SECTIONS]);
	});

	it("an absent payload, opened, says it is absent rather than showing an empty block", async () => {
		const user = userEvent.setup();
		renderPage(BARE_JOB);
		await user.click(screen.getByRole("button", { name: "Config snapshot" }));
		expect(await screen.findByText("No configuration snapshot was recorded for this job.")).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: "Execution metadata" }));
		expect(await screen.findByText("No execution metadata was recorded for this job.")).toBeInTheDocument();
	});

	it("the skeleton draws exactly one row per section, each with the page's heading", () => {
		const { container } = render(<JobDetailLoading />);
		const rows = container.querySelectorAll('[data-slot="job-detail-section-skeleton"]');
		expect(rows).toHaveLength(JOB_DETAIL_SECTIONS.length);
		// The page's own `SectionHeading`, so the row is as tall as the disclosure that replaces it.
		for (const row of rows) expect(row.querySelector('[data-slot="section-heading"]')).not.toBeNull();
		expect(headingTexts(container)).toEqual([...JOB_DETAIL_SECTIONS]);
	});
});

describe("job detail skeleton — the header above the log", () => {
	it("reserves the outcome line a finished job states under its status", () => {
		const { container } = render(<JobDetailLoading />);
		const outcome = container.querySelector('[data-slot="job-outcome-skeleton"]');
		expect(outcome).not.toBeNull();
		// Inside the header, above the log — the line moves the log's top edge.
		expect(outcome?.className).toContain("mt-3");
		expect(outcome?.className).toContain("text-ui-md");
		renderPage(BARE_JOB);
		expect(screen.getByText("Job completed successfully.", { selector: "p" })).toBeInTheDocument();
	});
});

describe("job detail skeleton — which skeleton a navigation paints", () => {
	const JOBS = path.resolve(__dirname, "../../app/(private)/[org]/~/jobs");

	it("no loading boundary sits directly in ~/jobs, where it would wrap the job route too", () => {
		expect(fs.existsSync(path.join(JOBS, "loading.tsx"))).toBe(false);
	});

	it("the list's skeleton and page share the (list) group, and the job route has its own", () => {
		expect(fs.existsSync(path.join(JOBS, "(list)", "loading.tsx"))).toBe(true);
		expect(fs.existsSync(path.join(JOBS, "(list)", "page.tsx"))).toBe(true);
		expect(fs.existsSync(path.join(JOBS, "[id]", "loading.tsx"))).toBe(true);
	});
});
