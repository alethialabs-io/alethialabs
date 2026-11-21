// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// `/invites/accept` (CON-L2, #6926):
//   A-02  accepting lands in the inviting organization and completes the invitee's setup;
//   A-08  no auth-server message reaches the screen — refusals are this route's own sentences;
//   A-19  one skeleton from the first paint to the card;
//   A-20  the card names the organization and the inviter, an invitation for another account says
//         so instead of offering Accept, a refused decline is shown, and a dead link has a way on.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

const h = vi.hoisted(() => {
	const state: { search: string; viewer: Viewer | null } = { search: "", viewer: null };
	return {
		state,
		replace: vi.fn(),
		getInvitation: vi.fn(),
		acceptInvitation: vi.fn(),
		rejectInvitation: vi.fn(),
		signOut: vi.fn(),
		markOnboardingComplete: vi.fn(),
		hardNavigate: vi.fn(),
	};
});

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(h.state.search),
	useRouter: () => ({ push: vi.fn(), replace: h.replace }),
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: h.state.viewer, isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signOut: h.signOut,
		organization: {
			getInvitation: h.getInvitation,
			acceptInvitation: h.acceptInvitation,
			rejectInvitation: h.rejectInvitation,
		},
	},
}));
vi.mock("@/app/server/actions/onboarding", () => ({
	markOnboardingComplete: h.markOnboardingComplete,
}));
vi.mock("@/components/shell/hard-navigate", () => ({ hardNavigate: h.hardNavigate }));

import AcceptInvitePage from "@/app/(public)/invites/accept/page";
import { invitationActionFailure, readInvitation } from "@/app/(public)/invites/accept/invitation";

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada",
	email: "ada@example.com",
	image: null,
	createdAt: new Date("2026-01-01T00:00:00Z"),
};

/** The body the organization plugin answers a read with. */
const INVITATION = {
	id: "inv-1",
	email: "ada@example.com",
	role: "member",
	organizationId: "org-1",
	inviterId: "u-grace",
	status: "pending",
	expiresAt: "2026-12-01T00:00:00Z",
	organizationName: "Acme Robotics",
	organizationSlug: "acme",
	inviterEmail: "grace@acme.test",
};

/** An auth-client failure with `code`. */
function refused(code: string, status = 400) {
	return { data: null, error: { code, status, statusText: "", message: "server text" } };
}

/** Renders the route with a fresh query cache. */
function renderPage() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<AcceptInvitePage />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	h.state.search = "token=inv-1&email=ada%40example.com";
	h.state.viewer = ADA;
	for (const fn of [
		h.replace,
		h.getInvitation,
		h.acceptInvitation,
		h.rejectInvitation,
		h.signOut,
		h.markOnboardingComplete,
		h.hardNavigate,
	]) {
		fn.mockReset();
	}
	h.getInvitation.mockResolvedValue({ data: INVITATION, error: null });
	h.markOnboardingComplete.mockResolvedValue(undefined);
});

describe("reading an invitation", () => {
	it.each([
		["YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", 403, "not-recipient"],
		["EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION", 403, "verify-email"],
		["INVITATION_NOT_FOUND", 400, "unavailable"],
		["INVITER_IS_NO_LONGER_A_MEMBER_OF_THE_ORGANIZATION", 400, "unavailable"],
		["SOMETHING_ELSE", 500, "failed"],
	])("maps %s to %s", async (code, status, kind) => {
		h.getInvitation.mockResolvedValue(refused(code, status));
		expect((await readInvitation("inv-1")).kind).toBe(kind);
	});

	it("answers a call that throws as a failure to retry", async () => {
		h.getInvitation.mockRejectedValue(new TypeError("Failed to fetch"));
		expect(await readInvitation("inv-1")).toEqual({ kind: "failed" });
	});

	it("never passes the auth server's message through an action failure", async () => {
		const messages = await Promise.all(
			[
				"YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
				"INVITATION_NOT_FOUND",
				"ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
				"UNKNOWN",
			].map((code) => invitationActionFailure("accept", async () => refused(code))),
		);
		expect(messages.filter((m) => m === null || m.includes("server text"))).toEqual([]);
		expect(await invitationActionFailure("decline", async () => ({ error: null }))).toBeNull();
	});
});

