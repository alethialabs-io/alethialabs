// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `provision_job_type` has thirteen values. AUDIT, DETECT_DRIFT and PROBE_CLUSTER all exist, all
// have runner-side executors, and two of them already run on a SCHEDULE — and the canvas offered
// exactly two jobs: Deploy and Destroy. These tests pin the Run menu that closes that gap, and the
// rule that matters most: when a job can't be queued, the REASON is shown, never swallowed.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunMenu } from "@/components/design-project/canvas/run-menu";

const queueEnvironmentAudit = vi.fn();
const queueClusterProbe = vi.fn();
const planProject = vi.fn();
const queueDriftDetection = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/canvas-jobs", () => ({
	queueEnvironmentAudit: (...a: unknown[]) => queueEnvironmentAudit(...a),
	queueClusterProbe: (...a: unknown[]) => queueClusterProbe(...a),
}));
vi.mock("@/app/server/actions/projects", () => ({
	planProject: (...a: unknown[]) => planProject(...a),
	queueDriftDetection: (...a: unknown[]) => queueDriftDetection(...a),
}));
vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
	},
}));

const PROJECT = "proj-1";
const ENV = "env-1";

async function openMenu() {
	const user = userEvent.setup();
	render(<RunMenu projectId={PROJECT} environmentId={ENV} />);
	await user.click(screen.getByRole("button", { name: /run/i }));
	return user;
}

beforeEach(() => {
	vi.clearAllMocks();
	queueEnvironmentAudit.mockResolvedValue({ jobId: "job-1" });
	queueClusterProbe.mockResolvedValue({ jobId: "job-2" });
	planProject.mockResolvedValue({ jobId: "job-3" });
	queueDriftDetection.mockResolvedValue({ jobId: "job-4" });
});

describe("every job the platform can run is reachable from the board", () => {
	it("offers Plan, Audit, Detect drift and Probe cluster", async () => {
		await openMenu();

		expect(screen.getByText("Plan")).toBeInTheDocument();
		expect(screen.getByText("Audit")).toBeInTheDocument();
		expect(screen.getByText("Detect drift")).toBeInTheDocument();
		expect(screen.getByText("Probe cluster")).toBeInTheDocument();
	});

	it("queues an AUDIT against this environment", async () => {
		const user = await openMenu();
		await user.click(screen.getByText("Audit"));

		expect(queueEnvironmentAudit).toHaveBeenCalledWith(PROJECT, ENV);
		expect(toastSuccess).toHaveBeenCalledWith("Audit queued");
	});

	it("queues a PROBE_CLUSTER", async () => {
		const user = await openMenu();
		await user.click(screen.getByText("Probe cluster"));

		expect(queueClusterProbe).toHaveBeenCalledWith(PROJECT, ENV);
	});

	it("queues a DETECT_DRIFT", async () => {
		const user = await openMenu();
		await user.click(screen.getByText("Detect drift"));

		expect(queueDriftDetection).toHaveBeenCalledWith(PROJECT, ENV);
	});

	it("queues a PLAN scoped to the environment on the board, not the project's default", async () => {
		const user = await openMenu();
		await user.click(screen.getByText("Plan"));

		expect(planProject).toHaveBeenCalledWith(PROJECT, null, ENV);
	});
});

// The actions throw for HONEST reasons — "run a plan first", "already running", "never deployed".
// Those messages are the answer, and swallowing them would leave the user staring at a menu that
// silently did nothing.
describe("a refusal explains itself", () => {
	it("surfaces why an audit can't run yet", async () => {
		queueEnvironmentAudit.mockRejectedValue(
			new Error("Run a plan first — there's nothing to audit yet."),
		);
		const user = await openMenu();
		await user.click(screen.getByText("Audit"));

		expect(toastError).toHaveBeenCalledWith(
			"Run a plan first — there's nothing to audit yet.",
		);
		expect(toastSuccess).not.toHaveBeenCalled();
	});

	it("surfaces why a probe can't run on an undeployed environment", async () => {
		queueClusterProbe.mockRejectedValue(
			new Error("This environment has never been deployed, so there's no cluster to probe."),
		);
		const user = await openMenu();
		await user.click(screen.getByText("Probe cluster"));

		expect(toastError).toHaveBeenCalledWith(
			"This environment has never been deployed, so there's no cluster to probe.",
		);
	});

	it("surfaces a duplicate-job refusal rather than queueing a second one", async () => {
		queueClusterProbe.mockRejectedValue(
			new Error("A cluster probe is already running for this environment."),
		);
		const user = await openMenu();
		await user.click(screen.getByText("Probe cluster"));

		expect(toastError).toHaveBeenCalledWith(
			"A cluster probe is already running for this environment.",
		);
	});
});

describe("the caller is told when a job lands", () => {
	it("notifies so the activity rail and node statuses refresh immediately", async () => {
		const onQueued = vi.fn();
		const user = userEvent.setup();
		render(
			<RunMenu projectId={PROJECT} environmentId={ENV} onQueued={onQueued} />,
		);
		await user.click(screen.getByRole("button", { name: /run/i }));
		await user.click(screen.getByText("Audit"));

		expect(onQueued).toHaveBeenCalled();
	});

	it("does not notify when the job was refused", async () => {
		queueEnvironmentAudit.mockRejectedValue(new Error("nope"));
		const onQueued = vi.fn();
		const user = userEvent.setup();
		render(
			<RunMenu projectId={PROJECT} environmentId={ENV} onQueued={onQueued} />,
		);
		await user.click(screen.getByRole("button", { name: /run/i }));
		await user.click(screen.getByText("Audit"));

		expect(onQueued).not.toHaveBeenCalled();
	});
});
