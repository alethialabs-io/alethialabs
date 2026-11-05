// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6459 — two pieces of the sign-in form's initial state that used to be set from effects:
//   - `?provider=github` opens the form already signing in with GitHub and starts the hand-off
//     exactly once;
//   - a remembered address seeds the email field after hydration, unless `?email=` or anything
//     typed already filled it.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ params: "", social: vi.fn() }));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(h.params),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signIn: { social: h.social, emailOtp: vi.fn() },
		emailOtp: { sendVerificationOtp: vi.fn() },
	},
}));
vi.mock("@/app/server/actions/auth", () => ({ requestEmailCode: vi.fn() }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { AuthForm } from "@/components/auth/auth-form";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

beforeEach(() => {
	h.params = "";
	h.social.mockReset();
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
});

describe("AuthForm — the ?provider= hint", () => {
	it("opens signing in with the hinted provider and starts its hand-off once", async () => {
		h.params = "provider=github";
		// A pending hand-off: the provider has not answered, so the form stays marked.
		h.social.mockReturnValue(new Promise(() => {}));
		render(<AuthForm mode="login" />);

		// The hand-off remembers the provider, so its tile may name itself "(last used)".
		expect(screen.getByRole("button", { name: /^GitHub/ })).toBeDisabled();
		await waitFor(() => expect(h.social).toHaveBeenCalledTimes(1));
		expect(h.social.mock.calls[0]?.[0]).toMatchObject({ provider: "github" });
	});

	it("rolls the form back when the hinted provider refuses", async () => {
		h.params = "provider=github";
		h.social.mockResolvedValue({ data: null, error: { message: "nope" } });
		render(<AuthForm mode="login" />);

		expect(await screen.findByText("nope")).toBeTruthy();
		expect(screen.getByRole("button", { name: /^GitHub/ })).not.toBeDisabled();
	});

	it("ignores a provider outside the allowlist", () => {
		h.params = "provider=evil";
		render(<AuthForm mode="login" />);

		expect(screen.getByRole("button", { name: "GitHub" })).not.toBeDisabled();
		expect(h.social).not.toHaveBeenCalled();
	});
});

describe("AuthForm — the remembered email", () => {
	it("seeds the email field with the remembered address", () => {
		useAuthPrefsStore.setState({ lastMethod: "email", lastEmail: "bob@x.com" });
		render(<AuthForm mode="login" />);
		fireEvent.click(screen.getByRole("button", { name: /continue with email/i }));

		expect(screen.getByLabelText("Work email")).toHaveValue("bob@x.com");
	});

	it("lets ?email= win over the remembered address", () => {
		h.params = "email=alice@y.com";
		useAuthPrefsStore.setState({ lastMethod: "email", lastEmail: "bob@x.com" });
		render(<AuthForm mode="login" />);

		expect(screen.getByLabelText("Work email")).toHaveValue("alice@y.com");
	});
});
