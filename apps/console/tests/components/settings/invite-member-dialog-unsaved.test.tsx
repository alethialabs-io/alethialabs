// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB2 (R6 E-17, E-24). Closing the invite dialog with addresses typed asks first, with the
// console's one discard question; an untouched dialog closes at once. Each row's remove button
// names its row.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/auth/client", () => ({ authClient: { organization: { inviteMember: vi.fn() } } }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/lib/query/use-members-query", () => ({
	useInviteContextQuery: () => ({ data: undefined }),
}));

import { InviteMemberDialog } from "@/components/settings/members/invite-member-dialog";

/** The dialog, controlled open, inside a query client. */
function renderOpen(onOpenChange: (open: boolean) => void) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<InviteMemberDialog open onOpenChange={onOpenChange} />
		</QueryClientProvider>,
	);
}

describe("InviteMemberDialog unsaved addresses (R6 E-17)", () => {
	it("an untouched dialog closes at once", async () => {
		const onOpenChange = vi.fn();
		renderOpen(onOpenChange);
		await userEvent.setup().keyboard("{Escape}");
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("a typed address asks before it is dropped; Discard closes", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		renderOpen(onOpenChange);
		await user.type(screen.getByRole("textbox", { name: "Email address 1" }), "ada@example.com");
		await user.keyboard("{Escape}");
		const prompt = await screen.findByRole("alertdialog");
		expect(prompt).toHaveTextContent("Discard these invitations?");
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
		await user.click(within(prompt).getByRole("button", { name: "Discard" }));
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});

describe("InviteMemberDialog row names (R6 E-24)", () => {
	it("each row's remove button names its row", async () => {
		const user = userEvent.setup();
		renderOpen(vi.fn());
		await user.click(screen.getByRole("button", { name: /add another/i }));
		expect(screen.getByRole("button", { name: "Remove invite 1" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Remove invite 2" })).toBeInTheDocument();
	});
});
