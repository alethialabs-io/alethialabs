// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-L2 (#6926): the sign-in form's entry paths.
//
//   A-03  a new account goes through onboarding carrying `next`, by email exactly as by provider —
//         except an invitation, which a new account goes straight to;
//   A-07  a server action that throws never puts the framework's masked sentence on screen;
//   A-08  the auth server's own `message` is never shown;
//   A-09  an expired or exhausted code says so and points at Resend;
//   A-13  SSO is a working entry that hands off to /sso/<slug>, not a disabled "Soon" tile.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	search: "",
	push: vi.fn(),
	sendVerificationOtp: vi.fn(),
	signInEmailOtp: vi.fn(),
	requestEmailCode: vi.fn(),
	hardNavigate: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(h.search),
	useRouter: () => ({ push: h.push, replace: vi.fn() }),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		signIn: { social: vi.fn(), emailOtp: h.signInEmailOtp },
		emailOtp: { sendVerificationOtp: h.sendVerificationOtp },
	},
}));
vi.mock("@/app/server/actions/auth", () => ({ requestEmailCode: h.requestEmailCode }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/components/shell/hard-navigate", () => ({ hardNavigate: h.hardNavigate }));

import { AuthForm, newAccountDestination, ssoSlugFrom } from "@/components/auth/auth-form";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

beforeEach(() => {
	document.elementFromPoint = () => null;
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
	h.search = "email=ada@example.com";
	h.push.mockReset();
	h.hardNavigate.mockReset();
	h.requestEmailCode.mockReset();
	h.requestEmailCode.mockResolvedValue({ outcome: "send-otp" });
	h.sendVerificationOtp.mockReset();
	h.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
	h.signInEmailOtp.mockReset();
});

/** Submits the prefilled email step. */
function submitEmail(): void {
	fireEvent.click(screen.getByRole("button", { name: /continue with email/i }));
}

/** Sends the code and pastes a full one. */
async function enterCode(code = "123456"): Promise<void> {
	submitEmail();
	await waitFor(() => expect(screen.getByText(/we sent a 6-digit code/i)).toBeTruthy());
	fireEvent.paste(window, { clipboardData: { getData: () => code } });
}

describe("newAccountDestination (A-03)", () => {
	it("sends a new account through onboarding, carrying next", () => {
		expect(newAccountDestination(null)).toBe("/onboarding");
		expect(newAccountDestination("/start?plan=team&trial=1")).toBe(
			"/onboarding?next=%2Fstart%3Fplan%3Dteam%26trial%3D1",
		);
	});

	it("sends a new account with an invitation straight to it", () => {
		expect(newAccountDestination("/invites/accept?token=t1")).toBe("/invites/accept?token=t1");
		// A path that only starts the same way is not an invitation.
		expect(newAccountDestination("/invites/acceptance")).toBe(
			"/onboarding?next=%2Finvites%2Facceptance",
		);
	});

	it("lands an emailed-code sign-up on the same destination a provider sign-up gets", async () => {
		h.search = `email=ada@example.com&next=${encodeURIComponent("/start?plan=team&trial=1")}`;
		h.signInEmailOtp.mockResolvedValue({ data: { user: {} }, error: null });
		render(<AuthForm mode="signup" />);

		await enterCode();

		await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
		expect(h.push).toHaveBeenCalledWith(newAccountDestination("/start?plan=team&trial=1"));
	});
});

describe("send failures show the form's own copy (A-07, A-08)", () => {
	it("says the code was not sent when the account check throws, never the thrown text", async () => {
		const masked =
			"An error occurred in the Server Components render. The specific message is omitted in production builds.";
		h.requestEmailCode.mockRejectedValue(new Error(masked));
		render(<AuthForm mode="login" />);

		submitEmail();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("We couldn’t send the code — try again.");
		expect(screen.queryByText(masked)).toBeNull();
	});

	it("never shows the auth server's message for an unrecognised send failure", async () => {
		h.sendVerificationOtp.mockResolvedValue({
			data: null,
			error: { status: 500, statusText: "", code: "SOMETHING_NEW", message: "raw server text" },
		});
		render(<AuthForm mode="login" />);

		submitEmail();

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toBe("We couldn’t send the code — try again.");
		expect(screen.queryByText("raw server text")).toBeNull();
	});

	it("says to wait when the auth server is rate-limiting", async () => {
		h.sendVerificationOtp.mockResolvedValue({
			data: null,
			error: { status: 429, statusText: "", message: "Too many requests" },
		});
		render(<AuthForm mode="login" />);

		submitEmail();

		expect((await screen.findByRole("alert")).textContent).toBe(
			"Too many attempts — wait a minute, then try again.",
		);
	});

	it("says the code was not sent when the send call itself throws", async () => {
		h.sendVerificationOtp.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<AuthForm mode="login" />);

		submitEmail();

		expect((await screen.findByRole("alert")).textContent).toBe(
			"We couldn’t send the code — try again.",
		);
		expect(screen.queryByText(/we sent a 6-digit code/i)).toBeNull();
	});
});

describe("a refused code says what to do next (A-09)", () => {
	/** The code field, by the accessible name the OTP input carries. */
	function codeField(): HTMLInputElement {
		const el = screen.getByLabelText("6-digit sign-in code");
		if (!(el instanceof HTMLInputElement)) throw new Error("the code field is not an input");
		return el;
	}

	it.each([
		["OTP_EXPIRED", "That code has expired. Use Resend code to get a new one."],
		[
			"TOO_MANY_ATTEMPTS",
			"Too many wrong tries — that code no longer works. Use Resend code to get a new one.",
		],
	])("points a dead code (%s) at Resend and empties the field", async (code, message) => {
		h.signInEmailOtp.mockResolvedValue({
			data: null,
			error: { status: 400, statusText: "", code, message: "server text" },
		});
		render(<AuthForm mode="login" />);

		await enterCode();

		expect((await screen.findByRole("alert")).textContent).toBe(message);
		await waitFor(() => expect(codeField().value).toBe(""));
	});

	it("keeps a mistyped code in the field so one digit can be fixed", async () => {
		h.signInEmailOtp.mockResolvedValue({
			data: null,
			error: { status: 400, statusText: "", code: "INVALID_OTP", message: "server text" },
		});
		render(<AuthForm mode="login" />);

		await enterCode("123456");

		expect((await screen.findByRole("alert")).textContent).toBe("That code didn’t work — try again.");
		expect(codeField().value).toBe("123456");
	});

	it("rolls back to a usable form when the verify call throws", async () => {
		h.signInEmailOtp.mockRejectedValue(new TypeError("Failed to fetch"));
		render(<AuthForm mode="login" />);

		await enterCode();

		expect((await screen.findByRole("alert")).textContent).toBe("That code didn’t work — try again.");
		expect(screen.queryByText(/verifying/i)).toBeNull();
	});
});

describe("the SSO entry (A-13)", () => {
	it("reduces a pasted sign-in link to the organization's name", () => {
		expect(ssoSlugFrom("acme")).toBe("acme");
		expect(ssoSlugFrom("  Acme ")).toBe("acme");
		expect(ssoSlugFrom("https://console.example.com/sso/acme")).toBe("acme");
		expect(ssoSlugFrom("https://console.example.com/sso/acme?provider=okta")).toBe("acme");
		expect(ssoSlugFrom("")).toBe("");
	});

	it("is a live control that opens an organization field", async () => {
		h.search = "";
		const user = userEvent.setup();
		render(<AuthForm mode="login" />);

		const sso = screen.getByRole("button", { name: /continue with sso/i });
		expect(sso).toBeEnabled();
		expect(sso).toHaveAttribute("aria-expanded", "false");

		await user.click(sso);

		expect(sso).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByLabelText("Organization")).toHaveFocus();
	});

	it("hands off to /sso/<slug>, carrying next", async () => {
		h.search = `next=${encodeURIComponent("/acme/~/jobs")}`;
		const user = userEvent.setup();
		render(<AuthForm mode="login" />);

		await user.click(screen.getByRole("button", { name: /continue with sso/i }));
		await user.type(screen.getByLabelText("Organization"), "https://console.example.com/sso/acme");
		await user.click(screen.getByRole("button", { name: /^continue$/i }));

		await waitFor(() => expect(h.hardNavigate).toHaveBeenCalledTimes(1));
		expect(h.hardNavigate).toHaveBeenCalledWith(`/sso/acme?next=${encodeURIComponent("/acme/~/jobs")}`);
	});

	it("refuses a name that cannot be an organization, and goes nowhere", async () => {
		h.search = "";
		const user = userEvent.setup();
		render(<AuthForm mode="login" />);

		await user.click(screen.getByRole("button", { name: /continue with sso/i }));
		await user.type(screen.getByLabelText("Organization"), "Acme Corp!");
		await user.click(screen.getByRole("button", { name: /^continue$/i }));

		expect(
			await screen.findByText(/lowercase letters, numbers and hyphens/i),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Organization")).toHaveAttribute("aria-invalid", "true");
		expect(h.hardNavigate).not.toHaveBeenCalled();
	});
});
