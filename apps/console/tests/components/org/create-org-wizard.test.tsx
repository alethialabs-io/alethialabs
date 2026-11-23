// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The create-a-team sheet on the wizard shell (WIZ-W7 PR (b), #6930).
//
// The sheet is the overlay `?wizard=create-org&step=name|declare|pay|invite`, with a tab draft of the
// team's name and slug. What this file holds it to — the unit's acceptance lines first:
//   - a reload on `declare` comes back on `declare`, with the name and the slug restored (and the slug
//     checked with the server again before the declaration is offered);
//   - `?step=invite` with no confirmed org lands on `name` — with no draft, and with one;
//   - the draft keeps two keys, `name` and `slug`, in the definition and in what is stored;
// and the rule behind them: `pay` and `invite` are reached only through the machine. A URL that
// names one the machine has not reached is put back, and a Back past a confirmed charge is undone.
//
// The test page's query string survives an unmount, so a second render is a reload.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const isOrgSlugAvailable = vi.fn();
const createIntent = vi.fn();
const conversionStatus = vi.fn();
const findUnfinished = vi.fn();
const linkSubscription = vi.fn();
const getProOffer = vi.fn();
const createOrg = vi.fn();
const startProTrial = vi.fn();

vi.mock("@/app/server/actions/billing", () => ({
	attachTaxIdToCustomer: vi.fn().mockResolvedValue({ ok: true }),
	saveNewOrgSetupDetails: vi.fn().mockResolvedValue({ ok: true }),
	findUnfinishedNewOrgSetup: (...a: unknown[]) => findUnfinished(...a),
	resolveNewOrgSetup: vi.fn().mockResolvedValue(null),
	createNewOrgSubscriptionIntent: (...a: unknown[]) => createIntent(...a),
	getProOffer: (...a: unknown[]) => getProOffer(...a),
	isOrgSlugAvailable: (...a: unknown[]) => isOrgSlugAvailable(...a),
	linkSubscriptionToNewOrg: (...a: unknown[]) => linkSubscription(...a),
	setCustomerBillingAddress: vi.fn().mockResolvedValue(undefined),
	startProTrial: (...a: unknown[]) => startProTrial(...a),
}));
vi.mock("@/app/server/actions/legal", () => ({
	declarePayer: vi.fn().mockResolvedValue(undefined),
	payerConversionStatus: (...a: unknown[]) => conversionStatus(...a),
}));
vi.mock("@/app/server/actions/org-settings", () => ({ updateOrgPrimaryAddress: vi.fn() }));
vi.mock("@/app/server/actions/workspace", () => ({
	setActiveOrganization: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/auth/client", () => ({
	authClient: {
		organization: {
			create: (...a: unknown[]) => createOrg(...a),
			delete: vi.fn().mockResolvedValue({}),
			inviteMember: vi.fn(),
		},
	},
}));
vi.mock("@/components/providers/viewer-provider", () => ({
	useViewer: () => ({ viewer: { id: "user-1", email: "owner@example.com" } }),
}));
vi.mock("@/lib/stores/use-workspace-store", () => ({
	useWorkspaceStore: (pick: (s: { fetchWorkspace: () => Promise<void> }) => unknown) =>
		pick({ fetchWorkspace: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/lib/analytics/track", () => ({ track: vi.fn() }));
vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/components/billing/payer-declaration-form", () => ({
	PayerDeclarationForm: ({ onDeclare }: { onDeclare: (d: unknown) => void }) => (
		<button
			type="button"
			onClick={() =>
				onDeclare({ capacity: "organization", billingCountry: "DE", authorityAttestation: "CTO" })
			}
		>
			Declare payer
		</button>
	),
}));
vi.mock("@/components/billing/stripe-elements", () => ({
	StripeElementsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/billing/billing-checkout-form", async (importActual) => {
	const actual = await importActual<typeof import("@/components/billing/billing-checkout-form")>();
	return {
		billingAddressFrom: vi.fn(() => ({})),
		checkoutFieldOf: actual.checkoutFieldOf,
		BillingCheckoutForm: ({ onPaid }: { onPaid: (b: unknown) => void }) => (
			<button
				type="button"
				onClick={() =>
					onPaid({
						name: "Acme GmbH",
						line1: "Hauptstr. 1",
						city: "Berlin",
						postalCode: "10115",
						country: "DE",
						taxType: "eu_vat",
						taxValue: "",
						useAsPrimary: false,
					})
				}
			>
				Pay
			</button>
		),
	};
});
vi.mock("@/components/billing/currency-toggle", () => ({ CurrencyToggle: () => null }));
vi.mock("@/lib/billing/use-live-plan-price", () => ({
	useLivePlanPrice: () => ({ unitAmount: 0, label: "$0" }),
}));
vi.mock("@/lib/org-url", () => ({ orgHost: () => "alethialabs.io" }));
vi.mock("@/lib/wizard/location", async (importOriginal) => {
	const harness = await import("@/tests/components/design-project/byo/byo-wizard-harness");
	return { ...(await importOriginal()), useWizardEnvironment: harness.useTestWizardEnvironment };
});

import { CreateOrgSheet } from "@/components/org/create-org-sheet";
import { createOrgWizard } from "@/components/org/create-org.wizard";
import {
	resetTestPage,
	setTestSearch,
	testParam,
} from "@/tests/components/design-project/byo/byo-wizard-harness";

/** Opens the sheet, names the team and continues to the declaration. */
async function toDeclaration(user: ReturnType<typeof userEvent.setup>) {
	const view = render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
	await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
	const cont = screen.getByRole("button", { name: /continue/i });
	await vi.waitFor(() => expect(cont).toBeEnabled());
	await user.click(cont);
	await screen.findByRole("button", { name: "Declare payer" });
	return view;
}

/** The values of every stored create-org draft, parsed. */
function storedDraftValues(): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	for (let index = 0; index < window.sessionStorage.length; index += 1) {
		const key = window.sessionStorage.key(index);
		if (key === null || !key.includes(":create-org:")) continue;
		const parsed: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
		if (typeof parsed === "object" && parsed !== null && "values" in parsed) {
			const values: unknown = parsed.values;
			if (typeof values === "object" && values !== null) found.push({ ...values });
		}
	}
	return found;
}

beforeEach(() => {
	resetTestPage();
	window.sessionStorage.clear();
	vi.clearAllMocks();
	isOrgSlugAvailable.mockResolvedValue(true);
	conversionStatus.mockResolvedValue({ allowed: true });
	findUnfinished.mockResolvedValue(null);
	createIntent.mockResolvedValue({
		kind: "intent",
		subscriptionId: "sub_1",
		customerId: "cus_1",
		clientSecret: "pi_secret",
		currency: "eur",
	});
	linkSubscription.mockResolvedValue({ planState: "active" });
	getProOffer.mockResolvedValue({ kind: "none" });
	// Held in flight: a paid setup's create never finishes unless a test says otherwise.
	createOrg.mockReturnValue(new Promise(() => undefined));
	startProTrial.mockResolvedValue(undefined);
});

describe("CreateOrgSheet on the wizard shell — the URL", () => {
	it("opens as ?wizard=create-org and says the step", async () => {
		const user = userEvent.setup();
		await toDeclaration(user);
		expect(testParam("wizard")).toBe("create-org");
		expect(testParam("step")).toBe("declare");
	});

	it("a reload on declare comes back on declare, with the name and the slug restored", async () => {
		const user = userEvent.setup();
		const first = await toDeclaration(user);
		first.unmount();

		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		expect(await screen.findByRole("button", { name: "Declare payer" })).toBeInTheDocument();
		expect(screen.getByText("Create Acme Cloud")).toBeInTheDocument();
		expect(testParam("step")).toBe("declare");
		// The restored slug is checked with the server again before the declaration is offered.
		expect(isOrgSlugAvailable).toHaveBeenCalledTimes(2);
		expect(isOrgSlugAvailable).toHaveBeenLastCalledWith("acme-cloud");
		expect(conversionStatus).not.toHaveBeenCalled();
	});

	it("a reload on declare whose slug was claimed meanwhile lands on name, with the refusal", async () => {
		const user = userEvent.setup();
		const first = await toDeclaration(user);
		first.unmount();
		isOrgSlugAvailable.mockResolvedValue(false);

		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		expect(await screen.findByRole("alert")).toHaveTextContent(/taken/i);
		expect(screen.queryByRole("button", { name: "Declare payer" })).toBeNull();
		await vi.waitFor(() => expect(testParam("step")).toBe("name"));
	});

	it("?step=invite with no confirmed org clamps to name", async () => {
		setTestSearch("wizard=create-org&step=invite");
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		expect(await screen.findByLabelText(/team name/i)).toBeInTheDocument();
		await vi.waitFor(() => expect(testParam("step")).toBe("name"));
	});

	it("?step=invite clamps to name even with a draft whose name and slug are valid", async () => {
		const user = userEvent.setup();
		const first = await toDeclaration(user);
		first.unmount();
		setTestSearch("wizard=create-org&step=invite");

		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await vi.waitFor(() => expect(testParam("step")).toBe("name"));
		expect(screen.getByLabelText(/team name/i)).toHaveValue("Acme Cloud");
		expect(screen.queryByRole("button", { name: "Declare payer" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Pay" })).toBeNull();
	});

	it("?step=pay with no intent opened clamps to name", async () => {
		const user = userEvent.setup();
		const first = await toDeclaration(user);
		first.unmount();
		setTestSearch("wizard=create-org&step=pay");

		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await vi.waitFor(() => expect(testParam("step")).toBe("name"));
		expect(screen.queryByRole("button", { name: "Pay" })).toBeNull();
		expect(createIntent).toHaveBeenCalledTimes(0);
	});

	it("a Back in the URL from declare returns to name, with the name kept", async () => {
		const user = userEvent.setup();
		await toDeclaration(user);
		setTestSearch("wizard=create-org&step=name");

		expect(await screen.findByLabelText(/team name/i)).toHaveValue("Acme Cloud");
		expect(screen.queryByRole("button", { name: "Declare payer" })).toBeNull();
	});

	it("a Back in the URL from the payment form returns to the declaration, keeping the payment refs", async () => {
		const user = userEvent.setup();
		await toDeclaration(user);
		await user.click(screen.getByRole("button", { name: "Declare payer" }));
		await screen.findByRole("button", { name: "Pay" });
		expect(testParam("step")).toBe("pay");

		setTestSearch("wizard=create-org&step=declare");
		await user.click(await screen.findByRole("button", { name: "Declare payer" }));
		await screen.findByRole("button", { name: "Pay" });
		expect(createIntent).toHaveBeenLastCalledWith(
			"team",
			expect.objectContaining({ priorSubscriptionId: "sub_1", customerId: "cus_1" }),
		);
	});

	it("a Back in the URL after the charge is confirmed is put back on pay", async () => {
		const user = userEvent.setup();
		await toDeclaration(user);
		await user.click(screen.getByRole("button", { name: "Declare payer" }));
		await user.click(await screen.findByRole("button", { name: "Pay" }));
		await screen.findByText(/your payment went through/i);

		setTestSearch("wizard=create-org&step=declare");
		await vi.waitFor(() => expect(testParam("step")).toBe("pay"));
		expect(screen.getByText(/your payment went through/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Declare payer" })).toBeNull();
	});
});

describe("CreateOrgSheet on the wizard shell — invite", () => {
	it("a finished setup moves the URL to invite through the gate, and drops the draft", async () => {
		getProOffer.mockResolvedValue({ kind: "trial", trialDays: 30 });
		createOrg.mockResolvedValue({ data: { id: "org-new", slug: "acme-cloud" }, error: null });
		const user = userEvent.setup();
		render(<CreateOrgSheet open onOpenChange={vi.fn()} />);
		await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
		const cont = screen.getByRole("button", { name: /continue/i });
		await vi.waitFor(() => expect(cont).toBeEnabled());
		await user.click(cont);
		await user.click(await screen.findByRole("button", { name: /start 30-day free trial/i }));

		await vi.waitFor(() => expect(testParam("step")).toBe("invite"));
		expect(startProTrial).toHaveBeenCalledWith({ orgId: "org-new" });
		expect(storedDraftValues()).toEqual([]);
	});
});

describe("CreateOrgSheet on the wizard shell — the draft", () => {
	it("the definition's draft schema has two keys: name and slug", () => {
		const schema = createOrgWizard.draft?.schema;
		if (!(schema instanceof z.ZodObject)) throw new Error("the draft schema is not an object schema");
		expect(Object.keys(schema.shape).sort()).toEqual(["name", "slug"]);
	});

	it("stores only the name and the slug — nothing of the declaration or the payment", async () => {
		const user = userEvent.setup();
		await toDeclaration(user);
		await user.click(screen.getByRole("button", { name: "Declare payer" }));
		await screen.findByRole("button", { name: "Pay" });

		const drafts = storedDraftValues();
		expect(drafts.length).toBeGreaterThan(0);
		for (const values of drafts) {
			expect(Object.keys(values).sort()).toEqual(["name", "slug"]);
		}
		expect(drafts).toContainEqual({ name: "Acme Cloud", slug: "acme-cloud" });
	});

	it("closing keeps the draft: the next open starts from the name typed", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		const view = render(<CreateOrgSheet open onOpenChange={onOpenChange} />);
		await user.type(screen.getByLabelText(/team name/i), "Acme Cloud");
		await user.keyboard("{Escape}");
		await vi.waitFor(() => expect(testParam("wizard")).toBeNull());
		expect(onOpenChange).toHaveBeenCalledWith(false);

		view.rerender(<CreateOrgSheet open={false} onOpenChange={onOpenChange} />);
		view.rerender(<CreateOrgSheet open onOpenChange={onOpenChange} />);
		expect(await screen.findByLabelText(/team name/i)).toHaveValue("Acme Cloud");
		expect(screen.getByText(/restored your draft/i)).toBeInTheDocument();
	});
});
