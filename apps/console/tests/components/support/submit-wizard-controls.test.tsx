// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The new-case wizard's controls.
//
// The button row stays put (F043, #6130):
//   · step 1 has no Back (there is nowhere to go back to) — but its slot stays, so Continue does not
//     jump across the row;
//   · Continue is disabled until the step's one choice is made, rather than enabled and refused;
//   · every step's validation message has its line reserved BEFORE there is a message, so a message
//     appearing never pushes the row down under the pointer.
//
// The choices are a radio group and the rail says where the person is (G-19); abuse is reported
// through its own form, linked from the type step rather than offered as a type (G-14).

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/support", () => ({ submitCase: vi.fn() }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/lib/wizard/location", async () => {
	const harness = await import("@/tests/components/support/submit-wizard-harness");
	return { useWizardEnvironment: harness.useTestWizardEnvironment };
});

import { SubmitCaseForm, stepAnswered } from "@/components/support/submit/submit-case-form";
import { resetTestPage } from "@/tests/components/support/submit-wizard-harness";

/** Renders the new-case wizard for org `acme`, with a pre-filled notification email. */
function renderSubmitWizard() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<SubmitCaseForm orgSlug="acme" defaultEmail="a@example.test" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetTestPage();
});

/** Renders the wizard and waits for its first step to come alive (it is inert until the draft is read). */
async function renderWizard() {
	const view = renderSubmitWizard();
	await screen.findByRole("radiogroup", { name: "Case type" });
	await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
	return view;
}

describe("the submit wizard's controls (F043)", () => {
	it("step 1 shows no Back button, keeps its slot, and disables Continue until a type is chosen", async () => {
		const { container } = await renderWizard();
		expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
		const row = container.querySelector('[data-slot="wizard-footer"]');
		// Two laid-out children either way: the Back slot (empty on step 1) and the primary action.
		// (A disabled primary also carries its reason in a `hidden` span, which takes no space.)
		const laidOut = Array.from(row?.children ?? []).filter((child) => !child.hasAttribute("hidden"));
		expect(laidOut).toHaveLength(2);
		expect(laidOut[0]?.getAttribute("data-slot")).toBe("wizard-footer-back");
		expect(laidOut[0]?.children).toHaveLength(0);
		expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

		fireEvent.click(screen.getByText("Technical"));
		expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
	});

	it("reserves the validation line before any message exists", async () => {
		const { container } = await renderWizard();
		const lines = container.querySelectorAll('[data-slot="field-message"]');
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(line.textContent).toBe("");
			expect(line.className).toContain("min-h-4");
		}
	});

	it("Back appears from step 2 on", async () => {
		await renderWizard();
		fireEvent.click(screen.getByText("Technical"));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(await screen.findByRole("button", { name: "Back" })).toBeInTheDocument();
	});
});

describe("the type step (G-19, G-14)", () => {
	it("is a radio group of the four case types, one of them checked by a click", async () => {
		await renderWizard();
		const group = screen.getByRole("radiogroup", { name: "Case type" });
		const radios = within(group).getAllByRole("radio");
		expect(radios.map((radio) => radio.getAttribute("value"))).toEqual([
			"technical",
			"billing",
			"account",
			"general",
		]);
		for (const radio of radios) expect(radio).not.toBeChecked();

		fireEvent.click(screen.getByText("Billing"));
		expect(screen.getByRole("radio", { name: "Billing" })).toBeChecked();
		expect(screen.queryByRole("button", { pressed: true })).toBeNull();
	});

	it("links to the abuse form instead of offering abuse as a type", async () => {
		await renderWizard();
		expect(screen.queryByRole("radio", { name: /abuse/i })).toBeNull();
		expect(screen.getByRole("link", { name: "Report abuse" })).toHaveAttribute(
			"href",
			"/acme/~/support/abuse",
		);
	});

	it("marks the current step on the rail", async () => {
		await renderWizard();
		const rail = screen.getByRole("navigation", { name: "New support case" });
		const current = rail.querySelectorAll('[aria-current="step"]');
		expect(current).toHaveLength(1);
		expect(current[0]?.textContent).toContain("Type");
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
