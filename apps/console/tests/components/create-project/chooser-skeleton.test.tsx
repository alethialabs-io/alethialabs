// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6351 (RUBRIC B2): the `/~/new` skeleton is the chooser's shape. The gate measured its import
// card at 166px against the 398px card a viewer with nothing linked gets, and the whole on-ramp row
// 14px low, because the skeleton drew two prompt bars where the empty textarea is one line. The
// skeleton now reads the viewer's linked git accounts before it draws, and draws the chooser's own
// parts (`chooser-parts.tsx`) — headings, frames, and the scratch cards' copy — so the two cannot
// drift apart. These tests pin that structure; the pixels are the release gate's to measure.

import { QueryClient } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/client", () => ({ authClient: { linkSocial: vi.fn() } }));
vi.mock("@/app/server/actions/identities", () => ({ getLinkedProviders: vi.fn() }));
vi.mock("@/app/server/actions/git/repositories", () => ({ fetchRepositoriesByProvider: vi.fn() }));
vi.mock("@/components/design-project/repository-context", () => ({
	useRepositoryContext: () => null,
}));

// The route's server read, answered per test.
const { linkedRead } = vi.hoisted(() => ({ linkedRead: vi.fn<() => Promise<string[]>>() }));
vi.mock("@/lib/rpc/server", () => ({
	serverOrpc: () => ({
		projects: {
			linkedGitProviders: {
				queryOptions: () => ({
					queryKey: ["projects", "linkedGitProviders"],
					queryFn: () => linkedRead(),
				}),
			},
		},
	}),
}));
vi.mock("@/lib/query/client", () => ({
	getQueryClient: () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
}));
vi.mock("@/lib/addons/byo-flag", () => ({ isByoHelmEnabled: () => true }));
vi.mock("@/lib/addons/byo-iac-flag", () => ({ isByoIacEnabled: () => false }));

const { ChooserSkeleton } = await import("@/components/create-project/create-project-skeletons");
const { StartFromScratchCards } = await import(
	"@/components/create-project/start-from-scratch-cards"
);
const { IMPORT_COLUMN_TITLE, SCRATCH_COLUMN_TITLE, scratchCards } = await import(
	"@/components/create-project/chooser-parts"
);
const { default: NewProjectLoading } = await import("@/app/(private)/[org]/~/new/loading");

const FLAGS = [
	{ byoHelmEnabled: false, byoIacEnabled: false },
	{ byoHelmEnabled: true, byoIacEnabled: false },
	{ byoHelmEnabled: false, byoIacEnabled: true },
	{ byoHelmEnabled: true, byoIacEnabled: true },
];

/** The import card's selector shape inside a rendered skeleton: the panel, the row, or neither. */
function selectorShape(container: HTMLElement): "panel" | "row" | "none" {
	const card = container.querySelector('[data-slot="import-card-skeleton"]');
	if (card?.querySelector('[data-slot="git-accounts-skeleton"]')) return "panel";
	if (card?.querySelector('[data-slot="repository-row-skeleton"]')) return "row";
	return "none";
}

beforeEach(() => {
	linkedRead.mockReset();
});

