// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The job page's actions (Apply a successful PLAN, Re-run) through the mutation contract (#6121,
// ADR 0005 D4): each is a `defineAction` returning `ActionResult`, driven by `useActionMutation`.
//
// #5445 still holds: a refusal reaches the toast as the server's own sentence (a `"use server"`
// throw used to become a digest in production), the page stays put, and the action can be pressed
// again. What #6121 adds: the button is disabled while its action is in flight (the double-submit
// guard), Apply sends only the plan job — the server reads the project and environment from it —
// and a settled action invalidates the jobs reads.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const applyPlan = vi.fn();
const rerunJob = vi.fn();
const push = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/jobs", () => ({
	applyPlan: (...a: unknown[]) => applyPlan(...a),
	cancelJob: vi.fn(),
	rerunJob: (...a: unknown[]) => rerunJob(...a),
}));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme", id: JOB_ID }),
	useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));
vi.mock("@/hooks/use-job-log-stream", () => ({ useJobLogStream: () => ({ logs: [] }) }));
// The runner picker is its own component's subject: here it is one button that confirms with
// "any runner", which is what the real popover reports.
vi.mock("@/components/runners/runner-select-popover", () => ({
	RunnerSelectPopover: ({
		onConfirm,
		disabled,
	}: {
		trigger: ReactNode;
		disabled?: boolean;
		onConfirm: (runnerId: string | null) => void;
	}) => (
		<button type="button" disabled={disabled} onClick={() => onConfirm(null)}>
			Apply
		</button>
	),
}));

import { JobDetail } from "@/app/(private)/[org]/~/jobs/[id]/job-detail";
import { orpc } from "@/lib/rpc/client";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const NO_ACCOUNT = "Connect a cloud account for this project before deploying.";

/** A finished PLAN of an environment: the one state in which the page offers Apply and Re-run. */
const PLAN = {
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
function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(orpc.jobs.detail.queryKey({ input: { id: JOB_ID } }), PLAN as never);
	client.setQueryData(orpc.jobs.logsHead.queryKey({ input: { id: JOB_ID } }), { lines: [], lastId: 0 });
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<JobDetail jobId={JOB_ID} column="mx-auto max-w-4xl" />
		</QueryClientProvider>,
	);
	return { invalidate };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Job detail — Apply", () => {
	it("shows the refusal's own sentence, stays on the page, and leaves Apply usable", async () => {
		applyPlan.mockResolvedValue({ ok: false, error: { kind: "conflict", message: NO_ACCOUNT } });
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Apply" }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(NO_ACCOUNT));
		// The plan job and the runner only: the server reads the project and the environment from it.
		expect(applyPlan).toHaveBeenCalledWith({ planJobId: JOB_ID, runnerId: null });
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled());
	});

	it("goes to the new deploy job when the apply is accepted, and refreshes the jobs reads", async () => {
		applyPlan.mockResolvedValue({ ok: true, data: { jobId: "job-deploy-9" } });
		const user = userEvent.setup();
		const { invalidate } = renderPage();

		await user.click(screen.getByRole("button", { name: "Apply" }));

		await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/acme/~/jobs/job-deploy-9"));
		expect(toastSuccess).toHaveBeenCalledWith("Deploy job created");
		expect(toastError).not.toHaveBeenCalled();
		await vi.waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({ queryKey: orpc.jobs.key() }),
		);
	});

	it("cannot be pressed twice while the apply is in flight", async () => {
		let settle: (v: unknown) => void = () => {};
		applyPlan.mockReturnValue(new Promise((r) => (settle = r)));
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: "Apply" }));
		await vi.waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled());
		expect(screen.getByRole("button", { name: /re-run/i })).toBeDisabled();
		settle({ ok: true, data: { jobId: "job-deploy-9" } });
		expect(applyPlan).toHaveBeenCalledTimes(1);
	});
});

describe("Job detail — Re-run", () => {
	it("re-queues the job and goes to the new one", async () => {
		rerunJob.mockResolvedValue({ ok: true, data: { id: "job-rerun-2" } });
		const user = userEvent.setup();
		renderPage();

		await user.click(screen.getByRole("button", { name: /re-run/i }));

		expect(rerunJob).toHaveBeenCalledWith({ jobId: JOB_ID });
		await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/acme/~/jobs/job-rerun-2"));
		expect(toastSuccess).toHaveBeenCalledWith("Job re-queued");
	});
});
