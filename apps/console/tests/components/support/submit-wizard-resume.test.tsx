// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The new-case wizard on the shared wizard engine: what survives a reload, and where a refusal lands.
//
//   · G-07 — the step is in the URL and the typed values are in the tab's draft, so rendering the
//     page again with the same URL (a reload) comes back on the same step with the same text, and
//     says so with "Restored your draft · Start over". Attachments cannot be kept, and the details
//     step says to re-attach them.
//   · A server field refusal lands on its field and takes the person to the step that shows it.
//   · G-04 — a refusal on a field no step shows is not silent: it is shown above the buttons.
//   · G-03 — a file that failed to attach is not promised a later upload nothing offers.
//
// "A reload" here is an unmount and a fresh render over the same query string and the same tab
// storage — which is all a reload leaves the page (`submit-wizard-harness.tsx`).

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

import { ATTACHMENTS_NOT_KEPT } from "@/components/support/submit/steps/step-details";
import { attachmentFailedMessage } from "@/components/support/use-submit-case";
import { SubmitCaseForm } from "@/components/support/submit/submit-case-form";
import { resetTestPage, setTestSearch, testSearch } from "@/tests/components/support/submit-wizard-harness";

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
	submitCase.mockReset();
	submitCase.mockResolvedValue({ ok: true, data: { id: "case-1", caseNumber: 1 } });
});

const SUBJECT = "Cluster is unreachable";
const DESCRIPTION = "My production cluster stopped responding after the last apply.";

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
	await waitFor(() => expect(screen.queryByRole("button", { name: "Pick Clusters" })).toBeNull());
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await screen.findByLabelText("Subject");
}

/** Fills Details with valid answers. */
function fillDetails() {
	fireEvent.change(screen.getByLabelText("Subject"), { target: { value: SUBJECT } });
	fireEvent.change(screen.getByLabelText("Description"), { target: { value: DESCRIPTION } });
}

/** From Details, filled in, to Contact; then presses Submit case. */
async function submitFromDetails() {
	fillDetails();
	fireEvent.click(screen.getByRole("button", { name: "Continue" }));
	await screen.findByLabelText("Notification email");
	fireEvent.click(screen.getByRole("button", { name: "Submit case" }));
	await waitFor(() => expect(submitCase).toHaveBeenCalledTimes(1));
}

describe("a reload restores the case (G-07)", () => {
	it("comes back on Details with the description typed, and offers to start over", async () => {
		const first = renderSubmitWizard();
		await toDetails();
		fillDetails();
		expect(new URLSearchParams(testSearch()).get("step")).toBe("details");
		first.unmount();

		renderSubmitWizard();

		expect(await screen.findByLabelText("Description")).toHaveValue(DESCRIPTION);
		expect(screen.getByLabelText("Subject")).toHaveValue(SUBJECT);
		expect(screen.getByText(/Restored your draft/)).toBeInTheDocument();
		expect(screen.getByText(ATTACHMENTS_NOT_KEPT)).toBeInTheDocument();
	});

	it("Start over drops the draft and returns to the first step", async () => {
		const first = renderSubmitWizard();
		await toDetails();
		fillDetails();
		first.unmount();
		renderSubmitWizard();
		await screen.findByLabelText("Description");

		fireEvent.click(screen.getByRole("button", { name: "Start over" }));

		expect(await screen.findByRole("radiogroup", { name: "Case type" })).toBeInTheDocument();
		expect(screen.queryByText(/Restored your draft/)).toBeNull();
		for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
	});

	it("a filed case leaves no draft behind", async () => {
		const first = renderSubmitWizard();
		await toDetails();
		await submitFromDetails();
		first.unmount();
		// A fresh visit to the page in the same tab: no step in the URL, the same tab storage.
		setTestSearch("");

		renderSubmitWizard();

		expect(await screen.findByRole("radiogroup", { name: "Case type" })).toBeInTheDocument();
		expect(screen.queryByText(/Restored your draft/)).toBeNull();
	});
});

describe("a server refusal lands where the person can act on it", () => {
	it("a field refusal returns to the field's step, with the message under the field", async () => {
		submitCase.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "Check the subject.",
				fields: { subject: ["That subject is not allowed."] },
			},
		});
		renderSubmitWizard();
		await toDetails();
		await submitFromDetails();

		expect(await screen.findByText("That subject is not allowed.")).toBeInTheDocument();
		expect(screen.getByLabelText("Subject")).toHaveAttribute("aria-invalid", "true");
		expect(new URLSearchParams(testSearch()).get("step")).toBe("details");
	});

	it("a refusal on a field no step shows is said above the buttons (G-04)", async () => {
		submitCase.mockResolvedValue({
			ok: false,
			error: {
				kind: "validation",
				message: "Check the case.",
				fields: { context: ["The page address could not be read."] },
			},
		});
		renderSubmitWizard();
		await toDetails();
		await submitFromDetails();

		expect(await screen.findByRole("alert")).toHaveTextContent("The page address could not be read.");
		// Still on Contact, with Submit available again.
		expect(screen.getByRole("button", { name: "Submit case" })).toBeEnabled();
	});
});

describe("a failed attachment (G-03)", () => {
	it("says the case was opened without the file, and promises no later upload", () => {
		const message = attachmentFailedMessage("trace.har");
		expect(message).toContain("trace.har");
		expect(message).toContain("opened without it");
		expect(message).not.toMatch(/later/i);
	});
});
