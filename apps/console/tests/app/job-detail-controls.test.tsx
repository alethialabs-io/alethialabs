// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6818 — the job page around its log:
//
//   · a control the reader may not use is DISABLED WITH ITS REASON, never hidden and never left to
//     be pressed and refused (components/errors/manage-gate.ts);
//   · a read that was refused renders the shared refusal, a read that failed renders an error with
//     a retry, and neither looks like the other (RUBRIC B4);
//   · the log hook is told when the job has finished, which is what lets it open no stream;
//   · a plan with a request to deploy from it shows the request, and a deploy shows its warnings.

import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/** What the page handed the log hook, most recent call last. */
const logHook = vi.hoisted(() => ({ calls: [] as Array<{ jobId: string | null; finished: boolean | undefined }> }));

vi.mock("@/app/server/actions/jobs", () => ({ applyPlan: vi.fn(), cancelJob: vi.fn(), rerunJob: vi.fn() }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme", id: JOB_ID }),
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/hooks/use-job-log-stream", () => ({
	useJobLogStream: (jobId: string | null, _head: unknown, _settled: unknown, options?: { finished?: boolean }) => {
		logHook.calls.push({ jobId, finished: options?.finished });
		return { logs: [], state: null, reconnect: () => {}, complete: true };
	},
}));
vi.mock("@/components/runners/runner-select-popover", () => ({
	RunnerSelectPopover: ({ trigger }: { trigger: ReactNode }) => <>{trigger}</>,
}));

import { JobDetail } from "@/app/(private)/[org]/~/jobs/[id]/job-detail";
import { MANAGE_DENIED_REASON } from "@/components/errors/manage-gate";
import { orpc } from "@/lib/rpc/client";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const ALL = { cancel: true, rerun: true, deploy: true };

/** A job of an environment; each case sets its kind, its status and what the reader may do. */
function job(fields: Record<string, unknown> = {}) {
	return {
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
		approval: null,
		can: ALL,
		...fields,
	};
}

/** A cache with an empty log head, in which a read that already failed is not tried again on mount. */
function newClient(): QueryClient {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity, retryOnMount: false } },
	});
	client.setQueryData(orpc.jobs.logsHead.queryKey({ input: { id: JOB_ID } }), { lines: [], lastId: 0, final: true });
	return client;
}

/** Renders the page over a cache already holding the job, as the server's prefetch leaves it. */
function renderPage({ data }: { data: ReturnType<typeof job> }) {
	const client = newClient();
	client.setQueryData(orpc.jobs.detail.queryKey({ input: { id: JOB_ID } }), data as never);
	return render(
		<QueryClientProvider client={client}>
			<JobDetail jobId={JOB_ID} column="mx-auto max-w-4xl" />
		</QueryClientProvider>,
	);
}

/** Renders the page over a cache in which the job's read has already ended in `error`. */
async function renderFailed(error: Error) {
	const client = newClient();
	await client.prefetchQuery({
		queryKey: orpc.jobs.detail.queryKey({ input: { id: JOB_ID } }),
		queryFn: () => Promise.reject(error),
	});
	return render(
		<QueryClientProvider client={client}>
			<JobDetail jobId={JOB_ID} column="mx-auto max-w-4xl" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	logHook.calls = [];
});

