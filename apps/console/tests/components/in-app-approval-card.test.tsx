// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The in-product agent's approval card (components/agent/approval/in-app-approval-card.tsx): it shows
// the plan job's own facts and digest, Approve is a person's decision through the one decision path,
// and only then does the requester's click start the job. A refused decision (the org requires a
// different approver) starts nothing.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render as rtlRender, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/approvals", () => ({ decideApplyApproval: vi.fn() }));
vi.mock("@/lib/agent/approval-actions", () => ({ readInAppApproval: vi.fn(), startInAppApproval: vi.fn() }));

import { decideApplyApproval } from "@/app/server/actions/approvals";
import { InAppApprovalCard } from "@/components/agent/approval/in-app-approval-card";
import { type InAppApprovalDetail, readInAppApproval, startInAppApproval } from "@/lib/agent/approval-actions";
import { TOPIC_KEYS } from "@/lib/query/topics";
import { useArtifactStore } from "@/lib/stores/use-artifact-store";

const APPROVAL = "00000000-0000-4000-8000-000000000050";
const PROJECT = "00000000-0000-4000-8000-000000000010";
const ENV = "00000000-0000-4000-8000-000000000020";
const PLAN = "00000000-0000-4000-8000-000000000030";
const JOB = "00000000-0000-4000-8000-000000000040";

const REQUEST = {
	status: "requested",
	approval_id: APPROVAL,
	approval_status: "pending",
	operation: "deploy",
	project_id: PROJECT,
	environment_id: ENV,
	plan_job_id: PLAN,
	digest_prefix: "9f3c1a7e",
	expires_at: new Date(Date.now() + 50 * 60_000).toISOString(),
} as const;

/** The card's read of the approval, with `status` and whether the reader's assistant asked. */
function detail(status: InAppApprovalDetail["approval"]["status"], requestedByReader = true): InAppApprovalDetail {
	return {
		approval: {
			id: APPROVAL,
			status,
			operation: "deploy",
			project_id: PROJECT,
			environment_id: ENV,
			plan_job_id: PLAN,
			digest_prefix: "9f3c1a7e",
			expires_at: REQUEST.expires_at,
			decided_at: null,
			decision_reason: null,
			consumed_job_id: status === "consumed" ? JOB : null,
		},
		plan: {
			projectName: "acme",
			environmentName: "staging",
			add: 14,
			change: 2,
			destroy: 0,
			monthly: 61.2,
			verifyVerdict: "pass",
		},
		reason: "initial staging cluster",
		requestedByReader,
	};
}

let queryClient: QueryClient;

/** Renders `ui` under a fresh QueryClient, as the console shell provides one. */
function render(ui: ReactElement) {
	return rtlRender(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
	queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	vi.clearAllMocks();
	vi.mocked(readInAppApproval).mockResolvedValue({ ok: true, data: detail("pending") });
	vi.mocked(startInAppApproval).mockResolvedValue({ ok: true, data: { jobId: JOB } });
	useArtifactStore.setState({ artifact: null });
});

