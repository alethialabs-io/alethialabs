// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The new-case wizard's button row stays put (F043, #6130):
//   · step 1 has no Back (there is nowhere to go back to) — but its slot stays, so Continue does not
//     jump across the row;
//   · Continue is disabled until the step's one choice is made, rather than enabled and refused;
//   · every step's validation message has its line reserved BEFORE there is a message, so a message
//     appearing never pushes the row down under the pointer.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/support", () => ({ submitCase: vi.fn() }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));

import { SubmitCaseForm, stepAnswered } from "@/components/support/submit/submit-case-form";

function renderWizard() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<SubmitCaseForm orgSlug="acme" defaultEmail="a@example.test" />
		</QueryClientProvider>,
	);
}

describe("the submit wizard's controls (F043)", () => {
	it("step 1 shows no Back button, keeps its slot, and disables Continue until a type is chosen", () => {
		renderWizard();
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
		const row = screen.getByRole("button", { name: "Continue" }).parentElement;
		// Two children either way: the Back slot (empty on step 1) and Continue.
		expect(row?.children).toHaveLength(2);
		expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

		fireEvent.click(screen.getByText("Technical"));
		expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
	});

	it("reserves the validation line before any message exists", () => {
		const { container } = renderWizard();
		const lines = container.querySelectorAll('[data-slot="field-message"]');
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line.textContent).toBe("");
			expect(line.className).toContain("min-h-4");
		}
	});

	it("Back appears from step 2 on", async () => {
		renderWizard();
		fireEvent.click(screen.getByText("Technical"));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
	});
});

describe("stepAnswered", () => {
	it("gates the three choice steps on their choice, and never the text steps", () => {
		expect(stepAnswered(0, {})).toBe(false);
		expect(stepAnswered(0, { type: "technical" })).toBe(true);
		expect(stepAnswered(1, {})).toBe(false);
		expect(stepAnswered(1, { category: "other" })).toBe(true);
		expect(stepAnswered(2, {})).toBe(false);
		expect(stepAnswered(3, {})).toBe(true);
		expect(stepAnswered(4, {})).toBe(true);
	});
});
