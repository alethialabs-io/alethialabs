// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5415 — the onboarding form must SHOW the server's refusal of a slug.
//
// `configureOnboardingOrg` always wrote "That slug is reserved — try another.", but it threw it, and
// a throw out of a `"use server"` export is redacted to a digest + HTTP 500 in a production build
// (the #4644 class). The form then sniffed the redacted message for /reserved|taken/, never matched,
// and toasted the digest. The release gate's `qa` leg recorded the result: no inline error, the user
// left on /onboarding with nothing said. The action now RETURNS the refusal; this file pins the half
// the action suite cannot see — that the form renders it inline and does not navigate.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configureOnboardingOrg = vi.fn();
const markOnboardingComplete = vi.fn();
const toastError = vi.fn();
const push = vi.fn();

vi.mock("@/app/server/actions/onboarding", () => ({
	configureOnboardingOrg: (...args: unknown[]) => configureOnboardingOrg(...args),
	markOnboardingComplete: (...args: unknown[]) => markOnboardingComplete(...args),
}));
vi.mock("@/app/server/actions/billing", () => ({
	createSubscriptionIntent: vi.fn(),
	saveTaxId: vi.fn(),
	startProTrial: vi.fn(),
	updateBillingAddress: vi.fn(),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { error: (...args: unknown[]) => toastError(...args) },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push, refresh: vi.fn() }),
	useSearchParams: () => new URLSearchParams(),
}));
// Billing, Stripe and the logo uploader are other screens' subjects; this file is about the name,
// the slug and one button.
vi.mock("@/components/billing/billing-checkout-form", () => ({
	billingAddressFrom: vi.fn(),
	BillingCheckoutForm: () => null,
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: () => null,
}));
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/components/org/org-logo-upload", () => ({ OrgLogoUpload: () => null }));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: 0, label: "$0" }),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { OnboardingForm } from "@/components/auth/onboarding-form";

const RESERVED = "That slug is reserved — try another.";

/** Renders the form for an owner's freshly provisioned primary org on the free plan. */
function renderIt() {
	return render(
		<OnboardingForm
			org={{ id: "org-1", name: "Acme", slug: "acme", logo: null, role: "owner" }}
			offer={{ kind: "none" }}
			proAvailable={false}
		/>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("OnboardingForm — a slug the server refuses", () => {
	it("renders the server's sentence inline and stays on the form", async () => {
		configureOnboardingOrg.mockResolvedValue({ ok: false, error: RESERVED });
		const user = userEvent.setup();
		renderIt();

		await user.click(screen.getByRole("button", { name: /customize url/i }));
		const slugBox = screen.getByRole("textbox", { name: "URL slug" });
		await user.clear(slugBox);
		await user.type(slugBox, "docs");
		await user.click(screen.getByRole("button", { name: /create organization/i }));

		expect(configureOnboardingOrg).toHaveBeenCalledWith({ name: "Acme", slug: "docs" });
		// THE DEFECT, INVERTED: before #5415 nothing rendered here — the refusal was a digest.
		expect(await screen.findByRole("alert")).toHaveTextContent(RESERVED);
		// A refusal is a field error, not a toast, and it must not navigate or finish onboarding.
		expect(toastError).not.toHaveBeenCalled();
		expect(push).not.toHaveBeenCalled();
		expect(markOnboardingComplete).not.toHaveBeenCalled();
		// The slug the sentence is about is still there to change, and the button is usable again.
		expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue("docs");
		expect(screen.getByRole("button", { name: /create organization/i })).toBeEnabled();
	});

	it("opens the URL editor when the refusal arrives with it closed", async () => {
		configureOnboardingOrg.mockResolvedValue({
			ok: false,
			error: "That slug is taken — try another.",
		});
		const user = userEvent.setup();
		renderIt();

		expect(screen.queryByRole("textbox", { name: "URL slug" })).toBeNull();
		await user.click(screen.getByRole("button", { name: /create organization/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(/taken/);
		expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue("acme");
	});

	it("toasts an UNEXPECTED failure and never presents it as a slug error", async () => {
		// What a production build delivers for a throw: a digest sentence that happens to contain
		// none of the field words — or, as here, one that does. Either way it is not a field error.
		configureOnboardingOrg.mockRejectedValue(new Error("An error occurred (digest: slug-123)"));
		const user = userEvent.setup();
		renderIt();

		await user.click(screen.getByRole("button", { name: /create organization/i }));

		await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).toBeNull();
		expect(push).not.toHaveBeenCalled();
	});

	it("finishes onboarding and lands on the org on success", async () => {
		configureOnboardingOrg.mockResolvedValue({ ok: true, slug: "acme" });
		markOnboardingComplete.mockResolvedValue(undefined);
		const user = userEvent.setup();
		renderIt();

		await user.click(screen.getByRole("button", { name: /create organization/i }));

		await vi.waitFor(() => expect(push).toHaveBeenCalledWith("/acme"));
		expect(markOnboardingComplete).toHaveBeenCalled();
		expect(screen.queryByRole("alert")).toBeNull();
	});
});
