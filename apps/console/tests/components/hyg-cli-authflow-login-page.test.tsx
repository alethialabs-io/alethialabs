// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The browser half of the CLI device flow. The page used to approve the device code in a
// useEffect ON MOUNT, so merely opening a phished /cli/login link bound the victim's
// account to the attacker's device code. It must now approve nothing without an explicit
// press, and must show the user_code so the user can compare it with their terminal.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// next/navigation is mocked per-test: the query string is a mutable module-level string.
let hygCliAuthflowSearch = "";
vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(hygCliAuthflowSearch),
}));

import CliLoginPage from "@/app/(private)/cli/login/page";

const HYG_CLI_AUTHFLOW_DEVICE_CODE = "2f1c8c1e-7a4b-4d2e-9a3f-0b5c6d7e8f90";
const HYG_CLI_AUTHFLOW_USER_CODE = "BCDF-GHJK";

const hygCliAuthflowFetch = vi.fn();

beforeEach(() => {
	hygCliAuthflowFetch.mockReset();
	hygCliAuthflowFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
	vi.stubGlobal("fetch", hygCliAuthflowFetch);
	hygCliAuthflowSearch = `device_code=${HYG_CLI_AUTHFLOW_DEVICE_CODE}&user_code=${HYG_CLI_AUTHFLOW_USER_CODE}`;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("/cli/login", () => {
	it("approves nothing on mount and shows the code to compare", async () => {
		render(<CliLoginPage />);

		// Precondition: the page really did render the approval step for a well-formed
		// link — an assertion of "no request" against a page that rendered an error would
		// prove nothing.
		expect(
			await screen.findByRole("button", { name: /approve/i }),
		).toBeInTheDocument();
		expect(screen.getByText(HYG_CLI_AUTHFLOW_USER_CODE)).toBeInTheDocument();

		// The takeover: this used to have fired from a useEffect, with no user gesture.
		expect(hygCliAuthflowFetch).not.toHaveBeenCalled();
	});

	it("binds the device code only when the user presses Approve", async () => {
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await user.click(await screen.findByRole("button", { name: /approve/i }));

		await waitFor(() => expect(hygCliAuthflowFetch).toHaveBeenCalledTimes(1));
		const [url, init] = hygCliAuthflowFetch.mock.calls[0];
		expect(url).toBe("/api/auth/cli/generate");
		expect(JSON.parse(init.body)).toEqual({
			device_code: HYG_CLI_AUTHFLOW_DEVICE_CODE,
			user_code: HYG_CLI_AUTHFLOW_USER_CODE,
		});
		expect(await screen.findByText(/authentication successful/i)).toBeInTheDocument();
	});

	it("lets the user decline without sending anything", async () => {
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await user.click(await screen.findByRole("button", { name: /isn't me/i }));

		expect(await screen.findByText(/not approved/i)).toBeInTheDocument();
		expect(hygCliAuthflowFetch).not.toHaveBeenCalled();
	});

	it("refuses a link with no user_code instead of offering to approve it", async () => {
		hygCliAuthflowSearch = `device_code=${HYG_CLI_AUTHFLOW_DEVICE_CODE}`;
		render(<CliLoginPage />);

		expect(await screen.findByText(/not a valid CLI login request/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
		expect(hygCliAuthflowFetch).not.toHaveBeenCalled();
	});

	it("surfaces the server's refusal when the code belongs to another account", async () => {
		hygCliAuthflowFetch.mockResolvedValue({
			ok: false,
			json: async () => ({ error: "This login request belongs to another account" }),
		});
		const user = userEvent.setup();
		render(<CliLoginPage />);

		await user.click(await screen.findByRole("button", { name: /approve/i }));

		expect(
			await screen.findByText(/belongs to another account/i),
		).toBeInTheDocument();
	});
});
