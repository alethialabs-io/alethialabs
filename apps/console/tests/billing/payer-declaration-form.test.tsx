// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The Early Access fields of the payer declaration and the billing-address step (#7324).
//
//   - "Does the organization have a VAT number?" is asked of an organization billed in the EU, with no
//     answer pre-selected and no copy about what either answer opens;
//   - a US buyer picks a state;
//   - a `complimentary_grant` refusal links to the Early Access request;
//   - the address step hands the address over with the DECLARED country, which it does not ask again.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/country-select", () => ({
	CountrySelect: ({ value, onChange }: { value: string; onChange: (code: string) => void }) => (
		<select aria-label="Billing country" value={value} onChange={(e) => onChange(e.target.value)}>
			<option value="">Select a country</option>
			<option value="DE">Germany</option>
			<option value="BG">Bulgaria</option>
			<option value="GB">United Kingdom</option>
			<option value="US">United States</option>
		</select>
	),
}));

import {
	BillingAddressForm,
	PayerDeclarationForm,
	refusalActionFor,
} from "@/components/billing/payer-declaration-form";

/** Renders the declaration form with an `onDeclare` spy. */
function renderForm(props: Partial<Parameters<typeof PayerDeclarationForm>[0]> = {}) {
	const onDeclare = vi.fn();
	render(
		<PayerDeclarationForm
			busy={false}
			refusal={null}
			submitLabel="Continue to payment"
			onDeclare={onDeclare}
			{...props}
		/>,
	);
	return onDeclare;
}

/** Fills in an organization billed in `country`. */
async function organizationIn(user: ReturnType<typeof userEvent.setup>, country: string) {
	await user.click(screen.getByRole("radio", { name: /An organization/ }));
	await user.selectOptions(screen.getByRole("combobox", { name: "Billing country" }), country);
	await user.type(screen.getByPlaceholderText("Director"), "Director");
}

describe("the VAT-number question", () => {
	it("is asked of an EU organization, with nothing pre-selected, and required", async () => {
		const user = userEvent.setup();
		const onDeclare = renderForm();
		await organizationIn(user, "DE");

		expect(screen.getByText("Does the organization have a VAT number?")).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "Yes" })).not.toBeChecked();
		expect(screen.getByRole("radio", { name: "No" })).not.toBeChecked();
		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(await screen.findByText(/Say whether the organization has a VAT number/)).toBeInTheDocument();
		expect(onDeclare).not.toHaveBeenCalled();
	});

	it("declares `not_given` with no number", async () => {
		const user = userEvent.setup();
		const onDeclare = renderForm();
		await organizationIn(user, "DE");
		await user.click(screen.getByRole("radio", { name: "No" }));
		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(onDeclare).toHaveBeenCalledWith(
			expect.objectContaining({ billingCountry: "DE", vatIdStatus: "not_given", vatId: null, billingState: null }),
		);
	});

	it("takes the number on a yes", async () => {
		const user = userEvent.setup();
		const onDeclare = renderForm();
		await organizationIn(user, "BG");
		await user.click(screen.getByRole("radio", { name: "Yes" }));
		await user.type(screen.getByRole("textbox", { name: /VAT number/ }), "BG123456789");
		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(onDeclare).toHaveBeenCalledWith(expect.objectContaining({ vatIdStatus: "given", vatId: "BG123456789" }));
	});

	it("is not asked outside the EU, nor of an individual", async () => {
		const user = userEvent.setup();
		renderForm();
		await organizationIn(user, "GB");
		expect(screen.queryByText("Does the organization have a VAT number?")).toBeNull();
		await user.click(screen.getByRole("radio", { name: /An individual/ }));
		await user.selectOptions(screen.getByRole("combobox", { name: "Billing country" }), "DE");
		expect(screen.queryByText("Does the organization have a VAT number?")).toBeNull();
	});

	// No steering (decisions-2026-11-23-early-access.md §2): nothing on the form may hint that one
	// answer opens a sale the other does not.
	it("carries no copy about what either answer opens", () => {
		const src = readFileSync(join(process.cwd(), "components/billing/payer-declaration-form.tsx"), "utf8");
		const question = src.slice(src.indexOf("Does the organization have a VAT number?"));
		const block = question.slice(0, question.indexOf("</fieldset>"));
		expect(block).not.toMatch(/reverse charge|complimentary|free|cheaper|faster|instant|recommended/i);
	});
});

describe("the US state", () => {
	it("is asked of a US buyer and required", async () => {
		const user = userEvent.setup();
		const onDeclare = renderForm();
		await organizationIn(user, "US");
		expect(screen.queryByText("Does the organization have a VAT number?")).toBeNull();
		expect(screen.getByRole("combobox", { name: "State" })).toBeInTheDocument();
		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(await screen.findByText(/Select the US state/)).toBeInTheDocument();
		expect(onDeclare).not.toHaveBeenCalled();
	});
});

describe("the complimentary-grant refusal", () => {
	it("links to the org's Early Access request", () => {
		const action = refusalActionFor("complimentary_grant", "acme");
		expect(action).toEqual({
			href: "/acme/~/settings/billing/early-access",
			label: "Request complimentary Early Access",
		});
		renderForm({ refusal: "Request complimentary Early Access instead.", refusalAction: action });
		expect(screen.getByRole("link", { name: /Request complimentary Early Access/ })).toHaveAttribute(
			"href",
			"/acme/~/settings/billing/early-access",
		);
	});

	it("is the only refusal with somewhere to go", () => {
		expect(refusalActionFor("market_closed", "acme")).toBeNull();
		expect(refusalActionFor("complimentary_grant", null)).toBeNull();
	});
});

describe("BillingAddressForm", () => {
	it("hands over the address with the declared country and state", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(
			<BillingAddressForm country="US" state="NY" busy={false} submitLabel="Continue to payment" onSubmit={onSubmit} />,
		);
		await user.type(screen.getByRole("textbox", { name: /Billing name/ }), "Acme Inc");
		await user.type(screen.getByRole("textbox", { name: /Address line 1/ }), "1 Main St");
		await user.type(screen.getByRole("textbox", { name: /City/ }), "New York");
		await user.type(screen.getByRole("textbox", { name: /Postal code/ }), "10001");
		await user.click(screen.getByRole("button", { name: /Continue to payment/ }));
		expect(onSubmit).toHaveBeenCalledWith({
			name: "Acme Inc",
			line1: "1 Main St",
			line2: undefined,
			city: "New York",
			postalCode: "10001",
			country: "US",
			state: "NY",
		});
	});

	it("requires the name, line 1, city and postal code", async () => {
		const user = userEvent.setup();
		const onSubmit = vi.fn();
		render(<BillingAddressForm country="DE" state={null} busy={false} submitLabel="Continue" onSubmit={onSubmit} />);
		await user.click(screen.getByRole("button", { name: /Continue/ }));
		expect(await screen.findByText(/Enter the address/)).toBeInTheDocument();
		expect(onSubmit).not.toHaveBeenCalled();
	});
});
