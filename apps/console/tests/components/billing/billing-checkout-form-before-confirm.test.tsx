// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// #5445 review of 3aae22463 — the checkout form's half of "nothing typed at checkout is lost".
//
// 1. The billing details reach the server BEFORE the card is confirmed (`beforeConfirm`). They used to
//    be saved only after the charge, so a crash between the two lost them, and a recovered setup asked
//    for the tax id again.
// 2. A refusal there stops the charge and is shown under the field — the customer has not paid.
// 3. The form applies the server's caps (lib/billing/billing-field-caps.ts). It used to accept any
//    length; the server then refused the whole record after the charge, and the caller swallowed it.
//
// Against 3aae22463 every case here fails: there is no `beforeConfirm`, so the card is confirmed with
// nothing saved, and an over-cap field is charged for.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const confirmCardPayment = vi.fn();

vi.mock("@stripe/react-stripe-js", () => ({
	CardNumberElement: () => null,
	CardExpiryElement: () => null,
	CardCvcElement: () => null,
	useStripe: () => ({ confirmCardPayment }),
	useElements: () => ({ getElement: () => ({}) }),
}));
vi.mock("@/components/billing/stripe-elements", () => ({ cardElementStyle: () => ({}) }));
vi.mock("next-themes", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
// The real picker is a popover; a native select reports the same value through the same onChange.
vi.mock("@repo/ui/country-select", () => ({
	CountrySelect: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
		<select aria-label="Country" value={value} onChange={(e) => onChange(e.target.value)}>
			<option value="">Select</option>
			<option value="DE">Germany</option>
		</select>
	),
}));

import {
	BillingCheckoutForm,
	type CheckoutRefusal,
	type CollectedBilling,
} from "@/components/billing/billing-checkout-form";

/** Renders the form with the given hooks; returns the user driver. */
function renderForm(
	onPaid: (b: CollectedBilling) => Promise<void>,
	beforeConfirm?: (b: CollectedBilling) => Promise<CheckoutRefusal | null>,
): ReturnType<typeof userEvent.setup> {
	const user = userEvent.setup();
	const element: React.ReactElement = (
		<BillingCheckoutForm
			clientSecret="pi_secret"
			meta={{ name: "Team" }}
			currency="eur"
			submitLabel="Create"
			onPaid={onPaid}
			beforeConfirm={beforeConfirm}
		/>
	);
	render(element);
	return user;
}

/** Fills the required fields, with `line1` as given. */
async function fill(user: ReturnType<typeof userEvent.setup>, line1 = "Hauptstr. 1") {
	await user.type(screen.getByLabelText("Full name"), "Acme GmbH");
	await user.selectOptions(screen.getByLabelText("Country"), "DE");
	await user.click(screen.getByLabelText("Address line 1"));
	await user.paste(line1);
	await user.type(screen.getByLabelText("City"), "Berlin");
	await user.type(screen.getByLabelText("Postal code"), "10115");
}

beforeEach(() => {
	vi.clearAllMocks();
	confirmCardPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
});

describe("BillingCheckoutForm — the details are saved before the charge", () => {
	it("hands the details to beforeConfirm BEFORE the card is confirmed, then charges and calls onPaid", async () => {
		const order: string[] = [];
		const beforeConfirm = vi.fn(async () => {
			order.push("save");
			return null;
		});
		confirmCardPayment.mockImplementation(async () => {
			order.push("charge");
			return { paymentIntent: { status: "succeeded" } };
		});
		const onPaid = vi.fn(async () => {
			order.push("paid");
		});
		const user = renderForm(onPaid, beforeConfirm);
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Create" }));

		await vi.waitFor(() => expect(onPaid).toHaveBeenCalledTimes(1));
		expect(order).toEqual(["save", "charge", "paid"]);
		expect(beforeConfirm).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Acme GmbH", line1: "Hauptstr. 1", country: "DE" }),
		);
	});

	it("a refusal stops the charge and is shown under the field it names", async () => {
		const onPaid = vi.fn(async () => {});
		const user = renderForm(onPaid, async () => ({ field: "line1", message: "Use at most 200 characters." }));
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(await screen.findByText("Use at most 200 characters.")).toBeInTheDocument();
		expect(confirmCardPayment).not.toHaveBeenCalled();
		expect(onPaid).not.toHaveBeenCalled();
	});

	it("a save that fails stops the charge and says the customer was not charged", async () => {
		const onPaid = vi.fn(async () => {});
		const user = renderForm(onPaid, async () => {
			throw new Error("network");
		});
		await fill(user);
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(await screen.findByText(/you have not been charged/i)).toBeInTheDocument();
		expect(confirmCardPayment).not.toHaveBeenCalled();
	});
});

describe("BillingCheckoutForm — the server's caps", () => {
	it("an address line over the server's cap is refused in the form — nothing is saved and nothing is charged", async () => {
		const beforeConfirm = vi.fn(async () => null);
		const onPaid = vi.fn(async () => {});
		const user = renderForm(onPaid, beforeConfirm);
		await fill(user, "x".repeat(201));
		await user.click(screen.getByRole("button", { name: "Create" }));

		expect(await screen.findByText("Use at most 200 characters.")).toBeInTheDocument();
		expect(beforeConfirm).not.toHaveBeenCalled();
		expect(confirmCardPayment).not.toHaveBeenCalled();
	});
});
