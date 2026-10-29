// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6335: on `[project]/settings/preview` the git-accounts block (the "No Git accounts linked" panel
// with its Link buttons, or the provider and repository row) was missing from the first paint. The
// repo picker read the viewer's linked providers itself, after mount, over a server action, so the
// server render and the first client frame were its loading row (RUBRIC B1). The route now
// prefetches `projects.linkedGitProviders` with the page, and the page hands the answer to the
// picker.
//
// These render the REAL `RepositorySelector` inside the page body over a client holding what the
// route dehydrates. They read the first render synchronously, before anything is awaited, because
// an assertion after a `findBy` would pass over the very frame the finding is about. The SERVER
// render is checked with `renderToString`, where no effect runs at all.

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/client", () => ({ authClient: { linkSocial: vi.fn() } }));
vi.mock("@/app/server/actions/identities", () => ({
	getLinkedProviders: vi.fn(async () => []),
}));
vi.mock("@/app/server/actions/git/repositories", () => ({
	fetchRepositoriesByProvider: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));
vi.mock("@/app/server/actions/preview", () => ({ savePreviewConfig: vi.fn() }));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { getLinkedProviders } = await import("@/app/server/actions/identities");
const { PreviewSettingsPage } = await import("@/components/settings/preview/preview-settings");
const { orpc } = await import("@/lib/rpc/client");
const { seededClient, withQueryClient } = await import("../support/general-settings");

const READ = { projectId: "proj-1", config: null, fabrics: [], gitCredentials: [] };

/** The page body over a client holding both keys the route prefetches. */
function pageOver(linked: ("github" | "gitlab" | "bitbucket")[]) {
	const client = seededClient();
	client.setQueryData(orpc.settings.preview.queryKey({ input: { project: "shop" } }), READ);
	client.setQueryData(orpc.projects.linkedGitProviders.queryKey(), linked);
	return withQueryClient(
		<PreviewSettingsPage
			project="shop"
			gitlabBaseUrl="https://gitlab.com"
			providerAvailability={{ github: true, gitlab: true, bitbucket: true }}
		/>,
		client,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("Preview settings — the git-accounts block is in the first paint (#6335, B1)", () => {
	it("nothing linked: the FIRST render is the Link panel, and the picker asks nothing", () => {
		render(pageOver([]));
		expect(screen.getByText("No Git accounts linked")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /Link GitHub/ })).toBeInTheDocument();
		expect(getLinkedProviders).not.toHaveBeenCalled();
	});

	it("a provider linked: the FIRST render is the provider row, never the Link panel", () => {
		render(pageOver(["github"]));
		expect(screen.getByRole("combobox", { name: "Git provider: github" })).toBeInTheDocument();
		expect(screen.queryByText("No Git accounts linked")).toBeNull();
		expect(getLinkedProviders).not.toHaveBeenCalled();
	});

	it("the SERVER render already carries the block", () => {
		const html = renderToString(pageOver([]));
		expect(html).toContain("No Git accounts linked");
		expect(html).toContain("Link GitHub");
	});
});
