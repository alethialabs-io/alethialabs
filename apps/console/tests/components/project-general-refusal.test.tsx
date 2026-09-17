// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4644, ASSERTED ON WHAT THE USER READS.
//
// The server half of this fix is testable on its own (tests/actions/projects.test.ts), but on its
// own it proves nothing about the defect: the actions ALWAYS had the sentence — "a project named X
// already exists", "this project has live or in-flight environments". What was broken is that the
// sentence never reached a screen, because a `throw` out of a `"use server"` export is redacted to
// an opaque `digest` in a production build, and both call sites rendered `e.message`.
//
// So the regression these tests guard is UI-shaped and cannot be seen from the action: an action
// that returns `{ ok: false, error }` into a component that still only has a `catch` is a silent
// no-op — the dialog closes, the field clears, and the user is told nothing at all. That failure
// is INVISIBLE to the action suite and to a type-check (the `catch` compiles fine).
//
// Asserted through `role="alert"` rather than by class or text position, because the point of
// attaching the refusal to the FIELD is that a screen reader is told too — a toast is gone in four
// seconds and the name that caused it is still in the box.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deleteProject = vi.fn();
const updateProjectName = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/app/server/actions/projects", () => ({
  deleteProject: (...args: unknown[]) => deleteProject(...args),
  updateProjectName: (...args: unknown[]) => updateProjectName(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
}));
// Not what this file is about, and it fetches on mount.
vi.mock("@/components/classification/classification-control", () => ({
  ClassificationControl: () => null,
}));

import { ProjectGeneral } from "@/components/settings/general/project-general";

function renderIt() {
  return render(
    <ProjectGeneral
      projectId="p1"
      orgSlug="acme"
      initialName="My App"
      slug="my-app"
    />,
  );
}

const TAKEN =
  'A project named "Taken" already exists in this organization. ' +
  "Project names are unique per organization and are compared without regard to case.";
const LIVE =
  "This project has live or in-flight environments. Destroy them before deleting the project.";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProjectGeneral — a rename the server refuses", () => {
  it("shows the SERVER's sentence on the name field, and does not claim success", async () => {
    updateProjectName.mockResolvedValue({ ok: false, error: TAKEN });
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Taken");
    await user.click(screen.getByRole("button", { name: /save/i }));

    // THE WHOLE POINT: the reason is on screen, in full, and announced.
    expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
    expect(toastError).toHaveBeenCalledWith(TAKEN);
    // A refusal is not a save. Before #4644 the action threw, the `catch` toasted a digest, and
    // these three would still have held — which is why the assertion above is the load-bearing one.
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // The rejected name is still in the box for the user to edit. A `form.reset()` here would
    // throw away the thing they have to change.
    expect(field).toHaveValue("Taken");
  });

  it("clears the server's refusal on a subsequent successful save", async () => {
    updateProjectName
      .mockResolvedValueOnce({ ok: false, error: TAKEN })
      .mockResolvedValueOnce({ ok: true, project_name: "Free" });
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Taken");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);

    await user.clear(field);
    await user.type(field, "Free");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    // A refusal that outlives the thing it was about is its own defect — the user fixed it and the
    // page still says they did not.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still uses the generic sentence for an UNEXPECTED failure, which is not advice", async () => {
    // An action that throws is a defect, not something the user did. Rendering its text as though
    // they could act on it is worse than the digest, so the `catch` keeps its own wording.
    updateProjectName.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    renderIt();

    // Save is disabled while the field still holds `initialName` — a rename has to be a rename.
    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Anything");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError).not.toHaveBeenCalledWith(TAKEN);
  });
});

describe("ProjectGeneral — a delete the server refuses", () => {
  it("keeps the reason on the page after the dialog closes", async () => {
    deleteProject.mockResolvedValue({ ok: false, error: LIVE });
    const user = userEvent.setup();
    renderIt();

    await user.click(screen.getByRole("button", { name: /^Delete project$/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      // The dialog's own confirm, not the trigger that opened it.
      within(dialog).getByRole("button", { name: /delete project/i }),
    );

    // The dialog closes on click, so a toast alone leaves a user who looked away with a page that
    // did nothing. The sentence stays put.
    expect(await screen.findByRole("alert")).toHaveTextContent(LIVE);
    expect(toastError).toHaveBeenCalledWith(LIVE);
    // NOT deleted: the success path navigates away, and the e2e spec's whole difficulty was that
    // "still on the page" is equally true of a refusal that says nothing.
    expect(push).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("navigates to the org on a successful delete", async () => {
    deleteProject.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    renderIt();

    await user.click(screen.getByRole("button", { name: /^Delete project$/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(
      within(dialog).getByRole("button", { name: /delete project/i }),
    );

    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
