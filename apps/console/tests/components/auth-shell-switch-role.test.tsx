// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The /login "no account" screen offers ONE button called "Create an account" (#5007).
//
// It offered two. The shell's topbar switch is a `<Link>` rendered through base-ui's Button with
// `nativeButton={false}`, and base-ui stamps `role="button"` on any non-native render — so the
// topbar's "Create an account" link announced itself as a BUTTON, beside the no-account card's own
// "Create an account" button. Two buttons of one name that do different things (the card's carries
// the email the visitor just typed; the topbar's does not) cannot be told apart by a screen reader,
// and the release gate's negatives spec died on exactly that in strict mode (run 35917620550).
//
// This renders the real composition /login renders — AuthShell around AuthForm — and walks it to the
// no-account step, because the defect only exists where the two meet: neither component alone has
// a duplicate.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(""),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signIn: { social: vi.fn(), emailOtp: vi.fn() },
		emailOtp: { sendVerificationOtp: vi.fn() },
	},
}));
const requestEmailCode = vi.fn();
vi.mock("@/app/server/actions/auth", () => ({
	requestEmailCode: (input: { email: string; mode: string }) => requestEmailCode(input),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { AuthForm } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

beforeEach(() => {
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
	requestEmailCode.mockReset();
});

/** Renders /login's composition: the shell's "Create an account" switch around the login form. */
function renderLogin(): void {
	render(
		<AuthShell switchPrompt="New to Alethia?" switchHref="/signup" switchLabel="Create an account">
			<AuthForm mode="login" />
		</AuthShell>,
	);
}

describe("AuthShell — the topbar switch is a link, not a second button", () => {
	it("names the switch as the link it is", () => {
		renderLogin();

		const link = screen.getByRole("link", { name: /create an account/i });
		expect(link.getAttribute("href")).toBe("/signup");
		// And not ALSO as a button: before the fix this query found the same anchor.
		expect(screen.queryByRole("button", { name: /create an account/i })).toBeNull();
	});

	it("leaves exactly one 'Create an account' BUTTON on the no-account step", async () => {
		requestEmailCode.mockResolvedValue({ outcome: "no-account" });
		const user = userEvent.setup();
		renderLogin();

		await user.click(screen.getByRole("button", { name: /continue with email/i }));
		const email = document.querySelector<HTMLInputElement>("#email");
		if (!email) throw new Error("the email step rendered no #email input");
		await user.type(email, "nobody@alethia.test");
		await user.click(screen.getByRole("button", { name: /continue with email/i }));

		await screen.findByRole("heading", { name: /no account for this email/i });
		// `getAllByRole` rather than `getByRole`, so a regression reports the COUNT it found.
		expect(screen.getAllByRole("button", { name: /create an account/i })).toHaveLength(1);
		expect(screen.getAllByRole("link", { name: /create an account/i })).toHaveLength(1);
	});
});