describe("InAppApprovalCard", () => {
	it("shows the plan job's facts, the digest and the agent's note as untrusted", async () => {
		render(<InAppApprovalCard request={REQUEST} />);
		expect(await screen.findByText(/acme \/ staging/)).toBeInTheDocument();
		expect(screen.getByText(/digest 9f3c1a7e/)).toBeInTheDocument();
		expect(screen.getByText("14 to add")).toBeInTheDocument();
		expect(screen.getByText(/untrusted/i)).toBeInTheDocument();
		expect(screen.getByText("initial staging cluster")).toBeInTheDocument();
	});

	it("approve is a person's decision, and only then does the requester's click start the job", async () => {
		vi.mocked(decideApplyApproval).mockResolvedValue({ ok: true, data: detail("approved").approval });
		render(<InAppApprovalCard request={REQUEST} />);
		await screen.findByText(/acme \/ staging/);
		await userEvent.click(screen.getByRole("button", { name: /approve and deploy/i }));
		await waitFor(() => expect(startInAppApproval).toHaveBeenCalledWith({ approvalId: APPROVAL }));
		expect(decideApplyApproval).toHaveBeenCalledWith({
			approvalId: APPROVAL,
			decision: "approve",
			confirmEnvironmentName: null,
		});
		expect(vi.mocked(decideApplyApproval).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(startInAppApproval).mock.invocationCallOrder[0] ?? 0,
		);
		expect(useArtifactStore.getState().artifact).toEqual({ projectId: PROJECT, jobId: JOB });
	});

	it("a refused decision (a different approver required) starts nothing and says why", async () => {
		const message = "This organization requires a different person to approve a request than the one it was made for.";
		vi.mocked(decideApplyApproval).mockResolvedValue({ ok: false, error: { kind: "conflict", message } });
		render(<InAppApprovalCard request={REQUEST} />);
		await screen.findByText(/acme \/ staging/);
		await userEvent.click(screen.getByRole("button", { name: /approve and deploy/i }));
		expect(await screen.findByText(message)).toBeInTheDocument();
		expect(startInAppApproval).not.toHaveBeenCalled();
	});

	it("an approval decided by another person is started by the requester's click", async () => {
		vi.mocked(readInAppApproval).mockResolvedValue({ ok: true, data: detail("approved") });
		render(<InAppApprovalCard request={REQUEST} />);
		await userEvent.click(await screen.findByRole("button", { name: /start deploy/i }));
		await waitFor(() => expect(startInAppApproval).toHaveBeenCalledWith({ approvalId: APPROVAL }));
	});

	it("a reader who is not the requester cannot start it", async () => {
		vi.mocked(readInAppApproval).mockResolvedValue({ ok: true, data: detail("approved", false) });
		render(<InAppApprovalCard request={REQUEST} />);
		expect(await screen.findByText(/the person who asked the assistant starts it/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /start deploy/i })).toBeNull();
	});

	it("a used approval links to its job", async () => {
		vi.mocked(readInAppApproval).mockResolvedValue({ ok: true, data: detail("consumed") });
		render(<InAppApprovalCard request={REQUEST} />);
		await userEvent.click(await screen.findByRole("button", { name: /view logs/i }));
		expect(useArtifactStore.getState().artifact).toEqual({ projectId: PROJECT, jobId: JOB });
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
	});
});

describe("InAppApprovalCard — live without a poll", () => {
	it("a teammate's decision reaches the card through the environments topic", async () => {
		render(<InAppApprovalCard request={REQUEST} />);
		expect(await screen.findByRole("button", { name: /approve and deploy/i })).toBeInTheDocument();
		vi.mocked(readInAppApproval).mockResolvedValue({ ok: true, data: detail("approved") });
		// What the change stream does on an `environments` hint (lib/realtime/client).
		await act(async () => {
			for (const key of TOPIC_KEYS.environments()) await queryClient.invalidateQueries({ queryKey: key });
		});
		expect(await screen.findByRole("button", { name: /start deploy/i })).toBeInTheDocument();
	});

	it("re-reads once when the request's window closes", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const soon = { ...REQUEST, expires_at: new Date(Date.now() + 5_000).toISOString() };
			render(<InAppApprovalCard request={soon} />);
			await screen.findByText(/acme \/ staging/);
			const reads = vi.mocked(readInAppApproval).mock.calls.length;
			vi.mocked(readInAppApproval).mockResolvedValue({ ok: true, data: detail("expired") });
			await act(async () => {
				await vi.advanceTimersByTimeAsync(7_000);
			});
			await waitFor(() => expect(vi.mocked(readInAppApproval).mock.calls.length).toBe(reads + 1));
			expect(await screen.findByText(/expired before it was decided/i)).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});
});
