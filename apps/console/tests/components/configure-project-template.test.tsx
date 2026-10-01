// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #4110 — THE TEMPLATE PICKER IS WIRED. For eight weeks the picker rendered nowhere and
// `apps/console/knip.json` was told not to look at it, so a green `check:dead-code` said nothing.
// These assertions are what now says it renders: on the `?scratch=template` path only, keyed on the
// console's one `TemplateId`, handing over the starter repository the chosen template names — and
// NOT changing the cluster, because `alethia-starter-ai` is CPU-only by decision (#4112).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_INSTANCE_TYPE } from "@/lib/cloud-providers";

const tryCreateProject = vi.fn();
const push = vi.fn();

vi.mock("@/app/server/actions/projects", () => ({
  tryCreateProject: (...args: unknown[]) => tryCreateProject(...args),
}));
vi.mock("@/app/server/actions/scanner", () => ({ getScanProposal: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
}));
vi.mock("@/components/cloud-connect/use-cloud-connect", () => ({
  useCloudConnect: () => ({
    openConnect: vi.fn(),
    connectingSlug: null,
    sheets: null,
  }),
}));
// The real cloud cards are another screen's subject. This stand-in selects one AWS account, which
// is the only thing the template path needs from them before Create is enabled.
vi.mock("@/components/create-project/cloud-picker", () => ({
  CloudPicker: ({
    onSelect,
  }: {
    onSelect: (identityId: string, provider: "aws") => void;
  }) => (
    <button type="button" onClick={() => onSelect("identity-1", "aws")}>
      pick aws
    </button>
  ),
}));
vi.mock("@/components/create-project/region-select", () => ({
  RegionSelect: () => null,
}));
vi.mock("@/components/create-project/environment-placement", () => ({
  EnvironmentPlacement: () => null,
}));

import { ConfigureProject } from "@/components/create-project/configure-project";

/** Renders the Configure screen for a scratch on-ramp. */
function renderFor(scratch: "template" | "blank") {
  return render(
    <ConfigureProject
      orgSlug="acme"
      source={{ kind: "scratch", scratch }}
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

describe("ConfigureProject — the template picker (#4110)", () => {
  it("renders the picker on the template path, starting on Standard and its apps starter", () => {
    renderFor("template");

    expect(screen.getByRole("heading", { name: "Template" })).toBeInTheDocument();
    const picker = screen.getByRole("group", { name: "Template" });
    expect(
      within(picker).getByRole("button", { name: /Standard/, pressed: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "alethialabs-io/alethia-starter-apps" }),
    ).toHaveAttribute("href", "https://github.com/alethialabs-io/alethia-starter-apps");
    // The rail names the picked template, not a hard-coded "Standard".
    expect(screen.getByText("Standard template")).toBeInTheDocument();
  });

  it("does NOT render the picker on the blank path", () => {
    renderFor("blank");
    expect(screen.queryByRole("heading", { name: "Template" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Template" })).toBeNull();
  });

  it("AI Workloads hands over alethia-starter-ai, with GitHub's copy form, and promises no GPU", async () => {
    const user = userEvent.setup();
    renderFor("template");

    await user.click(screen.getByRole("button", { name: /AI Workloads/ }));

    expect(screen.getByRole("button", { name: /AI Workloads/, pressed: true })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "alethialabs-io/alethia-starter-ai" }),
    ).toHaveAttribute("href", "https://github.com/alethialabs-io/alethia-starter-ai");
    expect(screen.getByRole("link", { name: /Use this template/ })).toHaveAttribute(
      "href",
      "https://github.com/alethialabs-io/alethia-starter-ai/generate",
    );
    expect(screen.getByText("AI Workloads template")).toBeInTheDocument();
    // #4935 fact 4: the old card said "GPU support", which is false of this starter.
    expect(screen.queryByText(/GPU support/)).toBeNull();
    expect(screen.getByText("CPU-only — provisions no GPU")).toBeInTheDocument();
  });

  it("Custom has no starter repository and says so instead of linking one", async () => {
    const user = userEvent.setup();
    renderFor("template");

    await user.click(screen.getByRole("button", { name: /Custom/ }));

    expect(screen.getByText("None — bring your own")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Use this template/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /alethia-starter/ })).toBeNull();
  });

  it("creates the SAME cluster for AI Workloads — the default node type, never a GPU one", async () => {
    tryCreateProject.mockResolvedValue({ ok: true, project: { id: "p1", slug: "rag" } });
    const user = userEvent.setup();
    renderFor("template");

    await user.click(screen.getByRole("button", { name: "pick aws" }));
    await user.click(screen.getByRole("button", { name: /AI Workloads/ }));
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "rag");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() => expect(tryCreateProject).toHaveBeenCalledTimes(1));
    expect(tryCreateProject.mock.calls[0][0].cluster.instance_types).toEqual([
      DEFAULT_INSTANCE_TYPE.aws,
    ]);
    expect(tryCreateProject.mock.calls[0][0].project.cloud_identity_id).toBe("identity-1");
  });
});
