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
const tryPlanProject = vi.fn();
const tryQueueDriftDetection = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

vi.mock("@/app/server/actions/canvas-jobs", () => ({
  queueEnvironmentAudit: (...a: unknown[]) => queueEnvironmentAudit(...a),
  queueClusterProbe: (...a: unknown[]) => queueClusterProbe(...a),
}));
vi.mock("@/app/server/actions/projects", () => ({
  tryPlanProject: (...a: unknown[]) => tryPlanProject(...a),
  tryQueueDriftDetection: (...a: unknown[]) => tryQueueDriftDetection(...a),
}));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

const PROJECT = "proj-1";
const ENV = "env-1";

// base-ui menus open on keyboard/pointer interaction. jsdom can't drive base-ui's pointer-open path
// (it dispatches no working PointerEvent to Floating UI), so open via keyboard — the menu items then
// respond to click as usual. Gesture only; every behavioral assertion below is unchanged.
async function openTrigger(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole("button", { name: /run/i });
  trigger.focus();
  await user.keyboard("{Enter}");
}

async function openMenu() {
  const user = userEvent.setup();
  render(<RunMenu projectId={PROJECT} environmentId={ENV} />);
  await openTrigger(user);
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  queueEnvironmentAudit.mockResolvedValue({ jobId: "job-1" });
  queueClusterProbe.mockResolvedValue({ jobId: "job-2" });
  tryPlanProject.mockResolvedValue({ ok: true, jobId: "job-3" });
  tryQueueDriftDetection.mockResolvedValue({ ok: true, jobId: "job-4" });
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

    expect(tryQueueDriftDetection).toHaveBeenCalledWith(PROJECT, ENV);
  });

  it("queues a PLAN scoped to the environment on the board, not the project's default", async () => {
    const user = await openMenu();
    await user.click(screen.getByText("Plan"));

    expect(tryPlanProject).toHaveBeenCalledWith(PROJECT, null, ENV);
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
      new Error(
        "This environment has never been deployed, so there's no cluster to probe.",
      ),
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

// #5445 — Plan and Detect drift RETURN their refusals. Thrown (as they were), a production build
// replaced the sentence with a digest before this menu's toast could show it — the "honest reasons"
// above reached the user as noise. Against the old menu these fail: it toasted "Plan queued".
describe("a RETURNED refusal explains itself too", () => {
  it("toasts the gate's sentence for a refused plan, and does not say it was queued", async () => {
    const reason =
      "No cloud account linked to this project. Go to Connectors to connect.";
    tryPlanProject.mockResolvedValue({ ok: false, error: reason });
    const onQueued = vi.fn();
    const user = userEvent.setup();
    render(
      <RunMenu projectId={PROJECT} environmentId={ENV} onQueued={onQueued} />,
    );
    await openTrigger(user);
    await user.click(screen.getByText("Plan"));

    expect(toastError).toHaveBeenCalledWith(reason);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("toasts the in-flight conflict for a refused drift check", async () => {
    const reason =
      "Environment is not in a valid state for this operation — a job may already be in progress.";
    tryQueueDriftDetection.mockResolvedValue({ ok: false, error: reason });
    const user = await openMenu();
    await user.click(screen.getByText("Detect drift"));

    expect(toastError).toHaveBeenCalledWith(reason);
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("the caller is told when a job lands", () => {
  it("notifies so the activity rail and node statuses refresh immediately", async () => {
    const onQueued = vi.fn();
    const user = userEvent.setup();
    render(
      <RunMenu projectId={PROJECT} environmentId={ENV} onQueued={onQueued} />,
    );
    await openTrigger(user);
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
    await openTrigger(user);
    await user.click(screen.getByText("Audit"));

    expect(onQueued).not.toHaveBeenCalled();
  });
});
