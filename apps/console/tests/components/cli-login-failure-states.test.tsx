// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// A-27 (#6926): `/cli/login`'s error stage is no longer terminal and no longer one sentence for
// everything. It is titled by what failed (the link, an approval, a refusal), offers another try
// where the request can still be answered, offers sign-in where the session ended (a 401), and the
// stage changes are announced through one polite live region that survives them.
//
// The harness is hyg-cli-authflow-login-page.test.tsx's, cut down: the account context is mocked at
// the hook (that file explains why), and `fetch` answers the mount-time read and then the POST.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
	const post: { status: number; body: unknown } = { status: 200, body: {} };
	return { search: "", fetch: vi.fn(), post };
});

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(h.search),
}));
vi.mock("@/app/(private)/cli/login/cli-session", () => ({
	useCliAccount: () => "ada@example.com",
}));

import CliLoginPage from "@/app/(private)/cli/login/page";
import { deviceApprovalScopes } from "@/lib/auth/cli-device-code";

const DEVICE_CODE = "2f1c8c1e-7a4b-4d2e-9a3f-0b5c6d7e8f90";
const USER_CODE = "BCDF-GHJK";

/** The described, pending request the mount-time read answers with. */
function pendingView() {
	return {
		status: "pending",
		user_code: USER_CODE,
		account: { email: "ada@example.com", name: "Ada" },
		requester: {
			client_name: "alethia-cli",
			client_version: "0.42.1",
			user_agent: "alethia-cli/0.42.1 (darwin; arm64)",
			request_ip: "203.0.113.7",
		},
		scopes: deviceApprovalScopes("github"),
		expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
	};
}

beforeEach(() => {
	h.search = `device_code=${DEVICE_CODE}&user_code=${USER_CODE}`;
	h.post = { status: 200, body: {} };
	h.fetch.mockReset();
	h.fetch.mockImplementation((url: string) => {
		if (String(url).startsWith("/api/auth/cli/request")) {
			return Promise.resolve({ ok: true, status: 200, json: async () => pendingView() });
		}
		return Promise.resolve({
			ok: h.post.status >= 200 && h.post.status < 300,
			status: h.post.status,
			json: async () => h.post.body,
		});
	});
	vi.stubGlobal("fetch", h.fetch);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** The one polite live region the page keeps across stages. */
function liveRegion(): HTMLElement {
	// The request panels carry `role="status"` of their own in some states; the page's region is
	// the visually hidden one.
	const region = screen.getAllByRole("status").find((el) => el.classList.contains("sr-only"));
	if (!region) throw new Error("the page has no stage live region");
	return region;
}

describe("/cli/login — failures say what failed and what to do (A-27)", () => {
	it("titles a refused approval as an approval, and lets it be tried again", async () => {
		h.post = { status: 409, body: { error: "This login request belongs to another account" } };
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await user.click(await screen.findByRole("button", { name: /^approve$/i }));

		expect(await screen.findByText("Approval failed")).toBeInTheDocument();
		expect(screen.getByRole("alert").textContent).toMatch(/belongs to another account/i);

		await user.click(screen.getByRole("button", { name: /try again/i }));

		expect(await screen.findByRole("button", { name: /^approve$/i })).toBeInTheDocument();
	});

	it("titles a refusal that did not record as a refusal, not as a failed sign-in", async () => {
		h.post = { status: 502, body: null };
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await user.click(await screen.findByRole("button", { name: /isn't me/i }));

		expect(await screen.findByText("Refusal not recorded")).toBeInTheDocument();
		expect(screen.queryByText(/authentication failed/i)).toBeNull();
		expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
	});

	it("offers sign-in, returning to this request, when the session ended", async () => {
		h.post = { status: 401, body: { error: "Unauthorized" } };
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await user.click(await screen.findByRole("button", { name: /^approve$/i }));

		expect(await screen.findByText("Sign in to approve")).toBeInTheDocument();
		const link = screen.getByRole("link", { name: "Sign in" });
		const target = new URL(link.getAttribute("href") ?? "", "https://console.test");
		expect(target.pathname).toBe("/login");
		expect(target.searchParams.get("next")).toBe(
			`/cli/login?device_code=${DEVICE_CODE}&user_code=${USER_CODE}`,
		);
		expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
	});

	it("offers nothing to press on a link that never parsed — the instruction is the way on", async () => {
		h.search = "device_code=not-a-uuid&user_code=nope";
		render(<CliLoginPage />);

		expect(await screen.findByText("This sign-in link can’t be used")).toBeInTheDocument();
		expect(screen.getByText(/run `alethia login`/i)).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("announces the outcome through one live region that survives the stage change", async () => {
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await screen.findByRole("button", { name: /^approve$/i });
		const region = liveRegion();
		expect(region.textContent).toBe("");

		await user.click(screen.getByRole("button", { name: /^approve$/i }));

		await waitFor(() => expect(liveRegion().textContent).toMatch(/approved/i));
		// The SAME node: a region inserted together with its text is not reliably announced.
		expect(liveRegion()).toBe(region);
	});
});
