// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The new-case wizard files a case ONLY from the Contact step's "Submit case" button (#6728), and its
// Details step reads like a person wrote it (#6729).
//
// #6728 on production: one click on Continue at Details advanced to Contact AND filed the case. The
// Continue and Submit buttons shared a slot with no `key`, so React re-typed the clicked node to
// `submit`; `handleNext` awaits `trigger()`, and a browser drains microtasks between the click
// listeners and the button's activation, so the re-type landed first and the activation submitted.
// jsdom runs the activation BEFORE microtasks, so a plain click here cannot reproduce the race —
// these tests pin the two things that close it instead, each of which fails on the old code:
//   · the click on Continue is cancelled (`fireEvent.click` returns false), so no activation runs;
//   · the Submit button is a NEW node, not the clicked Continue re-typed.
// Both are now the shared `WizardFooter`'s guarantee (`@repo/ui/wizard`), not handlers in the form.
// Enter in the Subject field is the browser's implicit submission (the step has one text input and no
// submit button), modelled here as a submit event on the form.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useFormContext } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { submitCase } = vi.hoisted(() => ({ submitCase: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/server/actions/support", () => ({ submitCase }));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("@/lib/wizard/location", async () => {
	const harness = await import("@/tests/components/support/submit-wizard-harness");
	return { useWizardEnvironment: harness.useTestWizardEnvironment };
});
// The Area step is a Radix Select, which jsdom cannot open; its choice is not under test here.
vi.mock("@/components/support/submit/steps/step-category", () => ({
	StepCategory: function StepCategoryStub() {
		const { setValue } = useFormContext();
		return (
			<button type="button" onClick={() => setValue("category", "clusters")}>
				Pick Clusters
			</button>
		);
	},
}));

import { SubmitCaseForm } from "@/components/support/submit/submit-case-form";
import { resetTestPage } from "@/tests/components/support/submit-wizard-harness";

/** Renders the new-case wizard for org `acme`, with a pre-filled notification email. */
function renderWizard() {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<SubmitCaseForm orgSlug="acme" defaultEmail="a@example.test" />
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	resetTestPage();
	submitCase.mockReset();
	submitCase.mockResolvedValue({ ok: true, data: { id: "case-1", caseNumber: 1 } });
});

/** Answers steps 1–3 (type, area, the defaulted severity) and lands on Details. */
async function toDetails() {
	// Wait for the first step to come alive: until the draft is read it is drawn inert and busy, and
	// a press there would land on a wizard that has not booted.
	await screen.findByRole("radiogroup", { name: "Case type" });
	await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());
	fireEvent.click(screen.getByText("Technical"));
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	fireEvent.click(await screen.findByRole("button", { name: "Pick Clusters" }));
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await screen.findByRole("button", { name: "Back" });
	await waitFor(() => expect(screen.queryByRole("button", { name: "Pick Clusters" })).toBeNull());
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await screen.findByLabelText("Subject");
}

/** Fills Details with valid answers. */
function fillDetails() {
	fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Cluster is unreachable" } });
	fireEvent.change(screen.getByLabelText("Description"), {
		target: { value: "My production cluster stopped responding after the last apply." },
	});
}

describe("the submit wizard files a case only from Contact (#6728)", () => {
	it("one click on Continue at Details shows Contact and files nothing", async () => {
		renderWizard();
		await toDetails();
		fillDetails();

		const proceeded = fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByLabelText("Notification email")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Submit case" })).toBeInTheDocument();
		// The click's default action was cancelled, so no activation can submit the form.
		expect(proceeded).toBe(false);
		expect(submitCase).not.toHaveBeenCalled();
	});

	it("renders Submit as a new node, not the clicked Continue re-typed", async () => {
		renderWizard();
		await toDetails();
		fillDetails();

		const continueButton = screen.getByRole("button", { name: "Continue" });
		fireEvent.click(continueButton);
		const submitButton = await screen.findByRole("button", { name: "Submit case" });

		expect(submitButton).not.toBe(continueButton);
		expect(continueButton.isConnected).toBe(false);
	});

	it("Enter in a Details field advances to Contact instead of filing", async () => {
		const { container } = renderWizard();
		await toDetails();
		fillDetails();

		const form = container.querySelector("form");
		if (!form) throw new Error("the wizard renders no form");
		fireEvent.submit(form);

		expect(await screen.findByLabelText("Notification email")).toBeInTheDocument();
		expect(submitCase).not.toHaveBeenCalled();
	});

	it("Back from Contact keeps the answers, and Submit case files exactly once", async () => {
		renderWizard();
		await toDetails();
		fillDetails();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		await screen.findByLabelText("Notification email");

		fireEvent.click(screen.getByRole("button", { name: "Back" }));
		expect(await screen.findByLabelText("Subject")).toHaveValue("Cluster is unreachable");
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		await screen.findByLabelText("Notification email");
		expect(submitCase).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Submit case" }));
		await waitFor(() => expect(submitCase).toHaveBeenCalledTimes(1));
		expect(submitCase).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: "Cluster is unreachable",
				contact: expect.objectContaining({ notifyEmail: "a@example.test" }),
			}),
		);
	});
});

describe("the Details step's validation (#6729)", () => {
	it("shows written messages and marks both fields invalid", async () => {
		renderWizard();
		await toDetails();
		const subject = screen.getByLabelText("Subject");
		const description = screen.getByLabelText("Description");
		expect(subject).not.toHaveAttribute("aria-invalid");
		expect(description).not.toHaveAttribute("aria-invalid");

		fireEvent.click(screen.getByRole("button", { name: "Continue" }));

		expect(await screen.findByText("Enter a subject of at least 3 characters.")).toBeInTheDocument();
		expect(screen.getByText("Describe the issue in at least 10 characters.")).toBeInTheDocument();
		expect(screen.queryByText(/too small/i)).toBeNull();
		expect(subject).toHaveAttribute("aria-invalid", "true");
		expect(description).toHaveAttribute("aria-invalid", "true");
		expect(subject).toHaveAccessibleDescription("Enter a subject of at least 3 characters.");
		expect(description).toHaveAccessibleDescription("Describe the issue in at least 10 characters.");
		// Still on Details.
		expect(screen.queryByLabelText("Notification email")).toBeNull();
	});
});
