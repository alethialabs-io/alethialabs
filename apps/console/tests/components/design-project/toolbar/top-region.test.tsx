// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// What is drawn under the board's toolbar, and in the inspector's Sources view, in place of the
// cards that used to be pinned to the board's corners (#6832).

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SeedNotice } from "@/components/design-project/canvas/empty/seed-notice";
import { SourceReposCard } from "@/components/design-project/source-repos-card";

describe("the seed's sentence", () => {
	it("is drawn in the flow of the toolbar's region when the host places it", () => {
		render(<SeedNotice inRegion sentence="This link's starting point was not applied." onDismiss={vi.fn()} />);
		const notice = screen.getByRole("status").closest('[data-slot="board-seed-notice"]');
		expect(notice).not.toBeNull();
		expect(notice?.className.split(" ")).not.toContain("absolute");
	});

	it("places itself when no region is given, as before", () => {
		render(<SeedNotice sentence="This link's starting point was not applied." onDismiss={vi.fn()} />);
		const notice = screen.getByRole("status").closest('[data-slot="board-seed-notice"]');
		expect(notice?.className.split(" ")).toContain("absolute");
	});

	it("is dismissed with its own button in either place", async () => {
		const user = userEvent.setup();
		const onDismiss = vi.fn();
		render(<SeedNotice inRegion sentence="Not applied." onDismiss={onDismiss} />);
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});

describe("the scanned repositories", () => {
	it("draws nothing for a project that was not inferred from a repository", () => {
		const { container } = render(<SourceReposCard repos={[]} />);
		expect(container).toBeEmptyDOMElement();
	});

	it("lists each repository with its ref and the services found in it, in the flow of its holder", () => {
		render(
			<SourceReposCard
				repos={[
					{
						repo_url: "https://github.com/acme/shop",
						ref: "main",
						services: [
							{ path: "api", name: "api", hasDockerfile: true, runtime: "node", port: 3000 },
							{ path: "web", name: "web", hasDockerfile: true },
						],
					},
					{ repo_url: "https://github.com/acme/billing" },
				]}
			/>,
		);
		const list = screen.getByRole("region", { name: "Source repositories" });
		expect(list.className.split(" ")).not.toContain("absolute");
		expect(list).toHaveTextContent("2 source repos");
		expect(list).toHaveTextContent("2 services");
		expect(list).toHaveTextContent("@main");
		expect(screen.getByText("api")).toBeInTheDocument();
		expect(screen.getByText("web")).toBeInTheDocument();
	});
});
