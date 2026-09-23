// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Controls the R8 audit filed as "did nothing" once it measured their pages (#4996). Each was a
// PRODUCT defect, and each test below renders the real component:
//
//  - Link GitHub / GitLab / Bitbucket on `[project]/settings/preview` and `~/new`: offered even on an
//    instance with no OAuth app for the provider, where `linkSocial` can only reject — and the
//    rejection was written into state that the no-accounts branch never rendered.
//  - Transfer on `~/settings/general`: a live button whose only effect was a "coming soon" toast.
//  - Design with the agent on `~/new`: once clicked it spun forever, even after the agent closed.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const linkSocial = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/~/new",
}));
vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: { update: vi.fn(), delete: vi.fn() },
		linkSocial,
	},
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (select: (st: unknown) => unknown) =>
		select({ activeOrgId: "org_1", fetchWorkspace: vi.fn() }),
}));
vi.mock("@/app/server/actions/org-settings", () => ({
	getOrgSettings: vi.fn(async () => ({
		name: "Acme",
		slug: "acme",
		logo: null,
		description: "",
		primaryAddress: null,
		region: "eu-west-1",
		defaultEnv: "production",
		terraformVersion: "1.9.0",
	})),
}));
// No linked provider: the selector renders its "No Git accounts linked" branch, which is the one
// the audit user sees.
vi.mock("@/app/server/actions/identities", () => ({
	getLinkedProviders: vi.fn(async () => []),
}));
vi.mock("@/app/server/actions/git/repositories", () => ({
	fetchRepositoriesByProvider: vi.fn(async () => ({ repositories: [] })),
}));
vi.mock("@/app/server/actions/scanner", () => ({ scanRepo: vi.fn() }));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));
vi.mock("@/components/org/upgrade-sheet-provider", () => ({
	useUpgradeSheet: () => ({ openUpgrade: vi.fn() }),
}));

const { RepositorySelector } = await import("@/components/repository-selector");
const { OrgGeneral } = await import("@/components/settings/general/org-general");
const { CreateProjectForm } = await import(
	"@/components/create-project/create-project-form"
);
const { useElenchStore } = await import("@/lib/stores/use-elench-store");
const { GIT_PROVIDER_NOT_ENABLED, gitProviderAvailability } = await import(
	"@/lib/connectors/git-providers"
);

const NONE = { github: false, gitlab: false, bitbucket: false };

beforeEach(() => {
	linkSocial.mockReset();
	useElenchStore.setState({ open: false, seedPrompt: null });
});

describe("gitProviderAvailability", () => {
	it("reads the three git slugs, and a slug the map lacks is not available", () => {
		expect(gitProviderAvailability({ github: true, gitlab: false, aws: true })).toEqual({
			github: true,
			gitlab: false,
			bitbucket: false,
		});
	});
});

describe("RepositorySelector — Link buttons", () => {
	it("renders an unconfigured provider disabled, with the reason as its title", async () => {
		render(
			<RepositorySelector
				value={undefined}
				onChange={vi.fn()}
				label=""
				providerAvailability={{ ...NONE, gitlab: true }}
			/>,
		);
		const github = await screen.findByRole("button", { name: /link github/i });
		const bitbucket = screen.getByRole("button", { name: /link bitbucket/i });
		const gitlab = screen.getByRole("button", { name: /link gitlab/i });
		for (const off of [github, bitbucket]) {
			expect(off).toBeDisabled();
			expect(off).toHaveAttribute("title", GIT_PROVIDER_NOT_ENABLED);
		}
		expect(gitlab).toBeEnabled();
		expect(gitlab).not.toHaveAttribute("title");
	});

	it("shows a failed link as an alert and returns to the page it was started on", async () => {
		linkSocial.mockResolvedValue({ error: { message: "provider not found" } });
		const user = userEvent.setup();
		window.history.pushState({}, "", "/acme/~/new?x=1");
		render(
			<RepositorySelector
				value={undefined}
				onChange={vi.fn()}
				label=""
				providerAvailability={{ github: true, gitlab: true, bitbucket: true }}
			/>,
		);
		await user.click(await screen.findByRole("button", { name: /link github/i }));
		expect(await screen.findByRole("alert")).toHaveTextContent(/failed to link github/i);
		expect(linkSocial).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: "github",
				callbackURL: `${window.location.origin}/acme/~/new?x=1`,
			}),
		);
	});
});

describe("OrgGeneral — Transfer", () => {
	it("is disabled and says ownership transfer is coming soon", async () => {
		render(<OrgGeneral />);
		const transfer = await screen.findByRole("button", { name: "Transfer" });
		expect(transfer).toBeDisabled();
		expect(transfer).toHaveAttribute("title", "Ownership transfer is coming soon");
	});
});

describe("CreateProjectForm — Design with the agent", () => {
	it("comes back once the agent surface closes", async () => {
		const user = userEvent.setup();
		render(
			<CreateProjectForm orgSlug="acme" canCollaborate providerAvailability={NONE} />,
		);
		await user.type(screen.getByRole("textbox"), "An EKS cluster");
		const launch = screen.getByRole("button", { name: "Design with the agent" });
		await user.click(launch);
		expect(useElenchStore.getState().open).toBe(true);
		expect(launch).toBeDisabled();

		act(() => useElenchStore.getState().close());
		await waitFor(() => expect(launch).toBeEnabled());
	});
});
