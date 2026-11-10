// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #6109, the client half: when the send-code route answers SIGN_IN_CODE_SEND_FAILED (the
// server half is sign-in-code-send-failure.test.ts, which pins the same literal), the sign-in
// form must stay on the email step and say the code was not sent — never advance to
// "We sent a 6-digit code".

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	sendVerificationOtp: vi.fn(),
	requestEmailCode: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams("email=known@example.com"),
	useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signIn: { social: vi.fn(), emailOtp: vi.fn() },
		emailOtp: { sendVerificationOtp: h.sendVerificationOtp },
	},
}));
vi.mock("@/app/server/actions/auth", () => ({ requestEmailCode: h.requestEmailCode }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { AuthForm } from "@/components/auth/auth-form";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

/** Submits the prefilled email step. */
function submitEmail(): void {
	fireEvent.click(screen.getByRole("button", { name: /continue with email/i }));
}

beforeEach(() => {
	// The code step mounts input-otp, which probes layout with document.elementFromPoint on
	// a timer. jsdom does no layout and does not implement it.
	document.elementFromPoint = () => null;
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
	h.requestEmailCode.mockReset();
	h.requestEmailCode.mockResolvedValue({ outcome: "send-otp" });
	h.sendVerificationOtp.mockReset();
});

describe("AuthForm — a sign-in code that was not sent (#6109)", () => {
	it("says so and stays on the email step", async () => {
		h.sendVerificationOtp.mockResolvedValue({
			data: null,
			error: {
				status: 503,
				statusText: "Service Unavailable",
				code: "SIGN_IN_CODE_SEND_FAILED",
				message: "anything the server says",
			},
		});
		render(<AuthForm mode="login" />);

		submitEmail();

		const alert = await screen.findByRole("alert");
		// The form owns this copy; it is not whatever text the response carried.
		expect(alert.textContent).toBe("We couldn’t send the code — try again.");
		expect(screen.queryByText(/we sent a 6-digit code/i)).toBeNull();
		expect(screen.getByRole("button", { name: /continue with email/i })).toBeTruthy();
	});

	it("advances to the code step when the code was sent", async () => {
		h.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
		render(<AuthForm mode="login" />);

		submitEmail();

		await waitFor(() => expect(screen.getByText(/we sent a 6-digit code/i)).toBeTruthy());
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
