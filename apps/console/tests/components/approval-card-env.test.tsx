// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The approval card (components/agent/approval-card.tsx) runs the operation against the
// environment the proposal names, falling back to the environment the Elench surface is scoped
// to. Before this it called `planProject(projectId)` / `provisionProject(projectId, planJobId)`
// with no environment at all — so on any non-default environment the user approved a plan or a
// deploy of the DEFAULT one.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/projects", () => ({
	planProject: vi.fn(),
	provisionProject: vi.fn(),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { planProject, provisionProject } from "@/app/server/actions/projects";
import { ApprovalCard } from "@/components/agent/approval-card";
import type { OperationProposal } from "@/lib/ai/operation";
import { useElenchStore } from "@/lib/stores/use-elench-store";

const PROJECT = "2b6c0d1e-7a3c-4b5d-8f0a-1c2d3e4f5a6b";
const PROPOSAL_ENV = "3f7c1a2e-8b4d-4c6e-9a1b-2d3e4f5a6b7c";
const SURFACE_ENV = "4a8d2b3f-9c5e-4d7f-8b2c-3e4f5a6b7c8d";

/** A plan proposal, optionally naming its environment. */
function plan(environmentId?: string): OperationProposal {
	return {
		id: "call-1",
		label: "Plan checkout",
		operation: { operation: "plan_project", projectId: PROJECT, environmentId },
	};
}

/** A deploy proposal, optionally naming its environment. */
function deploy(environmentId?: string): OperationProposal {
	return {
		id: "call-2",
		label: "Deploy checkout",
		operation: {
			operation: "provision_project",
			projectId: PROJECT,
			planJobId: "job-plan",
			environmentId,
		},
	};
}

/** Scope the Elench surface to a project + environment (what the topbar switcher does). */
function scopeSurface(environmentId: string | null) {
	useElenchStore.setState({
		ctx: { kind: "project", projectId: PROJECT, environmentId },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(planProject).mockResolvedValue({ jobId: "job-1" });
	vi.mocked(provisionProject).mockResolvedValue({ jobId: "job-2" });
	useElenchStore.setState({ ctx: { kind: "org" } });
});

describe("ApprovalCard — environment", () => {
	it("plans the environment the proposal names", async () => {
		const onResolve = vi.fn();
		render(<ApprovalCard proposal={plan(PROPOSAL_ENV)} onResolve={onResolve} />);
		await userEvent.click(screen.getByRole("button", { name: /approve & plan/i }));
		await waitFor(() =>
			expect(planProject).toHaveBeenCalledWith(PROJECT, undefined, PROPOSAL_ENV),
		);
		expect(onResolve).toHaveBeenCalledWith(
			expect.objectContaining({ status: "approved", environmentId: PROPOSAL_ENV, jobId: "job-1" }),
		);
	});

	it("deploys the environment the proposal names, keeping the plan job id", async () => {
		render(<ApprovalCard proposal={deploy(PROPOSAL_ENV)} />);
		await userEvent.click(screen.getByRole("button", { name: /approve & deploy/i }));
		await waitFor(() =>
			expect(provisionProject).toHaveBeenCalledWith(PROJECT, "job-plan", undefined, PROPOSAL_ENV),
		);
	});

	it("falls back to the environment the surface is scoped to when the proposal omits it", async () => {
		scopeSurface(SURFACE_ENV);
		render(<ApprovalCard proposal={plan()} />);
		await userEvent.click(screen.getByRole("button", { name: /approve & plan/i }));
		await waitFor(() =>
			expect(planProject).toHaveBeenCalledWith(PROJECT, undefined, SURFACE_ENV),
		);
	});

	it("prefers the proposal's environment over the surface's", async () => {
		scopeSurface(SURFACE_ENV);
		render(<ApprovalCard proposal={deploy(PROPOSAL_ENV)} />);
		await userEvent.click(screen.getByRole("button", { name: /approve & deploy/i }));
		await waitFor(() =>
			expect(provisionProject).toHaveBeenCalledWith(PROJECT, "job-plan", undefined, PROPOSAL_ENV),
		);
	});

	it("reaches the action's own default only when neither the proposal nor the surface knows", async () => {
		scopeSurface(null);
		const onResolve = vi.fn();
		render(<ApprovalCard proposal={plan()} onResolve={onResolve} />);
		await userEvent.click(screen.getByRole("button", { name: /approve & plan/i }));
		await waitFor(() =>
			expect(planProject).toHaveBeenCalledWith(PROJECT, undefined, undefined),
		);
		expect(onResolve).toHaveBeenCalledWith(expect.objectContaining({ environmentId: null }));
	});
});