describe("/invites/accept", () => {
	it("names the organization and who invited you", async () => {
		renderPage();

		expect(
			await screen.findByRole("heading", { name: /invited to join Acme Robotics/i }),
		).toBeInTheDocument();
		expect(screen.getByText("grace@acme.test")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
	});

	it("draws the card's skeleton while the invitation is read", () => {
		h.getInvitation.mockReturnValue(new Promise(() => {}));
		const { container } = renderPage();

		expect(container.querySelector('[data-slot="skeleton-root"]')).not.toBeNull();
		expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
	});

	it("accepts, completes setup and lands in the inviting organization", async () => {
		h.acceptInvitation.mockResolvedValue({ data: {}, error: null });
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: "Accept invitation" }));

		await waitFor(() => expect(h.hardNavigate).toHaveBeenCalledWith("/acme"));
		expect(h.acceptInvitation).toHaveBeenCalledWith({ invitationId: "inv-1" });
		expect(h.markOnboardingComplete).toHaveBeenCalledTimes(1);
	});

	it("still lands in the organization when completing setup fails", async () => {
		h.acceptInvitation.mockResolvedValue({ data: {}, error: null });
		h.markOnboardingComplete.mockRejectedValue(new Error("masked"));
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: "Accept invitation" }));

		await waitFor(() => expect(h.hardNavigate).toHaveBeenCalledWith("/acme"));
	});

	it("shows a refused accept in place, in its own words", async () => {
		h.acceptInvitation.mockResolvedValue(refused("ORGANIZATION_MEMBERSHIP_LIMIT_REACHED", 403));
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: "Accept invitation" }));

		expect((await screen.findByRole("alert")).textContent).toMatch(/no free seats/i);
		expect(screen.queryByText("server text")).toBeNull();
		expect(h.hardNavigate).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Accept invitation" })).toBeEnabled();
	});

	it("shows a refused decline instead of leaving as if it worked", async () => {
		h.rejectInvitation.mockResolvedValue(refused("SOMETHING_ELSE", 500));
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: "Decline" }));

		expect((await screen.findByRole("alert")).textContent).toBe(
			"We couldn’t decline the invitation. Try again.",
		);
		expect(screen.queryByText(/invitation declined/i)).toBeNull();
	});

	it("confirms a decline and offers the way back", async () => {
		h.rejectInvitation.mockResolvedValue({ data: {}, error: null });
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: "Decline" }));

		expect(await screen.findByRole("heading", { name: /invitation declined/i })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /go to alethia/i })).toHaveAttribute("href", "/dashboard");
	});

	it("tells the wrong account so, names both addresses, and offers no Accept", async () => {
		h.state.search = "token=inv-1&email=grace%40elsewhere.test";
		h.getInvitation.mockResolvedValue(refused("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", 403));
		renderPage();

		expect(
			await screen.findByRole("heading", { name: /this invitation is for another account/i }),
		).toBeInTheDocument();
		expect(screen.getByText(/sent to grace@elsewhere\.test/i)).toBeInTheDocument();
		expect(screen.getByText(/signed in as ada@example\.com/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Accept invitation" })).toBeNull();
	});

	it("switching account returns to sign-in with this invitation as next", async () => {
		h.getInvitation.mockResolvedValue(refused("YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", 403));
		h.signOut.mockResolvedValue({ data: { success: true }, error: null });
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: /sign out and switch account/i }));

		await waitFor(() => expect(h.hardNavigate).toHaveBeenCalledTimes(1));
		const target = new URL(String(h.hardNavigate.mock.calls[0]?.[0]), "https://console.test");
		expect(target.pathname).toBe("/login");
		expect(target.searchParams.get("next")).toBe("/invites/accept?token=inv-1&email=ada%40example.com");
		expect(target.searchParams.get("email")).toBe("ada@example.com");
	});

	it("says an expired or used invitation is no longer valid, with a way on", async () => {
		h.getInvitation.mockResolvedValue(refused("INVITATION_NOT_FOUND", 400));
		renderPage();

		expect(await screen.findByRole("heading", { name: /no longer valid/i })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /go to alethia/i })).toBeInTheDocument();
	});

	it("offers a retry when the read failed, and the retry reads again", async () => {
		h.getInvitation.mockResolvedValueOnce(refused("SOMETHING_ELSE", 500));
		const user = userEvent.setup();
		renderPage();

		await user.click(await screen.findByRole("button", { name: /try again/i }));

		expect(
			await screen.findByRole("heading", { name: /invited to join Acme Robotics/i }),
		).toBeInTheDocument();
		expect(h.getInvitation).toHaveBeenCalledTimes(2);
	});

	it("gives a link with no token a way on", () => {
		h.state.search = "";
		renderPage();

		expect(screen.getByRole("heading", { name: /invalid invitation/i })).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /go to alethia/i })).toBeInTheDocument();
	});

	it("sends a signed-out visitor to sign in, carrying the invitation and the address", async () => {
		h.state.viewer = null;
		renderPage();

		await waitFor(() => expect(h.replace).toHaveBeenCalledTimes(1));
		const target = new URL(String(h.replace.mock.calls[0]?.[0]), "https://console.test");
		expect(target.pathname).toBe("/login");
		expect(target.searchParams.get("next")).toBe("/invites/accept?token=inv-1&email=ada%40example.com");
		expect(target.searchParams.get("email")).toBe("ada@example.com");
		expect(h.getInvitation).not.toHaveBeenCalled();
	});
});
