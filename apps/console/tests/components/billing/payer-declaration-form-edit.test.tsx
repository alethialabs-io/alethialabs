// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// F031 (#6132): the declaration form tells its sheet when a declared fact changes, so a refusal
// about the PREVIOUS answer can be dropped. Both purchase sheets wire `onEdit` to clearing it.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/ui/country-select", () => ({
	CountrySelect: ({ value, onChange }: { value: string; onChange: (code: string) => void }) => (
		<select aria-label="Billing country" value={value} onChange={(e) => onChange(e.target.value)}>
			<option value="">Select a country</option>
			<option value="DE">Germany</option>
		</select>
	),
}));

import { PayerDeclarationForm } from "@/components/billing/payer-declaration-form";

/** Renders the form with a refusal on screen and an `onEdit` spy. */
function renderForm(onEdit = vi.fn()) {
	render(
		<PayerDeclarationForm
			busy={false}
			refusal="Not on sale in this country."
			submitLabel="Continue to payment"
			onEdit={onEdit}
			onDeclare={vi.fn()}
		/>,
	);
	return onEdit;
}

describe("PayerDeclarationForm — onEdit (F031)", () => {
	it("does not fire before anything is edited", () => {
		const onEdit = renderForm();
		expect(onEdit).not.toHaveBeenCalled();
	});

	it("fires when the capacity changes", async () => {
		const user = userEvent.setup();
		const onEdit = renderForm();
		await user.click(screen.getByRole("radio", { name: /An individual/ }));
		expect(onEdit).toHaveBeenCalled();
	});

	it("fires when the country changes", async () => {
		const user = userEvent.setup();
		const onEdit = renderForm();
		await user.selectOptions(screen.getByRole("combobox", { name: "Billing country" }), "DE");
		expect(onEdit).toHaveBeenCalled();
	});

	it("fires when the authority attestation is typed", async () => {
		const user = userEvent.setup();
		const onEdit = renderForm();
		await user.click(screen.getByRole("radio", { name: /An organization/ }));
		onEdit.mockClear();
		await user.type(screen.getByPlaceholderText("Director"), "D");
		expect(onEdit).toHaveBeenCalled();
	});
});
