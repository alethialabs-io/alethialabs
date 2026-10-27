// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// F034 (#6131): the import panel on `/~/new` swapped its whole layout mid-load. The repository
// selector's first frame — the server render included — was the "No Git accounts linked" panel with
// three Link buttons; then a skeleton; then the provider + repository row. The route now prefetches
// the caller's linked providers and hands them to the selector, whose FIRST render is the settled
// branch. These assertions read the first render synchronously, before anything is awaited: an
// assertion made after `findBy` would pass over the very frames the finding is about. The SERVER
// render is asserted with `renderToString`, where no effect runs at all: that frame is what the user
// sees before hydration, and it is exactly the one that used to be the Link panel.

import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/client", () => ({ authClient: { linkSocial: vi.fn() } }));
vi.mock("@/app/server/actions/identities", () => ({
	getLinkedProviders: vi.fn(async () => ["github"]),
}));
vi.mock("@/app/server/actions/git/repositories", () => ({
	fetchRepositoriesByProvider: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));

const { getLinkedProviders } = await import("@/app/server/actions/identities");
const { fetchRepositoriesByProvider } = await import("@/app/server/actions/git/repositories");
const { RepositorySelector } = await import("@/components/repository-selector");

/** The selector as the import panel renders it. */
function renderSelector(linkedProviders?: ("github" | "gitlab" | "bitbucket")[]) {
	return render(
		<RepositorySelector
			value={undefined}
			onChange={vi.fn()}
			label=""
			placeholder="Select a repository to import…"
			linkedProviders={linkedProviders}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("RepositorySelector — one layout through load (F034)", () => {
	it("seeded with a linked provider, the FIRST render is the provider + repository row", () => {
		renderSelector(["github"]);

		expect(screen.getByRole("combobox", { name: "Git provider: github" })).toBeInTheDocument();
		// The repositories are in flight from the first frame — never "No repositories found".
		expect(screen.getByRole("button", { name: "Fetching repositories..." })).toBeDisabled();
		expect(screen.queryByText("No Git accounts linked")).toBeNull();
		expect(screen.queryByText("No repositories found")).toBeNull();
		// The server already answered: the selector does not ask again.
		expect(getLinkedProviders).not.toHaveBeenCalled();
		expect(fetchRepositoriesByProvider).toHaveBeenCalledWith("github");
	});

	it("seeded with nothing linked, the FIRST render is the Link panel — and it stays", () => {
		renderSelector([]);

		expect(screen.getByText("No Git accounts linked")).toBeInTheDocument();
		expect(screen.queryByRole("combobox", { name: /Git provider/ })).toBeNull();
		expect(getLinkedProviders).not.toHaveBeenCalled();
		expect(fetchRepositoriesByProvider).not.toHaveBeenCalled();
	});

	it("the SERVER render is already the settled branch — seeded or not, never a Link panel by default", () => {
		const seeded = renderToString(
			<RepositorySelector value={undefined} onChange={vi.fn()} label="" linkedProviders={["github"]} />,
		);
		expect(seeded).toContain("Git provider: github");
		expect(seeded).not.toContain("No Git accounts linked");

		// Unseeded, the server cannot know — so it renders the loading row, not a guess that nothing
		// is linked (which is what every first frame used to say).
		const unseeded = renderToString(
			<RepositorySelector value={undefined} onChange={vi.fn()} label="" />,
		);
		expect(unseeded).not.toContain("No Git accounts linked");
		expect(unseeded).not.toContain("Link GitHub");
	});

	it("unseeded, the first render is the loading row — never a Link panel the data will take away", async () => {
		renderSelector(undefined);

		expect(screen.queryByText("No Git accounts linked")).toBeNull();
		expect(screen.queryByRole("button", { name: /Link GitHub/i })).toBeNull();
		expect(getLinkedProviders).toHaveBeenCalledTimes(1);
		// …and it settles on the row once the list lands.
		expect(
			await screen.findByRole("combobox", { name: "Git provider: github" }),
		).toBeInTheDocument();
	});
});
