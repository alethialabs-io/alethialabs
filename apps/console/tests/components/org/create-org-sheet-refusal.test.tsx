// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5442 — the create-a-team sheet must SAY why it refused a slug, in a sentence that is true, where
// the user can see it.
//
// #5415 fixed the onboarding form, whose action threw its refusals across the "use server" boundary
// and lost them to a production digest. This sheet does not have that defect — its slug check
// (`isOrgSlugAvailable`) answers a boolean and its create goes through better-auth's HTTP client,
// which returns errors rather than throwing them — but it had three of its own, each pinned below:
//
//   1. A RESERVED slug ("docs") was refused as TAKEN: `isOrgSlugAvailable` answers `false` for both,
//      so the user was sent looking for an organization that does not exist.
//   2. The refusal was a bare `<p>`, and the URL editor stayed closed — an auto-derived slug is only
//      preview text under the name, so the field the sentence was about was not on screen.
//   3. On the TRIAL panel, a slug claimed since Continue was written to a field error on the name
//      step, which is not rendered there: the button stopped doing anything and nothing was said.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const isOrgSlugAvailable = vi.fn();
const getProOffer = vi.fn();
const startProTrial = vi.fn();
const createOrg = vi.fn();

vi.mock("@/app/server/actions/billing", () => ({
	attachTaxIdToCustomer: vi.fn(),
	createNewOrgSubscriptionIntent: vi.fn(),
	getProOffer: (...args: unknown[]) => getProOffer(...args),
	isOrgSlugAvailable: (...args: unknown[]) => isOrgSlugAvailable(...args),
	linkSubscriptionToNewOrg: vi.fn(),
	setCustomerBillingAddress: vi.fn(),
	startProTrial: (...args: unknown[]) => startProTrial(...args),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: vi.fn(),
	payerConversionStatus: vi.fn(),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			create: (...args: unknown[]) => createOrg(...args),
			delete: vi.fn().mockResolvedValue({}),
			inviteMember: vi.fn(),
		},
	},
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { email: "owner@example.com" } }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (pick: (s: { fetchWorkspace: () => Promise<void> }) => unknown) =>
		pick({ fetchWorkspace: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
// Billing and Stripe are other screens' subjects; this file is about the name, the slug and the
// buttons that act on them.
vi.mock("@/components/billing/billing-checkout-form", () => ({
	billingAddressFrom: vi.fn(),
	BillingCheckoutForm: () => null,
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: () => null,
}));
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/components/billing/payer-declaration-form", () => ({
	PayerDeclarationForm: () => null,
}));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: 0, label: "$0" }),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));

import { CreateOrgSheet } from "@/components/org/create-org-sheet";

const RESERVED = "That slug is reserved — try another.";
const TAKEN = "That slug is taken — try another.";

/** Renders the open sheet. */
function renderIt() {
	return render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
}

/** Types a team name (which derives the slug) and presses Continue once the offer has resolved. */
async function nameAndContinue(user: ReturnType<typeof userEvent.setup>, name: string) {
	await user.type(screen.getByLabelText(/team name/i), name);
	const cont = screen.getByRole("button", { name: /continue/i });
	await vi.waitFor(() => expect(cont).toBeEnabled());
	await user.click(cont);
}

beforeEach(() => {
	vi.clearAllMocks();
	getProOffer.mockResolvedValue({ kind: "pay" });
	// The real action's answer for a reserved slug: false, indistinguishable from taken.
	isOrgSlugAvailable.mockImplementation(async (slug: string) => slug !== "docs");
});

describe("CreateOrgSheet — a slug it refuses", () => {
	it("calls a reserved slug RESERVED, not taken, and opens the URL editor on it", async () => {
		const user = userEvent.setup();
		renderIt();

		await nameAndContinue(user, "Docs");

		// THE DEFECT, INVERTED: this read "That slug is taken" — about an org that does not exist.
		expect(await screen.findByRole("alert")).toHaveTextContent(RESERVED);
		expect(screen.getByRole("alert")).not.toHaveTextContent(/taken/);
		expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue("docs");
		// It never left the name step.
		expect(screen.getByLabelText(/team name/i)).toBeInTheDocument();
	});

	it("announces a taken slug as an alert and opens the URL editor on it", async () => {
		isOrgSlugAvailable.mockResolvedValue(false);
		const user = userEvent.setup();
		renderIt();

		expect(screen.queryByRole("textbox", { name: "URL slug" })).toBeNull();
		await nameAndContinue(user, "Acme Cloud");

		expect(isOrgSlugAvailable).toHaveBeenCalledWith("acme-cloud");
		expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
		expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue("acme-cloud");
	});

	it("goes back to the name step when the slug is claimed between Continue and Start trial", async () => {
		getProOffer.mockResolvedValue({ kind: "trial", trialDays: 30 });
		isOrgSlugAvailable.mockResolvedValueOnce(true).mockResolvedValue(false);
		const user = userEvent.setup();
		renderIt();

		await nameAndContinue(user, "Acme Cloud");
		await user.click(await screen.findByRole("button", { name: /start 30-day free trial/i }));

		// Before #5442 the sheet stayed on the trial panel with the sentence nowhere on screen.
		expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
		expect(screen.getByRole("textbox", { name: "URL slug" })).toHaveValue("acme-cloud");
		expect(createOrg).not.toHaveBeenCalled();
		expect(startProTrial).not.toHaveBeenCalled();
	});

	it("goes back to the name step when the create itself refuses the slug on the trial path", async () => {
		getProOffer.mockResolvedValue({ kind: "trial", trialDays: 30 });
		isOrgSlugAvailable.mockResolvedValue(true);
		createOrg.mockResolvedValue({
			data: null,
			error: { message: "Organization already exists" },
		});
		const user = userEvent.setup();
		renderIt();

		await nameAndContinue(user, "Acme Cloud");
		await user.click(await screen.findByRole("button", { name: /start 30-day free trial/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent(TAKEN);
		expect(createOrg).toHaveBeenCalledWith({ name: "Acme Cloud", slug: "acme-cloud" });
		expect(startProTrial).not.toHaveBeenCalled();
	});
});
