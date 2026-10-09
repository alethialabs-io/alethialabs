// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Every console cmdk search must have an accessible name (#5824).
//
// cmdk points its input's `aria-labelledby` at its own visually hidden `<label cmdk-label>`, whose
// text is the root's `label` prop. Left empty, that reference resolves to "" — and because an
// `aria-labelledby` that resolves to nothing still wins over the placeholder, the search was an
// unnamed combobox in all of these, with its placeholder sitting visibly inside it.
//
// The REAL components are rendered and their popovers opened; only the server actions and stores
// behind them are stubbed. The assertion is the computed NAME (`getByRole(..., { name })`), never
// the attribute, because `aria-labelledby` was present the whole time.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
	usePathname: () => "/acme/shop",
	useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/server/actions/resolve", () => ({
	getEnvironmentsForSlug: vi.fn(async () => [
		{
			id: "env_1",
			project_id: "proj_1",
			name: "production",
			stage: "production",
			is_default: true,
		},
	]),
}));
vi.mock("@/components/environments/new-environment-dialog", () => ({
	NewEnvironmentDialog: () => null,
}));
vi.mock("@/components/org/create-org-sheet", () => ({
	CreateOrgSheet: () => null,
}));
vi.mock("@/lib/stores/use-elench-store", () => ({
	useElenchStore: { getState: () => ({ syncEnvironment: vi.fn() }) },
}));
vi.mock("@/lib/stores/use-workspace-store", () => {
	const state = {
		activeOrgId: "org_1",
		organizations: [
			{
				id: "org_1",
				name: "Acme",
				slug: "acme",
				plan: "community",
				logo: null,
			},
		],
		fetchWorkspace: () => {},
	};
	return {
		useWorkspaceStore: () => state,
		useActiveOrgSlug: () => "acme",
	};
});
vi.mock("@/lib/query/use-projects-query", () => ({
	useProjectsQuery: () => ({
		data: [
			{
				id: "proj_1",
				slug: "shop",
				project_name: "Shop",
				cloud_provider: null,
			},
		],
	}),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: { linkSocial: vi.fn() },
}));
vi.mock("@/app/server/actions/identities", () => ({
	getLinkedProviders: vi.fn(async () => ["github"]),
}));
vi.mock("@/app/server/actions/git/repositories", () => ({
	fetchRepositoriesByProvider: vi.fn(async () => ({
		repositories: [
			{
				id: "repo-1",
				name: "shop",
				full_name: "acme/shop",
				url: "https://github.com/acme/shop",
				private: true,
				default_branch: "main",
				provider: "github",
			},
		],
	})),
}));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));

const { EnvSwitcher } = await import("@/components/env-switcher");
const { OrgSwitcher } = await import("@/components/org-switcher");
const { ProjectSwitcher } = await import("@/components/project-switcher");
const { RepositorySelector } = await import("@/components/repository-selector");
const { Combobox } = await import("@/components/settings/access/combobox");
const { PromptInputCommand, PromptInputCommandInput } =
	await import("@/components/ai-elements/prompt-input");

describe("console cmdk searches have an accessible name", () => {
	it("names the environment switcher's search", async () => {
		const user = userEvent.setup({ delay: null });
		render(<EnvSwitcher />);
		await user.click(
			await screen.findByRole("button", { name: /^Switch environment/ }),
		);
		expect(
			await screen.findByRole("combobox", { name: "Find environment" }),
		).toHaveAttribute("placeholder", "Find environment…");
	});

	it("names the organization switcher's search", async () => {
		const user = userEvent.setup({ delay: null });
		render(<OrgSwitcher />);
		await user.click(
			screen.getByRole("button", { name: "Switch organization" }),
		);
		expect(
			await screen.findByRole("combobox", { name: "Find organization" }),
		).toHaveAttribute("placeholder", "Find organization…");
	});

	it("names the project switcher's search", async () => {
		const user = userEvent.setup({ delay: null });
		render(<ProjectSwitcher />);
		await user.click(screen.getByRole("button", { name: /^Switch project/ }));
		expect(
			await screen.findByRole("combobox", { name: "Find project" }),
		).toHaveAttribute("placeholder", "Find project…");
	});

	it("names the repository selector's search", async () => {
		const user = userEvent.setup({ delay: null });
		render(
			<RepositorySelector
				label="Repository"
				value={undefined}
				onChange={() => {}}
			/>,
		);
		await user.click(
			await screen.findByRole("button", { name: /Select repository/ }),
		);
		expect(
			await screen.findByRole("combobox", { name: "Search repositories" }),
		).toHaveAttribute("placeholder", "Search repositories...");
	});

	it("names the access combobox's search after its purpose", async () => {
		const user = userEvent.setup({ delay: null });
		render(
			<Combobox
				options={[{ value: "k8s.read", label: "Kubernetes read" }]}
				onChange={() => {}}
				placeholder="Select a permission…"
			/>,
		);
		await user.click(
			screen.getByRole("button", { name: "Select a permission…" }),
		);
		expect(
			await screen.findByRole("combobox", { name: "Select a permission" }),
		).toHaveAttribute("placeholder", "Select a permission…");
	});

	it("names the prompt input's command search from its required label", () => {
		render(
			<PromptInputCommand label="Search commands">
				<PromptInputCommandInput placeholder="Type a command…" />
			</PromptInputCommand>,
		);
		expect(
			screen.getByRole("combobox", { name: "Search commands" }),
		).toBeInTheDocument();
	});
});
