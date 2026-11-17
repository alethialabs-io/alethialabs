// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6756: the console's one session-ended surface. It follows the session state, Escape does not
// close it, and its link signs in and comes back to the address the person was on. "Stay on this
// page" swaps the dialog for a banner that cannot be closed, so the page can be copied from; a new
// report that the session has ended brings the dialog back.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionEnded } from "@/components/shell/session-ended";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

/** The dialog's sign-in link. */
async function signInLink(): Promise<HTMLAnchorElement | null> {
	const dialog = await screen.findByRole("alertdialog");
	return within(dialog).getByText("Sign in").closest("a");
}

beforeEach(() => {
	useSessionState.setState({ status: "active", dismissed: false });
	window.history.replaceState(null, "", "/acme/~/jobs?status=failed");
});

describe("SessionEnded", () => {
	it("renders nothing while the session is active", () => {
		render(<SessionEnded />);
		expect(screen.queryByRole("alertdialog")).toBeNull();
	});

	it("shows the dialog when the session ends, with a link back to this address", async () => {
		render(<SessionEnded />);
		act(() => endSession());
		const dialog = await screen.findByRole("alertdialog");
		expect(dialog).toHaveTextContent("Your session has ended");
		expect((await signInLink())?.getAttribute("href")).toBe("/login?next=%2Facme%2F~%2Fjobs%3Fstatus%3Dfailed");
	});

	it("opens with focus on \"Sign in\", the primary action, which comes before \"Stay on this page\"", async () => {
		render(<SessionEnded />);
		act(() => endSession());
		const link = await signInLink();
		expect(link).not.toBeNull();
		await waitFor(() => expect(link).toHaveFocus());
		const stay = within(screen.getByRole("alertdialog")).getByText("Stay on this page");
		// Sign in precedes the secondary action in the document, which is what gives it the focus.
		expect(link?.compareDocumentPosition(stay)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	});

	it("stays open on Escape: there is nothing to go back to", async () => {
		render(<SessionEnded />);
		act(() => endSession());
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});

	it("\"Stay on this page\" swaps the dialog for a banner with the same link and no way to close it", async () => {
		render(<SessionEnded />);
		act(() => endSession());
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.click(within(dialog).getByText("Stay on this page"));

		expect(screen.queryByRole("alertdialog")).toBeNull();
		const banner = screen.getByRole("alert");
		expect(banner).toHaveTextContent("Your session has ended. Sign in to continue.");
		expect(within(banner).getByText("Sign in").closest("a")?.getAttribute("href")).toBe(
			"/login?next=%2Facme%2F~%2Fjobs%3Fstatus%3Dfailed",
		);
		// The link is the banner's only control: nothing closes it.
		expect(banner.querySelectorAll("button, a, [role='button']")).toHaveLength(1);
		// The session is still ended; only its presentation changed.
		expect(useSessionState.getState()).toMatchObject({ status: "ended", dismissed: true });
	});

	it("a new report that the session has ended brings the dialog back over the banner", async () => {
		render(<SessionEnded />);
		act(() => endSession());
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByText("Stay on this page"));
		expect(screen.getByRole("alert")).toBeInTheDocument();

		act(() => endSession());
		expect(await screen.findByRole("alertdialog")).toHaveTextContent("Your session has ended");
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("the layout's form offers no \"Stay on this page\": there is no page behind it", async () => {
		render(<SessionEnded ended />);
		const dialog = await screen.findByRole("alertdialog");
		expect(within(dialog).queryByText("Stay on this page")).toBeNull();
	});

	it("shows the same dialog when the layout says the request had no session", async () => {
		render(<SessionEnded ended />);
		expect(useSessionState.getState().status).toBe("active");
		expect(await screen.findByRole("alertdialog")).toHaveTextContent("Your session has ended");
		expect((await signInLink())?.getAttribute("href")).toBe("/login?next=%2Facme%2F~%2Fjobs%3Fstatus%3Dfailed");
	});
});
