// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 — the job page's Apply (a successful PLAN → deploy) shows the server's refusal sentence.
//
// `provisionProject` refused by THROWING out of a `"use server"` export, and a production build
// replaced the sentence with a digest, so "Apply" answered a refusal the user could fix with noise.
// The page now calls `tryProvisionProject`, which RETURNS `{ ok: false, error }`. These drive the
// page's own `handleApply` through the Apply control and read what reaches the toast and the router.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryProvisionProject = vi.fn();
const push = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/projects", () => ({
	tryProvisionProject: (...a: unknown[]) => tryProvisionProject(...a),
}));
vi.mock("@/app/server/actions/jobs", () => ({ cancelJob: vi.fn(), rerunJob: vi.fn() }));
vi.mock("next/navigation", () => ({
	useParams: () => ({ org: "acme", id: "job-plan-1" }),
	useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock("sonner", () => ({
	toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a) },
}));
vi.mock("@/hooks/use-job-log-stream", () => ({ useJobLogStream: () => ({ logs: [] }) }));
// A finished PLAN with a project: the one state in which the page offers Apply.
vi.mock("@/lib/query/use-jobs-query", () => ({
	useJobQuery: () => ({
		data: {
			id: "job-plan-1",
			job_type: "PLAN",
			status: "SUCCESS",
			project_id: "proj-1",
			runner_id: null,
			created_at: null,
			started_at: null,
			completed_at: null,
			error_message: null,
			config_snapshot: null,
			execution_metadata: null,
		},
		isPending: false,
		refetch: vi.fn(),
	}),
}));
// The runner picker is its own component's subject: here it is one button that confirms with
// "any runner", which is what the real popover reports.
vi.mock("@/components/runners/runner-select-popover", () => ({
	RunnerSelectPopover: ({
		onConfirm,
	}: {
		trigger: ReactNode;
		onConfirm: (runnerId: string | null) => void;
	}) => (
		<button type="button" onClick={() => onConfirm(null)}>
			Apply
		</button>
	),
}));

import JobDetailPage from "@/app/(private)/[org]/~/jobs/[id]/page";

const NO_ACCOUNT = "Connect a cloud account for this project before deploying.";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Job detail — Apply", () => {
	it("shows the refusal's own sentence, stays on the page, and leaves Apply usable", async () => {
		tryProvisionProject.mockResolvedValue({ ok: false, error: NO_ACCOUNT });
		const user = userEvent.setup();
		render(<JobDetailPage />);

		await user.click(screen.getByRole("button", { name: "Apply" }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalledWith(NO_ACCOUNT));
		expect(tryProvisionProject).toHaveBeenCalledWith("proj-1", "job-plan-1", null);
		expect(toastSuccess).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		// `actionLoading` was released, so the user can try again after fixing the cause.
		expect(screen.getByRole("button", { name: /re-run/i })).toBeEnabled();
	});

	it("goes to the new deploy job when the apply is accepted", async () => {
		tryProvisionProject.mockResolvedValue({ ok: true, jobId: "job-deploy-9" });
		const user = userEvent.setup();
		render(<JobDetailPage />);

		await user.click(screen.getByRole("button", { name: "Apply" }));

		await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/acme/~/jobs/job-deploy-9"));
		expect(toastSuccess).toHaveBeenCalledWith("Deploy job created");
		expect(toastError).not.toHaveBeenCalled();
	});
});
