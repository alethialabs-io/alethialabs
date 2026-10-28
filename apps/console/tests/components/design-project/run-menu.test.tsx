// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `provision_job_type` has thirteen values. AUDIT, DETECT_DRIFT and PROBE_CLUSTER all exist, all
// have runner-side executors, and two of them already run on a SCHEDULE — and the canvas offered
// exactly two jobs: Deploy and Destroy. These tests pin the Run menu that closes that gap, and the
// rule that matters most: when a job can't be queued, the REASON is shown, never swallowed.
//
// #6119: every item is on the mutation contract. Each action answers an `ActionResult`; a refusal is
// a `conflict` whose sentence is shown verbatim (never a digest, #5445/#5454), a queued job
// invalidates the environment's status and job history, and the trigger is held while one is queued.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FakeCall, FakeHandler } from "@/tests/helpers/fake-orpc";

const queueEnvironmentAudit = vi.fn();
const queueClusterProbe = vi.fn();
const planEnvironment = vi.fn();
const detectDrift = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const h = vi.hoisted(() => ({
  handlers: {} as Record<string, FakeHandler>,
  calls: [] as FakeCall[],
}));

vi.mock("@/app/server/actions/canvas-jobs", () => ({
  queueEnvironmentAuditAction: (...a: unknown[]) => queueEnvironmentAudit(...a),
  queueClusterProbeAction: (...a: unknown[]) => queueClusterProbe(...a),
}));
vi.mock("@/app/server/actions/canvas-writes", () => ({
  planEnvironmentAction: (...a: unknown[]) => planEnvironment(...a),
  detectDriftAction: (...a: unknown[]) => detectDrift(...a),
}));
vi.mock("@/lib/rpc/client", async () => {
  const { fakeOrpc } = await import("@/tests/helpers/fake-orpc");
  return { orpc: fakeOrpc(h.handlers, h.calls).orpc };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}));

import { RunMenu } from "@/components/design-project/canvas/run-menu";

const PROJECT = "proj-1";
const ENV = "env-1";
const TARGET = { projectId: PROJECT, environmentId: ENV };

/** A refused job, as the action answers it. */
const refused = (message: string) => ({ ok: false, error: { kind: "conflict", message } });

let client: QueryClient;

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
  render(
    <QueryClientProvider client={client}>
      <RunMenu projectId={PROJECT} environmentId={ENV} />
    </QueryClientProvider>,
  );
  await openTrigger(user);
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queueEnvironmentAudit.mockResolvedValue({ ok: true, data: { jobId: "job-1" } });
  queueClusterProbe.mockResolvedValue({ ok: true, data: { jobId: "job-2" } });
  planEnvironment.mockResolvedValue({ ok: true, data: { jobId: "job-3" } });
  detectDrift.mockResolvedValue({ ok: true, data: { jobId: "job-4" } });
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

    await waitFor(() => expect(queueEnvironmentAudit).toHaveBeenCalledWith(TARGET));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Audit queued"));
  });

  it("queues a PROBE_CLUSTER", async () => {
    const user = await openMenu();
    await user.click(screen.getByText("Probe cluster"));

    await waitFor(() => expect(queueClusterProbe).toHaveBeenCalledWith(TARGET));
  });

  it("queues a DETECT_DRIFT", async () => {
    const user = await openMenu();
    await user.click(screen.getByText("Detect drift"));

    await waitFor(() => expect(detectDrift).toHaveBeenCalledWith(TARGET));
  });

  it("queues a PLAN scoped to the environment on the board, not the project's default", async () => {
    const user = await openMenu();
    await user.click(screen.getByText("Plan"));

    await waitFor(() => expect(planEnvironment).toHaveBeenCalledWith(TARGET));
  });
});

// The actions refuse for HONEST reasons — "run a plan first", "already running", "never deployed".
// Those messages are the answer, and swallowing them would leave the user staring at a menu that
// silently did nothing. Each arrives as a `conflict` and is toasted verbatim.
describe("a refusal explains itself", () => {
  it.each([
    ["Audit", queueEnvironmentAudit, "Run a plan first — there's nothing to audit yet."],
    [
      "Probe cluster",
      queueClusterProbe,
      "This environment has never been deployed, so there's no cluster to probe.",
    ],
    ["Probe cluster", queueClusterProbe, "A cluster probe is already running for this environment."],
    ["Plan", planEnvironment, "No cloud account linked to this project. Go to Connectors to connect."],
    [
      "Detect drift",
      detectDrift,
      "Environment is not in a valid state for this operation — a job may already be in progress.",
    ],
  ])("%s: toasts the refusal's sentence and does not say it was queued", async (item, action, reason) => {
    action.mockResolvedValue(refused(reason));
    const user = await openMenu();
    await user.click(screen.getByText(item));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(reason));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("does not say it was queued, nor leak the text, when the action fails unexpectedly", async () => {
    queueClusterProbe.mockResolvedValue({ ok: false, error: { kind: "unexpected", ref: "ab12cd34" } });
    const user = await openMenu();
    await user.click(screen.getByText("Probe cluster"));

    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Something went wrong on our side. Reference: ab12cd34"),
    );
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

describe("a queued job shows on the board at once", () => {
  it("invalidates the environment's job history and status, and nothing else", async () => {
    const jobs = [["canvas", "environmentJobs"], { input: TARGET, type: "query" }];
    const status = [["canvas", "environmentStatus"], { input: TARGET, type: "query" }];
    const other = [["canvas", "addons"], { input: TARGET, type: "query" }];
    for (const key of [jobs, status, other]) client.setQueryData(key, {});
    const user = await openMenu();
    await user.click(screen.getByText("Audit"));

    await waitFor(() => expect(client.getQueryState(jobs)?.isInvalidated).toBe(true));
    expect(client.getQueryState(status)?.isInvalidated).toBe(true);
    expect(client.getQueryState(other)?.isInvalidated).toBe(false);
  });

  it("holds the trigger while a job is being queued — the double-submit guard", async () => {
    let settle: (v: unknown) => void = () => {};
    queueEnvironmentAudit.mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const user = await openMenu();
    await user.click(screen.getByText("Audit"));

    await waitFor(() => expect(screen.getByRole("button", { name: /run/i })).toBeDisabled());
    // Press again — the trigger, then the item if the menu opened at all — while the first is in flight.
    await user.click(screen.getByRole("button", { name: /run/i }));
    await openTrigger(user);
    const again = screen.queryByText("Audit");
    if (again) await user.click(again);
    expect(queueEnvironmentAudit).toHaveBeenCalledTimes(1);
    settle({ ok: true, data: { jobId: "job-1" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /run/i })).toBeEnabled());
  });
});
