// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The account dialog's words and picture (R6 S-11). A person with no picture used to request
// `/generic-user-avatar.png`, which the console does not ship — a 404 on every open. One field was
// "Full Name" in one place and "Display Name" in the next, and the title and the button were in
// title case against the sentence case everywhere else.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

vi.mock("@/lib/auth/client", () => ({
	authClient: { listAccounts: vi.fn(async () => ({ data: [], error: null })), updateUser: vi.fn() },
	liveSession: {
		subscribe: () => () => {},
		get: () => ({ data: null, isPending: true, error: null }),
		onPossibleChange: () => () => {},
	},
}));
vi.mock("@/app/server/actions/privacy/self-serve", () => ({ requestMyErasure: vi.fn() }));

import { ViewerProvider } from "@/components/providers/viewer-provider";
import { AccountSettingsDialog } from "@/components/shell/account-settings-dialog";

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada Lovelace",
	email: "ada@acme.test",
	image: null,
	createdAt: new Date("2026-01-15T09:00:00.000Z"),
};

/** Renders the open dialog for `viewer`. */
function renderDialog(viewer: Viewer): HTMLElement {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ViewerProvider viewer={viewer}>
				<AccountSettingsDialog open onOpenChange={() => {}} />
			</ViewerProvider>
		</QueryClientProvider>,
	);
	return screen.getByRole("dialog");
}

describe("the account dialog's copy and avatar (S-11)", () => {
	it("a person with no picture requests no placeholder image, and is shown their initial", () => {
		const dialog = renderDialog(ADA);
		const images = Array.from(dialog.querySelectorAll("img")).map((img) => img.getAttribute("src"));
		expect(images).toEqual([]);
		expect(dialog).toHaveTextContent("A");
		expect(dialog.innerHTML).not.toContain("generic-user-avatar");
	});

	it("names the title and the save button in sentence case", () => {
		renderDialog(ADA);
		expect(screen.getByRole("heading", { name: "Account settings" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
	});

	it("calls the name field one thing: Display name", () => {
		const dialog = renderDialog(ADA);
		expect(screen.getByLabelText("Display name")).toBeInTheDocument();
		expect(dialog.textContent).not.toMatch(/Full Name/i);
	});
});
