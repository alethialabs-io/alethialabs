// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6756: the console's one session-ended dialog. It follows the session state, it cannot be
// dismissed, and its link signs in and comes back to the address the person was on.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionEnded } from "@/components/shell/session-ended";
import { endSession, useSessionState } from "@/lib/stores/use-session-state";

/** The dialog's sign-in link. */
async function signInLink(): Promise<HTMLAnchorElement | null> {
	const dialog = await screen.findByRole("alertdialog");
	return within(dialog).getByText("Sign in").closest("a");
}

beforeEach(() => {
	useSessionState.setState({ status: "active" });
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

	it("stays open on Escape: there is nothing to go back to", async () => {
		render(<SessionEnded />);
		act(() => endSession());
		const dialog = await screen.findByRole("alertdialog");
		fireEvent.keyDown(dialog, { key: "Escape" });
		fireEvent.keyDown(document.body, { key: "Escape" });
		expect(screen.getByRole("alertdialog")).toBeInTheDocument();
	});

	it("shows the same dialog when the layout says the request had no session", async () => {
		render(<SessionEnded ended />);
		expect(useSessionState.getState().status).toBe("active");
		expect(await screen.findByRole("alertdialog")).toHaveTextContent("Your session has ended");
		expect((await signInLink())?.getAttribute("href")).toBe("/login?next=%2Facme%2F~%2Fjobs%3Fstatus%3Dfailed");
	});
});
