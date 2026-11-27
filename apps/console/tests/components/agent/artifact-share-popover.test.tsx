// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The artifact Share popover's load of its share targets (#6459). The loading state belongs to ONE
// open of the popover: it is cleared where the popover opens, and an answer that lands after the
// popover closed is dropped. These pin the outcome; they do not see whether the state is set in
// the opening event or one commit later.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/server/actions/artifact-shares", () => ({
	getArtifactShareAccess: vi.fn(),
	listArtifactShares: vi.fn(),
	shareArtifact: vi.fn(),
	unshareArtifact: vi.fn(),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import {
	getArtifactShareAccess,
	listArtifactShares,
	shareArtifact,
} from "@/app/server/actions/artifact-shares";
import { ArtifactSharePopover } from "@/components/agent/artifact-share-popover";

type Shares = Awaited<ReturnType<typeof listArtifactShares>>;

/** A `listArtifactShares` answer the test settles by hand. */
function deferred(): { promise: Promise<Shares>; resolve: (rows: Shares) => void } {
	let resolve: (rows: Shares) => void = () => {};
	const promise = new Promise<Shares>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

const ORG_SHARED: Shares = [{ scopeType: "org", scopeId: null }];

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(getArtifactShareAccess).mockResolvedValue({ canShare: true, teams: [], roles: [] });
});

/** Render the popover and wait for its Share trigger (shown once access resolves). */
async function renderPopover(): Promise<HTMLElement> {
	render(<ArtifactSharePopover artifactId="a1" />);
	return screen.findByRole("button", { name: /^Share$/ });
}

describe("ArtifactSharePopover — loading per open", () => {
	// Fails if the loading state is not reset on a reopen: the second open would show the first
	// open's targets while its own list is still in flight.
	it("reads as loading on every open until that open's list lands", async () => {
		const first = deferred();
		const second = deferred();
		vi.mocked(listArtifactShares).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const user = userEvent.setup();
		const trigger = await renderPopover();

		await user.click(trigger);
		expect(await screen.findByText("Loading who has access")).toBeInTheDocument();
		first.resolve(ORG_SHARED);
		expect(await screen.findByRole("button", { name: "Stop sharing with Everyone in org" })).toBeInTheDocument();

		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByText("Share artifact")).not.toBeInTheDocument());
		await user.click(trigger);
		expect(await screen.findByText("Loading who has access")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Stop sharing with Everyone in org" })).not.toBeInTheDocument();

		second.resolve([]);
		expect(await screen.findByRole("button", { name: "Share with Everyone in org" })).toBeInTheDocument();
	});

	// Fails if a late answer is not dropped: the first open's list (org shared) would land in the
	// second open and show a target as shared that the second open's own answer says is not.
	it("drops an answer that lands after its open was closed", async () => {
		const first = deferred();
		const second = deferred();
		vi.mocked(listArtifactShares).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const user = userEvent.setup();
		const trigger = await renderPopover();

		await user.click(trigger);
		expect(await screen.findByText("Loading who has access")).toBeInTheDocument();
		await user.keyboard("{Escape}");
		await waitFor(() => expect(screen.queryByText("Share artifact")).not.toBeInTheDocument());
		await user.click(trigger);
		expect(await screen.findByText("Loading who has access")).toBeInTheDocument();

		// The second open's own answer lands first; the first open's answer arrives after it.
		second.resolve([]);
		expect(await screen.findByRole("button", { name: "Share with Everyone in org" })).toBeInTheDocument();
		first.resolve(ORG_SHARED);
		// Let the late answer's whole promise chain settle inside act before reading the screen.
		await act(async () => {
			await first.promise;
		});
		await act(async () => {});
		expect(screen.getByRole("button", { name: "Share with Everyone in org" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Stop sharing with Everyone in org" })).not.toBeInTheDocument();
	});
});

describe("ArtifactSharePopover — a share in flight (#7871)", () => {
	// Fails if the in-flight row falls back to a spinning Loader2 with no word for what it is doing.
	it("names the share on its row and swaps the check box for the inline [·] mark", async () => {
		vi.mocked(listArtifactShares).mockResolvedValue([]);
		let settle: () => void = () => {};
		vi.mocked(shareArtifact).mockReturnValue(
			new Promise<void>((r) => {
				settle = r;
			}),
		);
		const user = userEvent.setup();
		const trigger = await renderPopover();
		await user.click(trigger);
		await user.click(await screen.findByRole("button", { name: "Share with Everyone in org" }));

		// The row has flipped optimistically, so its name already reads as the shared state.
		const row = screen.getByRole("button", { name: "Stop sharing with Everyone in org" });
		expect(row).toHaveAttribute("aria-busy", "true");
		expect(row).toHaveTextContent("Sharing…");
		expect(screen.getByText("Sharing with Everyone in org")).toBeInTheDocument();
		expect(row.querySelector('[data-slot="mark-loader"]')).not.toBeNull();
		expect(row.querySelector(".animate-spin")).toBeNull();

		await act(async () => {
			settle();
		});
		expect(screen.getByRole("button", { name: "Stop sharing with Everyone in org" })).not.toHaveAttribute(
			"aria-busy",
		);
	});
});
