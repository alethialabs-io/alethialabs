// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The `/accept-terms` clickwrap, now rendered from the same copy module as onboarding's inline box
// (WIZ-W6, LEG-L5 #7096): each document's link and sealed version inside the label, links through
// `legalUrl`, the Privacy Policy as a notice. A failure is said in the form's own sentence, as an
// alert (A-07, A-15) — never a thrown message, which a production build turns into a digest.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const acceptLegalDocuments = vi.fn();
const replace = vi.fn();

vi.mock("@/app/server/actions/legal", () => ({
	acceptLegalDocuments: (...args: unknown[]) => acceptLegalDocuments(...args),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

import { AcceptTermsForm } from "@/components/legal/accept-terms-form";

const TERMS = {
	id: "terms",
	title: "Terms of Service",
	version: "2026-08-24",
	path: "/terms",
	firstAcceptance: true,
};
const FIRST = [TERMS];

beforeEach(() => {
	vi.clearAllMocks();
});

describe("AcceptTermsForm", () => {
	it("prints the version inside the label and links the documents through the legal site", () => {
		render(<AcceptTermsForm documents={FIRST} next="/dashboard" />);

		expect(
			screen.getByRole("checkbox", {
				name: "I have read and accept the Terms of Service (version 2026-08-24).",
			}),
		).not.toBeChecked();
		expect(screen.getByRole("link", { name: "Terms of Service" })).toHaveAttribute(
			"href",
			expect.stringMatching(/\/terms$/),
		);
		expect(screen.getByRole("link", { name: "Privacy Policy" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Accept our Terms" })).toBeInTheDocument();
	});

	it("keeps the button inert until the box is ticked, then records and continues", async () => {
		acceptLegalDocuments.mockResolvedValue({ accepted: 1 });
		const user = userEvent.setup();
		render(<AcceptTermsForm documents={FIRST} next="/dashboard" />);

		const button = screen.getByRole("button", { name: "Accept and continue" });
		expect(button).toBeDisabled();
		await user.click(screen.getByRole("checkbox"));
		expect(button).toBeEnabled();
		await user.click(button);

		await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
		expect(acceptLegalDocuments).toHaveBeenCalledWith(
			expect.objectContaining({ documentIds: ["terms"], locale: "en" }),
		);
	});

	it("says a failure in its own words, as an alert, and can be tried again", async () => {
		acceptLegalDocuments.mockRejectedValue(new Error("An error occurred (digest: 123)"));
		const user = userEvent.setup();
		render(<AcceptTermsForm documents={FIRST} next="/dashboard" />);

		await user.click(screen.getByRole("checkbox"));
		await user.click(screen.getByRole("button", { name: "Accept and continue" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Could not record your acceptance.");
		expect(screen.queryByText(/digest/)).toBeNull();
		expect(screen.getByRole("button", { name: "Accept and continue" })).toBeEnabled();
		expect(replace).not.toHaveBeenCalled();
	});

	it("tells a returning person the Terms changed, and a new one that they are agreeing for the first time", () => {
		const { unmount } = render(
			<AcceptTermsForm documents={[{ ...TERMS, firstAcceptance: false }]} next="/dashboard" />,
		);
		expect(screen.getByRole("heading", { name: "Our Terms have changed" })).toBeInTheDocument();
		unmount();
		render(<AcceptTermsForm documents={FIRST} next="/dashboard" />);
		expect(screen.queryByText(/have changed/)).toBeNull();
	});
});
