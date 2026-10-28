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
// #6131 adds what the create flow owed after that (findings F035, F036): the refusal is reported
// ONCE — beside the field, not also as a toast; a name the org holds is said while typing, from the
// read router's `projects.nameAvailability`, with the slug the project will really get; and the
// create goes through the mutation contract, so it cannot be submitted twice and it refreshes the
// shell's project list.
//
// The e2e spec (`e2e/flows/projects.negative.spec.ts`) asserts only that an error toast EXISTS —
// it cannot assert the sentence, which is exactly what #4644 records. These assertions are the
// half that spec cannot reach.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { orpc } from "@/lib/rpc/client";

const tryCreateProject = vi.fn();
const toastError = vi.fn();
const push = vi.fn();
/** What the mocked name check answers (the read router's `projects.nameAvailability`). */
interface Availability {
  current: { available: boolean; slug: string } | undefined;
}
const availability = vi.hoisted((): Availability => ({ current: undefined }));

vi.mock("@/app/server/actions/projects", () => ({
  tryCreateProject: (...args: unknown[]) => tryCreateProject(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
  },
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
// The screen's reads are read-router queries. A scratch on-ramp has no scan; the name check answers
// whatever the test put in `availability.current` — for any name, which is the server's job to vary.
vi.mock("@/components/create-project/use-create-project-reads", () => ({
  useScanResult: () => ({ result: null, retry: vi.fn() }),
  useNameAvailability: (_name: string, enabled: boolean) => ({
    availability: enabled ? availability.current : undefined,
    checking: false,
  }),
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

/** Renders the Configure screen for a blank project; returns the query client it reads through. */
function renderIt() {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ConfigureProject
        orgSlug="acme"
        source={{ kind: "scratch", scratch: "blank" }}
        canManage
        integrations={[]}
        awsSetup={null}
        gcpSetup={null}
        azureSetup={null}
        platformConfigured={{}}
      />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  vi.clearAllMocks();
  availability.current = undefined;
});

describe("ConfigureProject — a create the server refuses", () => {
  it("renders the SERVER's sentence beside the name field ONCE, and stays on the form", async () => {
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
    // F035: it was ALSO toasted, so one refusal was reported twice. The field is where it is fixed.
    expect(toastError).not.toHaveBeenCalled();
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

  it("drops the refusal once the name it was about is edited", async () => {
    tryCreateProject.mockResolvedValue({ ok: false, error: TAKEN });
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.type(field, "Taken");
    await user.click(screen.getByRole("button", { name: /create project/i }));
    await screen.findByRole("alert");

    await user.type(field, "2");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(field).toHaveAttribute("aria-invalid", "false");
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
    expect(toastError).not.toHaveBeenCalled();
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

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).not.toHaveBeenCalledWith(TAKEN);
    // The thrown text is not advice either: a production build would have shown a digest here.
    expect(toastError).not.toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("ConfigureProject — the name, checked while typing (F035)", () => {
  it("says a name the org holds BEFORE Create, and will not submit it", async () => {
    availability.current = { available: false, slug: "taken-2" };
    const user = userEvent.setup();
    renderIt();

    const field = screen.getByRole("textbox", { name: "Project name" });
    await user.type(field, "Taken");

    // A status, not an alert: nothing was pressed, so nothing is being answered.
    expect(screen.getByRole("status")).toHaveTextContent(
      'A project named "Taken" already exists in this organization.',
    );
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: /create project/i })).toBeDisabled();
    expect(tryCreateProject).not.toHaveBeenCalled();
  });

  it("previews the slug the project will really get, not the naive one", async () => {
    // `acme/api` is taken by another project's SLUG; the create would de-duplicate to `api-2`, and
    // F035 was the screen promising `acme/api` as if it were free.
    availability.current = { available: true, slug: "api-2" };
    const user = userEvent.setup();
    renderIt();

    await user.type(screen.getByRole("textbox", { name: "Project name" }), "api");

    expect(screen.getByText("api-2")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: /create project/i })).toBeEnabled();
  });
});

describe("ConfigureProject — the create, through the mutation contract", () => {
  it("cannot be submitted twice while the first is in flight", async () => {
    let resolve: (v: unknown) => void = () => {};
    tryCreateProject.mockImplementation(() => new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderIt();

    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Fresh");
    const create = screen.getByRole("button", { name: /create project/i });
    await user.click(create);
    await waitFor(() => expect(create).toBeDisabled());
    await user.click(create);

    resolve({ ok: true, project: { id: "p1", slug: "fresh" } });
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(tryCreateProject).toHaveBeenCalledTimes(1);
  });

  it("refreshes the shell's project list, so the new project is in the switcher at once (F036)", async () => {
    tryCreateProject.mockResolvedValue({ ok: true, project: { id: "p1", slug: "fresh" } });
    const user = userEvent.setup();
    const client = renderIt();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Fresh");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: orpc.workspace.projects.key() }),
    );
  });
});
