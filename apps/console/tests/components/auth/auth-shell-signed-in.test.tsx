// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A-10 (#6926): every screen past sign-in that wears AuthShell — accepting terms, onboarding, an
// invitation, the CLI hand-off, the trial refusal — says who is signed in and offers Sign out.
// The two front doors (they pass the "New to Alethia?" switch) show no account, and neither does a
// screen where nobody is signed in.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/viewer";

const h = vi.hoisted(() => {
	const state: { viewer: Viewer | null } = { viewer: null };
	return { state, signOut: vi.fn(), hardNavigate: vi.fn(), toastError: vi.fn() };
});

vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: h.state.viewer, isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({ authClient: { signOut: h.signOut } }));
vi.mock("@/components/shell/hard-navigate", () => ({ hardNavigate: h.hardNavigate }));
vi.mock("sonner", () => ({ toast: { error: h.toastError } }));

import { AUTH_SHELL_SIGN_OUT_FAILED, AuthShell } from "@/components/auth/auth-shell";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

const ADA: Viewer = {
	id: "u-ada",
	name: "Ada",
	email: "ada@example.com",
	image: null,
	createdAt: new Date("2026-01-01T00:00:00Z"),
};

beforeEach(() => {
	h.state.viewer = ADA;
	h.signOut.mockReset();
	h.hardNavigate.mockReset();
	h.toastError.mockReset();
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: "email", lastEmail: "ada@example.com" });
});

describe("AuthShell — the signed-in line (A-10)", () => {
	it("names the signed-in account and offers Sign out on a screen past sign-in", () => {
		render(<AuthShell>content</AuthShell>);

		expect(screen.getByText("ada@example.com")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
	});

	it("shows no account on a front door, which carries the switch link instead", () => {
		render(
			<AuthShell switchPrompt="New to Alethia?" switchHref="/signup" switchLabel="Create an account">
				content
			</AuthShell>,
		);

		expect(screen.queryByText("ada@example.com")).toBeNull();
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});

	it("shows nothing while nobody is signed in", () => {
		h.state.viewer = null;
		render(<AuthShell>content</AuthShell>);

		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});

	it("signs out the way the console does: ends the session, forgets the account, leaves", async () => {
		h.signOut.mockResolvedValue({ data: { success: true }, error: null });
		const user = userEvent.setup();
		render(<AuthShell>content</AuthShell>);

		await user.click(screen.getByRole("button", { name: "Sign out" }));

		await waitFor(() => expect(h.hardNavigate).toHaveBeenCalledWith("/"));
		expect(h.signOut).toHaveBeenCalledTimes(1);
		expect(useAuthPrefsStore.getState().lastEmail).toBeNull();
	});

	it("stays signed in and says so when the session could not be ended", async () => {
		h.signOut.mockResolvedValue({ data: null, error: { status: 500 } });
		const user = userEvent.setup();
		render(<AuthShell>content</AuthShell>);

		await user.click(screen.getByRole("button", { name: "Sign out" }));

		await waitFor(() => expect(h.toastError).toHaveBeenCalledWith(AUTH_SHELL_SIGN_OUT_FAILED));
		expect(h.hardNavigate).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
		expect(useAuthPrefsStore.getState().lastEmail).toBe("ada@example.com");
	});

	it("does not sign out twice on a double press", async () => {
		h.signOut.mockReturnValue(new Promise(() => {}));
		const user = userEvent.setup();
		render(<AuthShell>content</AuthShell>);

		const button = screen.getByRole("button", { name: "Sign out" });
		await user.click(button);
		await user.click(button);

		expect(h.signOut).toHaveBeenCalledTimes(1);
		expect(button).toBeDisabled();
	});
});
