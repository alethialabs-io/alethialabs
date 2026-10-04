// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5453 — a hyphen could not be TYPED into the create-a-team sheet's URL field.
//
// The field re-slugged its value on every keystroke with `slugifyOrEmpty`, which trims a trailing
// dash: `my-` was stored as `my`, and the next keystroke made `myt`. A hyphen could only be pasted
// or derived from a space in the team name. The field now holds a draft that keeps the dash, and the
// draft is finished (its edge dashes trimmed) on blur and before the slug is checked or sent.
// The first two cases fail against the old field on their value assertions.

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

/** Renders the open sheet, names the team, and opens the URL editor. Returns the URL field. */
async function openUrlEditor(user: ReturnType<typeof userEvent.setup>) {
	render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
	await user.type(screen.getByLabelText(/team name/i), "Acme");
	await user.click(screen.getByRole("button", { name: "Customize URL" }));
	const field = screen.getByRole("textbox", { name: "URL slug" });
	await user.clear(field);
	return field;
}

beforeEach(() => {
	vi.clearAllMocks();
	getProOffer.mockResolvedValue({ kind: "pay" });
	isOrgSlugAvailable.mockResolvedValue(true);
});

describe("CreateOrgSheet — typing a hyphen into the URL", () => {
	it("keeps the typed hyphen, so the next letter lands after it", async () => {
		const user = userEvent.setup();
		const field = await openUrlEditor(user);

		await user.type(field, "my-");
		expect(field).toHaveValue("my-");
		// Not refused mid-word: `my-` is on its way to `my-team`, and the check judges the finished slug.
		expect(screen.queryByRole("alert")).toBeNull();

		await user.type(field, "t");
		expect(field).toHaveValue("my-t");
	});

	it("collapses a doubled hyphen to one as it is typed", async () => {
		const user = userEvent.setup();
		const field = await openUrlEditor(user);

		await user.type(field, "my--team");
		expect(field).toHaveValue("my-team");
	});

	it("trims a trailing hyphen when the field is left, and checks the trimmed slug", async () => {
		const user = userEvent.setup();
		const field = await openUrlEditor(user);

		await user.type(field, "my-team-");
		expect(field).toHaveValue("my-team-");
		const cont = screen.getByRole("button", { name: /continue/i });
		await vi.waitFor(() => expect(cont).toBeEnabled());
		await user.click(cont);

		await vi.waitFor(() => expect(isOrgSlugAvailable).toHaveBeenCalled());
		// The availability check and everything after it read the stored value — never the draft.
		expect(isOrgSlugAvailable).toHaveBeenCalledWith("my-team");
		expect(isOrgSlugAvailable).not.toHaveBeenCalledWith("my-team-");
	});

	it("refuses a slug that is only hyphens as empty, not as a format error", async () => {
		const user = userEvent.setup();
		const field = await openUrlEditor(user);

		await user.type(field, "-");
		expect(field).toHaveValue("");
		await user.click(screen.getByRole("button", { name: /continue/i }));

		expect(await screen.findByRole("alert")).toHaveTextContent("Pick a slug.");
		expect(isOrgSlugAvailable).not.toHaveBeenCalled();
	});
});
