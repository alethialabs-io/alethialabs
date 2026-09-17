// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4644 ON THE CREATE SCREEN — the headline scenario in the issue: "a user types a project name
// that is already taken, hits Create, and gets a meaningless generic error instead of 'a project
// with this name already exists' — the create simply appears not to work."
//
// This is the console's ONLY create path. The action always wrote that sentence; a `throw` out of a
// `"use server"` export is redacted to an opaque `digest` in a production build, so it never
// arrived. The remedy is `tryCreateProject` RETURNING it — and a returned refusal is worse than a
// thrown one if the caller does not read it, because then nothing at all is shown. That is the
// regression guarded here, and neither a type-check nor the action suite can see it.
//
// The e2e spec (`e2e/flows/projects.negative.spec.ts`) asserts only that an error toast EXISTS —
// it cannot assert the sentence, which is exactly what #4644 records. These assertions are the
// half that spec cannot reach.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tryCreateProject = vi.fn();
const toastError = vi.fn();
const push = vi.fn();

vi.mock("@/app/server/actions/projects", () => ({
  tryCreateProject: (...args: unknown[]) => tryCreateProject(...args),
}));
vi.mock("@/app/server/actions/scanner", () => ({ getScanProposal: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
// The cloud rail, the region list and the placement matrix are other screens' subjects; this file
// is about one field and one button. `scratch: "blank"` already means no cloud is required.
vi.mock("@/components/cloud-connect/use-cloud-connect", () => ({
  useCloudConnect: () => ({
    openConnect: vi.fn(),
    connectingSlug: null,
    sheets: null,
  }),
}));
vi.mock("@/components/create-project/cloud-picker", () => ({
  CloudPicker: () => null,
}));
vi.mock("@/components/create-project/region-select", () => ({
  RegionSelect: () => null,
}));
vi.mock("@/components/create-project/environment-placement", () => ({
  EnvironmentPlacement: () => null,
}));

import { ConfigureProject } from "@/components/create-project/configure-project";

const TAKEN =
  'A project named "Taken" already exists in this organization. ' +
  "Project names are unique per organization and are compared without regard to case.";

function renderIt() {
  return render(
    <ConfigureProject
      orgSlug="acme"
      source={{ kind: "scratch", scratch: "blank" }}
      canManage
      integrations={[]}
      awsSetup={null}
      gcpSetup={null}
      azureSetup={null}
      platformConfigured={{}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConfigureProject — a create the server refuses", () => {
  it("renders the SERVER's sentence beside the name field and stays on the form", async () => {
    tryCreateProject.mockResolvedValue({ ok: false, error: TAKEN });
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Taken");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    // THE DEFECT, INVERTED. Before #4644 this was a digest; before the refusal was rendered at all
    // it was nothing.
    expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
    expect(toastError).toHaveBeenCalledWith(TAKEN);
    // The field carries the reason programmatically too — a screen-reader user is told which
    // control the sentence is about.
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(field).toHaveAccessibleDescription(TAKEN);
    // A refusal must NOT navigate. "Still on the form" and "created but the redirect failed" differ
    // by exactly one row, which is why the e2e spec counts rows; here the action simply never
    // succeeded.
    expect(push).not.toHaveBeenCalled();
    // …and the name is still there to edit.
    expect(field).toHaveValue("Taken");
  });

  it("refuses a name the schema rejects WITHOUT a round trip, in the server's words", async () => {
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "!!!");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    // Same sentence `projectNameProblem` returns for the same input — the client answer and the
    // server answer must be the SAME rule, not a second opinion.
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter at least one letter or number",
    );
    expect(tryCreateProject).not.toHaveBeenCalled();
  });

  it("navigates to the new project's canvas when the create succeeds", async () => {
    tryCreateProject.mockResolvedValue({
      ok: true,
      project: { id: "p1", slug: "taken-2" },
    });
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Fresh");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(push.mock.calls[0][0]).toContain("taken-2");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the generic sentence for an UNEXPECTED failure — a defect is not advice", async () => {
    tryCreateProject.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Fresh");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalledWith(TAKEN);
  });
});