describe("ChooserSkeleton — the import card the viewer will get", () => {
	it("nothing linked: the 'No Git accounts linked' panel's shape, not the row", () => {
		const { container } = render(
			<ChooserSkeleton byoHelmEnabled={false} byoIacEnabled={false} linked={false} />,
		);
		expect(selectorShape(container)).toBe("panel");
	});

	it("a provider linked, or no answer: the row's shape, not the panel", () => {
		for (const linked of [true, undefined]) {
			const { container, unmount } = render(
				<ChooserSkeleton byoHelmEnabled={false} byoIacEnabled={false} linked={linked} />,
			);
			expect(selectorShape(container)).toBe("row");
			unmount();
		}
	});

	it("the import card carries the panel's real heading, which wraps as the panel's does", () => {
		const { container } = render(
			<ChooserSkeleton byoHelmEnabled={false} byoIacEnabled={false} linked={false} />,
		);
		const card = container.querySelector<HTMLElement>('[data-slot="import-card-skeleton"]');
		expect(card).not.toBeNull();
		if (card === null) return;
		expect(within(card).getByRole("heading", { name: "Import a repository" })).toBeInTheDocument();
		expect(card.querySelector('[data-slot="section-heading-description"]')).not.toBeNull();
	});

	it("both column headings are the chooser's own", () => {
		render(<ChooserSkeleton byoHelmEnabled={false} byoIacEnabled={false} linked={undefined} />);
		expect(screen.getByText(IMPORT_COLUMN_TITLE)).toBeInTheDocument();
		expect(screen.getByText(SCRATCH_COLUMN_TITLE)).toBeInTheDocument();
	});

	it("the empty prompt is ONE line box, as the empty textarea is — not two bars", () => {
		const { container } = render(
			<ChooserSkeleton byoHelmEnabled={false} byoIacEnabled={false} linked={undefined} />,
		);
		const prompt = container.querySelector('[data-slot="prompt-skeleton"]');
		expect(prompt?.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(1);
		expect(prompt?.querySelector(".h-\\[1lh\\]")).not.toBeNull();
	});
});

describe("ChooserSkeleton — the scratch cards are the chooser's cards", () => {
	it("as many cards as the chooser shows, with each card's own title and description, in order", () => {
		for (const flags of FLAGS) {
			const sk = render(<ChooserSkeleton {...flags} linked={undefined} />);
			const cards = Array.from(
				sk.container.querySelectorAll<HTMLElement>('[data-slot="scratch-card-skeleton"]'),
			);
			sk.unmount();

			const real = render(<StartFromScratchCards {...flags} onSelect={vi.fn()} />);
			const tiles = real.getAllByRole("button");
			expect(cards).toHaveLength(tiles.length);
			expect(cards).toHaveLength(scratchCards(flags).length);
			cards.forEach((card, i) => {
				// Every tile's accessible description is its description node's text; the skeleton
				// card holds the same text (invisible), so it wraps to the same number of lines.
				const description = tiles[i]?.getAttribute("aria-describedby");
				const descText = description ? document.getElementById(description)?.textContent : null;
				expect(descText).toBeTruthy();
				expect(card.textContent).toContain(descText ?? "");
				expect(card.textContent).toContain(scratchCards(flags)[i]?.title ?? "<missing>");
			});
			real.unmount();
		}
	});

	it("a card with the 'New' pill has the pill's box in the skeleton too", () => {
		const { container } = render(
			<ChooserSkeleton byoHelmEnabled byoIacEnabled linked={undefined} />,
		);
		const withPill = Array.from(
			container.querySelectorAll<HTMLElement>('[data-slot="scratch-card-skeleton"]'),
		).filter((c) => c.textContent?.includes("New"));
		expect(withPill).toHaveLength(2);
	});
});

describe("the route's loading.tsx reads the viewer's linked git accounts before it draws", () => {
	it("nothing linked draws the panel", async () => {
		linkedRead.mockResolvedValue([]);
		const { container } = render(await NewProjectLoading());
		expect(linkedRead).toHaveBeenCalledTimes(1);
		expect(selectorShape(container)).toBe("panel");
	});

	it("a linked provider draws the row", async () => {
		linkedRead.mockResolvedValue(["github"]);
		const { container } = render(await NewProjectLoading());
		expect(selectorShape(container)).toBe("row");
	});

	it("a failed read draws the row, which the selector shows while it reads the list itself", async () => {
		linkedRead.mockRejectedValue(new Error("unavailable"));
		const { container } = render(await NewProjectLoading());
		expect(selectorShape(container)).toBe("row");
	});

	it("the flags reach it: BYO Helm on, BYO IaC off is three scratch cards", async () => {
		linkedRead.mockResolvedValue([]);
		const { container } = render(await NewProjectLoading());
		expect(container.querySelectorAll('[data-slot="scratch-card-skeleton"]')).toHaveLength(3);
	});
});
