// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// CON-PB1 (#6951): two of the sign-in form's P3 findings.
//
//   A-21  the login heading says "Sign in", the verb the rest of the product uses — not "Log in";
//   A-25  a refresh on "Enter your code" used to drop the person back on the provider grid. Sending
//         the code now records `?email=…&step=code`, and a form opened on that address starts on
//         the code step; going back to the email step clears it.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	search: "",
	sendVerificationOtp: vi.fn(),
	requestEmailCode: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(h.search),
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
vi.mock("@/components/shell/hard-navigate", () => ({ hardNavigate: vi.fn() }));

import { AuthForm, CODE_STEP_PARAM, codeStepSearch } from "@/components/auth/auth-form";
import { useAuthPrefsStore } from "@/lib/stores/use-auth-prefs-store";

beforeEach(() => {
	document.elementFromPoint = () => null;
	localStorage.clear();
	useAuthPrefsStore.setState({ lastMethod: null, lastEmail: null });
	window.history.replaceState(null, "", "/login");
	h.search = "";
	h.requestEmailCode.mockReset();
	h.requestEmailCode.mockResolvedValue({ outcome: "send-otp" });
	h.sendVerificationOtp.mockReset();
	h.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
});

describe("the login heading (A-21)", () => {
	it("says Sign in, never Log in", () => {
		render(<AuthForm mode="login" />);
		expect(screen.getByRole("heading", { name: "Sign in to Alethia" })).toBeInTheDocument();
		expect(screen.queryByText(/log in/i)).toBeNull();
	});
});

describe("codeStepSearch (A-25)", () => {
	it("records the step and the address, keeping every other parameter", () => {
		const next = new URLSearchParams(codeStepSearch("?next=%2Fstart", "ada@example.com"));
		expect(next.get("next")).toBe("/start");
		expect(next.get("email")).toBe("ada@example.com");
		expect(next.get(CODE_STEP_PARAM)).toBe("code");
	});

	it("clears only the step", () => {
		expect(codeStepSearch("?email=ada%40example.com&step=code", null)).toBe("?email=ada%40example.com");
		expect(codeStepSearch("?step=code", null)).toBe("");
	});
});

describe("the code step survives a refresh (A-25)", () => {
	it("sending the code writes the step into the address bar", async () => {
		h.search = "email=ada@example.com";
		window.history.replaceState(null, "", "/login?email=ada%40example.com");
		render(<AuthForm mode="login" />);
		fireEvent.click(screen.getByRole("button", { name: /continue with email/i }));
		await waitFor(() => expect(screen.getByText(/we sent a 6-digit code/i)).toBeTruthy());
		const params = new URLSearchParams(window.location.search);
		expect(params.get(CODE_STEP_PARAM)).toBe("code");
		expect(params.get("email")).toBe("ada@example.com");
		expect(window.location.pathname).toBe("/login");
	});

	it("an address carrying the step opens on the code field, not the provider grid", () => {
		h.search = "email=ada@example.com&step=code";
		render(<AuthForm mode="login" />);
		expect(screen.getByRole("heading", { name: /enter your code/i })).toBeInTheDocument();
		expect(screen.getByText(/we sent a 6-digit code/i)).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Sign in to Alethia" })).toBeNull();
	});

	it("the step alone, with no address to send to, opens where it always did", () => {
		h.search = "step=code";
		render(<AuthForm mode="login" />);
		expect(screen.queryByText(/we sent a 6-digit code/i)).toBeNull();
	});
});
