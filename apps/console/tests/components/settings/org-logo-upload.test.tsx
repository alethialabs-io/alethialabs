// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The organization logo control (CON-L3). Pins:
//   · R6 E-05: a refused removal is a refusal — it used to ignore the status, so a 403 or 500 read
//     as success and the logo vanished from the form while staying stored;
//   · R6 E-06: a failure is told by status in the console's words, never the route's raw `error`,
//     and a 401 ends the session instead of toasting.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toast, endSession } = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn() },
	endSession: vi.fn(),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/lib/stores/use-session-state", () => ({ endSession }));

import {
	logoFailureMessage,
	logoNetworkMessage,
	OrgLogoUpload,
} from "@/components/org/org-logo-upload";

const fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
	toast.success.mockReset();
	toast.error.mockReset();
	endSession.mockReset();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Renders the control with a logo, opens the removal confirmation and confirms it. */
async function confirmRemoval(onChange: (url: string | null) => void) {
	render(<OrgLogoUpload name="Acme" logo="/api/org/o1/logo?v=1" onChange={onChange} />);
	fireEvent.click(screen.getByRole("button", { name: "Remove" }));
	fireEvent.click(await screen.findByRole("button", { name: "Remove logo" }));
}

describe("logoFailureMessage", () => {
	it("has no sentence for a 401 — the session-ended dialog says it", () => {
		expect(logoFailureMessage("upload", 401)).toBeNull();
		expect(logoFailureMessage("remove", 401)).toBeNull();
	});

	it("says who may change the logo on a 403, never the route's 'Forbidden'", () => {
		expect(logoFailureMessage("remove", 403)).toMatch(/owners and admins/);
		expect(logoFailureMessage("upload", 403)).not.toMatch(/forbidden/i);
	});

	it("names the upload's own refusals", () => {
		expect(logoFailureMessage("upload", 413)).toMatch(/2 MB/);
		expect(logoFailureMessage("upload", 415)).toMatch(/PNG/);
		expect(logoFailureMessage("upload", 500)).toBe("Couldn't upload the logo. Try again.");
	});

	it("tells a dropped removal to check before retrying", () => {
		expect(logoNetworkMessage("remove")).toMatch(/check before trying again/);
		expect(logoNetworkMessage("upload")).toMatch(/wasn't changed/);
	});
});

describe("OrgLogoUpload — remove", () => {
	it("a removed logo clears the field and closes the confirmation", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
		const onChange = vi.fn();
		await confirmRemoval(onChange);
		await waitFor(() => expect(onChange).toHaveBeenCalledWith(null));
		await waitFor(() => expect(screen.queryByRole("button", { name: "Remove logo" })).toBeNull());
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("a refused removal is NOT success: the logo stays and the confirmation stays open", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));
		const onChange = vi.fn();
		await confirmRemoval(onChange);
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Only owners and admins can change the organization logo.",
			),
		);
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("button", { name: "Remove logo" })).toBeInTheDocument();
	});

	it("a 401 ends the session instead of toasting", async () => {
		fetchMock.mockResolvedValue(new Response("", { status: 401 }));
		const onChange = vi.fn();
		await confirmRemoval(onChange);
		await waitFor(() => expect(endSession).toHaveBeenCalled());
		expect(toast.error).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});
});

describe("OrgLogoUpload — upload", () => {
	it("refuses an oversized image before sending it", async () => {
		const onChange = vi.fn();
		const { container } = render(<OrgLogoUpload name="Acme" logo={null} onChange={onChange} />);
		const input = container.querySelector("input[type='file']");
		if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
		const big = new File([new Uint8Array(2 * 1024 * 1024 + 1)], "big.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [big] } });
		await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/2 MB/)));
		expect(fetchMock).not.toHaveBeenCalled();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("a refused upload shows the console's sentence, not the route's raw error", async () => {
		fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }));
		const onChange = vi.fn();
		const { container } = render(<OrgLogoUpload name="Acme" logo={null} onChange={onChange} />);
		const input = container.querySelector("input[type='file']");
		if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
		const png = new File([new Uint8Array(8)], "logo.png", { type: "image/png" });
		fireEvent.change(input, { target: { files: [png] } });
		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith(
				"Only owners and admins can change the organization logo.",
			),
		);
		expect(toast.error).not.toHaveBeenCalledWith("Forbidden");
		expect(onChange).not.toHaveBeenCalled();
	});
});
