// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4644, ASSERTED ON WHAT THE USER READS — and #6128, which moved both writes onto the mutation
// contract (`renameProject` / `removeProject` through `useActionMutation`).
//
// The server half is testable on its own (tests/actions/projects.test.ts,
// tests/actions/project-settings.test.ts), but on its own it proves nothing about the defect: the
// actions ALWAYS had the sentence — "a project named X already exists", "this project has live or
// in-flight environments". What was broken is that the sentence never reached a screen. So the
// regression these tests guard is UI-shaped: a refusal that arrives into a component that does not
// render it is a silent no-op — the dialog closes, the field clears, and the user is told nothing.
//
// Asserted through `role="alert"` rather than by class or text position, because the point of
// attaching the refusal to the FIELD is that a screen reader is told too — a toast is gone in four
// seconds and the name that caused it is still in the box.

import { ORPCError } from "@orpc/client";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const removeProject = vi.fn();
const renameProject = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();
const push = vi.fn();
const refresh = vi.fn();

vi.mock("@/app/server/actions/project-settings", () => ({
  removeProject: (...args: unknown[]) => removeProject(...args),
  renameProject: (...args: unknown[]) => renameProject(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh, replace: vi.fn() }),
}));
// Not what this file is about, and it fetches on mount.
vi.mock("@/components/classification/classification-control", () => ({
  ClassificationControl: () => null,
}));

import { orpc } from "@/lib/rpc/client";
import type { ProjectGeneral as ProjectGeneralRow } from "@/lib/rpc/procedures/settings";
import {
  MY_APP,
  PROJECT_KEY,
  failRead,
  mountProjectGeneral,
  renderProjectGeneral,
  seededClient,
} from "../support/general-settings";

const TAKEN =
  'A project named "Taken" already exists in this organization. ' +
  "Project names are unique per organization and are compared without regard to case.";
const LIVE =
  "This project has live or in-flight environments. Destroy them before deleting the project.";

/** The rename's refusal as the action answers it: a field error on `name`. */
const takenResult = {
  ok: false,
  error: { kind: "validation", message: TAKEN, fields: { name: [TAKEN] } },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ProjectGeneral — a rename the server refuses", () => {
  it("shows the SERVER's sentence on the name field, and does not claim success", async () => {
    renameProject.mockResolvedValue(takenResult);
    const user = userEvent.setup();
    renderProjectGeneral();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Taken");
    await user.click(screen.getByRole("button", { name: /save/i }));

    // THE WHOLE POINT: the reason is on screen, in full, and announced — under the field.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(TAKEN);
    expect(field).toHaveAttribute("aria-describedby", alert.id);
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    // The rejected name is still in the box for the user to edit. A `form.reset()` here would
    // throw away the thing they have to change.
    expect(field).toHaveValue("Taken");
    expect(renameProject).toHaveBeenCalledWith({ projectId: MY_APP.id, name: "Taken" });
  });

  it("clears the server's refusal on a subsequent successful save", async () => {
    renameProject
      .mockResolvedValueOnce(takenResult)
      .mockResolvedValueOnce({ ok: true, data: { project_name: "Free" } });
    const user = userEvent.setup();
    renderProjectGeneral();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Taken");
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);

    await user.clear(field);
    await user.type(field, "Free");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Project updated."));
    // A refusal that outlives the thing it was about is its own defect.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("uses the generic sentence for an UNEXPECTED failure, which is not advice", async () => {
    renameProject.mockResolvedValue({ ok: false, error: { kind: "unexpected", ref: "0badc0de" } });
    const user = userEvent.setup();
    renderProjectGeneral();

    // Save is disabled while the field still holds the loaded name — a rename has to be a rename.
    expect(screen.getByRole("button", { name: /save/i })).toBeDisabled();
    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Anything");
    await user.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0][0])).toMatch(/Reference: 0badc0de/);
  });
});

describe("ProjectGeneral — a rename that lands (F040, F015)", () => {
  it("refreshes the shell's project list (switcher, breadcrumb, palette) and this page", async () => {
    renameProject.mockResolvedValue({ ok: true, data: { project_name: "Renamed" } });
    const client = seededClient();
    client.setQueryData(orpc.workspace.projects.queryKey(), []);
    const user = userEvent.setup();
    renderProjectGeneral(MY_APP, client);

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.clear(field);
    await user.type(field, "Renamed");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Project updated."));
    expect(client.getQueryState(orpc.workspace.projects.queryKey())?.isInvalidated).toBe(true);
    expect(client.getQueryState(PROJECT_KEY)?.isInvalidated).toBe(true);
    // No full RSC refresh: the keys carry it (ADR 0005 D4.6).
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sends one rename for three rapid clicks", async () => {
    let finish: (value: unknown) => void = () => {};
    renameProject.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    renderProjectGeneral();
    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.type(field, "!");
    const save = screen.getByRole("button", { name: /save/i });
    await user.click(save);
    await user.click(save);
    await user.click(save);

    await waitFor(() => expect(renameProject).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    await act(async () => finish({ ok: true, data: { project_name: "My App!" } }));
    expect(renameProject).toHaveBeenCalledTimes(1);
  });
});

describe("ProjectGeneral — a delete the server refuses", () => {
  it("keeps the reason on the page after the dialog closes", async () => {
    removeProject.mockResolvedValue({ ok: false, error: { kind: "conflict", message: LIVE } });
    const user = userEvent.setup();
    renderProjectGeneral();

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
    expect(push).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("navigates to the org on a successful delete", async () => {
    removeProject.mockResolvedValue({ ok: true, data: { deleted: true } });
    const user = userEvent.setup();
    renderProjectGeneral();

    await user.click(screen.getByRole("button", { name: /^Delete project$/ }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: /delete project/i }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/acme"));
    expect(removeProject).toHaveBeenCalledWith({ projectId: MY_APP.id });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ProjectGeneral — four renders, never confused", () => {
  it("follows a rename made elsewhere while the form is pristine", async () => {
    const { client } = renderProjectGeneral();
    const theirs: ProjectGeneralRow = { ...MY_APP, project_name: "Their Name" };
    act(() => {
      client.setQueryData(PROJECT_KEY, theirs);
    });
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Their Name"),
    );
  });

  it("says the project is gone when the read answers null (deleted in another tab)", () => {
    const { container } = renderProjectGeneral(null);
    expect(screen.getByText("This project is gone")).toBeInTheDocument();
    expect(container.querySelector('[data-slot="project-general-skeleton"]')).toBeNull();
  });

  it("renders a refusal, a failure and pending each as itself", () => {
    const refused = seededClient();
    failRead(refused, PROJECT_KEY, new ORPCError("FORBIDDEN", { defined: true }));
    const a = mountProjectGeneral(refused);
    expect(a.container.querySelector('[data-state="refused"]')).not.toBeNull();
    a.unmount();

    const failed = seededClient();
    failRead(failed, PROJECT_KEY, new Error("network"));
    const b = mountProjectGeneral(failed);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(b.container.querySelector('[data-state="refused"]')).toBeNull();
    b.unmount();

    const c = mountProjectGeneral(seededClient());
    expect(c.container.querySelector('[data-slot="project-general-skeleton"]')).not.toBeNull();
  });
});
