// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// REL-L10 (#6911), the client half: the sign-in form says WHY a new account was refused — on the
// code step (emailed-code sign-up) and on the redirect back from an OAuth provider — using the copy
// from lib/auth/signup-guard/codes.ts, the module the server answers from. The challenge widget is
// off here (no site key in the runtime env), which is also what every existing form test relies on.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	search: "email=new@example.com",
	sendVerificationOtp: vi.fn(),
	signInEmailOtp: vi.fn(),
	requestEmailCode: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(h.search),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signIn: { social: vi.fn(), emailOtp: h.signInEmailOtp },
		emailOtp: { sendVerificationOtp: h.sendVerificationOtp },
	},
}));
vi.mock("@/app/server/actions/auth", () => ({ requestEmailCode: h.requestEmailCode }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { AuthForm } from "@/components/auth/auth-form";
import {
	CHALLENGE_REFUSED_MESSAGE,
	SIGNUP_DISPOSABLE_EMAIL,
	SIGNUP_NETWORK_LIMIT,
	SIGNUP_REFUSAL_MESSAGES,
	type SignupRefusalCode,
} from "@/lib/auth/signup-guard/codes";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

/** Both refusal codes — each behaviour is shown on two fixture values. */
const REFUSALS: SignupRefusalCode[] = [SIGNUP_DISPOSABLE_EMAIL, SIGNUP_NETWORK_LIMIT];

beforeEach(() => {
	document.elementFromPoint = () => null;
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
	h.search = "email=new@example.com";
	h.requestEmailCode.mockReset();
	h.requestEmailCode.mockResolvedValue({ outcome: "send-otp" });
	h.sendVerificationOtp.mockReset();
	h.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
	h.signInEmailOtp.mockReset();
});

/** Sends the code for the prefilled address and enters a full code. */
async function enterCode(): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: /continue with email/i }));
	await waitFor(() => expect(screen.getByText(/we sent a 6-digit code/i)).toBeTruthy());
	fireEvent.paste(window, { clipboardData: { getData: () => "123456" } });
}

describe("AuthForm — a refused new account (REL-L10)", () => {
	it.each(REFUSALS)("says why on the code step (%s)", async (code) => {
		h.signInEmailOtp.mockResolvedValue({
			data: null,
			error: { status: 403, statusText: "", code, message: "server text" },
		});
		render(<AuthForm mode="signup" />);

		await enterCode();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe(SIGNUP_REFUSAL_MESSAGES[code]);
	});

	it("still says a wrong code is a wrong code", async () => {
		h.signInEmailOtp.mockResolvedValue({
			data: null,
			error: { status: 400, statusText: "", code: "INVALID_OTP", message: "Invalid OTP" },
		});
		render(<AuthForm mode="signup" />);

		await enterCode();

		expect((await screen.findByRole("alert")).textContent).toBe("That code didn’t work — try again.");
	});

	it.each(REFUSALS)(
		"says why after an OAuth sign-up comes back refused (%s)",
		(code) => {
			// Better Auth appends its own `error` after the form's `?error=oauth`.
			h.search = `error=oauth&error=${code}&error_description=ignored`;
			render(<AuthForm mode="signup" />);
			expect(screen.getByRole("alert").textContent).toBe(SIGNUP_REFUSAL_MESSAGES[code]);
			expect(screen.queryByText("ignored")).toBeNull();
		},
	);

	it("shows the generic provider message when the appended code is not allowlisted", () => {
		h.search = "error=oauth&error=toString";
		render(<AuthForm mode="signup" />);
		expect(screen.getByRole("alert").textContent).toBe(
			"We couldn’t sign you in with that provider — try again.",
		);
	});

	it.each(["MISSING_RESPONSE", "VERIFICATION_FAILED"])(
		"asks for the security check when code issuance refuses the challenge (%s)",
		async (code) => {
			h.sendVerificationOtp.mockResolvedValue({
				data: null,
				error: { status: 400, statusText: "", code, message: "plugin text" },
			});
			render(<AuthForm mode="signup" />);
			fireEvent.click(screen.getByRole("button", { name: /continue with email/i }));
			expect((await screen.findByRole("alert")).textContent).toBe(CHALLENGE_REFUSED_MESSAGE);
		},
	);
});
