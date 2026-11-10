// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// F031 (#6132): the declaration form tells its sheet when a declared fact changes, so a refusal
// about the PREVIOUS answer can be dropped. Both purchase sheets wire `onEdit` to clearing it.

import { render, screen, waitFor } from "@testing-library/react";
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

describe("PayerDeclarationForm — what does NOT fire onEdit (#6459)", () => {
	// `onEdit` clears the refusal on screen, so firing it for anything but a changed answer would wipe
	// the sentence that explains why the purchase was refused.
	it("neither a submit nor a new server refusal calls onEdit", async () => {
		const user = userEvent.setup();
		const onEdit = vi.fn();
		const onDeclare = vi.fn();
		const props = { busy: false, submitLabel: "Continue to payment", onEdit, onDeclare };
		const { rerender } = render(<PayerDeclarationForm {...props} refusal={null} />);
		await user.click(screen.getByRole("radio", { name: /An individual/ }));
		await user.selectOptions(screen.getByRole("combobox", { name: "Billing country" }), "DE");
		onEdit.mockClear();

		await user.click(screen.getByRole("button", { name: "Continue to payment" }));
		await waitFor(() => expect(onDeclare).toHaveBeenCalledTimes(1));
		expect(onEdit).not.toHaveBeenCalled();

		rerender(<PayerDeclarationForm {...props} refusal="Not on sale in this country." />);
		expect(screen.getByText("Not on sale in this country.")).toBeInTheDocument();
		expect(onEdit).not.toHaveBeenCalled();
	});
});