describe("a control the reader may not use is disabled with its reason", () => {
	it("Cancel on a running job", () => {
		renderPage({ data: job({ job_type: "DEPLOY", status: "PROCESSING", can: { ...ALL, cancel: false } }) });
		const cancel = screen.getByRole("button", { name: "Cancel" });
		expect(cancel).toBeDisabled();
		expect(cancel).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
	});

	it("Deploy on a succeeded plan", () => {
		renderPage({ data: job({ can: { ...ALL, deploy: false } }) });
		const deploy = screen.getByRole("button", { name: "Deploy" });
		expect(deploy).toBeDisabled();
		expect(deploy).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
	});

	it("Re-run on a finished job", () => {
		renderPage({ data: job({ can: { ...ALL, rerun: false } }) });
		const rerun = screen.getByRole("button", { name: "Re-run" });
		expect(rerun).toBeDisabled();
		expect(rerun).toHaveAccessibleDescription(MANAGE_DENIED_REASON);
	});

	it("a reader who may use them gets live controls with nothing to explain", () => {
		renderPage({ data: job() });
		for (const name of ["Deploy", "Re-run"]) {
			const control = screen.getByRole("button", { name });
			expect(control).toBeEnabled();
			expect(control).not.toHaveAccessibleDescription();
		}
	});

	it("one denied control does not disable its neighbours", () => {
		renderPage({ data: job({ can: { ...ALL, deploy: false } }) });
		expect(screen.getByRole("button", { name: "Re-run" })).toBeEnabled();
	});

	it("the action that queues a deploy is called Deploy", () => {
		renderPage({ data: job() });
		expect(screen.getByRole("button", { name: "Deploy" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
	});
});

describe("a job that could not be read", () => {
	it("a refusal renders the shared refusal: no retry, not an error", async () => {
		const { container } = await renderFailed(new ORPCError("FORBIDDEN", { defined: true }));
		expect(screen.getByText("You don't have access to this job")).toBeInTheDocument();
		expect(container.querySelector('[data-state="refused"][data-refusal="forbidden"]')).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("a failure renders an error with a retry: not a refusal, not 'not found'", async () => {
		const { container } = await renderFailed(new Error("network"));
		expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load this job");
		expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
		expect(container.querySelector('[data-state="refused"]')).toBeNull();
		expect(screen.queryByText("Job not found.")).toBeNull();
	});
});

describe("the log hook is told whether the job has finished", () => {
	it.each([
		["QUEUED", false],
		["CLAIMED", false],
		["PROCESSING", false],
		["SUCCESS", true],
		["FAILED", true],
		["CANCELLED", true],
	] as const)("%s → finished: %s", (status, finished) => {
		renderPage({ data: job({ job_type: "DEPLOY", status }) });
		expect(logHook.calls.at(-1)).toEqual({ jobId: JOB_ID, finished });
	});
});

describe("what a job's page says beyond its status", () => {
	it("a plan somebody asked to deploy from shows the request as a wait on a person", () => {
		renderPage({
			data: job({
				approval: {
					operation: "deploy",
					status: "pending",
					requested_at: "2026-11-20T10:00:00.000Z",
					expires_at: "2999-01-01T00:00:00.000Z",
					decided_at: null,
					consumed_job_id: null,
				},
			}),
		});
		const notice = document.querySelector('[data-slot="job-approval"]');
		expect(notice).toHaveTextContent("Waiting for approval");
		expect(notice).toHaveTextContent("waiting for a person to approve it");
	});

	it("a plan nobody asked to deploy from shows no request", () => {
		renderPage({ data: job() });
		expect(document.querySelector('[data-slot="job-approval"]')).toBeNull();
	});

	it("a deploy that succeeded with warnings shows them", () => {
		renderPage({
			data: job({
				job_type: "DEPLOY",
				execution_metadata: {
					gitops_status: { mode: "gitops", manifest_warnings: ["service api skipped: no image", "binding db: endpoint unresolved"] },
				},
			}),
		});
		const warnings = screen.getByRole("region", { name: "Deploy warnings" });
		expect(warnings).toHaveTextContent("2 deploy warnings");
		expect(warnings).toHaveTextContent("service api skipped: no image");
		expect(warnings).toHaveTextContent("binding db: endpoint unresolved");
	});

	it("a FAILED deploy shows its warnings too: they are often the cause", () => {
		renderPage({
			data: job({
				job_type: "DEPLOY",
				status: "FAILED",
				error_message: "apply failed",
				execution_metadata: { gitops_status: { manifest_warnings: ["credential facet unsatisfied: registry"] } },
			}),
		});
		expect(screen.getByRole("region", { name: "Deploy warnings" })).toHaveTextContent(
			"credential facet unsatisfied: registry",
		);
	});

	it("a deploy with no warnings shows no warnings block", () => {
		renderPage({ data: job({ job_type: "DEPLOY", execution_metadata: { gitops_status: { mode: "gitops" } } }) });
		expect(screen.queryByRole("region", { name: "Deploy warnings" })).toBeNull();
	});
});
