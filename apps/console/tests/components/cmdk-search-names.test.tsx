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
//
// The environment switcher and the repository selector render their trigger only after a server
// action resolves, and that is where #5927's flake lived. The trigger arrived from a promise, i.e.
// OUTSIDE `act`, so React committed it and then left its passive effects for a later scheduler task.
// base-ui's trigger first renders against a placeholder floating context; the root publishes the
// real one in a layout effect, and the trigger only re-reads it when its `useSyncExternalStore`
// subscription — a passive effect — runs in that later task. Under a loaded runner the click could
// land in between: the button was on screen, `findByRole` had found it, and the click went to the
// placeholder, so `onOpenChange` never fired (`aria-expanded="false"` in the failure dump) and the
// combobox never appeared however long anything waited. The fix is not a longer timeout:
// `settleServerActions` lets the loads resolve INSIDE `act`, which flushes those effects before the
// test clicks — and the test then asserts the popover is open before it asks for the combobox.

import { act, render, screen } from "@testing-library/react";
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

const { getEnvironmentsForSlug } = await import(
	"@/app/server/actions/resolve"
);
const { getLinkedProviders } = await import("@/app/server/actions/identities");
const { fetchRepositoriesByProvider } = await import(
	"@/app/server/actions/git/repositories"
);
const { EnvSwitcher } = await import("@/components/env-switcher");
const { OrgSwitcher } = await import("@/components/org-switcher");
const { ProjectSwitcher } = await import("@/components/project-switcher");
const { RepositorySelector } = await import("@/components/repository-selector");
const { Combobox } = await import("@/components/settings/access/combobox");
const { PromptInputCommand, PromptInputCommandInput } =
	await import("@/components/ai-elements/prompt-input");

/** The mocked server actions whose results put a trigger on screen. */
const loaders = [
	vi.mocked(getEnvironmentsForSlug),
	vi.mocked(getLinkedProviders),
	vi.mocked(fetchRepositoriesByProvider),
];

/** How many times the mocked server actions have been called so far, across all of them. */
function loaderCalls(): number {
	return loaders.reduce((n, loader) => n + loader.mock.calls.length, 0);
}

/**
 * Resolves once every mocked server action the rendered component has called has settled, and
 * React has committed everything those results produced — renders AND passive effects — because
 * the waiting happens inside `act`. Loops because one load can start another (the repository
 * selector fetches repositories only once the linked providers arrive). The `setTimeout(0)` is not
 * a timing guess: the mocks resolve through microtasks alone, and one macrotask turn drains every
 * microtask chain the component hung off them, however slow the machine is.
 */
async function settleServerActions(): Promise<void> {
	await act(async () => {
		let seen = -1;
		while (seen !== loaderCalls()) {
			seen = loaderCalls();
			await Promise.allSettled(
				loaders.flatMap((loader) =>
					loader.mock.results.map((result) => result.value),
				),
			);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	});
}

describe("console cmdk searches have an accessible name", () => {
	it("names the environment switcher's search", async () => {
		const user = userEvent.setup({ delay: null });
		render(<EnvSwitcher />);
		await settleServerActions();
		const trigger = screen.getByRole("button", {
			name: /^Switch environment/,
		});
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByRole("combobox", { name: "Find environment" }),
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
		await settleServerActions();
		const trigger = screen.getByRole("button", { name: /Select repository/ });
		await user.click(trigger);
		expect(trigger).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByRole("combobox", { name: "Search repositories" }),
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
